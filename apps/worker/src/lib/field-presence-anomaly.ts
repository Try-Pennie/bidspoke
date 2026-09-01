// Field-presence detector (#422), log-only. Reads the field_presence_daily
// rollup and detects two silent-output shapes: Tier-1 drought (a normally
// present field collapses today) and Tier-2 day-one-dead (a field never present
// despite many runs). Mirrors volume-anomaly.ts. Thresholds are provisional and
// validated during the dark run; the stability gate is load-bearing (it stops
// normal no-bid/no-debt nulls from firing).

import type { SupabaseClient } from '@supabase/supabase-js'
import { MIN_BASELINE_DAYS } from './volume-anomaly'
import { fetchAllPaged } from './paginate'
import { getSlackConnection, postMessage, sendRecoveryAlert } from './slack'
import { announceRecovery, markAlerted, markSpikeSeen, type RecoveryKv } from './alert-recovery'

export { MIN_BASELINE_DAYS }
export const BASELINE_MIN_DAY_RUNS = 10
// Calibrated against the dark run, not chosen (#432). Measured over
// 2026-08-09..2026-09-01 with `npx tsx scripts/diagnose-field-presence.ts`:
// sweeping this floor from 0.98 down to 0.80 produced ZERO Tier-1 hits on all
// 24 days, while raising coverage from 104 to 117 of 144 (workflow, field)
// pairs. So the shipped 0.98 was buying no quiet, only blind spots. 0.90 sits
// on a plateau (0.92 and 0.90 both admit 112) and covers every stable-but-
// imperfect field the measurement found, the important one being Main Flow
// `pennie_or_eligibility.final` at 94.4% mean / 0.011 stddev: the Eligibility
// Scout field whose silent death is the incident this milestone was built
// after. At 0.98 a total Scout collapse could not have paged.
//
// STABLE_STDDEV_MAX is the gate that actually excludes variable no-bid fields,
// and it is deliberately unchanged.
export const STABLE_MEAN_MIN = 0.90
export const STABLE_STDDEV_MAX = 0.02
export const COLLAPSE_K = 4
export const COLLAPSE_FLOOR = 0.10
export const MIN_TODAY_SAMPLE = 20
export const DEAD_WINDOW_DAYS = 7
export const DEAD_MIN_RUNS = 200
// Also calibrated, not chosen (#432). The real 7-day distribution has an empty
// band: four fields resolve on exactly 0.0000% of runs (every one a genuinely
// broken reference, including #709), and the next-rarest real field sits at
// 0.2632%. The shipped 0.005 landed INSIDE the rare-but-real cluster rather
// than in the gap, so it called three legitimately-rare fields dead while
// exempting a fourth of the same kind at 0.679% (L172). 0.001 sits in the empty
// band with 2.6x margin below the nearest real field, and is deliberately not
// exactly zero so a chronically dead field that succeeds a handful of times in
// a large sample is still caught.
export const DEAD_MAX_RATE = 0.001

export function dailyRate(ran: number, present: number): number {
  return ran > 0 ? present / ran : 0
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

export function stddev(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / xs.length
  return Math.sqrt(variance)
}

/**
 * Every threshold the detector consults, injectable (#432).
 *
 * These exist so the dark-run validation can ask "what would a different mean
 * floor have paged over the same real days" by driving the SHIPPED predicate
 * with a different number, instead of a sweep reimplementing the rule beside
 * it, which is a second definition that drifts in whichever direction flatters
 * the argument (L107). Every field is optional and falls back to the shipped
 * constant, so no caller changes when a threshold moves.
 */
export interface PresenceThresholds {
  minBaselineDays?: number
  stableMeanMin?: number
  stableStddevMax?: number
  collapseK?: number
  collapseFloor?: number
  minTodaySample?: number
  deadMinRuns?: number
  deadMaxRate?: number
}

interface ResolvedThresholds {
  minBaselineDays: number
  stableMeanMin: number
  stableStddevMax: number
  collapseK: number
  collapseFloor: number
  minTodaySample: number
  deadMinRuns: number
  deadMaxRate: number
}

function resolve(t: PresenceThresholds = {}): ResolvedThresholds {
  // ?? not ||, so an override of 0 (a deliberate "exactly zero" ceiling) is
  // honoured rather than falling back to the shipped constant.
  return {
    minBaselineDays: t.minBaselineDays ?? MIN_BASELINE_DAYS,
    stableMeanMin: t.stableMeanMin ?? STABLE_MEAN_MIN,
    stableStddevMax: t.stableStddevMax ?? STABLE_STDDEV_MAX,
    collapseK: t.collapseK ?? COLLAPSE_K,
    collapseFloor: t.collapseFloor ?? COLLAPSE_FLOOR,
    minTodaySample: t.minTodaySample ?? MIN_TODAY_SAMPLE,
    deadMinRuns: t.deadMinRuns ?? DEAD_MIN_RUNS,
    deadMaxRate: t.deadMaxRate ?? DEAD_MAX_RATE,
  }
}

// A field is "stable" when it is essentially always present with low variance
// over enough days. Variable fields (no-bid, no-debt) have high variance and
// never qualify, so they never page.
export function isStableBaseline(rates: number[], thresholds?: PresenceThresholds): boolean {
  const t = resolve(thresholds)
  return (
    rates.length >= t.minBaselineDays &&
    mean(rates) >= t.stableMeanMin &&
    stddev(rates) <= t.stableStddevMax
  )
}

// Tier-1: a stable field whose today's rate falls well below its stable band,
// with enough runs today to judge. Returns the baseline stats on a hit.
export function detectDrought(
  baselineRates: number[],
  todayRate: number,
  todayRan: number,
  thresholds?: PresenceThresholds,
): { mean: number; stddev: number; todayRate: number } | null {
  const t = resolve(thresholds)
  if (todayRan < t.minTodaySample) return null
  if (!isStableBaseline(baselineRates, thresholds)) return null
  const m = mean(baselineRates)
  const sd = stddev(baselineRates)
  const margin = Math.max(t.collapseK * sd, t.collapseFloor)
  if (todayRate < m - margin) {
    return { mean: m, stddev: sd, todayRate }
  }
  return null
}

// Tier-2: many runs over the window, presence rate ~0, and never healthy on any
// day. The "never healthy" guard is what distinguishes born-dead (Tier-2) from
// was-healthy-then-died (Tier-1's collapse).
export function detectDayOneDead(
  windowRan: number,
  windowPresent: number,
  everHealthy: boolean,
  thresholds?: PresenceThresholds,
): boolean {
  const t = resolve(thresholds)
  if (windowRan < t.deadMinRuns) return false
  if (everHealthy) return false
  return dailyRate(windowRan, windowPresent) <= t.deadMaxRate
}

export interface PresenceRow {
  workflow_id: string
  field_path: string
  day: string
  ran_count: number
  present_count: number
}

export interface DroughtHit {
  workflow_id: string
  field_path: string
  mean: number
  stddev: number
  today_rate: number
  today_ran: number
}

export interface DeadHit {
  workflow_id: string
  field_path: string
  window_ran: number
  window_present: number
}

function groupByField(rows: PresenceRow[]): Map<string, PresenceRow[]> {
  const groups = new Map<string, PresenceRow[]>()
  for (const r of rows) {
    const key = `${r.workflow_id}|${r.field_path}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(r)
    else groups.set(key, [r])
  }
  return groups
}

// Tier-1: per field, build a baseline from prior days with enough runs, take the
// most recent 7, and test today's partial rate against the stability gate.
export function findDroughts(
  rows: PresenceRow[],
  today: string,
  thresholds?: PresenceThresholds,
): DroughtHit[] {
  const hits: DroughtHit[] = []
  for (const bucket of groupByField(rows).values()) {
    const todayRow = bucket.find((r) => r.day === today)
    if (!todayRow) continue
    const baselineRates = bucket
      .filter((r) => r.day < today && r.ran_count >= BASELINE_MIN_DAY_RUNS)
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-7)
      .map((r) => dailyRate(r.ran_count, r.present_count))
    const todayRate = dailyRate(todayRow.ran_count, todayRow.present_count)
    const result = detectDrought(baselineRates, todayRate, todayRow.ran_count, thresholds)
    if (result) {
      hits.push({
        workflow_id: todayRow.workflow_id,
        field_path: todayRow.field_path,
        mean: result.mean,
        stddev: result.stddev,
        today_rate: result.todayRate,
        today_ran: todayRow.ran_count,
      })
    }
  }
  return hits
}

// Tier-2: per field, sum the window and check day-one-dead. A field is counted
// as "ever healthy" only on a day with enough runs to trust its rate.
export function findDayOneDead(rows: PresenceRow[], thresholds?: PresenceThresholds): DeadHit[] {
  const hits: DeadHit[] = []
  for (const bucket of groupByField(rows).values()) {
    let windowRan = 0
    let windowPresent = 0
    let everHealthy = false
    for (const r of bucket) {
      windowRan += r.ran_count
      windowPresent += r.present_count
      if (r.ran_count >= BASELINE_MIN_DAY_RUNS && dailyRate(r.ran_count, r.present_count) >= STABLE_MEAN_MIN) {
        everHealthy = true
      }
    }
    if (detectDayOneDead(windowRan, windowPresent, everHealthy, thresholds)) {
      hits.push({
        workflow_id: bucket[0].workflow_id,
        field_path: bucket[0].field_path,
        window_ran: windowRan,
        window_present: windowPresent,
      })
    }
  }
  return hits
}

/**
 * What this run could actually establish about one field (#423).
 *
 * A live alert needs three answers, not two. "No hit" is not "healthy": Tier-1
 * judges TODAY's cumulative rate and today resets at UTC midnight, so at 00:30 a
 * field that is still completely dead has too few runs to judge and produces no
 * hit. Collapsing that into "healthy" would fire an all-clear over an ongoing
 * outage every night (L98, L11). Tier-2 has the same shape below its run floor.
 *
 * So `insufficient` means this run could not tell, and nothing is said either
 * way. Only `healthy` is evidence the condition ended, and only that announces
 * a recovery.
 */
export type FieldVerdict = 'alerting' | 'healthy' | 'insufficient'

export interface FieldState {
  workflow_id: string
  field_path: string
  verdict: FieldVerdict
  /** Present only on `alerting`, carrying what the page needs to say. */
  drought?: DroughtHit
  dead?: DeadHit
}

/** Tier-1, as a verdict per field rather than only the hits. */
export function classifyDrought(
  rows: PresenceRow[],
  today: string,
  thresholds?: PresenceThresholds,
): FieldState[] {
  const t = resolve(thresholds)
  const out: FieldState[] = []
  for (const bucket of groupByField(rows).values()) {
    const base = { workflow_id: bucket[0].workflow_id, field_path: bucket[0].field_path }
    const todayRow = bucket.find((r) => r.day === today)
    // No traffic recorded today at all, or not enough of it to judge a rate.
    if (!todayRow || todayRow.ran_count < t.minTodaySample) {
      out.push({ ...base, verdict: 'insufficient' })
      continue
    }
    const baselineRates = bucket
      .filter((r) => r.day < today && r.ran_count >= BASELINE_MIN_DAY_RUNS)
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-7)
      .map((r) => dailyRate(r.ran_count, r.present_count))
    // A field outside the stability gate can never page, so it must never
    // announce a recovery either: there was no incident to end.
    if (!isStableBaseline(baselineRates, thresholds)) {
      out.push({ ...base, verdict: 'insufficient' })
      continue
    }
    const todayRate = dailyRate(todayRow.ran_count, todayRow.present_count)
    const hit = detectDrought(baselineRates, todayRate, todayRow.ran_count, thresholds)
    if (hit) {
      out.push({
        ...base,
        verdict: 'alerting',
        drought: {
          ...base,
          mean: hit.mean,
          stddev: hit.stddev,
          today_rate: hit.todayRate,
          today_ran: todayRow.ran_count,
        },
      })
    } else {
      out.push({ ...base, verdict: 'healthy' })
    }
  }
  return out
}

/** Tier-2, as a verdict per field rather than only the hits. */
export function classifyDead(
  rows: PresenceRow[],
  thresholds?: PresenceThresholds,
): FieldState[] {
  const t = resolve(thresholds)
  const out: FieldState[] = []
  for (const bucket of groupByField(rows).values()) {
    const base = { workflow_id: bucket[0].workflow_id, field_path: bucket[0].field_path }
    let windowRan = 0
    let windowPresent = 0
    let everHealthy = false
    for (const r of bucket) {
      windowRan += r.ran_count
      windowPresent += r.present_count
      if (r.ran_count >= BASELINE_MIN_DAY_RUNS && dailyRate(r.ran_count, r.present_count) >= t.stableMeanMin) {
        everHealthy = true
      }
    }
    // Too little traffic over the window to call a field dead. This is the
    // population the design knowingly accepts a detection delay on, and it is
    // reported as unjudged rather than as fine.
    if (windowRan < t.deadMinRuns) {
      out.push({ ...base, verdict: 'insufficient' })
      continue
    }
    if (detectDayOneDead(windowRan, windowPresent, everHealthy, thresholds)) {
      out.push({
        ...base,
        verdict: 'alerting',
        dead: { ...base, window_ran: windowRan, window_present: windowPresent },
      })
    } else {
      out.push({ ...base, verdict: 'healthy' })
    }
  }
  return out
}

// Drop any hit whose (workflow_id, field_path) is in the silenced set. The key is
// `${workflow_id} ${field_path}` (a space separator a field path cannot contain).
export function excludeSilenced<T extends { workflow_id: string; field_path: string }>(
  hits: T[],
  silenced: Set<string>,
): T[] {
  return hits.filter((h) => !silenced.has(`${h.workflow_id} ${h.field_path}`))
}

// Author-set silences for the active workflows. Keyed to match excludeSilenced.
// A read failure returns an empty set (log-only detector still logs everything).
async function readSilences(supabase: SupabaseClient, workflowIds: string[]): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('field_presence_silences')
    .select('workflow_id, field_path')
    .in('workflow_id', workflowIds)
  if (error) {
    console.error('[field-presence] silences read failed:', error)
    return new Set()
  }
  return new Set((data ?? []).map((r) => `${r.workflow_id as string} ${r.field_path as string}`))
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * How long a paged (workflow, field) stays deduped.
 *
 * Deliberately longer than the 30 minutes the minute-cadence alerts use. A field
 * drought is a day-scale condition judged against today's cumulative rate, so it
 * persists for the rest of the day once it starts; at the hourly cadence a 30
 * minute cooldown would suppress nothing and page every hour about the same
 * field. Twelve hours caps it at two pages a day per field, and the recovery
 * all-clear clears the key early when the field genuinely comes back.
 */
export const FIELD_COOLDOWN_TTL_SECONDS = 12 * 60 * 60

export interface ActiveWorkflow {
  id: string
  name: string
  organization_id: string
  slack_channel: string | null
}

/**
 * The active, non-deleted workflows.
 *
 * THROWS on a read failure rather than returning what it has. An empty list
 * makes both checks a silent no-op that looks exactly like a healthy sweep, and
 * that is the shape where the system goes quietest precisely when it can see
 * least (L98). The cron site logs the throw and the daily heartbeat reports the
 * absence of a run.
 */
async function activeWorkflows(supabase: SupabaseClient): Promise<ActiveWorkflow[]> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, organization_id, slack_channel')
    .eq('is_active', true)
    .is('deleted_at', null)
  if (error) throw new Error(`workflows read failed: ${error.message}`)
  return (data ?? []).map((w) => ({
    id: w.id as string,
    name: w.name as string,
    organization_id: w.organization_id as string,
    slack_channel: (w.slack_channel as string | null) ?? null,
  }))
}

/**
 * The rollup rows for these workflows since `sinceDate`.
 *
 * Paged through `fetchAllPaged` with a stable total order (AUD-039). It
 * previously paged with a bare `.range()` and no ORDER BY, against a table the
 * 5-minute pg_cron refresh rewrites underneath it, so Postgres recomputed each
 * OFFSET against an independent scan and the pages skipped and duplicated rows.
 * That is quieter than a truncation: the detector still got ~the right NUMBER
 * of rows, so a dropped day looked like a field that simply had no traffic, and
 * a duplicated one distorted the very rates the thresholds are judged against.
 *
 * (workflow_id, field_path, day) is the table's primary key minus `is_test`,
 * which is filtered to a single value here, so it is a total order.
 *
 * A read failure THROWS rather than returning what it managed to collect: a
 * detector that judges "this field is dead" from a partial read would accuse a
 * healthy field on the strength of rows it never saw (L211, L215). The callers
 * log and skip the cycle.
 */
async function readPresenceRows(
  supabase: SupabaseClient,
  workflowIds: string[],
  sinceDate: string,
): Promise<PresenceRow[]> {
  const rows = await fetchAllPaged<Record<string, unknown>>(
    (from, to) =>
      supabase
        .from('field_presence_daily')
        .select('workflow_id, field_path, day, ran_count, present_count')
        .in('workflow_id', workflowIds)
        .gte('day', sinceDate)
        .eq('is_test', false)
        .order('workflow_id', { ascending: true })
        .order('field_path', { ascending: true })
        .order('day', { ascending: true })
        .range(from, to),
    'field_presence_daily',
  )
  return rows.map((r) => ({
    workflow_id: r.workflow_id as string,
    field_path: r.field_path as string,
    day: r.day as string,
    ran_count: count(r.ran_count, 'ran_count', r),
    present_count: count(r.present_count, 'present_count', r),
  }))
}

/**
 * A rollup count, or a refusal (L50).
 *
 * PostgREST renders a bigint as a string, so `Number()` is the right parse, but
 * it also renders anything it cannot render as null and turns a surprise into
 * NaN. Every threshold in this file is a `>=` or a rate, and NaN compares false
 * against all of them, so an unparsed count would drop its field out of its own
 * baseline in silence and land on the do-not-page side: the detector would go
 * on reporting an all-clear about a field it never actually measured.
 */
function count(value: unknown, column: string, row: Record<string, unknown>): number {
  // null, undefined and '' all pass through Number() as 0, which is finite and
  // means "the producing node never ran here". So a NaN check alone would let a
  // missing count read as a real measurement of zero, which is the quieter half
  // of this bug: the field drops out of every denominator with nothing said.
  const n = value === null || value === undefined || value === '' ? NaN : Number(value)
  if (!Number.isFinite(n)) {
    throw new Error(
      `field_presence_daily.${column} did not parse as a number ` +
        `(workflow ${String(row.workflow_id)}, field ${String(row.field_path)}, day ${String(row.day)})`,
    )
  }
  return n
}

/**
 * The Slack message for a field that stopped carrying a value.
 *
 * Says the four things an operator needs before they can act: which workflow,
 * which field, what changed (its own baseline against today), and where to look.
 * Returns the message ts, or null when it did not deliver, so the caller can
 * gate the cooldown on delivery rather than on the attempt.
 */
export async function sendFieldDroughtAlert(
  slack: { bot_token: string },
  channel: string,
  workflowName: string,
  hit: DroughtHit,
  appUrl: string,
): Promise<string | null> {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const url = `${appUrl}/workflows/${hit.workflow_id}`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Output Field Stopped', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `In *${workflowName}*, the field \`${hit.field_path}\` normally carries a value on ` +
          `*${pct(hit.mean)}* of runs. Today it is carrying one on *${pct(hit.today_rate)}* ` +
          `of ${hit.today_ran} runs.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'Something downstream reads this field, so those runs are proceeding without it. ' +
          'The usual causes are an upstream API returning a different shape, or a code node ' +
          'swallowing an error into an empty result.',
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `<${url}|Open workflow>` } },
  ]
  return postMessage(slack.bot_token, channel, blocks, `Output field stopped: ${workflowName} ${hit.field_path}`)
}

/**
 * The Slack message for a field that has never carried a value.
 *
 * Worded differently from the drought on purpose. A drought is "this broke
 * today"; this is "this has never worked", which usually means the reference
 * itself is wrong rather than the upstream being down, and the fix is usually to
 * correct or delete the reference (L11).
 */
export async function sendFieldDeadAlert(
  slack: { bot_token: string },
  channel: string,
  workflowName: string,
  hit: DeadHit,
  appUrl: string,
): Promise<string | null> {
  const url = `${appUrl}/workflows/${hit.workflow_id}`
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Output Field Never Resolves', emoji: false } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `In *${workflowName}*, something reads \`${hit.field_path}\`, and over the last ` +
          `${DEAD_WINDOW_DAYS} days it carried a value on *${hit.window_present} of ${hit.window_ran}* runs.`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'A field that has never resolved usually means the reference path is wrong or has ' +
          'gone obsolete, rather than an upstream being down. Either correct the path or remove ' +
          'the reference. If the field is legitimately allowed to be empty, silence it with a ' +
          'reason so this stops asking.',
      },
    },
    { type: 'section', text: { type: 'mrkdwn', text: `<${url}|Open workflow>` } },
  ]
  return postMessage(slack.bot_token, channel, blocks, `Output field never resolves: ${workflowName} ${hit.field_path}`)
}

/** `${workflow_id} ${field_path}`, the key both the silences and the KV use. */
function fieldKey(workflowId: string, fieldPath: string): string {
  return `${workflowId} ${fieldPath}`
}

interface TierConfig {
  /** KV/recovery prefix, so the two tiers never share an incident marker (L53). */
  prefix: string
  signal: string
  send: (
    slack: { bot_token: string },
    channel: string,
    workflowName: string,
    state: FieldState,
    appUrl: string,
  ) => Promise<string | null>
}

/**
 * Page, dedupe and stand down over a set of per-field verdicts.
 *
 * Shared by both tiers because they differ only in how the verdict was reached
 * and what the message says; the alerting rules (org gate, per-field cooldown,
 * cooldown only on delivery, all-clear when the field genuinely recovers) are
 * one implementation rather than a copy each.
 *
 * `insufficient` deliberately does nothing at all: it neither pages nor stands
 * down, because this run could not tell.
 */
async function alertOnStates(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
  workflows: ActiveWorkflow[],
  states: FieldState[],
  silenced: Set<string>,
  cfg: TierConfig,
): Promise<{ paged: number; recovered: number }> {
  const byId = new Map(workflows.map((w) => [w.id, w]))
  let paged = 0
  let recovered = 0

  for (const state of states) {
    if (state.verdict === 'insufficient') continue
    const wf = byId.get(state.workflow_id)
    if (!wf) continue
    const id = fieldKey(state.workflow_id, state.field_path)
    const cooldownKey = `${cfg.prefix}-cooldown:${id}`

    // A silenced field is one the author has said may be empty. It must not
    // page, and it must not announce a recovery either: there is no incident.
    if (silenced.has(id)) continue

    if (state.verdict === 'healthy') {
      const did = await announceRecovery(kv, cfg.prefix, id, cooldownKey, async (alertedAt, endedAt) => {
        const slack = await getSlackConnection(supabase, wf.organization_id)
        if (!slack || !slack.volume_alerts_enabled) return false
        return sendRecoveryAlert(slack, wf.slack_channel ?? slack.default_channel, {
          signal: cfg.signal,
          subject: `${wf.name} ${state.field_path}`,
          alertedAt,
          endedAt,
          url: `${appUrl}/workflows/${wf.id}`,
        })
      })
      if (did) recovered++
      continue
    }

    // Stamp the incident's running end on EVERY alerting tick, before the
    // cooldown gate, so the all-clear reports how long the field was empty
    // rather than how long ago we last mentioned it.
    await markSpikeSeen(kv, cfg.prefix, id)
    if (await kv.get(cooldownKey)) continue

    const slack = await getSlackConnection(supabase, wf.organization_id)
    if (!slack || !slack.volume_alerts_enabled) {
      console.log(`[${cfg.prefix}] no Slack or opted-out org=${wf.organization_id} field=${id}`)
      continue
    }
    const channel = wf.slack_channel ?? slack.default_channel
    const sent = await cfg.send(slack, channel, wf.name, state, appUrl)
    // Only start the cooldown once the alert actually delivered: a kicked bot
    // must not suppress the retry for 12 hours while the field stays empty.
    if (sent) {
      await kv.put(cooldownKey, '1', { expirationTtl: FIELD_COOLDOWN_TTL_SECONDS })
      await markAlerted(kv, cfg.prefix, id)
      paged++
    }
  }
  return { paged, recovered }
}

/**
 * Tier-1 (hourly): a field that normally carries a value has stopped.
 *
 * Live since #423. Thresholds were calibrated against 24 days of the dark run
 * (#432), which produced zero Tier-1 hits, so a page here is not a routine
 * event.
 */
export async function runFieldPresenceDroughtCheck(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
): Promise<void> {
  const workflows = await activeWorkflows(supabase)
  if (workflows.length === 0) return
  const workflowIds = workflows.map((w) => w.id)
  const today = new Date().toISOString().slice(0, 10)
  const since = new Date(Date.now() - (MIN_BASELINE_DAYS + 8) * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const states = classifyDrought(rows, today)
  const silenced = await readSilences(supabase, workflowIds)

  for (const s of states) {
    if (s.verdict === 'alerting' && !silenced.has(fieldKey(s.workflow_id, s.field_path))) {
      console.log(JSON.stringify({ event: 'field_presence_drought', ...s.drought }))
    }
  }
  const { paged, recovered } = await alertOnStates(supabase, kv, appUrl, workflows, states, silenced, {
    prefix: 'field-presence-drought',
    signal: 'output field stopped',
    send: (slack, channel, name, state, url) =>
      sendFieldDroughtAlert(slack, channel, name, state.drought as DroughtHit, url),
  })
  console.log(
    `[field-presence-drought] workflows=${workflows.length} ` +
      `alerting=${states.filter((s) => s.verdict === 'alerting').length} ` +
      `healthy=${states.filter((s) => s.verdict === 'healthy').length} ` +
      `unjudged=${states.filter((s) => s.verdict === 'insufficient').length} ` +
      `paged=${paged} recovered=${recovered}`,
  )
}

/**
 * Tier-2 (daily): a field that has never carried a value despite many runs.
 *
 * Live since #423. On the calibrated ceiling this reports only references that
 * resolve on literally none of their runs.
 */
export async function runFieldPresenceDeadCheck(
  supabase: SupabaseClient,
  kv: RecoveryKv,
  appUrl: string,
): Promise<void> {
  const workflows = await activeWorkflows(supabase)
  if (workflows.length === 0) return
  const workflowIds = workflows.map((w) => w.id)
  const since = new Date(Date.now() - DEAD_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
  const rows = await readPresenceRows(supabase, workflowIds, since)
  const states = classifyDead(rows)
  const silenced = await readSilences(supabase, workflowIds)

  const visible = states.filter(
    (s) => s.verdict === 'alerting' && !silenced.has(fieldKey(s.workflow_id, s.field_path)),
  )
  console.log(
    JSON.stringify({
      event: 'field_presence_dead_digest',
      count: visible.length,
      fields: visible.map((s) => s.dead),
    }),
  )
  const { paged, recovered } = await alertOnStates(supabase, kv, appUrl, workflows, states, silenced, {
    prefix: 'field-presence-dead',
    signal: 'output field never resolves',
    send: (slack, channel, name, state, url) =>
      sendFieldDeadAlert(slack, channel, name, state.dead as DeadHit, url),
  })
  console.log(
    `[field-presence-dead] workflows=${workflows.length} alerting=${visible.length} ` +
      `unjudged=${states.filter((s) => s.verdict === 'insufficient').length} ` +
      `paged=${paged} recovered=${recovered}`,
  )
}
