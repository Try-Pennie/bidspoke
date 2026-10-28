/**
 * A step send through a connection (#1950, PR 2 of B3): connectionFetch's
 * answers turned into what the run invocation judges a send by
 * (connection-send.ts), and the two changes to connectionFetch the runner
 * needs: a requeue names the HTTP status that asked for it, and a service may
 * declare that a rate limit on some requests is its answer (Snowflake's status
 * poll, #2337).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { SealedEnvelope } from '@bidspoke/connection-seal'
import { connectionFetch, type ConnectionCall } from '../connections/connection-fetch'
import { ConnectionRefusal, CONNECTION_REFUSAL_CODES, LoginMintError, RequeueAt } from '../connections/refusals'
import { snowflakeAnswersRateLimit, snowflakeServiceEntry } from '../connections/snowflake-service'
import { CONN, ORG, T0, exampleRules, makeDoubles, makeKeys, sealLogin, usableCopy, type TestKeys } from '../connections/__tests__/harness'
import { connectionAnswer, NOTHING_SENT_REFUSALS } from '../connection-send'
import { organizationIdFrom } from '../ops-db'
import type { ClaimedRun, CompleteOutcome, SendIntentResult } from '../ops-writes'
import { invokeRun, type RunDb } from '../run-invocation'

let keys: TestKeys
let envelope: SealedEnvelope

beforeAll(async () => {
  keys = await makeKeys()
  envelope = await sealLogin(keys)
}, 120_000)

const WORKFLOW = '0192f4a0-0000-7000-8000-0000000000aa'

function stepCall(): ConnectionCall {
  return { organizationId: ORG, connectionId: CONN, source: { kind: 'copy' }, purpose: 'step', workflowId: WORKFLOW, record: { recordsNothing: 'a test' } }
}

describe('connectionFetch: a requeue names the status that asked for it', () => {
  it('a 429 and a 503 with Retry-After each carry their status', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
    d.respond(new Response('slow', { status: 429, headers: { 'retry-after': '30' } }))
    expect(((await connectionFetch(d.deps, stepCall(), 'https://api.example.test/x', { method: 'POST' })) as RequeueAt).status).toBe(429)
    d.respond(new Response('busy', { status: 503, headers: { 'retry-after': '30' } }))
    expect(((await connectionFetch(d.deps, stepCall(), 'https://api.example.test/x', { method: 'POST' })) as RequeueAt).status).toBe(503)
  })

  it('a requeue with no request made (a token endpoint 429) carries no status', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec, async () => {
      throw new LoginMintError('rate_limited', 'token_endpoint_rate_limited', new Date(T0 + 10_000))
    })])
    const res = await connectionFetch(d.deps, stepCall(), 'https://api.example.test/x', { method: 'POST' })
    expect(res).toBeInstanceOf(RequeueAt)
    expect((res as RequeueAt).status).toBeNull()
    expect(d.rec.sent).toEqual([])
  })
})

describe('connectionFetch: a rate limit a service declares to be its answer passes through', () => {
  it('hands back the response for a request the rule names, and requeues every other', async () => {
    const d = makeDoubles(keys, usableCopy(envelope), (rec) => [{
      ...exampleRules(rec),
      answersRateLimit: ({ method, url }: { method: string; url: URL }) => method === 'GET' && url.pathname.startsWith('/poll/'),
    }])
    d.respond(new Response('running', { status: 429 }))
    const polled = await connectionFetch(d.deps, stepCall(), 'https://api.example.test/poll/1')
    expect(polled).toBeInstanceOf(Response)
    expect((polled as Response).status).toBe(429)
    expect(await connectionFetch(d.deps, stepCall(), 'https://api.example.test/other')).toBeInstanceOf(RequeueAt)
    expect(await connectionFetch(d.deps, stepCall(), 'https://api.example.test/poll/1', { method: 'POST' })).toBeInstanceOf(RequeueAt)
  })

  it('Snowflake names a GET of a statement (its status or a result partition), never the POST that runs one', () => {
    const at = (method: string, path: string) => snowflakeAnswersRateLimit({ method, url: new URL(`https://acme.snowflakecomputing.com${path}`) })
    expect(at('GET', '/api/v2/statements/01b2-handle')).toBe(true)
    expect(at('GET', '/api/v2/statements/01b2-handle?partition=2')).toBe(true)
    expect(at('POST', '/api/v2/statements')).toBe(false)
    expect(at('POST', '/api/v2/statements/01b2-handle')).toBe(false)
    expect(at('get', '/api/v2/statements/01b2-handle')).toBe(true)
    expect(at('POST', '/api/v2/statements/01b2-handle/cancel')).toBe(false)
    expect(at('GET', '/api/v2/statements')).toBe(false)
    expect(at('GET', '/oauth/token')).toBe(false)
    expect(snowflakeServiceEntry({ now: () => T0 }).rules.answersRateLimit).toBe(snowflakeAnswersRateLimit)
  })
})

describe('connectionAnswer: what the run judges a send by', () => {
  it('a response is answered, with its status', async () => {
    const res = new Response('ok', { status: 201 })
    expect(await connectionAnswer(async () => res)).toEqual({ kind: 'answered', status: 201, value: res })
  })

  it('a requeue keeps its time, cause and status', async () => {
    const at = new Date(T0 + 30_000)
    expect(await connectionAnswer(async () => new RequeueAt(at, 'rate_limited', 503))).toEqual({ kind: 'requeue', notBefore: at, cause: 'rate_limited', status: 503 })
  })

  it('a refusal made before anything was sent is not_sent, by its code', async () => {
    expect(await connectionAnswer(async () => { throw new ConnectionRefusal('connection_needs_reauth', 'x') })).toEqual({ kind: 'not_sent', reason: 'connection_needs_reauth' })
  })

  it('a refusal after the request may have left, and anything that is not a refusal, is thrown: the send is unknown', async () => {
    for (const code of ['connection_network_error', 'connection_timeout', 'connection_aborted'] as const) {
      await expect(connectionAnswer(async () => { throw new ConnectionRefusal(code, 'x') })).rejects.toBeInstanceOf(ConnectionRefusal)
    }
    await expect(connectionAnswer(async () => { throw new Error('odd') })).rejects.toThrow('odd')
  })

  it('classifies every refusal code, and holds the ones that may follow a send out of the nothing sent list', () => {
    for (const code of CONNECTION_REFUSAL_CODES) expect(typeof NOTHING_SENT_REFUSALS[code]).toBe('boolean')
    expect(Object.entries(NOTHING_SENT_REFUSALS).filter(([, v]) => !v).map(([k]) => k).sort())
      .toEqual(['connection_aborted', 'connection_network_error', 'connection_rate_limited', 'connection_timeout'])
  })
})

// ── end to end: invokeRun, a ledgered send, connectionFetch ──────────────────

class LedgerDb implements RunDb {
  readonly results: Array<{ status: string; responseStatus?: number }> = []
  readonly completes: CompleteOutcome[] = []
  async start() { return { outcome: 'started' as const, stateVersion: 4, attempt: 1 } }
  async extend() { return true }
  async recordIntent(): Promise<SendIntentResult> { return { outcome: 'recorded', ledgerId: 'ledger-1', ledgerStatus: 'intent' } }
  async recordResult(_run: ClaimedRun, _id: string, result: { status: 'forwarded' | 'failed'; responseStatus?: number }) {
    this.results.push(result)
    return 'recorded' as const
  }
  async recordStep() { return 'recorded' as const }
  // One send and no walk (#1951): nothing is named or read.
  async recordCheckpoint(): Promise<never> { throw new Error('no checkpoint is named here') }
  async readCheckpoint(): Promise<never> { throw new Error('no checkpoint is read here') }
  async complete(_run: ClaimedRun, end: CompleteOutcome) {
    this.completes.push(end)
    return { outcome: 'completed' as const, runStatus: end.outcome }
  }
}

function claimed(): ClaimedRun {
  return {
    runRequestId: '0192f4a0-0000-7000-8000-000000000001', organizationId: organizationIdFrom(ORG), workflowId: WORKFLOW, workflowVersion: 1,
    triggerKind: 'schedule', claimToken: 'token-1', claimExpiresAt: new Date(T0 + 60_000).toISOString(), stateVersion: 3,
    attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
    executionChainId: '0192f4a0-0000-7000-8000-0000000000cc', resumedFromExecutionId: null, payload: null, payloadRef: null,
  }
}

async function runOnePost(answer: Response) {
  const d = makeDoubles(keys, usableCopy(envelope), (rec) => [exampleRules(rec)])
  d.respond(answer)
  const db = new LedgerDb()
  const clock = { now: () => T0, timer: (_ms: number, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })) }
  const report = await invokeRun({ db, clock, newExecutionId: () => 'exec-1', log: () => undefined }, claimed(), async (ctx) => {
    await ctx.send({
      nodeId: 'post_message', seq: 0, method: 'POST', url: 'https://api.example.test/chat.postMessage', idempotent: false,
      forward: ({ signal }) => connectionAnswer(() => connectionFetch(d.deps, { ...stepCall(), signal }, 'https://api.example.test/chat.postMessage', { method: 'POST', body: '{}' })),
    })
    return { outcome: 'done' }
  })
  return { report, db, sent: d.rec.sent.length }
}

describe('a non idempotent action through connectionFetch (#2337 comment, 2026-10-22)', () => {
  it('answered 503 with Retry-After ends as outcome unknown, never requeued', async () => {
    const { report, db, sent } = await runOnePost(new Response('busy', { status: 503, headers: { 'retry-after': '30' } }))
    expect(sent).toBe(1)
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
    expect(db.results).toEqual([{ status: 'forwarded', responseStatus: 503 }])
  })

  it('answered 429 waits, spending no attempt (#1693 7.4, #2859)', async () => {
    const { report, db } = await runOnePost(new Response('slow', { status: 429, headers: { 'retry-after': '30' } }))
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'suspend', reason: 'rate_limit_wait', status: 429, notBefore: new Date(T0 + 30_000) } })
    expect(db.results).toEqual([{ status: 'failed', responseStatus: 429 }])
  })
})
