/**
 * Suspend and resume across invocations (#1951, #1698 1.5 and 1.8): an ops run
 * walked by invokeRun with OPS_CONTINUATION=on, slice after slice, against a
 * fake of the ops database's run row that fences and counts the way its
 * functions do (start_run_execution, record_run_checkpoint, run_checkpoint and
 * complete_run_request, proven against a real Postgres in
 * supabase-ops/supabase/tests/run_continuation.test.sql and
 * run_checkpoints.test.sql), and an R2 store in memory that writes only where
 * nothing is.
 *
 * THE TWO RECORDED RESUME FAILURE SHAPES (#1698 1.8), rebuilt with ops node
 * types, each seen red with route replay disabled (the resume restoring each
 * completed step's output and then evaluating its edges again, the skip and
 * reuse path the money engine removed):
 *  1. a branch that routed its SECOND arm, resumed after a later failure, must
 *     continue down the second arm;
 *  2. a first wins choice whose winner completed must not re-fire the loser.
 *     The ops walk has no parallel node yet (it refuses one before any step
 *     runs, the last test here), so the shape is rebuilt as the choice the ops
 *     lane can make: a branch that picked its winner's arm, the winner's send
 *     made before the slice ended. Slice 5 of #2867's list rebuilds it with the
 *     parallel node once the ops walk runs one.
 */
import { describe, expect, it } from 'vitest'
import type { CheckpointStore } from '../checkpoint'
import { CONTINUATION_BUDGET } from '../checkpoint'
import { organizationIdFrom } from '../ops-db'
import {
  OpsClaimLostError, type CheckpointAck, type ClaimedRun, type CompleteOutcome, type NamedCheckpoint, type OpsStepRecord, type RunCheckpointRead,
  type SendIntent, type SendIntentResult,
} from '../ops-writes'
import { invokeRun, type RunClock, type RunDb, type RunInvocationReport } from '../run-invocation'
import { UNCHARGED_RESUME_REASONS, type CheckpointAckOutcome, type ContinuationMode, type OpsStepRecordOutcome } from '../run-vocabulary'
import { StepEndsRun, walkOpsDefinition, type OpsStepHandler } from '../run-walk'

const ORG = organizationIdFrom('6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60')
const RUN_ID = '0192f4a0-0000-7000-8000-000000001951'

/** The ops run row, as the functions keep it. */
class RunRowDb implements RunDb {
  token = ''
  stateVersion = 1
  status: 'queued' | 'suspended' | 'claimed' | 'running' | 'done' | 'failed' | 'needs_human' | 'dead' = 'queued'
  attempts = 0
  unchargedAttempts = 0
  continuations = 0
  resumeReason: string | null = null
  pointer: (NamedCheckpoint & { executionId: string }) | null = null
  readonly ends: CompleteOutcome[] = []
  readonly records: Array<{ executionId: string; record: OpsStepRecord }> = []
  private claims = 0

  /** claim_run_requests: a new holder, the state version moved. */
  claim(): ClaimedRun {
    if (!['queued', 'suspended'].includes(this.status)) throw new Error(`run is ${this.status}, not claimable`)
    this.claims++
    this.token = `token-${this.claims}`
    this.stateVersion++
    this.status = 'claimed'
    return {
      runRequestId: RUN_ID, organizationId: ORG, workflowId: '00000000-0000-4000-8000-0000000019c0', workflowVersion: 1, triggerKind: 'schedule',
      claimToken: this.token, claimExpiresAt: '2026-10-28T12:01:00.000Z', stateVersion: this.stateVersion, attempts: this.attempts,
      unchargedAttempts: this.unchargedAttempts, maxAttempts: 3, resumeReason: this.resumeReason, executionChainId: RUN_ID,
      resumedFromExecutionId: null, payload: { amount: 3 }, payloadRef: null,
    }
  }

  async start(run: ClaimedRun) {
    if (run.claimToken !== this.token || this.status !== 'claimed') throw new OpsClaimLostError('start_run_execution: lost')
    this.status = 'running'
    this.attempts++
    if ((UNCHARGED_RESUME_REASONS as readonly (string | null)[]).includes(this.resumeReason)) this.unchargedAttempts++
    this.stateVersion++
    return { outcome: 'started' as const, stateVersion: this.stateVersion, attempt: this.attempts, continuations: this.continuations, runVariables: null }
  }

  async extend(run: ClaimedRun) {
    return run.claimToken === this.token && this.status === 'running'
  }

  private ledger = 0
  async recordIntent(run: ClaimedRun, intent: Omit<SendIntent, 'runRequestId' | 'claimToken'>): Promise<SendIntentResult> {
    if (run.claimToken !== this.token || this.status !== 'running' || intent.stateVersion !== this.stateVersion) return { outcome: 'stale', ledgerId: null, ledgerStatus: null }
    this.ledger++
    return { outcome: 'recorded', ledgerId: `ledger-${this.ledger}`, ledgerStatus: 'intent' }
  }

  async recordResult() {
    return 'recorded' as const
  }

  async recordStep(run: ClaimedRun, executionId: string, record: OpsStepRecord): Promise<OpsStepRecordOutcome> {
    if (run.claimToken !== this.token || this.status !== 'running') return 'stale'
    this.records.push({ executionId, record })
    return 'recorded'
  }

  async recordCheckpoint(run: ClaimedRun, ack: CheckpointAck): Promise<CheckpointAckOutcome> {
    if (run.claimToken !== this.token || this.status !== 'running' || ack.stateVersion !== this.stateVersion) return 'stale'
    if (this.pointer?.key === ack.key) return 'already_recorded'
    this.pointer = { key: ack.key, stateVersion: ack.stateVersion, steps: ack.steps, sha256: ack.sha256, bytes: ack.bytes, executionId: ack.executionId }
    return 'recorded'
  }

  async readCheckpoint(run: ClaimedRun): Promise<RunCheckpointRead> {
    if (run.claimToken !== this.token || !['claimed', 'running'].includes(this.status)) return { held: false }
    const p = this.pointer
    return { held: true, stateVersion: this.stateVersion, checkpoint: p && { key: p.key, stateVersion: p.stateVersion, steps: p.steps, sha256: p.sha256, bytes: p.bytes } }
  }

  async complete(run: ClaimedRun, end: CompleteOutcome) {
    if (run.claimToken !== this.token) throw new OpsClaimLostError('complete_run_request: lost')
    if (end.outcome === 'suspend' && end.reason === 'continue') {
      // The migration's refusal: a continuation needs a checkpoint this attempt named.
      if (this.pointer?.stateVersion !== this.stateVersion) throw new Error('complete_run_request: a continue suspend needs a checkpoint this attempt named')
      this.continuations++
    }
    this.ends.push(end)
    this.stateVersion++
    if (end.outcome === 'done') this.status = 'done'
    else if (end.outcome === 'retry') { this.status = 'queued'; this.resumeReason = 'retry' }
    else if (end.outcome === 'suspend') { this.status = 'suspended'; this.resumeReason = end.reason }
    else this.status = end.outcome
    return { outcome: 'completed' as const, runStatus: this.status }
  }
}

/** A clock whose timers never fire on their own: no deadline passes, and the heartbeat waits until it is stopped. */
function stillClock(): RunClock {
  let now = Date.parse('2026-10-28T12:00:00.000Z')
  return {
    now: () => (now += 5),
    timer: (_ms, signal) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    }),
  }
}

function memoryStore(): { store: CheckpointStore; objects: Map<string, string> } {
  const objects = new Map<string, string>()
  return {
    objects,
    store: {
      put: async (key, body) => {
        if (objects.has(key)) {
          if (objects.get(key) === body) return 'already_written'
          throw new Error(`${key} is taken`)
        }
        objects.set(key, body)
        return 'written'
      },
      get: async (key) => objects.get(key) ?? null,
    },
  }
}

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, namespace: id, type, config })
const edge = (source: string, target: string, sourceHandle?: string) => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { source_handle: sourceHandle } : {}) })

/** A branch that matches 'big' only when the payload's amount passes 50; the run's amount is 3, so it routes else, its SECOND arm. */
const pick = (id: string) => node(id, 'branch', {
  branches: [{ label: 'big', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.amount', operator: 'gt', value: '50' }] }] } }],
})

/** One run, sliced by invokeRun with the walk, slice after slice until it ends. */
function harness(definition: unknown, handlers: Readonly<Record<string, OpsStepHandler>>, sliceSteps: number, mode: ContinuationMode = 'on') {
  const db = new RunRowDb()
  const m = memoryStore()
  const logs: Array<Record<string, unknown>> = []
  let executions = 0
  const slice = (): Promise<RunInvocationReport> => invokeRun(
    { db, clock: stillClock(), newExecutionId: () => `0192f4a0-0000-7000-8000-${String(++executions).padStart(12, '0')}`, log: (e) => { logs.push(e) } },
    db.claim(),
    (ctx) => walkOpsDefinition(definition, ctx, handlers, {
      continuation: { mode, budget: { ...CONTINUATION_BUDGET, sliceSteps }, store: () => m.store, log: (e) => { logs.push(e) } },
    }),
  )
  return { db, m, logs, slice }
}

/** A step that sends one POST to its host and answers what it was told. */
function sender(sent: string[]): OpsStepHandler {
  return async ({ node: n, run }) => {
    const host = `${n.id}.example.test`
    await run.send({
      nodeId: n.id, seq: 0, method: 'POST', url: `https://${host}/`, idempotent: false,
      forward: async () => { sent.push(n.id); return { kind: 'answered', status: 200, value: { ok: true } } },
    })
    return { output: { sent: n.id } }
  }
}

describe('suspend and resume across invocations (#1951)', () => {
  it('failure shape 1: a branch that routed its second arm, resumed after a later failure, continues down the second arm', async () => {
    // shape -> pick routes else -> b1 -> b2 -> b3; its first arm, a, must never run.
    const def = {
      nodes: [node('shape', 'step'), pick('pick'), node('a', 'step'), node('b1', 'step'), node('b2', 'step'), node('b3', 'step')],
      edges: [edge('trigger', 'shape'), edge('shape', 'pick'), edge('pick', 'a', 'big'), edge('pick', 'b1', 'else'), edge('b1', 'b2'), edge('b2', 'b3')],
    }
    const ran: string[] = []
    const failOnce = new Set(['b2'])
    const step: OpsStepHandler = async ({ node: n }) => {
      if (failOnce.has(n.id)) {
        // A failure nothing of which can have changed anything (a GET past its deadline): the run is retried.
        failOnce.delete(n.id)
        throw new StepEndsRun({ outcome: 'retry', error: `step ${n.id} could not read its source this time` })
      }
      ran.push(n.id)
      return { output: { ran: n.id } }
    }
    const h = harness(def, { step }, 3)

    // Slice 1: shape, pick (else), b1, then the boundary: suspended to continue.
    expect(await h.slice()).toMatchObject({ outcome: 'completed', end: { outcome: 'suspend', reason: 'continue' } })
    // Slice 2 resumes at b2, which fails: the run is retried.
    expect(await h.slice()).toMatchObject({ outcome: 'completed', end: { outcome: 'retry' } })
    // Slice 3, the retry, resumes from the same checkpoint and goes on down the second arm.
    expect(await h.slice()).toMatchObject({ outcome: 'completed', end: { outcome: 'done' } })

    expect(ran).toEqual(['shape', 'b1', 'b2', 'b3'])
    expect(h.db.status).toBe('done')
    // The continuation was not charged; the retry was.
    expect({ attempts: h.db.attempts, unchargedAttempts: h.db.unchargedAttempts, continuations: h.db.continuations }).toEqual({ attempts: 3, unchargedAttempts: 1, continuations: 1 })
  })

  it('failure shape 2: a first wins choice whose winner completed and sent never re-fires the loser, and the winner never sends twice', async () => {
    // first routes else (the winner's arm) -> winner sends -> after sends; the loser arm sends too, and must never run.
    const def = {
      nodes: [pick('first'), node('loser', 'send'), node('winner', 'send'), node('after', 'send')],
      edges: [edge('trigger', 'first'), edge('first', 'loser', 'big'), edge('first', 'winner', 'else'), edge('winner', 'after')],
    }
    const sent: string[] = []
    const h = harness(def, { send: sender(sent) }, 2)

    // Slice 1: first, winner (sends), boundary.
    expect(await h.slice()).toMatchObject({ end: { outcome: 'suspend', reason: 'continue' } })
    expect(sent).toEqual(['winner'])
    // Slice 2 resumes at after: the winner is restored, not run, and the loser never fires.
    expect(await h.slice()).toMatchObject({ end: { outcome: 'done' } })
    expect(sent).toEqual(['winner', 'after'])
  })

  it('a continuation after a send that cannot be repeated resumes after it: every send is made exactly once across the slices', async () => {
    const def = {
      nodes: ['p0', 'p1', 'p2', 'p3', 'p4'].map((id) => node(id, 'send')),
      edges: [edge('trigger', 'p0'), edge('p0', 'p1'), edge('p1', 'p2'), edge('p2', 'p3'), edge('p3', 'p4')],
    }
    const sent: string[] = []
    const h = harness(def, { send: sender(sent) }, 2)
    const ends: string[] = []
    for (let i = 0; i < 5 && !['done', 'failed', 'needs_human', 'dead'].includes(h.db.status); i++) {
      const r = await h.slice()
      ends.push(r.outcome === 'completed' ? `${r.end.outcome}${'reason' in r.end ? `:${r.end.reason}` : ''}` : r.outcome)
    }
    expect(ends).toEqual(['suspend:continue', 'suspend:continue', 'done'])
    expect(sent).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
    // Each slice's step records are its own attempt's, from place 0.
    const byExecution = new Map<string, number[]>()
    for (const r of h.db.records) byExecution.set(r.executionId, [...(byExecution.get(r.executionId) ?? []), r.record.seq])
    expect([...byExecution.values()]).toEqual([[0, 1], [0, 1], [0]])
  })

  it('a stale holder never resumes: a holder whose run was claimed again reads no checkpoint, runs no step and completes nothing', async () => {
    const def = { nodes: ['p0', 'p1', 'p2'].map((id) => node(id, 'send')), edges: [edge('trigger', 'p0'), edge('p0', 'p1'), edge('p1', 'p2')] }
    const sent: string[] = []
    const h = harness(def, { send: sender(sent) }, 1)
    await h.slice()
    expect(h.db.continuations).toBe(1)
    // The continuation is claimed and started by a holder, then swept and claimed by another before the first reads its checkpoint.
    const stale = h.db.claim()
    const readCheckpoint = h.db.readCheckpoint.bind(h.db)
    h.db.readCheckpoint = async (run) => {
      if (run.claimToken === stale.claimToken) {
        h.db.status = 'queued'
        h.db.claim()
      }
      return readCheckpoint(run)
    }
    const report = await invokeRun(
      { db: h.db, clock: stillClock(), newExecutionId: () => '0192f4a0-0000-7000-8000-0000000000ff', log: () => undefined },
      stale,
      (ctx) => walkOpsDefinition(def, ctx, { send: sender(sent) }, { continuation: { mode: 'on', budget: { ...CONTINUATION_BUDGET, sliceSteps: 1 }, store: () => h.m.store, log: () => undefined } }),
    )
    expect(report).toEqual({ outcome: 'claim_lost', during: 'checkpoint' })
    expect(sent).toEqual(['p0'])
    expect(h.db.ends).toHaveLength(1)
  })

  it('a parallel node never reaches a checkpoint: the ops walk refuses it before any step runs', async () => {
    const def = { nodes: [node('fan', 'parallel'), node('p0', 'send')], edges: [edge('trigger', 'fan'), edge('fan', 'p0')] }
    const sent: string[] = []
    const h = harness(def, { send: sender(sent) }, 1)
    expect(await h.slice()).toMatchObject({ end: { outcome: 'failed', error: 'an ops run cannot take a step of type parallel yet, so nothing was run' } })
    expect(sent).toEqual([])
    expect(h.m.objects.size).toBe(0)
  })
})
