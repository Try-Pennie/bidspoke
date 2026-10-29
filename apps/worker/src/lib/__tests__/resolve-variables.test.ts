/**
 * The one resolver of which saved environment variable row a workflow's run
 * reads (#2997, phase 1 of #2982). The precedence rules that lived inside
 * servedVersionVariables (#2702) now live here, and the ops gateway's
 * opsRunVariables applies them to the current rows: the workflow's own row over
 * the organization's, the later saved of two organization rows winning, a row
 * with no value reaching no run, and a row saved for another workflow, or a
 * workflow's own row of an organization only key, never reaching it.
 */
import { describe, expect, it } from 'vitest'
import { resolveVariables } from '../resolve-variables'

const WF = '00000000-0000-4000-8000-0000000019a1'
const OTHER_WF = '00000000-0000-4000-8000-0000000019a2'

const row = (key: string, value: string | null, over: Record<string, unknown> = {}) => ({
  key, value, is_secret: false, scope: 'global', workflow_id: null as string | null, ...over,
})
const own = (key: string, value: string | null, over: Record<string, unknown> = {}) => row(key, value, { scope: 'workflow', workflow_id: WF, ...over })

/** The resolved values by name, for reading a case at a glance. */
const valuesOf = (resolved: Map<string, { value: unknown }>) => Object.fromEntries([...resolved].map(([k, r]) => [k, r.value]))

describe('resolveVariables', () => {
  it('answers only the names asked for, in the order asked, leaving out a name with no row', () => {
    const rows = [row('B', 'b'), row('A', 'a'), row('UNASKED', 'u')]
    const resolved = resolveVariables(rows, WF, ['A', 'MISSING', 'B'])
    expect([...resolved.keys()]).toEqual(['A', 'B'])
    expect(valuesOf(resolved)).toEqual({ A: 'a', B: 'b' })
  })

  it('lays the workflow\'s own row over the organization\'s, whichever was saved first', () => {
    const rows = [row('K', 'org'), own('K', 'mine')]
    expect(valuesOf(resolveVariables(rows, WF, ['K']))).toEqual({ K: 'mine' })
    expect(valuesOf(resolveVariables([...rows].reverse(), WF, ['K']))).toEqual({ K: 'mine' })
  })

  it('of two organization rows with one name, the later saved wins', () => {
    expect(valuesOf(resolveVariables([row('K', 'older'), row('K', 'newer')], WF, ['K']))).toEqual({ K: 'newer' })
  })

  it('of two of the workflow\'s own rows with one name, the later saved wins', () => {
    expect(valuesOf(resolveVariables([own('K', 'older'), own('K', 'newer')], WF, ['K']))).toEqual({ K: 'newer' })
  })

  it('skips a row with an empty or missing value, so an older or organization value shows through', () => {
    expect(valuesOf(resolveVariables([row('K', 'older'), row('K', '')], WF, ['K']))).toEqual({ K: 'older' })
    expect(valuesOf(resolveVariables([row('K', 'org'), own('K', '')], WF, ['K']))).toEqual({ K: 'org' })
    expect(valuesOf(resolveVariables([row('K', 'org'), own('K', null)], WF, ['K']))).toEqual({ K: 'org' })
    expect(resolveVariables([row('K', '')], WF, ['K']).size).toBe(0)
  })

  it('never reaches a row saved for another workflow', () => {
    expect(resolveVariables([own('K', 'theirs', { workflow_id: OTHER_WF })], WF, ['K']).size).toBe(0)
    expect(valuesOf(resolveVariables([row('K', 'org'), own('K', 'theirs', { workflow_id: OTHER_WF })], WF, ['K']))).toEqual({ K: 'org' })
  })

  it('never reaches a workflow\'s own row of an organization only key, nor a workflow row naming no workflow', () => {
    const rows = [row('SALESFORCE_CLIENT_ID', 'org'), own('SALESFORCE_CLIENT_ID', 'mine'), own('K', 'nobody\'s', { workflow_id: null })]
    expect(valuesOf(resolveVariables(rows, WF, ['SALESFORCE_CLIENT_ID', 'K']))).toEqual({ SALESFORCE_CLIENT_ID: 'org' })
  })

  it('answers with the winning row itself, so a caller can tell a secret from a plain value', () => {
    const rows = [row('K', 'org'), own('K', 'ciphertext', { is_secret: true })]
    expect(resolveVariables(rows, WF, ['K']).get('K')).toEqual(own('K', 'ciphertext', { is_secret: true }))
  })

  it('never resolves a name to something an object inherits', () => {
    expect(resolveVariables([row('A', 'a')], WF, ['constructor', 'toString', '__proto__']).size).toBe(0)
  })
})
