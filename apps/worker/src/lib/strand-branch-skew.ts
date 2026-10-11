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
 * here), accumulates them across a window, and when one branch has taken
 * effectively everything over a meaningful sample while another never fired,
 * alerts: the shape of a branch that cannot match. It is a slow recalibration
 * signal, not an incident, so it re-surfaces on a monthly cooldown.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { STRAND_BRANCHES, emptyBranchCounts, type StrandBranch } from './stranded-executions'
import { rateLimitedOrgAlert, type CooldownKv } from './alert-fanout'
import { getSlackConnection, postMessage } from './slack'
import { formatErr } from './format-error'

/** The sample below which the distribution says nothing (a rate needs a denominator, L716). */
export const SKEW_MIN_SAMPLE = 50
/** The share one branch must exceed to count as "effectively everything". */
export const SKEW_DOMINANCE_SHARE = 0.98

export interface SkewVerdict {
  /** Whether one branch dominates while another never fired. */
  skewed: boolean
  /** The alert sentence, naming the measurement; null when not skewed. */
  reason: string | null
}

/**
 * Decide whether the branch tally is the shape of a dead branch (#1133): a
 * meaningful sample, one branch taking at least SKEW_DOMINANCE_SHARE of it, and
 * at least one other branch that never fired. Pure, so it is exercised against
 * measured shapes with no KV or database near the test.
 *
 * A branch at zero is the signal, not merely a dominant branch: 98% down one
 * branch with the rest spread thinly is a drain doing its job, while 98% down
 * one branch with another at a flat zero over fifty-plus rows is a branch that
 * may be unable to match. The never-flagged direction (all branches firing) is
 * deliberately silent.
 */
export function decideBranchSkew(
  counts: Record<StrandBranch, number>,
  opts: { minSample?: number; dominanceShare?: number } = {},
): SkewVerdict {
  const minSample = opts.minSample ?? SKEW_MIN_SAMPLE
  const dominanceShare = opts.dominanceShare ?? SKEW_DOMINANCE_SHARE
  const total = STRAND_BRANCHES.reduce((sum, b) => sum + (counts[b] ?? 0), 0)
  if (total < minSample) return { skewed: false, reason: null }

  const dominant = STRAND_BRANCHES.reduce((top, b) => ((counts[b] ?? 0) > (counts[top] ?? 0) ? b : top), STRAND_BRANCHES[0])
  const dominantCount = counts[dominant] ?? 0
  if (dominantCount / total < dominanceShare) return { skewed: false, reason: null }

  const deadBranches = STRAND_BRANCHES.filter((b) => (counts[b] ?? 0) === 0)
  if (deadBranches.length === 0) return { skewed: false, reason: null }

  const pct = Math.round((dominantCount / total) * 100)
  return {
    skewed: true,
    reason:
      `The strand drain resolved ${dominantCount} of ${total} rows (${pct}%) via the ${dominant} branch, and these ` +
      `branches never fired: ${deadBranches.join(', ')}. That is the shape of a branch that cannot match the data it ` +
      `is meant to. Check resolveStrandedExecution against a real stranded run before trusting the ${dominant} verdict ` +
      `(#1133; this is how #1112 stayed invisible for 14 days).`,
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
 * sample, evaluate the distribution, reset the window, and alert if a branch has
 * gone dead (#1133). Best-effort; the caller runs it in the drain's waitUntil.
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

  // Enough to judge. A healthy distribution starts a fresh window at once, so a
  // later fix shows up. A skewed one alerts; the window is reset only once the
  // signal has been delivered OR is being deliberately suppressed by the cooldown
  // (so a known skew does not accumulate forever), and KEPT on a genuine delivery
  // failure so the next tick retries rather than losing the signal for another
  // whole sample.
  const verdict = decideBranchSkew(window.counts, { minSample })
  if (!verdict.skewed) {
    await kv.put(WINDOW_KEY, freshWindow())
    return false
  }

  const inCooldown = (await kv.get(SKEW_COOLDOWN_KEY)) !== null
  const reason = verdict.reason ?? ''
  const alerted = await rateLimitedOrgAlert({
    kv,
    cooldownKey: SKEW_COOLDOWN_KEY,
    ttlSeconds: SKEW_COOLDOWN_SECONDS,
    supabase: deps.supabase,
    logLabel: 'strand-branch-skew',
    perOrg: async (orgId) => {
      const slack = await getSlackConnection(deps.supabase, orgId)
      if (!slack || !slack.config_alerts_enabled) return false
      const blocks = [
        { type: 'header', text: { type: 'plain_text', text: 'A strand-drain branch may be unable to fire', emoji: false } },
        { type: 'section', text: { type: 'mrkdwn', text: reason } },
        { type: 'section', text: { type: 'mrkdwn', text: `<${deps.appUrl}/dashboard|Open dashboard>` } },
      ]
      return (await postMessage(slack.bot_token, slack.default_channel, blocks, 'A strand-drain branch may be unable to fire')) !== null
    },
  })

  // Delivered, or suppressed by the cooldown (a known skew): reset so the window
  // does not grow without bound and a later fix is visible. A genuine delivery
  // failure (not in cooldown, nothing delivered) keeps the window for the next
  // tick to retry.
  if (alerted || inCooldown) await kv.put(WINDOW_KEY, freshWindow())
  else await kv.put(WINDOW_KEY, JSON.stringify(window))
  return alerted
}
