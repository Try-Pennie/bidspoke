/**
 * The plain variables an ops workflow version carries (#2702, Dan's decisions
 * of 2026-10-28): a version keeps the values of the variables its definition
 * may read as they were when it was saved (workflow_versions.env_capture,
 * written by the database at the insert), and the bidding Worker serves to ops
 * only the ones the definition reads: a plain one by its value, a secret one by
 * its name alone, so the ops run can refuse it by name.
 *
 * Which saved value a workflow's run reads follows the env loader's rules
 * (rowReach): the organization's value, with the workflow's own laid over it,
 * the newer of two organization rows winning, and never another workflow's.
 */
import { describe, expect, it } from 'vitest'
import { envReferences } from '../definition-env-references'
import { servedVersionVariables } from '../version-variables'

const WF = '00000000-0000-4000-8000-0000000019a1'
const OTHER_WF = '00000000-0000-4000-8000-0000000019a2'

const row = (key: string, value: string | null, over: Record<string, unknown> = {}) => ({
  key, value, is_secret: false, scope: 'global', workflow_id: null, ...over,
})
const own = (key: string, value: string | null, over: Record<string, unknown> = {}) => row(key, value, { scope: 'workflow', workflow_id: WF, ...over })
const secret = (key: string, over: Record<string, unknown> = {}) => row(key, null, { is_secret: true, ...over })

const node = (id: string, config: Record<string, unknown>) => ({ id, namespace: id, type: 'transform', config })
const readsDef = (...keys: string[]) => ({
  nodes: [node('shape', { mappings: keys.map((k) => ({ source: `{{env.${k}}}`, target: k.toLowerCase() })) })],
  edges: [],
})

describe('envReferences: the variables a definition reads', () => {
  it('finds env.X as a path and {{env.X}} in a template, in steps and edge conditions, once each, in order', () => {
    const def = {
      nodes: [node('a', { mappings: [{ source: 'env.API_BASE', target: 'b' }, { source: 'see {{ env.LIST_ID }} and {{env.API_BASE}}', target: 'c' }] })],
      edges: [{ id: 'e', source: 'a', target: 'b', condition: { field: 'env.REGION' } }],
    }
    expect(envReferences(def)).toEqual(['API_BASE', 'LIST_ID', 'REGION'])
  })

  it('does not read a mention that is neither a path nor a template, nor anything outside the steps and edges', () => {
    const def = { name: 'uses env.NAME_ONLY', nodes: [node('a', { note: 'mentions env.PROSE in a sentence' })], edges: [] }
    expect(envReferences(def)).toEqual([])
  })

  it('reads nothing from something that is not nodes and edges', () => {
    expect(envReferences({})).toEqual([])
    expect(envReferences({ nodes: 'env.X', edges: null })).toEqual([])
  })
})

describe('servedVersionVariables: what a version serves to ops', () => {
  it('serves nothing for a version saved before its variables were kept', () => {
    expect(servedVersionVariables(null, WF, readsDef('API_BASE'), 'workflow w version 3')).toBeNull()
  })

  it('serves the plain values the definition reads, and the names of the secret ones, never a secret value', () => {
    const capture = [row('API_BASE', 'https://api.example.test'), secret('TOKEN'), row('UNREAD', 'not read')]
    expect(servedVersionVariables(capture, WF, readsDef('API_BASE', 'TOKEN'), 'workflow w version 3')).toEqual({
      values: { API_BASE: 'https://api.example.test' }, secret_keys: ['TOKEN'],
    })
  })

  it('leaves out a variable the version did not keep, so the run names it as missing', () => {
    expect(servedVersionVariables([row('API_BASE', 'a')], WF, readsDef('API_BASE', 'LIST_ID'), 'workflow w version 3')).toEqual({
      values: { API_BASE: 'a' }, secret_keys: [],
    })
  })

  it('lays the workflow\'s own value over the organization\'s, as the env loader does', () => {
    const capture = [row('API_BASE', 'org'), own('API_BASE', 'mine')]
    expect(servedVersionVariables(capture, WF, readsDef('API_BASE'), 'v')?.values).toEqual({ API_BASE: 'mine' })
    // Whichever order the rows were saved in.
    expect(servedVersionVariables([...capture].reverse(), WF, readsDef('API_BASE'), 'v')?.values).toEqual({ API_BASE: 'mine' })
  })

  it('a workflow\'s own secret withholds the organization\'s plain value of the same name', () => {
    const capture = [row('API_BASE', 'org'), own('API_BASE', null, { is_secret: true })]
    expect(servedVersionVariables(capture, WF, readsDef('API_BASE'), 'v')).toEqual({ values: {}, secret_keys: ['API_BASE'] })
  })

  it('of two organization rows with one name, the later saved wins, as the env loader reads them', () => {
    expect(servedVersionVariables([row('K', 'older'), row('K', 'newer')], WF, readsDef('K'), 'v')?.values).toEqual({ K: 'newer' })
  })

  it('never serves another workflow\'s own value, nor a workflow\'s own value of an organization only key', () => {
    const capture = [own('K', 'theirs', { workflow_id: OTHER_WF }), own('SALESFORCE_CLIENT_ID', 'mine'), row('SALESFORCE_CLIENT_ID', 'org')]
    expect(servedVersionVariables(capture, WF, readsDef('K', 'SALESFORCE_CLIENT_ID'), 'v')).toEqual({
      values: { SALESFORCE_CLIENT_ID: 'org' }, secret_keys: [],
    })
  })

  it('refuses, by the version\'s name, kept variables it cannot read, rather than serving a guess', () => {
    for (const bad of [{}, 'x', [{ key: 'K' }], [row('K', 'v', { is_secret: 'yes' })], [row('K', null, { value: 5 })], [secret('K', { value: 'ciphertext' })], [row('bad key', 'v')]]) {
      expect(() => servedVersionVariables(bad, WF, readsDef('K'), 'workflow w version 3')).toThrow(/workflow w version 3/)
    }
  })
})
