import { describe, expect, it } from 'vitest'
import { blockingProblems, unfinishedAppActionSteps, validateDefinition, type DefinitionProblem, type DefinitionVerdict } from '../index'

/**
 * An app_action step at save (#2339): one catalogue action, at the version the
 * step pinned, through the connection it names by id, its arguments checked
 * against that version's schema. Ops only. A half built step saves as a draft;
 * a step naming a version the catalogue does not have, or arguments that version
 * would refuse, is refused on every save, by name.
 */

const CONNECTION = '33333333-3333-4333-8333-333333333333'
const trigger = { type: 'schedule', config: { cron: '0 13 * * *', timezone: 'America/New_York' } }
const step = (config: Record<string, unknown>) => ({ id: 'post', type: 'app_action', namespace: 'post', config })
const def = (config: Record<string, unknown>, extra: Array<{ id: string; type: string; namespace: string; config: Record<string, unknown> }> = []) => ({
  trigger,
  nodes: [step(config), ...extra],
  edges: [{ source: 'trigger', target: 'post' }, ...extra.map((n) => ({ source: 'post', target: n.id }))],
})
const SLACK = { service: 'slack', action: 'slack.send-message', actionVersion: 1, connection: CONNECTION, args: { channel: 'C0OPS', text: 'Hello {{trigger.payload.name}}' } }

function problems(verdict: DefinitionVerdict): DefinitionProblem[] {
  if (verdict.kind !== 'judged') throw new Error(`expected a judged verdict, got ${verdict.kind}`)
  return verdict.problems
}
const ofStep = (p: DefinitionProblem[]) => p.filter((x) => x.namespace === 'post' || x.nodeId === 'post')

describe('an app_action step on the ops lane', () => {
  it('a step whose action, version, connection and arguments fit the catalogue saves with no problem', () => {
    expect(ofStep(problems(validateDefinition(def(SLACK), { lane: 'ops' })))).toEqual([])
  })

  it('a half built step saves as a draft, and a live save names what it lacks, in the setup order', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, 'No service and action chosen'],
      [{ service: 'slack', action: 'slack.send-message' }, 'No version of slack.send-message pinned'],
      [{ ...SLACK, connection: undefined }, 'No connection chosen'],
      [{ ...SLACK, args: { channel: 'C0OPS' } }, 'text is required'],
    ]
    for (const [config, message] of cases) {
      const p = ofStep(problems(validateDefinition(def(config), { lane: 'ops' })))
      expect(blockingProblems(p, { live: false }), message).toEqual([])
      expect(blockingProblems(p, { live: true }).map((x) => x.message), message).toContain(message)
    }
  })

  it('refuses on every save, by name, a version the catalogue does not have, never saving it on the newest', () => {
    const p = ofStep(problems(validateDefinition(def({ ...SLACK, actionVersion: 9 }), { lane: 'ops' })))
    expect(blockingProblems(p, { live: false })).toMatchObject([{ rule: 'app_action', reason: 'action_version_missing' }])
    const unknown = ofStep(problems(validateDefinition(def({ ...SLACK, action: 'slack.post-shout' }), { lane: 'ops' })))
    expect(blockingProblems(unknown, { live: false })).toMatchObject([{ rule: 'app_action', reason: 'action_unknown' }])
  })

  it('refuses on every save arguments the pinned version would refuse, each by name', () => {
    const p = ofStep(problems(validateDefinition(def({ ...SLACK, args: { channel: 'C0OPS', text: 'hi', colour: 'red' } }), { lane: 'ops' })))
    expect(blockingProblems(p, { live: false })).toMatchObject([{ rule: 'app_action', reason: 'argument_unknown' }])
  })

  it('refuses on every save a connection that is not a connection id, and an action of another service (L75)', () => {
    const notId = ofStep(problems(validateDefinition(def({ ...SLACK, connection: 'trypennie' }), { lane: 'ops' })))
    expect(blockingProblems(notId, { live: false })).toMatchObject([{ rule: 'app_action', reason: 'connection_id_invalid' }])
    const other = ofStep(problems(validateDefinition(def({ ...SLACK, service: 'snowflake' }), { lane: 'ops' })))
    expect(blockingProblems(other, { live: false })).toMatchObject([{ rule: 'app_action', reason: 'action_service_mismatch' }])
  })
})

describe('the money lane', () => {
  it('refuses an app_action step on every save, twice over: its type is ops only, and so is the connection it is bound to', () => {
    const p = ofStep(problems(validateDefinition({ ...def(SLACK), trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } } }, { lane: 'money' })))
    expect(blockingProblems(p, { live: false }).map((x) => [x.rule, x.reason])).toEqual([['node_lane', 'node_not_on_lane'], ['connection_lane', 'connection_on_money_lane']])
  })

  it('refuses, as a second check, a webhook step bound to a connection: a connection is an ops login', () => {
    const money = {
      trigger: { type: 'http_webhook', config: { method: 'POST', auth_method: 'api_key' } },
      nodes: [{ id: 'call', type: 'webhook', namespace: 'call', config: { url: 'https://api.example.com', connection: CONNECTION } }],
      edges: [{ source: 'trigger', target: 'call' }],
    }
    const p = problems(validateDefinition(money, { lane: 'money' }))
    expect(blockingProblems(p, { live: false })).toMatchObject([{ rule: 'connection_lane', reason: 'connection_on_money_lane', namespace: 'call' }])
    const unbound = { ...money, nodes: [{ ...money.nodes[0], config: { url: 'https://api.example.com' } }] }
    expect(problems(validateDefinition(unbound, { lane: 'money' })).filter((x) => x.rule === 'connection_lane')).toEqual([])
  })
})

describe('unfinishedAppActionSteps (#2338, plan 3.3): what keeps a workflow from being switched on', () => {
  it('names each App Action step that lacks what it runs, its connection or a required field, from the rules at the stamp', () => {
    const verdict = unfinishedAppActionSteps(def({ ...SLACK, connection: undefined }), { lane: 'ops', schemaVersion: 1 })
    expect(verdict).toEqual({ kind: 'judged', steps: [{ nodeId: 'post', namespace: 'post', message: expect.stringContaining('No connection chosen') }] })
    expect(unfinishedAppActionSteps(def({ ...SLACK, args: { channel: 'C0OPS' } }), { lane: 'ops' })).toMatchObject({ steps: [{ message: expect.stringContaining('text is required') }] })
    expect(unfinishedAppActionSteps(def({}), { lane: 'ops' })).toMatchObject({ steps: [{ message: expect.stringContaining('No service and action chosen') }] })
  })

  it('a finished step, and every other step type, is not named', () => {
    expect(unfinishedAppActionSteps(def(SLACK, [{ id: 'f', type: 'filter', namespace: 'f', config: {} }]), { lane: 'ops' })).toEqual({ kind: 'judged', steps: [] })
  })

  it('a stamp this build cannot judge is answered as such, never as finished', () => {
    expect(unfinishedAppActionSteps(def({}), { lane: 'ops', schemaVersion: 99 })).toMatchObject({ kind: 'unknown_schema_version' })
  })
})
