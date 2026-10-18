/**
 * Measures the at-risk watch's gap (#2055, from phase D of #2015).
 *
 * The watch (at-risk-writes.ts, #2022) records a post-answer Salesforce write in
 * KV only once it has been out for 2 s, so the Salesforce read-back (#2023) can
 * find it. The #2015 plan accepted one gap for that saving and asked for it to be
 * measured after launch: a write whose record never lands. Nothing will ever read
 * such a write back. It happens three ways, and this ledger sees all three from
 * inside the run, in memory, without reading KV:
 *
 *  - the record's own KV write failed, or the watch never started (it logs and
 *    lets the write run unrecorded);
 *  - the run was cut off (12 s after the answer, #1860) while the write was still
 *    inside its first 2 s, and the request's work ended before its mark;
 *  - the write started with less than 2 s left before Cloudflare cancels the
 *    request's work (30 s after the answer, WAIT_UNTIL_LIMIT_MS), so its mark
 *    falls after the cancel.
 *
 * WHAT IT WRITES. One KV key per fact, under its own prefix, kept 8 days:
 * `at-risk-gap:<UTC day>:<kind>:<execution id>:<step>`. Per fact, not a counter,
 * because a read-then-write counter undercounts exactly when many runs are cut
 * off at once, which is the slowdown this exists for. The kinds:
 *
 *  - cut_off: a run was cut off with its walk still out (step `-`). The
 *    denominator.
 *  - held: a watched write running at the cut-off whose record is in KV.
 *  - unrecorded: a watched write running at the cut-off past its 2 s mark (and
 *    the grace for the record to land) with no record. A gap.
 *  - exposed: a watched write running at the cut-off still inside its first 2 s.
 *  - late_start: a watched write that started too close to the cancel.
 *  - caught_up / missed: the second look of an exposed or late write once its mark
 *    and grace passed, or it settled: recorded or settled, or neither (a gap).
 *
 * An exposed or late write with NO second look is the third gap: the request's work
 * was cancelled before the second look ran, which is the isolate dying inside the
 * write's first 2 s that the plan named. Its absence is the evidence, which is
 * why the start is written eagerly and the second look separately.
 *
 * The daily report (lib/at-risk-gap-report.ts) reads these and records one
 * job_runs row a day. Nothing here pages: every run this counts already pages
 * under continuation_unfinished, which pages whenever a write still out at the
 * cut-off has no record the read-back owns, or a write lies ahead (#2024). See
 * the report's header for the measured rate and the decision.
 *
 * Read only with respect to Salesforce: it measures, it never resends.
 */
import { formatErr } from '../lib/format-error'
import type { RetryClock } from '../lib/post-response-budget'
import { AT_RISK_AFTER_MS, atRiskKey, type AtRiskKv, type AtRiskWatch } from './at-risk-writes'

export const AT_RISK_GAP_PREFIX = 'at-risk-gap:'
/** A week of evidence, and a day for the report to run late. */
export const AT_RISK_GAP_TTL_SECONDS = 8 * 24 * 60 * 60
/**
 * How long past its 2 s mark a write's record may take to land before it counts
 * as missing: an encrypt and one KV write, well inside a second.
 */
export const RECORD_GRACE_MS = 1_000

export const AT_RISK_GAP_KINDS = ['cut_off', 'held', 'unrecorded', 'exposed', 'late_start', 'caught_up', 'missed'] as const
export type AtRiskGapKind = (typeof AT_RISK_GAP_KINDS)[number]

/** The step a run level fact (cut_off) is keyed by. */
export const RUN_LEVEL_STEP = '-'

export const atRiskGapKey = (day: string, kind: AtRiskGapKind, executionId: string, stepNamespace: string): string =>
  `${AT_RISK_GAP_PREFIX}${day}:${kind}:${executionId}:${stepNamespace}`

export interface AtRiskGapFact {
  day: string
  kind: AtRiskGapKind
  execution_id: string
  step_namespace: string
}

/** A key as atRiskGapKey built it, or null. The step is the rest, colons and all. */
export function parseAtRiskGapKey(name: string): AtRiskGapFact | null {
  if (!name.startsWith(AT_RISK_GAP_PREFIX)) return null
  const parts = name.slice(AT_RISK_GAP_PREFIX.length).split(':')
  if (parts.length < 4) return null
  const [day, kind, executionId, ...step] = parts
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(AT_RISK_GAP_KINDS as readonly string[]).includes(kind) || !executionId) return null
  const stepNamespace = step.join(':')
  if (!stepNamespace) return null
  return { day, kind: kind as AtRiskGapKind, execution_id: executionId, step_namespace: stepNamespace }
}

/** The UTC calendar day of a time, the day the report reads the fact under. */
export const utcDayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

interface WatchedStep {
  startedAtMs: number
  recorded: boolean
  settled: boolean
  /** Told once when the step settles, so a second look need not wait out its timer. */
  onSettle: Array<() => void>
}

export interface AtRiskLedgerOptions {
  kv: AtRiskKv
  clock: RetryClock
  run: { workflowId: string; executionId: string }
  /** Milliseconds until Cloudflare cancels the request's work: infinite before the answer. */
  msUntilCancel: () => number
  /** Keeps a write the ledger starts on its own (a late start's) alive past the step. */
  waitUntil?: (p: Promise<unknown>) => void
}

export class AtRiskLedger {
  private readonly steps = new Map<string, WatchedStep>()

  constructor(private readonly opts: AtRiskLedgerOptions) {}

  /**
   * Wraps the run's watch starter: every watch it starts is followed here, its
   * record seen landing through the KV it is handed, and its settle seen. A
   * starter that throws is followed too, as a write with no record.
   */
  follow(start: (stepNamespace: string, kv: AtRiskKv) => AtRiskWatch): (stepNamespace: string) => AtRiskWatch {
    return (stepNamespace) => {
      const step: WatchedStep = { startedAtMs: this.opts.clock.now(), recorded: false, settled: false, onSettle: [] }
      this.steps.set(stepNamespace, step)
      const recordKey = atRiskKey(this.opts.run.executionId, stepNamespace)
      const kv: AtRiskKv = {
        put: async (key, value, putOpts) => {
          await this.opts.kv.put(key, value, putOpts)
          if (key === recordKey) step.recorded = true
        },
        delete: (key) => this.opts.kv.delete(key),
      }
      const watch = start(stepNamespace, kv)
      if (this.opts.msUntilCancel() < AT_RISK_AFTER_MS) {
        const work = this.expose(stepNamespace, step, 'late_start', utcDayOf(this.opts.clock.now()))
        this.opts.waitUntil?.(work)
      }
      return {
        ...watch,
        settle: (outcome) => {
          step.settled = true
          for (const tell of step.onSettle.splice(0)) tell()
          return watch.settle(outcome)
        },
      }
    }
  }

  /**
   * The run was cut off with `runningNamespaces` still out. Writes the run's fact,
   * one per watched write among them, and looks again at any still inside its first
   * 2 s. Resolves when every second look is written. Never throws.
   */
  async measureCutOff(runningNamespaces: readonly string[]): Promise<void> {
    const now = this.opts.clock.now()
    const day = utcDayOf(now)
    const work: Promise<void>[] = [this.put(day, 'cut_off', RUN_LEVEL_STEP, now)]
    for (const ns of new Set(runningNamespaces)) {
      const step = this.steps.get(ns)
      // Not a watched write (a relay post, a code node, an Achieve call): none of this ledger's.
      if (!step || step.settled) continue
      if (step.recorded) {
        work.push(this.put(day, 'held', ns, now))
      } else if (now - step.startedAtMs >= AT_RISK_AFTER_MS + RECORD_GRACE_MS) {
        console.error(`[at-risk-gap] step ${ns} of execution ${this.opts.run.executionId} was still out at the cut-off ${now - step.startedAtMs} ms after it started, with no at-risk record: nothing will read this write back`)
        work.push(this.put(day, 'unrecorded', ns, now))
      } else {
        work.push(this.expose(ns, step, 'exposed', day))
      }
    }
    await Promise.all(work)
  }

  /** Writes the start eagerly, then the second look once the mark and grace pass or the step settles. */
  private async expose(ns: string, step: WatchedStep, kind: 'exposed' | 'late_start', day: string): Promise<void> {
    const started = this.put(day, kind, ns, this.opts.clock.now())
    const stop = new AbortController()
    const wait = Math.max(0, step.startedAtMs + AT_RISK_AFTER_MS + RECORD_GRACE_MS - this.opts.clock.now())
    const settled = new Promise<void>((resolve) => {
      if (step.settled) resolve()
      else step.onSettle.push(resolve)
    })
    await Promise.race([this.opts.clock.timer(wait, stop.signal), settled])
    stop.abort()
    const caughtUp = step.recorded || step.settled
    if (!caughtUp) {
      console.error(`[at-risk-gap] step ${ns} of execution ${this.opts.run.executionId} passed its 2 s mark with no at-risk record (${kind}): nothing will read this write back`)
    }
    await Promise.all([started, this.put(day, caughtUp ? 'caught_up' : 'missed', ns, this.opts.clock.now())])
  }

  private async put(day: string, kind: AtRiskGapKind, ns: string, atMs: number): Promise<void> {
    const step = this.steps.get(ns)
    const value = {
      v: 1,
      workflow_id: this.opts.run.workflowId,
      execution_id: this.opts.run.executionId,
      step_namespace: ns,
      at: new Date(atMs).toISOString(),
      ...(step ? { age_ms: atMs - step.startedAtMs } : {}),
    }
    try {
      await this.opts.kv.put(atRiskGapKey(day, kind, this.opts.run.executionId, ns), JSON.stringify(value), { expirationTtl: AT_RISK_GAP_TTL_SECONDS })
    } catch (e) {
      // The measurement is lost, not the write it measures; said, never thrown into the run.
      console.error(`[at-risk-gap] could not record ${kind} for step ${ns} of execution ${this.opts.run.executionId}:`, formatErr(e))
    }
  }
}
