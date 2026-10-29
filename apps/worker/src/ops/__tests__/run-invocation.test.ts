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
import {
  OpsClaimLostError, OpsWriteError, type CheckpointAck, type ClaimedRun, type CompleteOutcome, type OpsStepRecord, type RunCheckpointRead, type SendIntent, type SendIntentResult,
} from '../ops-writes'
import type { CheckpointAckOutcome, OpsStepRecordOutcome } from '../run-vocabulary'
import {
  CheckpointNotNamed,
  HEARTBEAT_EVERY_MS,
  RUN_DB_DEADLINE_MS,
  RUN_LEASE_SECONDS,
  RunStopped,
  SEND_DEADLINE_MS,
  StepNotSent,
  StepTimedOut,
  StepUnrecorded,
  invokeRun,
  stepRequestId,
  type ForwardAnswer,
  type RunBody,
  type RunDb,
  type RunInvocationOptions,
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
  /** How many times the run has been suspended to continue (#1951), as start answers it. */
  continuations = 0
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
    return { outcome: 'started' as const, stateVersion: this.stateVersion, attempt: run.attempts + 1, continuations: this.continuations }
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

  readonly steps: Array<{ executionId: string; record: OpsStepRecord }> = []
  stepAnswers: Array<() => Promise<OpsStepRecordOutcome>> = []

  async recordStep(run: ClaimedRun, executionId: string, record: OpsStepRecord): Promise<OpsStepRecordOutcome> {
    this.calls.push(`step:${record.nodeId}:${record.seq}`)
    const answer = this.stepAnswers.shift()
    if (answer) return answer()
    if (run.claimToken !== this.token || this.status !== 'running') return 'stale'
    this.steps.push({ executionId, record })
    return 'recorded'
  }

  /** The checkpoint the run names (#1951), fenced as record_run_checkpoint is. */
  named: CheckpointAck | null = null
  checkpointAnswers: Array<() => Promise<CheckpointAckOutcome>> = []
  readAnswers: Array<() => Promise<RunCheckpointRead>> = []

  async recordCheckpoint(run: ClaimedRun, ack: CheckpointAck): Promise<CheckpointAckOutcome> {
    this.calls.push(`checkpoint:${ack.stateVersion}-${ack.steps}`)
    const answer = this.checkpointAnswers.shift()
    if (answer) return answer()
    if (run.claimToken !== this.token || this.status !== 'running' || ack.stateVersion !== this.stateVersion) return 'stale'
    if (this.named?.key === ack.key) return 'already_recorded'
    if (this.named && this.named.stateVersion === ack.stateVersion && this.named.steps >= ack.steps) return 'superseded'
    this.named = ack
    return 'recorded'
  }

  async readCheckpoint(run: ClaimedRun): Promise<RunCheckpointRead> {
    this.calls.push('read_checkpoint')
    const answer = this.readAnswers.shift()
    if (answer) return answer()
    if (run.claimToken !== this.token || this.status === 'ended') return { held: false }
    const n = this.named
    return { held: true, stateVersion: this.stateVersion, checkpoint: n && { key: n.key, stateVersion: n.stateVersion, steps: n.steps, sha256: n.sha256, bytes: n.bytes } }
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
  const run = (body: RunBody, over: Partial<ClaimedRun> = {}, options?: RunInvocationOptions): Promise<RunInvocationReport> => invokeRun(deps, claimed(over), body, options)
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

  // A deferral spends no retry attempt (#1693 7.4, #2859): the run waits as a
  // rate_limit_wait suspend naming its step, never a charged retry.
  it('the same send answered 429 waits without spending an attempt, its ledger row failed, since a 429 proves nothing was applied', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => requeue(429)) })
      return { outcome: 'done' }
    })
    expect(report).toEqual({
      outcome: 'completed',
      end: {
        outcome: 'suspend', reason: 'rate_limit_wait', step: 'post', status: 429, notBefore: new Date('2026-10-22T13:00:00Z'),
        error: 'step post (POST x.example.com): rate_limited, answered 429, asked to wait until 2026-10-22T13:00:00.000Z',
      },
      runStatus: 'suspend',
    })
    expect(h.db.results).toEqual([{ ledgerId: 'ledger-1', status: 'failed', responseStatus: 429 }])
  })

  it('an idempotent send answered 503 with Retry-After waits the same way', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'put', seq: 0, method: 'PUT', url: 'https://x.example.com/', idempotent: true, forward: h.forwardWith('put', async () => requeue(503)) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ end: { outcome: 'suspend', reason: 'rate_limit_wait', step: 'put', status: 503 } })
  })

  it('a wait asked with no request made (a token endpoint 429) carries no status', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'read', seq: 0, method: 'GET', url: 'https://x.example.com/', idempotent: true, forward: h.forwardWith('read', async () => requeue(null)) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({
      end: { outcome: 'suspend', reason: 'rate_limit_wait', step: 'read', status: null, error: 'step read (GET x.example.com): rate_limited, no request was made, asked to wait until 2026-10-22T13:00:00.000Z' },
    })
  })

  it('the database ending a wait at the requeue cap is reported by name, with the step, host and status', async () => {
    const h = harness()
    h.db.completeAnswers.push(async () => ({ outcome: 'completed', runStatus: 'failed' }))
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => requeue(429)) })
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'suspend', reason: 'rate_limit_wait' }, runStatus: 'failed' })
    expect(h.events).toContainEqual(expect.objectContaining({ event: 'ops_run', step: 'requeue_cap_reached', node_id: 'post', host: 'x.example.com', status: 429 }))
  })

  it('a wait the database took is not reported as the cap', async () => {
    const h = harness()
    await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => requeue(429)) })
      return { outcome: 'done' }
    })
    expect(h.events.some((e) => e.step === 'requeue_cap_reached')).toBe(false)
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

describe('invokeRun: a slice that ends to continue (#1951)', () => {
  it('hands the body the continuations its start answered', async () => {
    const h = harness()
    h.db.continuations = 2
    let seen = -1
    await h.run(async (ctx) => {
      seen = ctx.continuations
      return { outcome: 'done' }
    })
    expect(seen).toBe(2)
  })

  it('a body that ends to continue completes its claim suspended to continue, at once', async () => {
    const h = harness()
    const report = await h.run(async () => ({ outcome: 'continue' }))
    expect(report).toEqual({ outcome: 'completed', end: { outcome: 'suspend', reason: 'continue', notBefore: new Date(h.clock.now()) }, runStatus: 'suspend' })
  })

  // A continuation resumes after its checkpoint, so a send made before it is
  // never made again: unlike a retry, it is not turned into failed.
  it('continues after a send that cannot be repeated, since the continuation resumes after it', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(200, 1)) })
      return { outcome: 'continue' }
    })
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'suspend', reason: 'continue' } })
  })

  it('an end a send decided still wins over a continue', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      try {
        await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => { throw new Error('reset') }) })
      } catch {
        // A body that swallows the stop and asks to continue.
      }
      return { outcome: 'continue' }
    })
    expect(report).toMatchObject({ end: { outcome: 'needs_human', reason: 'send_outcome_unknown' } })
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

// Each step of an ops run, recorded (#2703), through record_ops_step, fenced by the claim token.
describe('invokeRun: recording a step (#2703)', () => {
  const EXEC = '0192f4a0-0000-7000-8000-0000000000ee'
  const rec = (nodeId = 'shape', seq = 0): OpsStepRecord => ({
    seq, nodeId, namespace: nodeId, stepType: 'transform', status: 'completed', startedAt: new Date('2026-10-24T14:00:00.000Z'), durationMs: 4,
    output: { amount: 7 }, outputBytes: null, error: null,
  })
  const failedWrite = () => Promise.reject(new OpsWriteError('record_ops_step failed (57014): canceling statement due to statement timeout'))

  it('records under the attempt\'s execution id, through the run\'s own claim, before the run completes', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      await ctx.recordStep(rec())
      return { outcome: 'done' }
    })
    expect(report).toEqual({ outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' })
    expect(h.db.steps).toEqual([{ executionId: EXEC, record: rec() }])
    expect(h.db.calls.filter((c) => !c.startsWith('extend'))).toEqual([`start:${EXEC}`, 'step:shape:0', 'complete:done'])
  })

  it('hands the body the run\'s clock', async () => {
    const h = harness()
    let read = 0
    await h.run(async (ctx) => {
      read = ctx.now()
      return { outcome: 'done' }
    })
    expect(read).toBe(h.clock.now())
  })

  it('a stale answer is a lost claim: the body is stopped, nothing more is written and nothing is completed', async () => {
    const h = harness()
    h.db.stepAnswers.push(async () => 'stale')
    let thrown: unknown = null
    const report = await h.run(async (ctx) => {
      try {
        await ctx.recordStep(rec())
      } catch (err) {
        thrown = err
        throw err
      }
      return { outcome: 'done' }
    })
    expect(report).toEqual({ outcome: 'claim_lost', during: 'record' })
    expect(thrown).toBeInstanceOf(RunStopped)
    expect(h.db.calls.some((c) => c.startsWith('complete'))).toBe(false)
  })

  it('a record the database refuses as lost is a lost claim too', async () => {
    const h = harness()
    h.db.stepAnswers.push(() => Promise.reject(new OpsClaimLostError('record_ops_step: lost')))
    const report = await h.run(async (ctx) => {
      await ctx.recordStep(rec())
      return { outcome: 'done' }
    })
    expect(report).toEqual({ outcome: 'claim_lost', during: 'record' })
  })

  it('a record that keeps failing is tried three times, then named as not kept, never read as recorded', async () => {
    const h = harness()
    h.db.stepAnswers.push(failedWrite, failedWrite, failedWrite)
    let thrown: unknown = null
    const report = await h.run(async (ctx) => {
      try {
        await ctx.recordStep(rec())
      } catch (err) {
        thrown = err
        return { outcome: 'failed', error: (err as Error).message }
      }
      return { outcome: 'done' }
    })
    expect(thrown).toBeInstanceOf(StepUnrecorded)
    expect(thrown).toMatchObject({ nodeId: 'shape', reason: expect.stringContaining('57014') })
    expect(h.db.calls.filter((c) => c.startsWith('step'))).toEqual(['step:shape:0', 'step:shape:0', 'step:shape:0'])
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'failed' } })
    expect(h.events).toContainEqual(expect.objectContaining({ step: 'step_unrecorded', node_id: 'shape', seq: 0 }))
  })

  it('a record past its deadline is tried again, and a repeat that finds it landed is accepted', async () => {
    const h = harness()
    h.db.stepAnswers.push(() => never(), async () => 'already_recorded')
    const running = h.run(async (ctx) => {
      await ctx.recordStep(rec())
      return { outcome: 'done' }
    })
    await until(() => h.db.calls.includes('step:shape:0'))
    await h.clock.advance(RUN_DB_DEADLINE_MS)
    expect(await running).toEqual({ outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' })
    expect(h.db.calls.filter((c) => c.startsWith('step'))).toEqual(['step:shape:0', 'step:shape:0'])
  })

  it('once a send has decided how the run ends, a record writes nothing', async () => {
    const h = harness()
    let recorded: Promise<unknown> = Promise.resolve()
    const report = await h.run(async (ctx) => {
      try {
        await ctx.send({ nodeId: 'get', seq: 0, method: 'GET', url: 'https://x.example.com/', idempotent: true, forward: h.forwardWith('get', async () => ({ kind: 'requeue', notBefore: new Date('2026-10-22T13:00:00Z'), status: null, cause: 'rate_limited' })) })
      } catch {
        recorded = ctx.recordStep(rec('get')).then(() => 'recorded', (err: unknown) => err)
      }
      return { outcome: 'done' }
    })
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'suspend', reason: 'rate_limit_wait' } })
    expect(await recorded).toBeInstanceOf(RunStopped)
    expect(h.db.calls.some((c) => c.startsWith('step'))).toBe(false)
  })
})

describe('invokeRun: naming and reading a checkpoint (#1951)', () => {
  const KEY = `checkpoints/v1/${ORG}/${RUN_ID}/4-2.json`
  const ack = { steps: 2, key: KEY, sha256: 'a'.repeat(64), bytes: 900 }

  it('names a checkpoint with the attempt\'s execution and the state version its start answered, and reads it back', async () => {
    const h = harness()
    let read: unknown
    const report = await h.run(async (ctx) => {
      expect(ctx.stateVersion).toBe(4)
      expect(await ctx.checkpoints.name(ack)).toBe('recorded')
      expect(await ctx.checkpoints.name(ack)).toBe('already_recorded')
      read = await ctx.checkpoints.read()
      return { outcome: 'done' }
    })
    expect(report).toEqual({ outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' })
    expect(h.db.named).toEqual({ ...ack, executionId: '0192f4a0-0000-7000-8000-0000000000ee', stateVersion: 4 })
    expect(read).toEqual({ key: KEY, stateVersion: 4, steps: 2, sha256: 'a'.repeat(64), bytes: 900 })
  })

  it('a stale holder (the run swept and claimed again) names nothing: its claim is lost and nothing is completed', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      h.db.reclaim()
      await ctx.checkpoints.name(ack)
      return { outcome: 'done' }
    })
    expect(report).toEqual({ outcome: 'claim_lost', during: 'checkpoint' })
    expect(h.db.named).toBeNull()
    expect(h.db.calls.some((c) => c.startsWith('complete'))).toBe(false)
  })

  it('a read that finds the run no longer this holder\'s is a lost claim too', async () => {
    const h = harness()
    const report = await h.run(async (ctx) => {
      h.db.reclaim()
      await ctx.checkpoints.read()
      return { outcome: 'done' }
    })
    expect(report).toEqual({ outcome: 'claim_lost', during: 'checkpoint' })
  })

  it('an acknowledgement that fails every try throws CheckpointNotNamed naming why, and the run itself goes on', async () => {
    const h = harness()
    h.db.checkpointAnswers.push(...[1, 2, 3].map(() => async (): Promise<CheckpointAckOutcome> => { throw new OpsWriteError('record_run_checkpoint failed (57014): canceled') }))
    let thrown: unknown
    const report = await h.run(async (ctx) => {
      try {
        await ctx.checkpoints.name(ack)
      } catch (err) {
        thrown = err
      }
      return { outcome: 'done' }
    })
    expect(thrown).toBeInstanceOf(CheckpointNotNamed)
    expect((thrown as Error).message).toMatch(/57014/)
    expect(h.db.calls.filter((c) => c.startsWith('checkpoint'))).toHaveLength(3)
    expect(report).toEqual({ outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' })
  })

  it('an acknowledgement past its deadline is tried again, and a repeat that finds it landed is accepted (a crash between write and acknowledgement is safe to repeat)', async () => {
    const h = harness()
    h.db.checkpointAnswers.push(() => never(), async () => 'already_recorded')
    let answer: unknown
    const running = h.run(async (ctx) => {
      answer = await ctx.checkpoints.name(ack)
      return { outcome: 'done' }
    })
    await until(() => h.db.calls.includes('checkpoint:4-2'))
    await h.clock.advance(RUN_DB_DEADLINE_MS)
    expect(await running).toEqual({ outcome: 'completed', end: { outcome: 'done' }, runStatus: 'done' })
    expect(answer).toBe('already_recorded')
  })

  it('once the run has stopped, neither names nor reads, writing nothing', async () => {
    const h = harness()
    const tried: unknown[] = []
    await h.run(async (ctx) => {
      try {
        await ctx.send({ nodeId: 'get', seq: 0, method: 'GET', url: 'https://x.example.com/', idempotent: true, forward: h.forwardWith('get', async () => ({ kind: 'requeue', notBefore: new Date('2026-10-22T13:00:00Z'), status: null, cause: 'rate_limited' })) })
      } catch {
        tried.push(await ctx.checkpoints.name(ack).catch((err: unknown) => err), await ctx.checkpoints.read().catch((err: unknown) => err))
      }
      return { outcome: 'done' }
    })
    expect(tried[0]).toBeInstanceOf(RunStopped)
    expect(tried[1]).toBeInstanceOf(RunStopped)
    expect(h.db.calls.some((c) => c.startsWith('checkpoint') || c === 'read_checkpoint')).toBe(false)
  })
})

// The wait before a retry after a real failure (#1693 item 7.4, Dan's decision of
// 2026-10-28): 15 s by default, doubling, never more than 8 minutes, counted by
// charged attempts only; or, set to none, the first real failure ends the run.
describe('invokeRun: the retry setting (#1693)', () => {
  const boom: RunBody = async () => { throw new Error('partner 500') }
  /** The wait the retry was given, in seconds from the run's clock. */
  const waitOf = (report: RunInvocationReport, now: number): number | null => {
    if (report.outcome !== 'completed' && report.outcome !== 'complete_failed') return null
    if (report.end.outcome !== 'retry' || report.end.notBefore === undefined) return null
    return (report.end.notBefore.getTime() - now) / 1000
  }

  it('waits 15, 30, 60, 120, 240, 480 then 480 s by default, one charged attempt after another', async () => {
    const waits: Array<number | null> = []
    for (let charged = 0; charged < 7; charged++) {
      const h = harness()
      const report = await h.run(boom, { attempts: charged, resumeReason: charged === 0 ? null : 'retry', maxAttempts: 10 })
      waits.push(waitOf(report, h.clock.now()))
    }
    expect(waits).toEqual([15, 30, 60, 120, 240, 480, 480])
  })

  it('counts only charged attempts: rate limit, resource and continuation starts never grow the wait', async () => {
    // One charged failure, then two rate limit waits: the run resumed from the last wait fails.
    const h = harness()
    expect(waitOf(await h.run(boom, { attempts: 3, unchargedAttempts: 2, resumeReason: 'rate_limit_wait' }), h.clock.now())).toBe(15)
    // The same history resumed by a retry is its second charged attempt.
    const again = harness()
    expect(waitOf(await again.run(boom, { attempts: 3, unchargedAttempts: 2, resumeReason: 'retry' }), again.clock.now())).toBe(30)
    for (const resumeReason of ['resource_wait', 'continue']) {
      const w = harness()
      expect(waitOf(await w.run(boom, { attempts: 4, unchargedAttempts: 3, resumeReason }), w.clock.now())).toBe(15)
    }
  })

  it('follows a configured base and cap', async () => {
    const retry = { mode: 'backoff' as const, baseSeconds: 5, capSeconds: 20 }
    const waits: Array<number | null> = []
    for (let charged = 0; charged < 4; charged++) {
      const h = harness()
      waits.push(waitOf(await h.run(boom, { attempts: charged, resumeReason: charged === 0 ? null : 'retry', maxAttempts: 10 }, { retry }), h.clock.now()))
    }
    expect(waits).toEqual([5, 10, 20, 20])
  })

  it('keeps a later time the body asked for, and never retries sooner than the wait', async () => {
    const late = harness()
    const lateAt = new Date(late.clock.now() + 3_600_000)
    expect(await late.run(async () => ({ outcome: 'retry', notBefore: lateAt }))).toMatchObject({ end: { outcome: 'retry', notBefore: lateAt } })
    const soon = harness()
    expect(waitOf(await soon.run(async () => ({ outcome: 'retry', notBefore: new Date(soon.clock.now() + 1_000) })), soon.clock.now())).toBe(15)
  })

  it('a send whose intent was not confirmed waits the same way before its retry', async () => {
    const h = harness()
    h.db.intentAnswer = async () => { throw new OpsWriteError('record_send_intent could not be called') }
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => answered(200, 1)) })
      return { outcome: 'done' }
    })
    expect(waitOf(report, h.clock.now())).toBe(15)
  })

  it('set to none, the first real failure ends the run failed, whatever max_attempts allows', async () => {
    const h = harness()
    const report = await h.run(boom, { maxAttempts: 5 }, { retry: { mode: 'none' } })
    expect(report).toMatchObject({ outcome: 'completed', end: { outcome: 'failed' } })
    if (report.outcome !== 'completed' || report.end.outcome !== 'failed') throw new Error('expected failed')
    expect(report.end.error).toMatch(/partner 500/)
    expect(report.end.error).toMatch(/set not to retry/)
    expect(h.db.completes).toEqual([report.end])
  })

  it('set to none, a body asking for a retry and a send whose intent was not confirmed end failed too', async () => {
    const asked = harness()
    expect(await asked.run(async () => ({ outcome: 'retry', error: 'try later' }), {}, { retry: { mode: 'none' } })).toMatchObject({ end: { outcome: 'failed', error: expect.stringMatching(/try later/) } })
    const unconfirmed = harness()
    unconfirmed.db.intentAnswer = async () => { throw new OpsWriteError('record_send_intent could not be called') }
    const report = await unconfirmed.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: unconfirmed.forwardWith('post', async () => answered(200, 1)) })
      return { outcome: 'done' }
    }, {}, { retry: { mode: 'none' } })
    expect(report).toMatchObject({ end: { outcome: 'failed' } })
    expect(unconfirmed.forwards).toHaveLength(0)
  })

  it('set to none, a rate limit wait is unchanged: it waits as asked and spends no attempt', async () => {
    const h = harness()
    const at = new Date('2026-10-22T13:00:00Z')
    const report = await h.run(async (ctx) => {
      await ctx.send({ nodeId: 'post', seq: 0, method: 'POST', url: 'https://x.example.com/', idempotent: false, forward: h.forwardWith('post', async () => ({ kind: 'requeue', notBefore: at, status: 429, cause: 'rate_limited' })) })
      return { outcome: 'done' }
    }, {}, { retry: { mode: 'none' } })
    expect(report).toMatchObject({ end: { outcome: 'suspend', reason: 'rate_limit_wait', notBefore: at } })
  })

  it('a retry whose complete fails every try reports the wait it was given, sent the same on each try', async () => {
    const h = harness()
    h.db.completeAnswers = [1, 2, 3].map(() => async () => { throw new OpsWriteError('complete_run_request could not be called') })
    const sent: CompleteOutcome[] = []
    const complete = h.db.complete.bind(h.db)
    h.db.complete = (run, end) => { sent.push(end); return complete(run, end) }
    const report = await h.run(boom, { attempts: 1, resumeReason: 'retry' })
    expect(report).toMatchObject({ outcome: 'complete_failed', end: { outcome: 'retry' }, error: expect.stringMatching(/could not be called/) })
    expect(waitOf(report, h.clock.now())).toBe(30)
    expect(sent).toHaveLength(3)
    expect(new Set(sent.map((e) => (e.outcome === 'retry' ? e.notBefore?.toISOString() : null))).size).toBe(1)
    expect(h.events).toContainEqual(expect.objectContaining({ step: 'complete_failed', outcome: 'retry' }))
  })
})
