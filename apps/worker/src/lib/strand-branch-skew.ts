/**
 * Catch a strand-drain branch that cannot fire (#1133).
 *
 * resolveStrandedExecution resolves each stranded run down one of four evidence
 * branches (failed_step, graph_dead_end, sighting_outcome, unresolved). The
 * precise branches sit in front of a conservative, always-correct `unresolved`
 * fallback, and the fallback being truthful is exactly what hides a precise
 * branch that never matches (L551): #1112 resolved 119 of 119 rows as
 * `unresolved` over 14 days, with graph_dead_end never once firing, and that read
 * as the drain being careful rather than as a dead branch.
 *
 * So this tallies the branches each drain run took (counted in the drain, fed
 * here), accumulates them across a window, and when the `unresolved` fallback has
 * resolved EVERY row over a meaningful sample and NOT ONE precise branch ever
 * fired, alerts: the shape of a precise path that cannot match. It deliberately
 * does not flag a single precise branch merely being absent (graph_dead_end is
 * legitimately zero for a code-node-answering workflow); only the precise
 * evidence never once helping is the signal (see decideBranchSkew). It is a slow
 * recalibration signal, not an incident, so it re-surfaces on a monthly cooldown.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { STRAND_BRANCHES, emptyBranchCounts, type StrandBranch } from './stranded-executions'
import { rateLimitedOrgAlert, type CooldownKv } from './alert-fanout'
import { getSlackConnection, postMessage } from './slack'
import { formatErr } from './format-error'

/** The sample below which the distribution says nothing (a rate needs a denominator, L716). */
export const SKEW_MIN_SAMPLE = 50

/** The fallback branch, and the precise branches that sit in front of it. */
const FALLBACK_BRANCH: StrandBranch = 'unresolved'
const PRECISE_BRANCHES: readonly StrandBranch[] = ['failed_step', 'graph_dead_end', 'sighting_outcome']

export interface SkewVerdict {
  /** Whether the fallback resolved everything while no precise branch ever fired. */
  skewed: boolean
  /** The alert sentence, naming the measurement; null when not skewed. */
  reason: string | null
}

/**
 * Decide whether the branch tally is the shape #1112 had (#1133): over a
 * meaningful sample, the conservative `unresolved` FALLBACK resolved every row
 * and NOT ONE precise branch (failed_step, graph_dead_end, sighting_outcome)
 * ever fired. Pure, so it is exercised against measured shapes with no KV or
 * database near the test.
 *
 * Deliberately NOT "any branch at zero dominates". A single precise branch at
 * zero is ambiguous, not a defect: graph_dead_end is legitimately zero for a
 * workflow that answers from inside a code node (it never reaches a terminal
 * node), and failed_step is zero whenever nothing failed. Flagging those would
 * page on a healthy drain. The robust, low-false-positive signal is that the
 * precise evidence NEVER ONCE helps: even a code-node flow should sometimes see a
 * failed step or a recorded sighting outcome, so zero precise resolutions over
 * fifty-plus rows is the fallback hiding a precise path that cannot match (L551),
 * which is exactly #1112 (119 of 119 unresolved, every precise branch dead). A
 * single precise resolution clears it: the precise path demonstrably CAN fire.
 */
export function decideBranchSkew(
  counts: Record<StrandBranch, number>,
  opts: { minSample?: number } = {},
): SkewVerdict {
  const minSample = opts.minSample ?? SKEW_MIN_SAMPLE
  const total = STRAND_BRANCHES.reduce((sum, b) => sum + (counts[b] ?? 0), 0)
  if (total < minSample) return { skewed: false, reason: null }

  const preciseTotal = PRECISE_BRANCHES.reduce((sum, b) => sum + (counts[b] ?? 0), 0)
  // Any precise resolution at all means the precise path can fire: not a dead branch.
  if (preciseTotal > 0) return { skewed: false, reason: null }

  const fallbackCount = counts[FALLBACK_BRANCH] ?? 0
  const pct = Math.round((fallbackCount / total) * 100)
  // Admin-facing: plain, actionable, no internal lesson or issue references.
  return {
    skewed: true,
    reason:
      `The stranded-run cleanup resolved all ${total} of its recent runs (${pct}%) with the conservative "unknown ` +
      `outcome" fallback, and never once used any of the precise checks (failed step, completed workflow, recorded ` +
      `outcome). Over this many runs at least one precise check should have matched, so a precise check has likely ` +
      `stopped working. Have an engineer review how stranded runs are resolved.`,
  }
}

const WINDOW_KEY = 'strand-branch-skew:window'
/** Re-surface monthly until someone acts: this is recalibration, not an incident. */
const SKEW_COOLDOWN_SECONDS = 30 * 24 * 60 * 60
const SKEW_COOLDOWN_KEY = 'strand-branch-skew-cooldown'
/**
 * The longest a window below the sample is allowed to span before it is aged out
 * and restarted. A window that sits part-full for over a month is stale: the
 * distribution it holds is no longer about the present. Comfortably longer than
 * the cooldown so a healthy, slowly-filling window is never reset mid-fill.
 */
const MAX_WINDOW_MS = 45 * 24 * 60 * 60 * 1000

interface SkewWindow {
  since: string
  counts: Record<StrandBranch, number>
}

function parseWindow(raw: string | null, nowIso: string): SkewWindow {
  if (raw === null) return { since: nowIso, counts: emptyBranchCounts() }
  try {
    const parsed = JSON.parse(raw) as Partial<SkewWindow>
    const counts = emptyBranchCounts()
    for (const b of STRAND_BRANCHES) {
      const v = (parsed.counts as Record<string, unknown> | undefined)?.[b]
      counts[b] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
    }
    // Fall back to now when `since` is absent or unparseable, so the staleness
    // check never silently disables itself on a NaN date (L50).
    const sinceOk = typeof parsed.since === 'string' && Number.isFinite(Date.parse(parsed.since))
    return { since: sinceOk ? (parsed.since as string) : nowIso, counts }
  } catch {
    // An unparseable window restarts the accumulation rather than throwing: this
    // is a best-effort recalibration signal, and a reset loses at most one window.
    return { since: nowIso, counts: emptyBranchCounts() }
  }
}

/**
 * Add this run's branch tally to the window, and when it has reached a meaningful
 * sample, evaluate the distribution and alert if the precise evidence never fired
 * (#1133). The window is RESET once it has been judged, whatever the alert outcome,
 * so it can never grow without bound and the Slack fan-out is never re-run tick
 * after tick while delivery fails. A failed delivery is re-detected on the next
 * full window (a dead branch is persistent) and the monthly cooldown dedups the
 * deliveries that land. Best-effort; the caller runs it in the drain's waitUntil.
 * Returns whether it alerted.
 */
export async function recordAndCheckBranchSkew(
  kv: CooldownKv,
  byBranch: Record<StrandBranch, number>,
  deps: { supabase: SupabaseClient; appUrl: string; nowMs?: number; minSample?: number },
): Promise<boolean> {
  const nowMs = deps.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const minSample = deps.minSample ?? SKEW_MIN_SAMPLE

  // A tick with no resolved rows (the common case: no stranded runs, or a scan
  // that failed) has nothing to add, so it touches no KV at all, not on every one
  // of the ~1,440 daily ticks. A part-full window is aged out on the next tick
  // that does bring rows, which is the only tick whose judgement it could affect.
  const added = STRAND_BRANCHES.reduce((sum, b) => sum + (byBranch[b] ?? 0), 0)
  if (added === 0) return false

  let window: SkewWindow
  try {
    window = parseWindow(await kv.get(WINDOW_KEY), nowIso)
  } catch (e) {
    console.error('[strand-branch-skew] could not read the window, skipping:', formatErr(e))
    return false
  }

  // Age out a stale window BEFORE evaluating, so a window whose distribution is
  // months old is never judged (nor crosses the sample) on stale data. A reset
  // keeps THIS tick's rows, so the current run is never discarded.
  const sinceMs = Date.parse(window.since)
  const stale = Number.isFinite(sinceMs) && nowMs - sinceMs >= MAX_WINDOW_MS
  if (stale) window = { since: nowIso, counts: emptyBranchCounts() }
  for (const b of STRAND_BRANCHES) window.counts[b] += byBranch[b] ?? 0

  const freshWindow = () => JSON.stringify({ since: nowIso, counts: emptyBranchCounts() })
  const total = STRAND_BRANCHES.reduce((sum, b) => sum + window.counts[b], 0)
  if (total < minSample) {
    // Still accumulating: keep filling the (possibly just-reset) window.
    await kv.put(WINDOW_KEY, JSON.stringify(window))
    return false
  }

  // Enough to judge. Reset the window now it has been judged, WHATEVER the alert
  // outcome, and persist that reset before alerting. This is the one reset rule
  // that avoids every pathology of keeping the window: a kept window either grows
  // without bound (no Slack configured) or re-runs the Slack fan-out on every tick
  // while delivery is failing. A failed alert is not a lost signal here: the dead
  // branch is PERSISTENT, so the next full window re-detects it, and the monthly
  // cooldown dedups the deliveries that do land. (A low-volume path pays a delay
  // of one more window, which is acceptable for a slow recalibration signal.)
  const verdict = decideBranchSkew(window.counts, { minSample })
  await kv.put(WINDOW_KEY, freshWindow())
  if (!verdict.skewed) return false

  const reason = verdict.reason ?? ''
  return rateLimitedOrgAlert({
    kv,
    cooldownKey: SKEW_COOLDOWN_KEY,
    ttlSeconds: SKEW_COOLDOWN_SECONDS,
    supabase: deps.supabase,
    logLabel: 'strand-branch-skew',
    perOrg: async (orgId) => {
      const slack = await getSlackConnection(deps.supabase, orgId)
      if (!slack || !slack.config_alerts_enabled) return false
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'Stranded-run cleanup may be missing outcomes', emoji: false } },
        { type: 'section', text: { type: 'mrkdwn', text: reason } },
        { type: 'section', text: { type: 'mrkdwn', text: `<${deps.appUrl}/dashboard|Open dashboard>` } },
      ]
      return (await postMessage(slack.bot_token, slack.default_channel, blocks, 'Stranded-run cleanup may be missing outcomes')) !== null
    },
  })
}
