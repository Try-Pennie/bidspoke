/**
 * What the daily Step Timeout Warnings alert lists, judged over five days (#2934,
 * Dan's decisions of 2026-10-29).
 *
 * The alert used to judge a step only on the runs that FINISHED, over the two
 * hours or the day before it. That over reported a short slow patch (2026-10-28,
 * Engine Bidding) and missed steps that were losing runs (2026-10-29, Main Flow's
 * Credit Collections): a run the timeout cuts off never finishes, so it is never
 * in that sample, and a finished run of a step with no retries can never be
 * slower than its timeout. So the alert now reads two things over five days:
 *
 * - The runs that failed on the timeout ("Step timed out after" final failures).
 *   Two or more is a step losing runs. When every one of them falls inside one
 *   short burst it is an incident instead, a likely upstream outage, shown with
 *   its window and no suggested timeout (#1474): raising a timeout does not help
 *   a call that hangs.
 * - An even sample of finished runs across the five days (at most a fixed number
 *   per hour), so one slow day weighs one fifth and not the whole. A timeout
 *   below the suggestion from it is thin headroom, a lower urgency section.
 *
 * The canvas badge and the config panel keep their fresher adaptive reading
 * (collectWorkflowDurationStats): someone editing a step wants to know how it
 * runs now. Only the push alert judges the period.
 *
 * Pure: the readers live in timeout-audit.ts and the wording in slack.ts.
 */
import type { WorkflowDefinition } from '../types'
import { suggestionFloorMs } from './timeout-floor'
import { nodeRetries, underProvision } from './timeout-suggestion'

/** How many days the alert judges (Dan, 2026-10-28). */
export const AUDIT_PERIOD_DAYS = 5

/** Timed out runs in the period that list a step (Dan, 2026-10-29). One is an unlucky run. */
export const TIMED_OUT_RUNS_TO_LIST = 2

/**
 * The longest span of lost runs read as one burst, an incident rather than a
 * timeout set too low (#1474: "inside one contiguous hour or two"). The outage
 * of 2026-10-29 ran 10:41 AM to 12:08 PM ET.
 */
export const OUTAGE_BURST_MS = 2 * 60 * 60 * 1000

/**
 * Below this many sampled runs a headroom finding is not listed: its p99 would
 * be little more than its slowest run. The config panel shows its callout at
 * the same count.
 */
export const HEADROOM_MIN_SAMPLE = 10

/** One step's five day reading, as `step_timeout_audit_by_workflow` answers it. */
export interface PeriodStepStats {
  p50: number | null
  p99: number | null
  max_ms: number | null
  /** Finished runs in the even sample. */
  sample_size: number
  /** Every run in the period that failed on its timeout. */
  timed_out: number
  /** When those runs started, the most recent ones first if the function had to cap them. */
  timed_out_at: string[]
}

interface StepRef {
  node_id: string
  namespace: string
  label: string | null
  type: string
  configured_ms: number
}

export interface Burst {
  count: number
  start: string
  end: string
}

/** Two or more runs failed on the timeout, not all in one burst. */
export interface LosingRunsFinding extends StepRef {
  kind: 'losing_runs'
  retries: number
  timed_out: number
  /** When the latest started; null only if the reading carried no readable time for them. */
  latest_at: string | null
  /** The densest short burst among them, when it holds two or more but not all. */
  burst: Burst | null
  /** The five day suggestion, only when it is above the setting. */
  suggested_ms: number | null
}

/** Every lost run fell in one short burst: a likely upstream outage. */
export interface OutageFinding extends StepRef {
  kind: 'outage'
  timed_out: number
  start: string
  end: string
}

/** Nothing (or one run) lost, but the setting sits under the five day suggestion. */
export interface HeadroomFinding extends StepRef {
  kind: 'headroom'
  retries: number
  suggested_ms: number
  p99_ms: number
  max_ms: number
  sample_size: number
  severity: 'red' | 'amber'
}

export type PeriodFinding = LosingRunsFinding | OutageFinding | HeadroomFinding

export interface WorkflowPeriodFindings {
  workflow_id: string
  workflow_name: string
  findings: PeriodFinding[]
}

/**
 * The window of at most `spanMs` holding the most of `times` (epoch ms, any
 * order), the latest such window when two hold as many. Null for no times.
 */
export function densestBurst(times: number[], spanMs: number): { count: number; start: number; end: number } | null {
  if (times.length === 0) return null
  const t = [...times].sort((a, b) => a - b)
  let best = { count: 0, start: 0, end: 0 }
  let lo = 0
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi] - t[lo] > spanMs) lo++
    const count = hi - lo + 1
    if (count >= best.count) best = { count, start: t[lo], end: t[hi] }
  }
  return best
}

const iso = (ms: number) => new Date(ms).toISOString()

/**
 * Every step of one workflow the alert lists from its five day reading. A step
 * below the reliable minimum is left to the sub floor section, which already
 * names it. A step is listed once: losing runs or an incident before headroom.
 */
export function findPeriodFindings(
  definition: WorkflowDefinition | null | undefined,
  statsByNamespace: Map<string, PeriodStepStats>,
): PeriodFinding[] {
  const nodes = definition?.nodes
  if (!Array.isArray(nodes)) return []
  const losing: LosingRunsFinding[] = []
  const outages: OutageFinding[] = []
  const headroom: HeadroomFinding[] = []
  for (const node of nodes) {
    const configured = node.config?.timeout_ms
    if (typeof configured !== 'number') continue
    if (configured < suggestionFloorMs(node.type)) continue
    const stats = statsByNamespace.get(node.namespace)
    if (!stats) continue
    const ref: StepRef = { node_id: node.id, namespace: node.namespace, label: node.label ?? null, type: node.type, configured_ms: configured }
    const retries = nodeRetries(node.config)

    if (stats.timed_out >= TIMED_OUT_RUNS_TO_LIST) {
      const times = stats.timed_out_at.map((s) => Date.parse(s)).filter((n) => Number.isFinite(n))
      const burst = densestBurst(times, OUTAGE_BURST_MS)
      // All in one burst only when the burst holds every lost run: a capped list
      // of times (the function returns the latest 1,000) holds fewer than the
      // count, so a burst within it can never pass for all of them.
      const allInOneBurst = burst !== null && burst.count === stats.timed_out
      if (allInOneBurst) {
        outages.push({ kind: 'outage', ...ref, timed_out: stats.timed_out, start: iso(burst.start), end: iso(burst.end) })
        continue
      }
      const judged = stats.p99 != null && stats.max_ms != null && stats.sample_size >= HEADROOM_MIN_SAMPLE
        ? underProvision(node.type, configured, retries, stats.p99, stats.max_ms)
        : null
      losing.push({
        kind: 'losing_runs',
        ...ref,
        retries,
        timed_out: stats.timed_out,
        latest_at: times.length > 0 ? iso(Math.max(...times)) : null,
        burst: burst && burst.count >= TIMED_OUT_RUNS_TO_LIST ? { count: burst.count, start: iso(burst.start), end: iso(burst.end) } : null,
        suggested_ms: judged?.suggested_ms ?? null,
      })
      continue
    }

    if (stats.p99 == null || stats.max_ms == null || stats.sample_size < HEADROOM_MIN_SAMPLE) continue
    const judged = underProvision(node.type, configured, retries, stats.p99, stats.max_ms)
    if (!judged) continue
    headroom.push({
      kind: 'headroom', ...ref, retries,
      suggested_ms: judged.suggested_ms, p99_ms: stats.p99, max_ms: stats.max_ms,
      sample_size: stats.sample_size, severity: judged.severity,
    })
  }
  // Most in trouble first: most runs lost, the largest incident, red before amber.
  losing.sort((a, b) => b.timed_out - a.timed_out)
  outages.sort((a, b) => b.timed_out - a.timed_out)
  headroom.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'red' ? -1 : 1))
  return [...losing, ...outages, ...headroom]
}

/**
 * The part of the dedupe signature these findings contribute: which step, at
 * which setting, read which way. Counts and percentiles move every day and
 * would re-send an unchanged alert; an incident carries its start, so a new one
 * on the same step is new.
 */
export function periodFindingsSignature(workflows: WorkflowPeriodFindings[]): string {
  return workflows
    .flatMap((w) => w.findings.map((f) => {
      const base = `${w.workflow_id}:${f.node_id}:${f.configured_ms}`
      return f.kind === 'outage' ? `${base}:outage:${f.start}` : `${base}:${f.kind}`
    }))
    .sort()
    .join('|')
}
