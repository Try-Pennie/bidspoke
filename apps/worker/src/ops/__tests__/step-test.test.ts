/**
 * The ops step test (#2339): one app_action step run for real through the
 * executor and the real connectionFetch, its result kept on ops (Dan's decision
 * of 2026-10-23: the ops database only, the latest per step, 7 days). Driven
 * with the sealed connection, the service and the ops database as doubles.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { resolveActionVersion } from '@bidspoke/service-catalogue/schema'
import { ActionFailure, implement, type ActionRun, type JsonValue, type RuntimeAction } from '@bidspoke/service-catalogue/runtime'
import type { TestStepRequest } from '../../lib/ops-connections-contract'
import { ACCESS_TOKEN, CONN, LOGIN_SECRET, ORG, exampleRules, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from '../connections/__tests__/harness'
import type { StepTestRecord, StoredStepTest } from '../ops-writes'
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
  trigger_payload: { name: 'Ada' },
  steps: { earlier: { output: { who: 'ops' }, status: 'completed' } },
  confirm_send: true,
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

  it('keeps a plain null answer as null, never as an answer over the cap', async () => {
    const w = world()
    w.d.respond(Response.json(null))
    const answer = await runStepTest(w.deps, request(), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, result: { status: 'completed', output: null, output_bytes: 4 } })
    expect(w.kept[0].result).toMatchObject({ output: null, outputBytes: null })
  })

  it('answers the result even when it could not be kept, saying so', async () => {
    const w = world({ record: async () => { throw new Error('canceling statement due to statement timeout') } })
    w.d.respond(Response.json({ id: 1 }))
    const answer = await runStepTest(w.deps, request(), new AbortController().signal)
    expect(answer).toMatchObject({ ok: true, recorded: false, result: { status: 'completed', output: { id: 1 } } })
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
      result: { node_id: 'node_1', namespace: 'notify', tested_by: DAN, tested_at: '2026-10-22T10:00:00.000Z', status: 'completed', output: { id: 1 }, output_bytes: 8, error: null, requests: [], duration_ms: 120 },
    })
    expect(asked).toEqual([[ORG, WF, 'node_1']])
    expect(await readStepTest(world().deps, { organization_id: ORG, workflow_id: WF, node_id: 'node_1' })).toEqual({ ok: true, result: null })
  })

  it('a read that fails is refused by name, never answered as no result', async () => {
    const w = world({ read: async () => { throw new Error('connection refused') } })
    expect(await readStepTest(w.deps, { organization_id: ORG, workflow_id: WF, node_id: 'node_1' })).toMatchObject({ ok: false, refused: 'step_test_unavailable' })
  })
})
