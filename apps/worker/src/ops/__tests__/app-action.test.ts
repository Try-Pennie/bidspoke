/**
 * The ops executor for app_action (#2339): one catalogue action, at the
 * version the step pinned, sent through the connection the step names, every
 * request through the run's ledgered send and connectionFetch. Driven here
 * through the real walk, the real invokeRun and the real connectionFetch, with
 * the ops database, the sealed connection and the service as doubles.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { resolveActionVersion } from '@bidspoke/service-catalogue/schema'
import { ActionFailure, implement, type ActionRun, type RuntimeAction } from '@bidspoke/service-catalogue/runtime'
import { appActionHandler, type AppActionDeps } from '../app-action'
import { ACCESS_TOKEN, CONN, LOGIN_SECRET, ORG, exampleRules, makeDoubles, makeKeys, sealLogin, usableCopy, type Doubles, type TestKeys } from '../connections/__tests__/harness'
import type { ClaimedRun, CompleteOutcome, SendIntent } from '../ops-writes'
import { invokeRun, stepRequestId, type RunBody, type RunDb, type RunInvocationReport } from '../run-invocation'
import { walkOpsDefinition } from '../run-walk'

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys)
}, 120_000)

const RUN: ClaimedRun = {
  runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: ORG,
  workflowId: '00000000-0000-4000-8000-0000000019a1', workflowVersion: 3, triggerKind: 'schedule', claimToken: 'token-1',
  claimExpiresAt: '2026-10-17T10:03:31.000Z', stateVersion: 2, attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
  executionChainId: '0192f4a0-0000-7000-9000-000000000001', resumedFromExecutionId: null, payload: { name: 'Ada', id: 7 }, payloadRef: null,
}

const schema = (key: string, version: number, over: Partial<RuntimeAction> = {}) => ({
  key, name: key, version,
  arguments: [
    { key: 'text', type: 'text' as const, required: true, allowsVariables: true, parseJson: false },
    { key: 'tags', type: 'list' as const, required: false, allowsVariables: true, parseJson: true },
  ],
  sideEffect: true, idempotent: false, idempotentBecause: 'A test action.',
  ...over,
})

/** Posts its text to the connection's host and returns the service's answer, as a catalogue action does. */
const post = (version: number): ActionRun => async (ctx, args) => {
  const host = (ctx.target as { host: string }).host
  const res = await ctx.fetch(`https://${host}/v${version}/post`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...args, request_id: ctx.requestId }) })
  // As the catalogue's actions do, a failure quotes what the service said.
  if (res.status >= 500) throw new ActionFailure('example_failed', `the service answered ${res.status}: ${await res.text()}`, 'unknown')
  if (res.status >= 400) throw new ActionFailure('example_refused', `the service answered ${res.status}: ${await res.text()}`, 'not_applied')
  return { version, answer: (await res.json()) as { id: number } }
}

const ACTIONS: RuntimeAction[] = [
  implement(schema('example.post', 1), post(1)),
  implement(schema('example.post', 2), post(2)),
  implement(schema('example.put', 1, { idempotent: true, idempotentBecause: 'The service keys the write on the request id.' }), post(1)),
]

const step = (over: Record<string, unknown> = {}, id = 'notify') => ({
  id, namespace: id, type: 'app_action',
  config: { service: 'example', action: 'example.post', actionVersion: 1, connection: CONN, args: { text: 'Hello {{trigger.payload.name}}', tags: '["{{trigger.payload.id}}", "ops"]' }, ...over },
})
const definition = (...nodes: Array<ReturnType<typeof step>>) => ({
  nodes,
  edges: nodes.map((n, i) => ({ id: `e${i}`, source: i === 0 ? 'trigger' : nodes[i - 1].id, target: n.id })),
})

/** The ops database as a run uses it: every call recorded. */
class FakeRunDb implements RunDb {
  intents: SendIntent[] = []
  results: unknown[] = []
  completes: CompleteOutcome[] = []
  async start() {
    return { outcome: 'started' as const, stateVersion: 3, attempt: 1 }
  }
  async extend() {
    return true
  }
  async recordIntent(_run: ClaimedRun, intent: Omit<SendIntent, 'runRequestId' | 'claimToken'>) {
    this.intents.push(intent as SendIntent)
    return { outcome: 'recorded' as const, ledgerId: `ledger-${this.intents.length}`, ledgerStatus: null }
  }
  async recordResult(_run: ClaimedRun, ledgerId: string, result: unknown) {
    this.results.push({ ledgerId, ...(result as object) })
    return 'recorded' as const
  }
  async complete(_run: ClaimedRun, end: CompleteOutcome) {
    this.completes.push(end)
    return { outcome: 'completed' as const, runStatus: end.outcome }
  }
}

const clock = {
  now: () => Date.parse('2026-10-17T10:02:31.000Z'),
  timer: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
}

interface World {
  d: Doubles
  db: FakeRunDb
  logs: unknown[]
  outputs: Record<string, unknown>
  run(def: unknown): Promise<RunInvocationReport>
}

function world(over: Partial<AppActionDeps> = {}): World {
  const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
  const db = new FakeRunDb()
  const logs: unknown[] = []
  const outputs: Record<string, unknown> = {}
  const deps: AppActionDeps = {
    connection: () => d.deps,
    resolveAction: (key, version) => resolveActionVersion(ACTIONS, key, version),
    sleep: async () => undefined,
    ...over,
  }
  const handler = appActionHandler(deps)
  return {
    d, db, logs, outputs,
    run: (def) => {
      const body: RunBody = (ctx) => walkOpsDefinition(def, ctx, {
        app_action: async (args) => {
          const r = await handler(args)
          outputs[args.node.namespace] = r.output
          return r
        },
      })
      return invokeRun({ db, clock, newExecutionId: () => '0192f4a0-0000-7000-8000-0000000000ee', log: (e) => { logs.push(e) } }, RUN, body)
    },
  }
}

const sentBody = (d: Doubles, i = 0) => JSON.parse(String(d.rec.sent[i].init.body)) as Record<string, unknown>

describe('app_action through the ledgered send and connectionFetch', () => {
  it('sends the pinned action with its arguments resolved, the connection\'s login applied, and records its answer as the step output', async () => {
    const w = world()
    w.d.respond(Response.json({ id: 42 }))
    const report = await w.run(definition(step()))
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'done' } })
    expect(w.d.rec.sent.map((s) => s.url)).toEqual(['https://api.example.test/v1/post'])
    expect(sentBody(w.d)).toMatchObject({ text: 'Hello Ada', tags: [7, 'ops'] })
    expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(w.outputs.notify).toEqual({ version: 1, answer: { id: 42 } })
    // The send went through the ledger, as a non idempotent POST to the declared host.
    expect(w.db.intents).toMatchObject([{ nodeId: 'notify', seq: 0, method: 'POST', host: 'api.example.test', idempotent: false }])
  })

  it('hands the action the step\'s stable request id, the attempt key of its first send, the same on every attempt', async () => {
    const expected = await stepRequestId(RUN.runRequestId, 'notify', 0)
    for (let attempt = 0; attempt < 2; attempt++) {
      const w = world()
      w.d.respond(Response.json({ id: 1 }))
      await w.run(definition(step()))
      expect(sentBody(w.d).request_id).toBe(expected)
      expect(w.db.intents[0].attemptKey).toBe(expected)
    }
  })

  it('a step pinned to version 1 still runs version 1 after version 2 is registered', async () => {
    const w = world()
    w.d.respond(Response.json({ id: 1 }))
    await w.run(definition(step({ actionVersion: 1 })))
    expect(w.d.rec.sent[0].url).toBe('https://api.example.test/v1/post')
    expect(w.outputs.notify).toMatchObject({ version: 1 })

    const v2 = world()
    v2.d.respond(Response.json({ id: 1 }))
    await v2.run(definition(step({ actionVersion: 2 })))
    expect(v2.d.rec.sent[0].url).toBe('https://api.example.test/v2/post')
  })

  it('refuses by name, before anything is sent, a version the catalogue no longer has', async () => {
    const w = world()
    const report = await w.run(definition(step({ actionVersion: 3 })))
    expect(report).toMatchObject({ end: { outcome: 'failed', error: expect.stringContaining('action_version_missing') } })
    expect(w.d.rec.sent).toEqual([])
    expect(w.db.intents).toEqual([])
  })

  it('refuses by name a step whose settings or arguments do not fit the pinned version, before anything is sent', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ connection: 'trypennie' }, 'connection_id_invalid'],
      [{ actionVersion: '1' }, 'action_version_not_pinned'],
      [{ args: { tags: '[]' } }, 'argument_missing'],
      [{ args: { text: 'x', colour: 'red' } }, 'argument_unknown'],
      [{ args: { text: '{{steps.nowhere.output.text}}' } }, 'argument_unresolved'],
    ]
    for (const [over, reason] of cases) {
      const w = world()
      const report = await w.run(definition(step(over)))
      expect(report, reason).toMatchObject({ end: { outcome: 'failed', error: expect.stringContaining(reason) } })
      expect(w.d.rec.sent).toEqual([])
    }
  })

  it('refuses a connection of another service than the step names, never sending through it (L75)', async () => {
    const w = world()
    w.d.setCopy(usableCopy(envelope, { service: 'slack' }))
    const report = await w.run(definition(step()))
    expect(report).toMatchObject({ end: { outcome: 'failed', error: expect.stringContaining('connection_service_mismatch') } })
    expect(w.d.rec.sent).toEqual([])
  })

  // Dan's decision on #2338 (2026-10-23): a person's own Google account may be
  // used only by its owner, so no workflow sends email as someone else. Ops
  // holds no record yet of who owns such a connection or who bound a step to it,
  // so the step is refused by name rather than run on a guess (L75).
  it('refuses a step bound to a person\'s own account connection by name, with nothing sent, while who bound it is unrecorded', async () => {
    const w = world()
    w.d.setCopy(usableCopy(envelope, { target: { own_account: true } }))
    const report = await w.run(definition(step()))
    expect(report).toMatchObject({ end: { outcome: 'failed', error: expect.stringContaining('own_account_binder_unrecorded') } })
    expect(w.d.rec.sent).toEqual([])
    expect(w.db.intents).toEqual([])
  })

  it('a company connection whose target only resembles an own account is not refused for it', async () => {
    const w = world()
    w.d.setCopy(usableCopy(envelope, { target: { host: 'api.example.test', own_account: 'true' } }))
    w.d.respond(Response.json({ id: 1 }))
    expect(await w.run(definition(step()))).toMatchObject({ end: { outcome: 'done' } })
  })

  it('a removed connection is refused by name before anything is sent or written to the ledger', async () => {
    const w = world()
    w.d.setCopy(usableCopy(envelope, { state: 'connection_removed' }))
    const report = await w.run(definition(step()))
    expect(report).toMatchObject({ end: { outcome: 'failed', error: expect.stringContaining('connection_removed') } })
    expect(w.d.rec.sent).toEqual([])
    expect(w.db.intents).toEqual([])
  })

  it('an unreadable connection copy is tried again later, since nothing was sent', async () => {
    const w = world()
    w.d.setCopy(new Error('the ops database did not answer'))
    expect(await w.run(definition(step()))).toMatchObject({ end: { outcome: 'retry' } })
  })

  it('an ops deploy without the connections key refuses the step by name, the run failed', async () => {
    const w = world({ connection: () => { throw new Error('OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops') } })
    expect(await w.run(definition(step()))).toMatchObject({ end: { outcome: 'failed', error: expect.stringContaining('OPS_CONNECTIONS_PRIVATE_KEY') } })
  })
})

describe('how an action\'s failure ends the run', () => {
  it('a request the service refused applied nothing: the run fails, naming the action\'s code', async () => {
    const w = world()
    w.d.respond(new Response('no', { status: 422 }))
    expect(await w.run(definition(step()))).toMatchObject({ end: { outcome: 'failed', error: expect.stringContaining('example_refused') } })
  })

  it('an unknown outcome after a non idempotent send goes to a person, never retried', async () => {
    const w = world()
    w.d.respond(new Response('upstream reset', { status: 502 }))
    expect(await w.run(definition(step()))).toMatchObject({ end: { outcome: 'needs_human', reason: 'send_outcome_unknown', error: expect.stringContaining('example_failed') } })
  })

  it('an unknown outcome of an idempotent action is tried again, since its resend cannot apply twice', async () => {
    const w = world()
    w.d.respond(new Response('upstream reset', { status: 502 }))
    expect(await w.run(definition(step({ action: 'example.put' })))).toMatchObject({ end: { outcome: 'retry' } })
  })

  it('a request that failed below HTTP may have landed: a non idempotent one goes to a person', async () => {
    const w = world()
    w.d.respond(new TypeError('network connection lost'))
    expect(await w.run(definition(step()))).toMatchObject({ end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
  })
})

describe('a login never reaches a stored record or a log (#1689 3.0, from Revert)', () => {
  it('the known token is absent from the step output, the ledger, the run\'s end and every log line, while the service did receive it', async () => {
    const outcomes: Array<() => Response | Error> = [
      () => Response.json({ id: 42 }),
      () => new Response('no', { status: 422 }),
      () => new Response('reset', { status: 502 }),
      () => new TypeError('network connection lost'),
    ]
    for (const answer of outcomes) {
      const w = world()
      w.d.respond(answer())
      const report = await w.run(definition(step()))
      // The positive control: the login really was applied to the request.
      expect(new Headers(w.d.rec.sent[0].init.headers).get('authorization')).toContain(ACCESS_TOKEN)
      const stored = JSON.stringify({ report, outputs: w.outputs, intents: w.db.intents, results: w.db.results, completes: w.db.completes, logs: w.logs, reports: w.d.rec.reports })
      expect(stored).not.toContain(ACCESS_TOKEN)
      expect(stored).not.toContain(LOGIN_SECRET)
    }
  })

  it('a service that echoes the login back, in its answer or its error text, hands it to neither the step output nor the run\'s end', async () => {
    const echo = `Bearer ${ACCESS_TOKEN} for ${LOGIN_SECRET}`
    const answers: Array<[() => Response, string]> = [
      [() => Response.json({ id: 42, echo }), 'done'],
      [() => new Response(`refused: ${echo}`, { status: 422 }), 'failed'],
      [() => new Response(`upstream says ${echo}`, { status: 502 }), 'needs_human'],
    ]
    for (const [answer, outcome] of answers) {
      const w = world()
      w.d.respond(answer())
      const report = await w.run(definition(step()))
      expect(report, outcome).toMatchObject({ end: { outcome } })
      const stored = JSON.stringify({ report, outputs: w.outputs, intents: w.db.intents, results: w.db.results, completes: w.db.completes, logs: w.logs })
      expect(stored, outcome).not.toContain(ACCESS_TOKEN)
      expect(stored, outcome).not.toContain(LOGIN_SECRET)
      // The rest of what the service said is kept, with the login marked as removed.
      expect(stored, outcome).toContain('[redacted] for [redacted]')
    }
  })
})
