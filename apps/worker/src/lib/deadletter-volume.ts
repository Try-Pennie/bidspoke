/**
 * ADR 0002's "build the durable outcome store now" condition, made measurable (#355).
 *
 * ADR 0002 deferred the durable store behind the writeOutcome seam and said to
 * "watch dead-letter alert volume for a week" as the trigger to build it, but never
 * defined what volume means build-now, and a vague trigger never fires. This records
 * a concrete, measurable bar: a per-UTC-day dead-letter counter, and a daily check
 * that announces when the bar is met.
 *
 * The bar (also recorded in docs/adr/0002-observability-vs-outcome-write-tiers.md),
 * either half of which trips it:
 *
 *  (a) ANY unrecoverable money-row loss. A lead_sightings.insert or
 *      lead_sighting_bids.insert dead-letter is a must-not-lose ROW insert with no
 *      persisted column for a drain to rebuild from, so a single one is a permanent
 *      loss of a billing / win-tracking row, the exact risk the deferral accepted.
 *      The finalize losses self-heal (the strand drains reconstruct them from
 *      already-persisted columns), so they do not count toward this half.
 *
 *  (b) SUSTAINED volume: dead-letters of our own database writes reach
 *      BUILD_NOW_DAILY_VOLUME per day for BUILD_NOW_VOLUME_DAYS consecutive UTC days.
 *      That is the outage frequency at which (a) stops being a matter of luck, even
 *      if no row has been lost yet. A failed Salesforce update does not count
 *      (#2087): it has its own alerts and the replay tool.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSlackConnection, postMessage } from './slack'
import { rateLimitedOrgAlert } from './alert-fanout'
import { CONTINUATION_UNFINISHED_LABEL, WRITEBACK_UNCAPTURABLE_LABEL } from '../engine/dead-letter-labels'

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** The per-day total at or above which a day counts toward the sustained-volume half. */
export const BUILD_NOW_DAILY_VOLUME = 5
/** How many consecutive days must each clear the daily volume for the sustained half to trip. */
export const BUILD_NOW_VOLUME_DAYS = 3

const DAY_MS = 24 * 60 * 60 * 1000
// Retain each day's tally a few days past the furthest day the check reads (the
// third completed day back), so the daily check always sees the full span even if
// it runs late or skips a day.
const DAILY_COUNT_TTL_SECONDS = (BUILD_NOW_VOLUME_DAYS + 3) * 24 * 60 * 60
// Re-surface weekly rather than nagging daily.
const BUILD_NOW_COOLDOWN_SECONDS = 7 * 24 * 60 * 60
const BUILD_NOW_COOLDOWN_KEY = 'outcome-deadletter-buildnow-cooldown'
// A durable mark that the condition has fired at least once. It has NO TTL, so the
// reminder genuinely holds until the store is built, rather than ageing out with
// the day tallies after a one-off loss (#355). Cleared only when DURABLE_STORE_BUILT
// flips to true.
const BUILD_NOW_TRIPPED_KEY = 'outcome-deadletter-buildnow-tripped'

/**
 * Flip to true in the same change that builds the durable outcome store. While it
 * is false, a met condition re-surfaces weekly; once true, the check clears the
 * trip mark and stays silent, so the reminder has a definite, code-visible end
 * rather than nagging for ever with no way to stop it (#355).
 */
export const DURABLE_STORE_BUILT = false

export interface DeadLetterDayCounts {
  total: number
  unrecoverable: number
  /**
   * The same total by dead letter label, so the alert can say WHAT was counted
   * (#835). Absent on a tally written before it existed, which then names no kind.
   */
  labels?: Record<string, number>
}

/** The UTC calendar day of a timestamp, as YYYY-MM-DD. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const dayKey = (day: string): string => `outcome-deadletter-daily:${day}`

/**
 * Whether a dead-lettered write is a permanent loss no daily drain can reconstruct.
 *
 * The finalize losses self-heal (execution_finalize via the stranded-execution
 * drain, lead_sightings.finalize via the sighting drain, both from already-persisted
 * columns). sf_writeback is a tier-3 external PATCH recorded as degraded, not a row
 * loss. An unfinished continuation is an unknown outcome, not a loss. What is left,
 * the two row INSERTS, is what ADR 0002 names as "the one limit": a long outage can
 * drop them with no column to rebuild from.
 *
 * This is a deliberate list, not a derivation, because the dead-letter labels are
 * free-text strings at the writeOutcome call sites with no enum to enumerate (L96).
 * A NEW must-not-lose row insert added to writeOutcome must be added here and named
 * in ADR 0002's "the one limit", or the build-now trigger will stay quiet for it.
 */
export function isUnrecoverableOutcomeLoss(label: string): boolean {
  return label === 'lead_sightings.insert' || label === 'lead_sighting_bids.insert'
}

/**
 * The dead-letter labels that are a failed Salesforce update rather than a write
 * to our own database (#2087, Dan 2026-10-14). They have their own alerts and the
 * replay tool, and this bar exists to decide whether OUR database writes need a
 * durable store, so they do not count toward it. A failure to save into the
 * replay store (outcome_writeback_deadletters.insert) is a database write and
 * still counts.
 */
const SALESFORCE_UPDATE_LABELS: ReadonlySet<string> = new Set(['sf_writeback', WRITEBACK_UNCAPTURABLE_LABEL])

/**
 * Whether a dead-letter label is a CONFIRMED database loss that should count
 * toward the volume bar. continuation_unfinished is an unknown outcome (the walk
 * did not finish in time but may well have landed), not a loss, so it is
 * excluded: counting it would inflate the sustained-volume half and the
 * "dead-letter totals" copy with runs that lost nothing (#355). A failed
 * Salesforce update is excluded too (#2087). Every other label is a real tier-2
 * loss, reconstructable or not.
 */
function isConfirmedLoss(label: string): boolean {
  return label !== CONTINUATION_UNFINISHED_LABEL && !SALESFORCE_UPDATE_LABELS.has(label)
}

function parseCounts(raw: string | null): DeadLetterDayCounts {
  if (!raw) return { total: 0, unrecoverable: 0, labels: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<DeadLetterDayCounts>
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    const labels: Record<string, number> = {}
    // A tally written before #2087 still holds failed Salesforce updates; they are
    // discounted here, where every reader reads, so an old day cannot trip the bar.
    let discounted = 0
    if (parsed.labels && typeof parsed.labels === 'object') {
      for (const [label, n] of Object.entries(parsed.labels)) {
        if (num(n) <= 0) continue
        if (SALESFORCE_UPDATE_LABELS.has(label)) discounted += num(n)
        else labels[label] = num(n)
      }
    }
    return { total: Math.max(0, num(parsed.total) - discounted), unrecoverable: num(parsed.unrecoverable), labels }
  } catch {
    return { total: 0, unrecoverable: 0, labels: {} }
  }
}

/**
 * Count one dead-letter into its UTC day's tally (#355). Called on every tier-2
 * loss, before the alert threshold and cooldown, so a suppressed loss still counts.
 *
 * A non-atomic read-then-write, like the window counter beside it: concurrent
 * isolates can overwrite each other's increment, so the tally is approximate and
 * only ever UNDER the truth, which is the safe side for a bar of "5 or more" and
 * "one or more". Best-effort: never throws into the caller's loss path.
 */
export async function recordDeadLetterVolume(kv: KvLike, label: string, nowMs: number = Date.now()): Promise<void> {
  // An unfinished continuation is not a loss, and a failed Salesforce update is not
  // a database loss (#2087), so neither counts toward either half.
  if (!isConfirmedLoss(label)) return
  try {
    const key = dayKey(utcDay(nowMs))
    const cur = parseCounts(await kv.get(key))
    const next: DeadLetterDayCounts = {
      total: cur.total + 1,
      unrecoverable: cur.unrecoverable + (isUnrecoverableOutcomeLoss(label) ? 1 : 0),
      labels: { ...cur.labels, [label]: (cur.labels?.[label] ?? 0) + 1 },
    }
    await kv.put(key, JSON.stringify(next), { expirationTtl: DAILY_COUNT_TTL_SECONDS })
  } catch (e) {
    console.error(`[deadletter-volume] count failed for ${label}:`, e)
  }
}

export interface BuildNowVerdict {
  tripped: boolean
  reasons: ('unrecoverable-loss' | 'sustained-volume')[]
  /** Unrecoverable losses tallied across the recent window (today plus the prior days). */
  unrecoverableRecent: number
  /** The completed days judged for the sustained-volume half, newest first. */
  volumeDays: { day: string; total: number }[]
  /** Dead letters by label across today and those completed days, so the alert names what was counted (#835). */
  byLabel: Record<string, number>
}

/**
 * Evaluate ADR 0002's build-now bar against the recent per-day tallies (#355).
 *
 * Two windows, because they ask different things:
 *  - Unrecoverable half: any single loss across TODAY and the prior
 *    BUILD_NOW_VOLUME_DAYS - 1 days. A loss is a loss the instant it is recorded,
 *    so a partial day counts.
 *  - Sustained-volume half: every one of the last BUILD_NOW_VOLUME_DAYS COMPLETED
 *    days (ending yesterday) must clear the daily bar. Today is excluded, because
 *    the 13:00 UTC check sees only part of it, and a true three-day run would
 *    otherwise be missed until today's partial total also reached the bar (#355).
 */
export async function evaluateBuildNow(kv: KvLike, nowMs: number = Date.now()): Promise<BuildNowVerdict> {
  // Unrecoverable window: today back through BUILD_NOW_VOLUME_DAYS - 1 days.
  const unrecoverableDays: string[] = []
  for (let i = 0; i < BUILD_NOW_VOLUME_DAYS; i++) unrecoverableDays.push(utcDay(nowMs - i * DAY_MS))
  // Every day either window reads, today back through the oldest completed day,
  // read once each.
  const readDays = Array.from({ length: BUILD_NOW_VOLUME_DAYS + 1 }, (_unused, i) => utcDay(nowMs - i * DAY_MS))
  const counts = new Map(await Promise.all(readDays.map(async (d) => [d, parseCounts(await kv.get(dayKey(d)))] as const)))
  const countsOf = (d: string): DeadLetterDayCounts => counts.get(d) ?? { total: 0, unrecoverable: 0, labels: {} }

  const unrecoverableRecent = unrecoverableDays.map((d) => countsOf(d).unrecoverable).reduce((sum, n) => sum + n, 0)

  // Volume window: the BUILD_NOW_VOLUME_DAYS completed days ending yesterday.
  const volumeDays = readDays.slice(1).map((day) => ({ day, total: countsOf(day).total }))

  const byLabel: Record<string, number> = {}
  for (const d of readDays) {
    for (const [label, n] of Object.entries(countsOf(d).labels ?? {})) byLabel[label] = (byLabel[label] ?? 0) + n
  }
  const sustainedVolume = volumeDays.every((d) => d.total >= BUILD_NOW_DAILY_VOLUME)

  const reasons: ('unrecoverable-loss' | 'sustained-volume')[] = []
  if (unrecoverableRecent > 0) reasons.push('unrecoverable-loss')
  if (sustainedVolume) reasons.push('sustained-volume')

  return { tripped: reasons.length > 0, reasons, unrecoverableRecent, volumeDays, byLabel }
}

function buildBlocks(verdict: BuildNowVerdict, appUrl: string): unknown[] {
  // A standing reminder: the condition fired earlier (the durable trip mark is set)
  // but has since aged out of the recent window. Say that, rather than the verdict's
  // empty reasons reading as "0 a day".
  const lead =
    verdict.reasons.includes('unrecoverable-loss')
      ? `*${verdict.unrecoverableRecent} outcome ${verdict.unrecoverableRecent === 1 ? 'row was' : 'rows were'} lost* recently that the daily drains cannot rebuild (a lead_sightings or bid-row insert). This is the permanent loss ADR 0002 deferred the durable store against.`
      : verdict.reasons.includes('sustained-volume')
      ? `Dead-letter volume has stayed at or above ${BUILD_NOW_DAILY_VOLUME} a day for ${BUILD_NOW_VOLUME_DAYS} days running. Outages are now frequent enough that a lost row is a matter of time.`
      : 'The build-now condition fired earlier and the durable outcome store still has not been built.'
  const recent = verdict.volumeDays.map((d) => `${d.day}: ${d.total}`).join(', ')
  // Largest first. Empty when every tally predates the per-label count.
  const kinds = Object.entries(verdict.byLabel)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${label} ${n}`)
    .join(', ')
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Time to build the durable outcome store', emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: `${lead} The deferral ADR 0002 recorded has expired.` } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Dead-letter totals, recent completed days:* ${recent}.` } },
    ...(kinds ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Counted by kind, today and those days:* ${kinds}.` } }] : []),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Starts from what was counted rather than prescribing the finalize move
        // whatever it was (#835): the finalize kinds are already rebuilt by the
        // strand drains, and the inserts are the rows nothing rebuilds.
        // "The kinds counted above" only when that line was printed: a standing
        // reminder whose tallies aged out, or tallies from before the per-kind
        // count, print none (review of #2082).
        text:
          `The build goes behind the writeOutcome seam (one file)${kinds ? ', and starts from the kinds counted above' : ''}: ` +
          'lead_sightings.insert and lead_sighting_bids.insert are rows no drain can rebuild, while the finalize kinds are rebuilt by the strand drains. See the "Upgrade path" in docs/adr/0002-observability-vs-outcome-write-tiers.md, then flip DURABLE_STORE_BUILT to stop this reminder.',
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `<${appUrl}/dashboard|Open dashboard>` } },
  ]
}

/**
 * Daily check (#355): once ADR 0002's build-now bar is met, announce it weekly to
 * every Slack org until the durable store is built. A durable trip mark holds the
 * reminder even after a one-off loss ages out of the day tallies, so a single
 * permanent loss is not forgotten after one alert; the reminder ends only when
 * DURABLE_STORE_BUILT flips. Returns whether it alerted. Best-effort; the caller
 * runs it inside the daily batch's waitUntil.
 */
export async function runDeadLetterBuildTriggerCheck(
  kv: KvLike,
  supabase: SupabaseClient,
  appUrl: string,
  nowMs: number = Date.now(),
  // Injectable so the built branch is testable; production uses the module constant.
  storeBuilt: boolean = DURABLE_STORE_BUILT,
): Promise<boolean> {
  if (storeBuilt) {
    // The store is built: stop reminding, and clear the mark so a future, separate
    // deferral would start clean. Log a failed clear rather than swallowing it, or
    // the mark could silently survive the flip (L340).
    await kv.delete(BUILD_NOW_TRIPPED_KEY).catch((e) => console.error('[deadletter-build-trigger] clearing the trip mark failed:', e))
    return false
  }

  const verdict = await evaluateBuildNow(kv, nowMs)
  const everTripped = (await kv.get(BUILD_NOW_TRIPPED_KEY)) !== null
  if (!verdict.tripped && !everTripped) return false

  // Persist that the condition has fired, so the reminder outlives the day tallies.
  if (verdict.tripped && !everTripped) {
    await kv.put(BUILD_NOW_TRIPPED_KEY, new Date(nowMs).toISOString())
  }

  return rateLimitedOrgAlert({
    kv,
    cooldownKey: BUILD_NOW_COOLDOWN_KEY,
    ttlSeconds: BUILD_NOW_COOLDOWN_SECONDS,
    supabase,
    logLabel: 'deadletter-build-trigger',
    perOrg: async (orgId) => {
      const slack = await getSlackConnection(supabase, orgId)
      if (!slack || !slack.config_alerts_enabled) return false
      return (await postMessage(slack.bot_token, slack.default_channel, buildBlocks(verdict, appUrl), 'Time to build the durable outcome store')) !== null
    },
  })
}
