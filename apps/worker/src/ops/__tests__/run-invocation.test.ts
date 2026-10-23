/**
 * Run invocation (#1950, B3 of the #1698 run engine): the Worker half of the
 * lease, the heartbeat, the state version fence and the send ledger.
 *
 * The database half (claim token, state version, the fenced intent, the lease
 * sweep) is proven against a real Postgres in supabase-ops/supabase/tests/
 * run_engine_*.test.sql. These tests drive invokeRun against a fake that fences
 * the way those functions do, on an injected clock (L524, L290), and prove what
 * lives here: the order intent, forward, result; that a stale or lost holder
 * sends nothing; that every wait has a deadline and a forward past it is
 * recorded as unknown; and which outcome each answer ends the run with.
 */
import { describe, expect, it } from 'vitest'
import { organizationIdFrom } from '../ops-db'
import { OpsClaimLostError, OpsWriteError, type ClaimedRun, type CompleteOutcome, type SendIntent, type SendIntentResult } from '../ops-writes'
import {
  HEARTBEAT_EVERY_MS,
  RUN_DB_DEADLINE_MS,
  RUN_LEASE_SECONDS,
  SEND_DEADLINE_MS,
  StepNotSent,
  StepTimedOut,
  invokeRun,
  stepRequestId,
  type ForwardAnswer,
  type RunBody,
  type RunDb,
  type RunInvocationReport,
} from '../run-invocation'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const RUN_ID = '0192f4a0-0000-7000-8000-000000000001'

// ── an injected clock: timers fire only when the test advances it ─────────────

function manualClock() {
  let now = 1_000_000
  const timers: Array<{ at: number; fire: () => void }> = []
  return {
    now: () => now,
    timer(ms: number, signal: AbortSignal): Promise<void> {
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        const t = { at: now + ms, fire: resolve }
        timers.push(t)
        signal.addEventListener('abort', () => {
          const i = timers.indexOf(t)
          if (i >= 0) timers.splice(i, 1)
          resolve()
        }, { once: true })
      })
    },
    pending: () => timers.length,
    async advance(ms: number): Promise<void> {
      const target = now + ms
      await flush()
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > target) break
        timers.shift()
        now = next.at
        next.fire()
        await flush()
      }
      now = target
      await flush()
    },
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

/**
 * Waits, on real time, for something the run reaches only after real async work
 * (the step request id is a crypto digest): advancing the clock before then would
 * register its deadline after the advance, and the test would hang (L290).
 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 5000 && !cond(); i++) await new Promise((r) => setTimeout(r, 1))
  if (!cond()) throw new Error('the run never reached the point the test waits for')
}

/** A promise that never settles: a database or partner that never answers. */
const never = <T>() => new Promise<T>(() => undefined)

// ── a fake ops database that fences as the real functions do ──────────────────

class FakeRunDb implements RunDb {
  token = 'token-1'
  stateVersion = 3
  status: 'claimed' | 'running' | 'ended' = 'claimed'
  readonly calls: string[] = []
  readonly intents: Array<Omit<SendIntent, 'runRequestId' | 'claimToken'> & { claimToken: string }> = []
  readonly results: Array<{ ledgerId: string; status: string; responseStatus?: number }> = []
  readonly completes: CompleteOutcome[] = []
  extendAnswer: (() => Promise<boolean>) | null = null
  intentAnswer: (() => Promise<SendIntentResult>) | null = null
  completeAnswers: Array<() => Promise<{ outcome: 'completed'; runStatus: string }>> = []

  async start(run: ClaimedRun, executionId: string) {
    this.calls.push(`start:${executionId}`)
    if (run.claimToken !== this.token || this.status !== 'claimed') throw new OpsClaimLostError('start_run_execution: lost')
    this.status = 'running'
    this.stateVersion += 1
    return { outcome: 'started' as const, stateVersion: this.stateVersion, attempt: run.attempts + 1 }
  }

  async extend(run: ClaimedRun, leaseSeconds: number) {
    this.calls.push(`extend:${leaseSeconds}`)
    if (this.extendAnswer) return this.extendAnswer()
    return run.claimToken === this.token && this.status !== 'ended'
  }

  async recordIntent(run: ClaimedRun, intent: Omit<SendIntent, 'runRequestId' | 'claimToken'>): Promise<SendIntentResult> {
    this.calls.push(`intent:${intent.nodeId}:${intent.seq}`)
    if (this.intentAnswer) return this.intentAnswer()
    if (run.claimToken !== this.token || intent.stateVersion !== this.stateVersion || this.status !== 'running') {
      return { outcome: 'stale', ledgerId: null, ledgerStatus: null }
    }
    this.intents.push({ ...intent, claimToken: run.claimToken })
    return { outcome: 'recorded', ledgerId: `ledger-${this.intents.length}`, ledgerStatus: 'intent' }
  }

  async recordResult(_run: ClaimedRun, ledgerId: string, result: { status: 'forwarded' | 'failed'; responseStatus?: number }) {
    this.calls.push(`result:${ledgerId}:${result.status}`)
    this.results.push({ ledgerId, ...result })
    return 'recorded' as const
  }

  async complete(run: ClaimedRun, end: CompleteOutcome) {
    this.calls.push(`complete:${end.outcome}`)
    const answer = this.completeAnswers.shift()
    if (answer) return answer()
    if (run.claimToken !== this.token) throw new OpsClaimLostError('complete_run_request: lost')
    this.completes.push(end)
    this.status = 'ended'
    return { outcome: 'completed' as const, runStatus: end.outcome }
  }

  /** The lease sweep and a new claim took the run while its first holder was paused. */
  reclaim(): void {
    this.token = 'token-2'
    this.stateVersion += 2
    this.status = 'running'
  }
}

function claimed(over: Partial<ClaimedRun> = {}): ClaimedRun {
  return {
    runRequestId: RUN_ID, organizationId: ORG, workflowId: '0192f4a0-0000-7000-8000-0000000000aa', workflowVersion: 4,
    triggerKind: 'schedule', claimToken: 'token-1', claimExpiresAt: '2026-10-22T12:01:00.000Z', stateVersion: 3,
    attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
    executionChainId: '0192f4a0-0000-7000-8000-0000000000cc', resumedFromExecutionId: null, payload: null, payloadRef: null,
    ...over,
  }
}

function harness() {
  const db = new FakeRunDb()
  const clock = manualClock()
  const events: Array<Record<string, unknown>> = []
  const forwards: Array<{ nodeId: string; requestId: string; signal: AbortSignal }> = []
  const deps = { db, clock, newExecutionId: () => '0192f4a0-0000-7000-8000-0000000000ee', log: (e: Record<string, unknown>) => { events.push(e) } }
  const run = (body: RunBody, over: Partial<ClaimedRun> = {}): Promise<RunInvocationReport> => invokeRun(deps, claimed(over), body)
  /** A forward that records it was called and answers with what the test gives. */
  const forwardWith = <T>(nodeId: string, answer: (signal: AbortSignal) => Promise<ForwardAnswer<T>>) => (call: { signal: AbortSignal; requestId: string }) => {
    forwards.push({ nodeId, requestId: call.requestId, signal: call.signal })
    db.calls.push(`forward:${nodeId}`)
    return answer(call.signal)
  }
  return { db, clock, events, forwards, run, forwardWith }
}

const answered = <T>(status: number, value: T): ForwardAnswer<T> => ({ kind: 'answered', status, value })

describe('invokeRun: the order of a ledgered send', () => {
  it('starts, renews, writes the intent, forwards, marks it forwarded, then completes done', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      const r = await ctx.send({ nodeId: 'post_row', seq: 0, method: 'POST', url: 'https://api.example.com/rows', idempotent: false, forward: h.forwardWith('post_row', async () => answered(201, 'ok')) })
      expect(r).toEqual({ status: 201, value: 'ok' })
      return { outcome: 'done' }
    })
    expect(report).toEqual({ outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' })
    const order = h.db.calls.filter((c) => !c.startsWith('extend'))
    expect(order).toEqual(['start:0192f4a0-0000-7000-8000-0000000000ee', 'intent:post_row:0', 'forward:post_row', 'result:ledger-1:forwarded', 'complete:done'])
    // The intent is fenced with the version start answered, not the claim's.
    expect(h.db.intents[0]).toMatchObject({ stateVersion: 4, method: 'POST', host: 'api.example.com', idempotent: false, claimToken: 'token-1' })
    expect(h.db.results[0]).toEqual({ ledgerId: 'ledger-1', status: 'forwarded', responseStatus: 201 })
    // The heartbeat renewed the lease once, before the body ran, with the run's lease.
    expect(h.db.calls[1]).toBe(`extend:${RUN_LEASE_SECONDS}`)
    expect(h.clock.pending()).toBe(0)
  })

  it('sends a GET without a ledger row', async () => {
    const h = harness()
    await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'read', seq: 0, method: 'GET', url: 'https://api.example.com/rows', idempotent: false, forward: h.forwardWith('read', async () => answered(200, 1)) })
      return { outcome: 'done' }
    })
    expect(h.db.calls.some((c) => c.startsWith('intent'))).toBe(false)
    expect(h.forwards).toHaveLength(1)
  })

  it('refuses a method the ledger has no name for, sending nothing', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'odd', seq: 0, method: 'TRACE', url: 'https://api.example.com/', idempotent: false, forward: h.forwardWith('odd', async () => answered(200, 1)) })
      return { outcome: 'done' }
    })
    expect(h.forwards).toHaveLength(0)
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'retry' } })
  })

  it('gives each step a request id that is stable across attempts and recorded as the attempt key', async () => {
    const first = await stepRequestId(RUN_ID, 'insert', 2)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await stepRequestId(RUN_ID, 'insert', 2)).toBe(first)
    expect(await stepRequestId(RUN_ID, 'insert', 3)).not.toBe(first)
    expect(await stepRequestId(RUN_ID, 'insert2', 2)).not.toBe(first)
    expect(await stepRequestId('0192f4a0-0000-7000-8000-000000000002', 'insert', 2)).not.toBe(first)

    const h = harness()
    await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'insert', seq: 2, method: 'POST', url: 'https://x.example.com/', idempotent: true, forward: h.forwardWith('insert', async () => answered(200, 1)) })
      return { outcome: 'done' }
    }, { attempts: 1 })
    expect(h.forwards[0].requestId).toBe(first)
    expect(h.db.intents[0].attemptKey).toBe(first)
  })
})

describe('invokeRun: a holder that no longer holds the run sends nothing', () => {
  it('a holder paused while its run was re-claimed makes zero forwards when it resumes (#1698 D2)', async () => {
    const h = harness()
    let resume!: () => void
    const paused = new Promise<void>((r) => { resume = r })
    const running = h.run(async (ctx) => {
      await paused
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(200, 1)) })
      return { outcome: 'done' }
    })
    await until(() => h.db.calls.filter((c) => c.startsWith('extend')).length === 1)
    h.db.reclaim()
    resume()
    const report = await running
    expect(h.forwards).toHaveLength(0)
    expect(report).toEqual({ outcome: 'claim_lost', during: 'send' })
    // The new holder's run is not ended by the old one.
    expect(h.db.completes).toEqual([])
  })

  it('a heartbeat answered false stops the body and refuses its next send (#1698 D3)', async () => {
    const h = harness()
    let sawAbort = false
    const running = h.run(async (ctx) => {
      await h.clock.timer(HEARTBEAT_EVERY_MS * 2, new AbortController().signal)
      sawAbort = ctx.signal.aborted
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(200, 1)) })
      return { outcome: 'done' }
    })
    await until(() => h.db.calls.filter((c) => c.startsWith('extend')).length === 1)
    h.db.extendAnswer = async () => false
    await h.clock.advance(HEARTBEAT_EVERY_MS * 2)
    expect(await running).toEqual({ outcome: 'claim_lost', during: 'heartbeat' })
    expect(sawAbort).toBe(true)
    expect(h.forwards).toHaveLength(0)
    expect(h.db.calls.some((c) => c.startsWith('complete'))).toBe(false)
  })

  it('renews every HEARTBEAT_EVERY_MS while the body runs', async () => {
    const h = harness()
    let finish!: () => void
    const running = h.run(async () => {
      await new Promise<void>((r) => { finish = r })
      return { outcome: 'done' }
    })
    await h.clock.advance(HEARTBEAT_EVERY_MS * 3)
    finish()
    await running
    expect(h.db.calls.filter((c) => c.startsWith('extend'))).toHaveLength(4)
  })

  it('a heartbeat that never answers is given up on at its deadline, and the run is lost once the lease it last confirmed has passed', async () => {
    const h = harness()
    let finish!: () => void
    const running = h.run(async (ctx) => {
      await new Promise<void>((r) => { finish = r })
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(200, 1)) })
      return { outcome: 'done' }
    })
    await until(() => h.db.calls.filter((c) => c.startsWith('extend')).length === 1)
    h.db.extendAnswer = () => never<boolean>()
    // Two renewals hang to their deadline; the lease confirmed at the start still holds.
    await h.clock.advance(HEARTBEAT_EVERY_MS * 2 + RUN_DB_DEADLINE_MS)
    expect(h.events.filter((e) => e.step === 'heartbeat_unconfirmed')).toHaveLength(2)
    // Then the lease confirmed at the start passes with no renewal confirmed.
    let settled = false
    void running.then(() => { settled = true })
    await h.clock.advance(RUN_LEASE_SECONDS * 1000)
    // The heartbeat itself gives the run up, before the body tries another send.
    expect(settled).toBe(true)
    finish()
    expect(await running).toEqual({ outcome: 'claim_lost', during: 'heartbeat' })
    await flush()
    expect(h.forwards).toHaveLength(0)
  })

  it('a start the database refuses runs no body', async () => {
    const h = harness()
    h.db.status = 'ended'
    let ran = false
    const report = await h.run(async () => { ran = true; return { outcome: 'done' } })
    expect(report).toEqual({ outcome: 'claim_lost', during: 'start' })
    expect(ran).toBe(false)
  })

  it('a start that never answers is given up on at its deadline, and runs no body', async () => {
    const h = harness()
    h.db.start = () => never()
    let ran = false
    const running = h.run(async () => { ran = true; return { outcome: 'done' } })
    await h.clock.advance(RUN_DB_DEADLINE_MS)
    expect(await running).toMatchObject({ outcome: 'start_failed' })
    expect(ran).toBe(false)
  })
})

describe('invokeRun: every external wait has a deadline (lessons audit L110)', () => {
  it('a forward that never answers trips SEND_DEADLINE_MS, is aborted, stays an intent (unknown) and ends the run needs_human', async () => {
    const h = harness()
    const running = h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', () => never()) })
      return { outcome: 'done' }
    })
    await until(() => h.forwards.length === 1)
    await h.clock.advance(SEND_DEADLINE_MS)
    const report = await running
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
    expect(h.forwards[0].signal.aborted).toBe(true)
    // No result: an intent with no result is the ledger's unknown.
    expect(h.db.results).toEqual([])
    expect(SEND_DEADLINE_MS).toBeLessThan(RUN_LEASE_SECONDS * 1000)
  })

  it('a forward that throws (it may have landed) is unknown too', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => { throw new Error('connection reset') }) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
    expect(h.db.results).toEqual([])
  })

  it('the unknown wins even when the body catches it and says done', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      try {
        await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => { throw new Error('reset') }) })
      } catch { /* swallowed */ }
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
  })

  it('an idempotent send that times out is retried, since resending it is safe', async () => {
    const h = harness()
    const running = h.run(async (ctx) => {
      await ctx.send({ nodeId: 'put', seq: 0, method: 'PUT', url: 'https://x.example.com/', idempotent: true, forward: h.forwardWith('put', () => never()) })
      return { outcome: 'done' }
    })
    await until(() => h.forwards.length === 1)
    await h.clock.advance(SEND_DEADLINE_MS)
    expect(await running).toMatchObject({ outcome: 'completed', end: { outcome: 'retry' } })
  })

  it('a GET that times out throws StepTimedOut to the body', async () => {
    const h = harness()
    let caught: unknown = null
    const running = h.run(async (ctx) => {
      try {
        await ctx.send({ nodeId: 'read', seq: 0, method: 'GET', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('read', () => never()) })
      } catch (err) { caught = err }
      return { outcome: 'done' }
    })
    await until(() => h.forwards.length === 1)
    await h.clock.advance(SEND_DEADLINE_MS)
    expect(await running).toMatchObject({ outcome: 'completed', end: { outcome: 'done' } })
    expect(caught).toBeInstanceOf(StepTimedOut)
  })

  it('an intent write that never answers sends nothing and retries the run', async () => {
    const h = harness()
    h.db.intentAnswer = () => never()
    const running = h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(200, 1)) })
      return { outcome: 'done' }
    })
    await until(() => h.db.calls.includes('intent:post:0'))
    await h.clock.advance(RUN_DB_DEADLINE_MS)
    expect(await running).toMatchObject({ outcome: 'completed', end: { outcome: 'retry' } })
    expect(h.forwards).toHaveLength(0)
  })
})

describe('invokeRun: what a requeue answers', () => {
  const requeue = (status: number | null, cause: 'rate_limited' | 'pool_full' = 'rate_limited'): ForwardAnswer<never> => ({ kind: 'requeue', notBefore: new Date('2026-10-22T13:00:00Z'), status, cause })

  it('a non idempotent send answered 503 with Retry-After ends as outcome unknown (#2337 comment, 2026-10-22)', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => requeue(503)) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
    expect(h.db.results).toEqual([{ ledgerId: 'ledger-1', status: 'forwarded', responseStatus: 503 }])
  })

  it('the same send answered 429 requeues, its ledger row failed, since a 429 proves nothing was applied', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => requeue(429)) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ end: { outcome: 'retry', notBefore: new Date('2026-10-22T13:00:00Z') } })
    expect(h.db.results).toEqual([{ ledgerId: 'ledger-1', status: 'failed', responseStatus: 429 }])
  })

  it('an idempotent send answered 503 requeues', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'put', seq: 0, method: 'PUT', url: 'https://x.example.com/', idempotent: true, forward: h.forwardWith('put', async () => requeue(503)) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ end: { outcome: 'retry' } })
  })

  it('a resource wait (nothing sent) suspends the run on that cause', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'sf', seq: 0, method: 'POST', url: 'https://x.my.salesforce.com/', idempotent: false, forward: h.forwardWith('sf', async () => requeue(null, 'pool_full')) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ end: { outcome: 'suspend', reason: 'resource_wait', cause: 'pool_full' } })
    expect(h.db.results).toEqual([{ ledgerId: 'ledger-1', status: 'failed' }])
  })

  it('a later, milder answer does not replace an unknown send', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await Promise.allSettled([
        ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => { throw new Error('reset') }) }),
        ctx.send({ nodeId: 'read', seq: 0, method: 'GET', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('read', async () => { await new Promise((r) => setTimeout(r, 0)); return requeue(429) }) }),
      ])
      return { outcome: 'done' }
    })
    expect(h.forwards.map((f) => f.nodeId).sort()).toEqual(['post', 'read'])
    expect(report).toMatchObject({ end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
  })

  it('a requeue after a send that cannot be repeated ends the run failed, never retried', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'first', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('first', async () => answered(200, 1)) })
      await ctx.send({ nodeId: 'second', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('second', async () => requeue(429)) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ end: { outcome: 'failed' } })
  })
})

describe('invokeRun: how the body ends the run', () => {
  it('a body that throws before any send is retried', async () => {
    const h = harness()
    const report = await h.run(async () => { throw new Error('boom') })
    expect(report).toMatchObject({ end: { outcome: 'retry', error: 'boom' } })
  })

  it('a body that throws after a send that cannot be repeated ends failed', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(200, 1)) })
      throw new Error('after the post')
    })
    expect(report).toMatchObject({ end: { outcome: 'failed', error: 'after the post' } })
  })

  it('a body that asks for a retry after such a send ends failed too', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(500, 1)) })
      return { outcome: 'retry', error: 'partner 500' }
    })
    expect(report).toMatchObject({ end: { outcome: 'failed', error: 'partner 500' } })
  })

  // #2339: a send that was answered, by an action that then cannot tell
  // whether what it asked for was applied (a 5xx after a write), is the body's
  // to judge; it ends the run for a person, never as a plain failure.
  it('a body may end its run needs_human with send_outcome_unknown', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(502, 1)) })
      return { outcome: 'needs_human', reason: 'send_outcome_unknown', error: 'step post: answered 502 after the send; it may have landed' }
    })
    expect(report).toMatchObject({ end: { outcome: 'needs_human', reason: 'send_outcome_unknown', error: 'step post: answered 502 after the send; it may have landed' } })
    expect(h.db.calls.at(-1)).toBe('complete:needs_human')
  })

  it('a send the connection never made is marked failed and thrown to the body as StepNotSent', async () => {
    const h = harness()
    let caught: unknown = null
    const report = await h.run(async (ctx) => {
      try {
        await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => ({ kind: 'not_sent', reason: 'connection_needs_reauth' })) })
      } catch (err) { caught = err }
      return { outcome: 'retry' }
    })
    expect(caught).toBeInstanceOf(StepNotSent)
    expect(h.db.results).toEqual([{ ledgerId: 'ledger-1', status: 'failed' }])
    // Nothing left, so the run may still be retried.
    expect(report).toMatchObject({ end: { outcome: 'retry' } })
  })

  it('a complete that fails is tried again, and one the database says is not ours is claim lost', async () => {
    const h = harness()
    h.db.completeAnswers = [async () => { throw new OpsWriteError('complete_run_request could not be called') }]
    expect(await h.run(async () => ({ outcome: 'done' }))).toMatchObject({ outcome: 'completed', end: { outcome: 'done' } })
    expect(h.db.calls.filter((c) => c.startsWith('complete'))).toHaveLength(2)

    const lost = harness()
    lost.db.completeAnswers = [async () => { throw new OpsClaimLostError('complete_run_request: lost') }]
    expect(await lost.run(async () => ({ outcome: 'done' }))).toEqual({ outcome: 'claim_lost', during: 'complete' })
  })

  it('a complete that never answers is given up on, three deadlines at most', async () => {
    const h = harness()
    h.db.complete = () => { h.db.calls.push('complete'); return never() }
    const running = h.run(async () => ({ outcome: 'done' }))
    await h.clock.advance(RUN_DB_DEADLINE_MS * 3)
    expect(await running).toMatchObject({ outcome: 'complete_failed', end: { outcome: 'done' } })
    expect(h.db.calls.filter((c) => c === 'complete')).toHaveLength(3)
  })
})
