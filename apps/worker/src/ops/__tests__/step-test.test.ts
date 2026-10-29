/**
 * The ops step test (#2339): one app_action step run for real through the
 * executor and the real connectionFetch, its result kept on ops (Dan's decision
 * of 2026-10-23: the ops database only, the latest per step, 7 days). Driven
 * with the sealed connection, the service and the ops database as doubles.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { resolveActionVersion } from '@bidspoke/service-catalogue/schema'
import { ActionFailure, implement, type ActionRun, type JsonValue, type RuntimeAction } from '@bidspoke/service-catalogue/runtime'
import type { TestStepRequest } from '../../lib/ops-connections-contract'
import type { OpsVersionVariables } from '../../lib/ops-gateway-contract'
import { ACCESS_TOKEN, CONN, LOGIN_SECRET, ORG, exampleRules, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from '../connections/__tests__/harness'
import type { RunStepContext, StepTestRecord, StoredStepTest } from '../ops-writes'
import { STEP_TEST_OUTPUT_MAX_BYTES, STEP_TEST_REQUESTS_MAX_BYTES, readStepTest, runStepTest, type StepTestDeps } from '../step-test'

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys)
}, 120_000)

const WF = '00000000-0000-4000-8000-0000000019a1'
const DAN = '00000000-0000-4000-8000-0000000023d1'
const SOMEONE_ELSE = '00000000-0000-4000-8000-0000000023d2'

const schema = (key: string, over: Partial<RuntimeAction> = {}) => ({
  key, name: key, version: 1,
  arguments: [{ key: 'text', type: 'text' as const, required: true, allowsVariables: true, parseJson: false }],
  sideEffect: true, idempotent: false, idempotentBecause: 'A test action.',
  ...over,
})

const post: ActionRun = async (ctx, args) => {
  const host = (ctx.target as { host: string }).host
  const res = await ctx.fetch(`https://${host}/post`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
  if (res.status >= 400) throw new ActionFailure('example_refused', `the service answered ${res.status}: ${await res.text()}`, 'not_applied')
  return (await res.json()) as JsonValue
}

const read: ActionRun = async (ctx) => {
  const host = (ctx.target as { host: string }).host
  const res = await ctx.fetch(`https://${host}/files?q=${encodeURIComponent('x')}`)
  return (await res.json()) as JsonValue
}

const ACTIONS: RuntimeAction[] = [
  implement(schema('example.post'), post),
  implement(schema('example.list', { sideEffect: false, idempotent: true, idempotentBecause: 'A read.' }), read),
]

const request = (over: Partial<TestStepRequest> = {}, config: Record<string, unknown> = {}): TestStepRequest => ({
  organization_id: ORG,
  workflow_id: WF,
  tested_by: DAN,
  node: { id: 'node_1', namespace: 'notify', config: { service: 'example', action: 'example.post', actionVersion: 1, connection: CONN, args: { text: 'Hello {{trigger.payload.name}} from {{steps.earlier.output.who}}' }, boundBy: DAN, ...config } },
  execution_id: null,
  trigger_payload: { name: 'Ada' },
  steps: { earlier: { output: { who: 'ops' }, status: 'completed' } },
  confirm_send: true,
  version: null,
  variables: null,
  ...over,
})

interface World {
  d: Doubles
  kept: Array<{ organizationId: string; workflowId: string; result: StepTestRecord }>
  deps: StepTestDeps
}

function world(over: Partial<StepTestDeps> = {}): World {
  const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
  const kept: World['kept'] = []
  let clock = Date.parse('2026-10-23T14:00:00.000Z')
  const deps: StepTestDeps = {
    appAction: { connection: () => d.deps, resolveAction: (key, version) => resolveActionVersion(ACTIONS, key, version), sleep: async () => undefined },
    record: async (organizationId, workflowId, result) => {
      kept.push({ organizationId, workflowId, result })
      return '2026-10-23T14:00:01.000Z'
    },
    read: async () => null,
    readRun: async () => null,
    now: () => (clock += 25),
    newRunId: () => '0192f4a0-0000-7000-8000-0000000000aa',
    ...over,
  }
  return { d, kept, deps }
}

describe('testing an app_action step on ops', () => {
  it('runs the step for real with its context, keeps the latest result with the requests it made, and answers it', async () => {
    const w = world()
    w.d.respond(Response.json({ id: 42, files: [{ name: 'a.csv' }] }))
    const answer = await runStepTest(w.deps, request(), new AbortController().signal)
    expect(w.d.rec.sent.map((s) => s.url)).toEqual(['https://api.example.test/post'])
    expect(JSON.parse(String(w.d.rec.sent[0].init.body))).toEqual({ text: 'Hello Ada from ops' })
    expect(answer).toMatchObject({
      ok: true, recorded: true,
      result: { node_id: 'node_1', namespace: 'notify', tested_by: DAN, tested_at: '2026-10-23T14:00:01.000Z', status: 'completed', output: { id: 42, files: [{ name: 'a.csv' }] }, error: null },
    })
    expect(w.kept).toHaveLength(1)
    expect(w.kept[0]).toMatchObject({ organizationId: ORG, workflowId: WF, result: { nodeId: 'node_1', namespace: 'notify', testedBy: DAN, status: 'completed' } })
    expect(w.kept[0].result.requests).toMatchObject([{ method: 'POST', url: 'https://api.example.test/post', attempt: 1 }])
    expect(w.kept[0].result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('refuses a step that changes something in the service unless the person confirmed the real send, sending and keeping nothing', async () => {
    const w = world()
    const answer = await runStepTest(w.deps, request({ confirm_send: false }), new AbortController().signal)
    expect(answer).toMatchObject({ ok: false, refused: 'step_test_send_unconfirmed', detail: expect.stringContaining('example.post') })
    expect(w.d.rec.sent).toEqual([])
    expect(w.kept).toEqual([])
  })

  it('runs a read without asking, since it changes nothing', async () => {
    const w = world()
    w.d.respond(Response.json({ files: [] }))
    const answer = await runStepTest(w.deps, request({ confirm_send: false }, { action: 'example.list', args: { text: 'x' } }), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'completed', output: { files: [] } } })
    expect(w.d.rec.sent).toHaveLength(1)
  })

  it('keeps a failure as the latest result, naming its code, with the requests it made', async () => {
    const w = world()
    w.d.respond(new Response('no such channel', { status: 404 }))
    const answer = await runStepTest(w.deps, request(), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'failed', output: null, error: expect.stringContaining('example_refused') } })
    expect(w.kept[0].result).toMatchObject({ status: 'failed', error: expect.stringContaining('example_refused') })
    expect(w.kept[0].result.requests).toHaveLength(1)
  })

  it('keeps a step refused before sending (settings that do not fit) as a failed test, naming why', async () => {
    const w = world()
    const answer = await runStepTest(w.deps, request({}, { connection: 'trypennie' }), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'failed', error: expect.stringContaining('connection_id_invalid') } })
    expect(w.d.rec.sent).toEqual([])
  })

  it('a person\'s own account is tested only by its owner: the boundBy rule the runs use', async () => {
    const own = { host: 'api.example.test', own_account: true }
    const owner = world()
    owner.d.setCopy(usableCopy(envelope, { target: own, ownerUserId: DAN }))
    owner.d.respond(Response.json({ id: 1 }))
    expect(await runStepTest(owner.deps, request(), new AbortController().signal)).toMatchObject({ ok: true, result: { status: 'completed' } })

    const other = world()
    other.d.setCopy(usableCopy(envelope, { target: own, ownerUserId: SOMEONE_ELSE }))
    expect(await runStepTest(other.deps, request(), new AbortController().signal))
      .toMatchObject({ ok: true, result: { status: 'failed', error: expect.stringContaining('own_account_not_owner') } })
    expect(other.d.rec.sent).toEqual([])
  })

  it('a service that echoes the login back hands it to neither the kept result nor the answer', async () => {
    const echo = `Bearer ${ACCESS_TOKEN} for ${LOGIN_SECRET}`
    for (const respond of [() => Response.json({ id: 42, echo }), () => new Response(`refused: ${echo}`, { status: 422 })]) {
      const w = world()
      w.d.respond(respond())
      const answer = await runStepTest(w.deps, request(), new AbortController().signal)
      // The login was really applied to the request.
      expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toContain(ACCESS_TOKEN)
      for (const text of [JSON.stringify(answer), JSON.stringify(w.kept)]) {
        expect(text).not.toContain(ACCESS_TOKEN)
        expect(text).not.toContain(LOGIN_SECRET)
      }
    }
  })

  it(`keeps an answer over ${STEP_TEST_OUTPUT_MAX_BYTES} bytes by its size alone, so it is named rather than read as empty`, async () => {
    const w = world()
    w.d.respond(Response.json({ big: 'x'.repeat(STEP_TEST_OUTPUT_MAX_BYTES) }))
    const answer = await runStepTest(w.deps, request(), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'completed', output: null, output_bytes: expect.any(Number) } })
    expect(w.kept[0].result.output).toBeNull()
    expect(w.kept[0].result.outputBytes).toBeGreaterThan(STEP_TEST_OUTPUT_MAX_BYTES)
  })

  it(`keeps at most ${STEP_TEST_REQUESTS_MAX_BYTES} bytes of requests, saying how many it left out`, async () => {
    const many: ActionRun = async (ctx) => {
      for (let i = 0; i < 40; i++) await ctx.fetch(`https://api.example.test/rows/${i}`, { method: 'POST', body: 'y'.repeat(3000) })
      return { ok: true }
    }
    const w = world({ appAction: { connection: () => w.d.deps, resolveAction: (key, version) => resolveActionVersion([implement(schema('example.post'), many)], key, version), sleep: async () => undefined } })
    for (let i = 0; i < 40; i++) w.d.respond(Response.json({ ok: true }))
    await runStepTest(w.deps, request(), new AbortController().signal)
    const requests = w.kept[0].result.requests
    expect(new TextEncoder().encode(JSON.stringify(requests)).length).toBeLessThanOrEqual(STEP_TEST_REQUESTS_MAX_BYTES)
    expect(requests.at(-1)).toMatchObject({ omitted: expect.any(Number) })
    const shown = requests.length - 1
    expect((requests.at(-1) as { omitted: number }).omitted).toBe(40 - shown)
  })

  /**
   * What record_step_test stores for a kept record (supabase-ops, #2339): the
   * output as given, and its size as given when the output is null, measured
   * by the database otherwise (here by the Worker's measure, which these tests
   * never compare for a kept answer).
   */
  const storedAs = (record: StepTestRecord): StoredStepTest => ({
    ...record,
    testedAt: '2026-10-23T14:00:01.000Z',
    outputBytes: record.output === null ? record.outputBytes : new TextEncoder().encode(JSON.stringify(record.output)).length,
  })

  /** The answer's three size fields now, and as read back from what was kept (#2773). */
  async function nowAndReadBack(body: unknown) {
    const w = world()
    w.d.respond(Response.json(body))
    const answer = await runStepTest(w.deps, request(), new AbortController().signal)
    if (!answer.ok) throw new Error(`the test was refused: ${answer.refused}`)
    const stored = storedAs(w.kept[0].result)
    const read = await readStepTest(world({ read: async () => stored }).deps, { organization_id: ORG, workflow_id: WF, node_id: 'node_1' })
    if (!read.ok || read.result === null) throw new Error('the kept result was not read back')
    const pick = (r: { output: unknown; output_bytes: number | null; output_dropped: boolean }) => ({ output: r.output, output_bytes: r.output_bytes, output_dropped: r.output_dropped })
    return { now: pick(answer.result), readBack: pick(read.result), kept: w.kept[0].result }
  }

  it('an action that answered nothing has its own shape, never an answer dropped for size, the same now and read back', async () => {
    const { now, readBack, kept } = await nowAndReadBack(null)
    expect(kept).toMatchObject({ status: 'completed', output: null, outputBytes: null })
    expect(now).toEqual({ output: null, output_bytes: null, output_dropped: false })
    expect(readBack).toEqual(now)
  })

  it('an answer dropped for size says so and how big it was, the same now and read back', async () => {
    const { now, readBack } = await nowAndReadBack({ big: 'x'.repeat(STEP_TEST_OUTPUT_MAX_BYTES) })
    expect(now).toEqual({ output: null, output_bytes: expect.any(Number), output_dropped: true })
    expect(now.output_bytes).toBeGreaterThan(STEP_TEST_OUTPUT_MAX_BYTES)
    expect(readBack).toEqual(now)
  })

  it('a kept answer is not dropped, now or read back', async () => {
    const { now, readBack } = await nowAndReadBack({ id: 7 })
    expect(now).toMatchObject({ output: { id: 7 }, output_dropped: false })
    expect(readBack).toMatchObject({ output: { id: 7 }, output_dropped: false })
  })

  it('answers the result even when it could not be kept, saying so', async () => {
    const w = world({ record: async () => { throw new Error('canceling statement due to statement timeout') } })
    w.d.respond(Response.json({ id: 1 }))
    const answer = await runStepTest(w.deps, request(), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, recorded: false, result: { status: 'completed', output: { id: 1 } } })
  })
})

// Testing a step with a past run's data (#2339), from the run's recorded steps (#2703).
describe('testing a step with a past run\'s data', () => {
  const EXEC = '0192f4a0-0000-7000-8000-0000000000e1'
  const fromRun = (over: Partial<TestStepRequest> = {}, config: Record<string, unknown> = {}) =>
    request({ execution_id: EXEC, trigger_payload: undefined, steps: {}, ...over }, config)
  const context = (over: Partial<RunStepContext> = {}): RunStepContext => ({
    executionStatus: 'failed', startedAt: '2026-10-23T09:00:00.000Z', withinRetention: true, reached: true, payload: { name: 'Grace' },
    payloadElsewhere: false, contextBytes: 20,
    steps: [{ namespace: 'shape', nodeId: 'n0', seq: 0, output: { n: 1 }, outputKept: true }, { namespace: 'earlier', nodeId: 'n1', seq: 1, output: { who: 'the run' }, outputKept: true }],
    ...over,
  })

  it('builds the step\'s context from that run\'s payload and recorded outputs, within the organization, and runs it as any test', async () => {
    const asked: unknown[] = []
    const w = world({ readRun: async (...args) => { asked.push(args); return context() } })
    w.d.respond(Response.json({ id: 9 }))
    const answer = await runStepTest(w.deps, fromRun(), new AbortController().signal)
    expect(asked).toEqual([[ORG, WF, EXEC, 'node_1']])
    expect(JSON.parse(String(w.d.rec.sent[0].init.body))).toEqual({ text: 'Hello Grace from the run' })
    expect(answer).toMatchObject({ ok: true, recorded: true, result: { status: 'completed', output: { id: 9 } } })
    expect(w.kept).toHaveLength(1)
  })

  it('a payload or a step given with the run replaces the run\'s', async () => {
    const w = world({ readRun: async () => context() })
    w.d.respond(Response.json({ id: 9 }))
    await runStepTest(w.deps, fromRun({ trigger_payload: { name: 'Ada' }, steps: { earlier: { output: { who: 'me' }, status: 'completed' } } }), new AbortController().signal)
    expect(JSON.parse(String(w.d.rec.sent[0].init.body))).toEqual({ text: 'Hello Ada from me' })
  })

  it('still asks before a step that changes something sends for real', async () => {
    const w = world({ readRun: async () => context() })
    expect(await runStepTest(w.deps, fromRun({ confirm_send: false }), new AbortController().signal)).toMatchObject({ ok: false, refused: 'step_test_send_unconfirmed' })
    expect(w.d.rec.sent).toEqual([])
  })

  it('refuses by name, sending and keeping nothing, a run it cannot rebuild the step\'s whole context from', async () => {
    const cases: Array<[StepTestDeps['readRun'], string, RegExp]> = [
      [async () => null, 'step_test_run_not_found', /no such run/],
      [async () => context({ withinRetention: false, payload: null, steps: null, contextBytes: null }), 'step_test_run_records_gone', /7 days/],
      // Never reached the step, and the step reads a step the run did not record.
      [async () => context({ reached: false, steps: [{ namespace: 'shape', nodeId: 'n0', seq: 0, output: {}, outputKept: true }] }), 'step_test_run_steps_missing', /earlier/],
      // The step it reads was recorded by its size alone.
      [async () => context({ steps: [{ namespace: 'earlier', nodeId: 'n1', seq: 0, output: null, outputKept: false }] }), 'step_test_run_output_not_kept', /earlier/],
      // The outputs together are more than a test takes.
      [async () => context({ steps: null, contextBytes: 900_000 }), 'step_test_run_output_not_kept', /900000/],
      [async () => context({ payload: null, payloadElsewhere: true }), 'step_test_run_payload_not_held', /payload/],
      [async () => { throw new Error('canceling statement due to statement timeout') }, 'step_test_run_unavailable', /could not be read/],
    ]
    for (const [readRun, refused, detail] of cases) {
      const w = world({ readRun })
      const answer = await runStepTest(w.deps, fromRun(), new AbortController().signal)
      expect(answer, refused).toMatchObject({ ok: false, refused, detail: expect.stringMatching(detail), retry_at: null })
      expect(w.d.rec.sent, refused).toEqual([])
      expect(w.kept, refused).toEqual([])
    }
  })

  it('takes the payload given beside a run whose own payload is held elsewhere, and a step given for one the run did not record', async () => {
    const w = world({ readRun: async () => context({ reached: false, payload: null, payloadElsewhere: true, steps: [] }) })
    w.d.respond(Response.json({ id: 1 }))
    const answer = await runStepTest(w.deps, fromRun({ trigger_payload: { name: 'Ada' }, steps: { earlier: { output: { who: 'me' }, status: 'completed' } } }), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'completed' } })
  })

  it('a step the run reached runs on the context the run had there, even where a step it reads did not run on that path', async () => {
    // The run reached node_1 without "earlier" (another branch): the test reproduces what the run saw.
    const w = world({ readRun: async () => context({ reached: true, steps: [{ namespace: 'shape', nodeId: 'n0', seq: 0, output: {}, outputKept: true }] }) })
    w.d.respond(Response.json({ id: 3 }))
    const answer = await runStepTest(w.deps, fromRun(), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'completed' } })
    // What the run itself sent at this step: the text with nothing where "earlier" would be.
    expect(JSON.parse(String(w.d.rec.sent[0].init.body))).toEqual({ text: 'Hello Grace from ' })
  })

  it('a step that reads its steps by a name worked out as it runs is refused unless the run reached it', async () => {
    const dynamic = { args: { text: '{{steps[trigger.payload.which].output.who}}' } }
    const notReached = world({ readRun: async () => context({ reached: false }) })
    expect(await runStepTest(notReached.deps, fromRun({}, dynamic), new AbortController().signal))
      .toMatchObject({ ok: false, refused: 'step_test_run_steps_missing', detail: expect.stringMatching(/worked out as it runs/) })
    const reached = world({ readRun: async () => context({ reached: true }) })
    reached.d.respond(Response.json({ id: 1 }))
    expect(await runStepTest(reached.deps, fromRun({}, dynamic), new AbortController().signal)).toMatchObject({ ok: true })
  })
})

describe('reading a step\'s kept test result', () => {
  const stored: StoredStepTest = {
    nodeId: 'node_1', namespace: 'notify', testedBy: DAN, testedAt: '2026-10-22T10:00:00.000Z', status: 'completed',
    output: { id: 1 }, outputBytes: 8, error: null, requests: [], durationMs: 120,
  }

  it('answers the organization\'s result for the step, or null once there is none under 7 days old', async () => {
    const asked: unknown[] = []
    const w = world({ read: async (...args) => { asked.push(args); return stored } })
    expect(await readStepTest(w.deps, { organization_id: ORG, workflow_id: WF, node_id: 'node_1' })).toEqual({
      ok: true,
      result: { node_id: 'node_1', namespace: 'notify', tested_by: DAN, tested_at: '2026-10-22T10:00:00.000Z', status: 'completed', output: { id: 1 }, output_bytes: 8, output_dropped: false, error: null, requests: [], duration_ms: 120 },
    })
    expect(asked).toEqual([[ORG, WF, 'node_1']])
    expect(await readStepTest(world().deps, { organization_id: ORG, workflow_id: WF, node_id: 'node_1' })).toEqual({ ok: true, result: null })
  })

  it('a read that fails is refused by name, never answered as no result', async () => {
    const w = world({ read: async () => { throw new Error('connection refused') } })
    expect(await readStepTest(w.deps, { organization_id: ORG, workflow_id: WF, node_id: 'node_1' })).toMatchObject({ ok: false, refused: 'step_test_unavailable' })
  })
})

// #2702: a step test follows the run's rule. It is given the plain values the
// workflow's newest saved version kept, which the bidding Worker sends with the
// request, and is refused by name, before anything is sent or kept, when the
// step reads a secret variable or one that version did not keep.
describe('a step test\'s environment variables (#2702)', () => {
  const readsEnv = { args: { text: 'Post to {{env.API_BASE}} as {{ env.TEAM }}' } }
  const version = (variables: OpsVersionVariables | null, number = 7) => ({ number, variables })

  it('sends the step with the values the newest saved version kept', async () => {
    const w = world()
    w.d.respond(Response.json({ ok: true }))
    const answer = await runStepTest(w.deps, request({ version: version({ values: { API_BASE: 'https://hooks.example.test', TEAM: 'ops' }, secretKeys: [] }) }, readsEnv), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'completed' } })
    expect(JSON.parse(String(w.d.rec.sent[0].init.body))).toEqual({ text: 'Post to https://hooks.example.test as ops' })
  })

  it('refuses a step reading a secret variable by name, sending and keeping nothing', async () => {
    const w = world()
    const answer = await runStepTest(w.deps, request({ version: version({ values: { TEAM: 'ops' }, secretKeys: ['API_BASE'] }) }, readsEnv), new AbortController().signal)
    expect(answer).toEqual({
      ok: false, refused: 'step_test_variable_unavailable', retry_at: null,
      detail: 'this step reads the secret variable env.API_BASE, and an ops step is never given a secret: a credential belongs in a connection, so nothing was sent',
    })
    expect(w.d.rec.sent).toEqual([])
    expect(w.kept).toEqual([])
  })

  it('refuses a step reading a variable the newest saved version did not keep, naming it and the version', async () => {
    const w = world()
    const answer = await runStepTest(w.deps, request({ version: version({ values: { API_BASE: 'a' }, secretKeys: [] }) }, readsEnv), new AbortController().signal)
    expect(answer).toMatchObject({
      ok: false, refused: 'step_test_variable_unavailable',
      detail: 'this step reads env.TEAM, which was not a variable of this workflow when version 7 was saved, so nothing was sent; add it, save the workflow and test again',
    })
    expect(w.d.rec.sent).toEqual([])
  })

  it('refuses a step reading any variable when no saved version kept their values, never sending a blank', async () => {
    for (const [given, said] of [
      [version(null), 'this step reads env.API_BASE, env.TEAM, and version 7 of the workflow was saved before ops kept the values of its variables with it, so nothing was sent; save the workflow and test again'],
      [null, 'this step reads env.API_BASE, env.TEAM, and no saved version of the workflow kept the values of its variables, so nothing was sent; save the workflow and test again'],
    ] as const) {
      const w = world()
      expect(await runStepTest(w.deps, request({ version: given }, readsEnv), new AbortController().signal)).toMatchObject({ ok: false, refused: 'step_test_variable_unavailable', detail: said })
      expect(w.d.rec.sent).toEqual([])
    }
  })

  it('a step reading no variable runs whatever was kept', async () => {
    const w = world()
    w.d.respond(Response.json({ id: 1 }))
    expect(await runStepTest(w.deps, request({ version: null }), new AbortController().signal)).toMatchObject({ ok: true })
  })
})

// #3002 (phase 6 of #2982): bidding sends the CURRENT values of the variables
// the step reads, secrets decrypted (Dan, 2026-10-29: "Yes, ops reads secrets").
// The step is given them; a secret's value never reaches what ops keeps or logs,
// each replaced by the variable's name. A variable with no saved value is
// refused by name, before anything is sent or kept.
describe('a step test\'s current variables (#3002)', () => {
  const SECRET = 'fake-step-test-token-value'
  const readsSecret = { args: { text: 'Post to {{env.API_BASE}} with {{env.TOKEN}}' } }
  const current = { values: { API_BASE: 'https://hooks.example.test' }, secretValues: { TOKEN: SECRET } }

  /** Every line written to the console while fn runs, as one string. */
  async function logged(fn: () => Promise<unknown>): Promise<string> {
    const lines: unknown[] = []
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args) }))
    try {
      await fn()
    } finally {
      for (const s of spies) s.mockRestore()
    }
    return JSON.stringify(lines)
  }

  it('gives the step the current values bidding sent, a secret decrypted among them', async () => {
    const w = world()
    w.d.respond(Response.json({ ok: true }))
    const answer = await runStepTest(w.deps, request({ variables: current }, readsSecret), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'completed' } })
    expect(JSON.parse(String(w.d.rec.sent[0].init.body))).toEqual({ text: `Post to https://hooks.example.test with ${SECRET}` })
  })

  it('reads the current values over any saved version a bidding Worker also names', async () => {
    const w = world()
    w.d.respond(Response.json({ ok: true }))
    const saved = { number: 7, variables: { values: { API_BASE: 'https://old.example.test' }, secretKeys: ['TOKEN'] } }
    await runStepTest(w.deps, request({ variables: current, version: saved }, readsSecret), new AbortController().signal)
    expect(JSON.parse(String(w.d.rec.sent[0].init.body))).toEqual({ text: `Post to https://hooks.example.test with ${SECRET}` })
  })

  it('refuses by name a variable with no saved value, sending and keeping nothing', async () => {
    const w = world()
    const answer = await runStepTest(w.deps, request({ variables: { values: { API_BASE: 'a' }, secretValues: {} } }, readsSecret), new AbortController().signal)
    expect(answer).toEqual({
      ok: false, refused: 'step_test_variable_unavailable', retry_at: null,
      detail: 'this step reads env.TOKEN, which has no saved value for this workflow, so nothing was sent; add it on the environment variables page and test again',
    })
    expect(w.d.rec.sent).toEqual([])
    expect(w.kept).toEqual([])
  })

  it('keeps and answers the result with each secret value replaced by its name, and logs none, when the service echoes it', async () => {
    const responses = [() => Response.json({ id: 42, echo: `got ${SECRET}` }), () => new Response(`refused: ${SECRET}`, { status: 422 })]
    const records = [undefined, async () => { throw new Error(`the write failed holding ${SECRET}`) }]
    for (const respond of responses) {
      for (const record of records) {
        const w = world(record === undefined ? {} : { record })
        w.d.respond(respond())
        let answer: unknown
        const lines = await logged(async () => { answer = await runStepTest(w.deps, request({ variables: current }, readsSecret), new AbortController().signal) })
        // The secret really reached the service.
        expect(String(w.d.rec.sent[0].init.body)).toContain(SECRET)
        expect(JSON.stringify(answer)).not.toContain(SECRET)
        expect(JSON.stringify(answer)).toContain('TOKEN')
        expect(JSON.stringify(w.kept)).not.toContain(SECRET)
        expect(lines).not.toContain(SECRET)
      }
    }
  })

  it('keeps the requests the step made with the secret replaced by its name', async () => {
    const w = world()
    w.d.respond(Response.json({ ok: true }))
    await runStepTest(w.deps, request({ variables: current }, readsSecret), new AbortController().signal)
    expect(JSON.stringify(w.kept)).not.toContain(SECRET)
    expect(JSON.stringify(w.kept[0].result.requests)).toContain('with TOKEN')
  })
})
