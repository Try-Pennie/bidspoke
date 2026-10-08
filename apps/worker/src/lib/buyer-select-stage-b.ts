/**
 * The Stage B daily report (#1809): beside each Stage A parity row, what the
 * canary arm (buyer_select selling live) and the legacy arm (tripoint_ping) did
 * that day. Each live percent step of #1414 is judged against the same
 * criteria (attempts, the accept rate against the legacy arm, the added latency
 * against the ceiling, one bid row per execution), and the 1 percent review on
 * 2026-10-06 took a few dozen hand queries over tables purged within a week,
 * with the bid rows already gone for most of the period. This row outlives both.
 *
 * Computed from the rows the parity refresh already reads, plus the canary
 * attempts' own rows for where the node's time went call by call (#1909), and
 * one read of Tripoint's bid rows for the day. The bid rows drain within
 * about a day of export, so a day whose bid rows are no longer all
 * held is unmeasured, never a count of zero missing (L98, L90), and an
 * execution too recent for its bid row to have landed is settling, never
 * missing. A failed bid or timing read marks that one figure unmeasured and
 * leaves every other figure, and the Stage A counts, standing (L73).
 *
 * Not part of the counts hash: a sign off approves the Stage A counts, and a
 * Stage B figure moving must not clear it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { easternDayStartUtc } from '@bidspoke/buyer-profile'
import { nextIsoDate, type ParityExecution } from './buyer-select-parity'
import { fetchAllPaged } from './paginate'
import { ATTEMPT_CALLS } from './attempt-timing'

/** The buyer whose bid rows the report checks; the only buyer selling on the Engine flow. */
export const STAGE_B_BUYER_SLUG = 'tripoint'

/** A bid row is written in the background after the call; an execution younger than this is settling, not missing. */
export const BID_SETTLE_MS = 10 * 60_000

/** Read past the day's end, because Tripoint is called seconds after a lead arrives and a lead at 23:59:59 is answered after midnight. */
export const BID_READ_MARGIN_MS = 10 * 60_000

export interface StageBArm {
  attempts: number
  accepted: number
  /** Tripoint's answer code per attempt; `none` when no code came back (a timeout, an unreadable answer). */
  result_codes: Record<string, number>
  duration_p50_ms: number | null
  duration_p95_ms: number | null
}

export interface StageBCanary extends StageBArm {
  /** The buyer call alone (#1804), over the attempts that recorded it. */
  buyer_call_p50_ms: number | null
  buyer_call_p95_ms: number | null
  /** The node's own time, its duration minus the buyer call, over the same attempts. */
  own_p50_ms: number | null
  own_p95_ms: number | null
  /** Attempts written before the call was timed: in the duration figures, not in the call or own figures. */
  buyer_call_unmeasured: number
  /** Where the node's own time went, call by call, read from the attempt rows (#1909). */
  timing: StageBTiming
}

/** One spread of milliseconds over the attempts that recorded it. Percentiles are null, never zero, over none. */
export interface TimingSpread {
  attempts: number
  p50_ms: number | null
  p95_ms: number | null
  /** The sum, so each call's share of the overhead can be read off one row. */
  total_ms: number
}

/** An object call's name in the report: the node's timing field without its unit. */
export type AttemptCallName = (typeof ATTEMPT_CALLS)[number] extends `${infer N}_ms` ? N : never

export type StageBTiming =
  | {
      /** Attempt rows whose three phases could be read. */
      attempts: number
      /** From the attempt's start to the request leaving: the claim and the reservation. */
      before_call: TimingSpread
      /** The buyer call alone. */
      call: TimingSpread
      /** From the answer to the attempt's end: breaker, commit or release, mark sold and the mirror. */
      after_call: TimingSpread
      /** Our own time around the call, before plus after, the figure the latency ceiling is about. */
      overhead: TimingSpread
      /** Each object call, over only the attempts that reached it, so an absent call is never a zero (L90). */
      calls: Partial<Record<AttemptCallName, TimingSpread>>
      /** Attempts written before the per call figures existed (#1835): in the phases, in no call. */
      calls_unmeasured: number
      /** Rows whose phases could not be read, left out of every figure rather than read as zero (L11). */
      unreadable: number
      /** Canary leads with no timing row at all, such as every lead before #1804: not timed, never zero time (L90). */
      executions_untimed: number
    }
  | { unmeasured: string }

/** One live attempt row's timing as stored, unread. */
export interface AttemptTimingRow {
  execution_id: string
  timing: unknown
}

export type StageBBidRows =
  | {
      canary_missing: number
      canary_multiple: number
      legacy_missing: number
      legacy_multiple: number
      settling: number
      /** Whether the day had ended when this check was taken; a check on a running day covers only part of it. */
      window_complete: boolean
    }
  | { unmeasured: string }

export interface StageBCounts {
  /** Every live percent the node recorded that day, ascending: more than one means the step changed mid day. */
  live_percent_seen: number[]
  canary: StageBCanary
  legacy: StageBArm
  /** Canary duration minus legacy step duration at the same percentile; null when either arm has none. */
  added_p50_ms: number | null
  added_p95_ms: number | null
  bid_rows: StageBBidRows
}

export type StageBBids = { rows: Map<string, number> } | { unmeasured: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function nearestRank(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

const minus = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a - b)

function codeOf(v: unknown): string {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return 'none'
}

/** A canary attempt: the node ran live and contacted a buyer (its sale is not skipped). */
function isCanaryAttempt(e: ParityExecution): boolean {
  const sale = e.node?.sale
  return e.node?.mode_effective === 'live' && isRecord(sale) && sale.skipped === false
}

/** A legacy attempt: tripoint_ping ran for the lead rather than bailing. */
function isLegacyAttempt(e: ParityExecution): boolean {
  return e.incumbent !== null && e.incumbent.skipped === false
}

export function summariseStageB(executions: ParityExecution[], bids: StageBBids, settleBeforeMs: number, windowComplete: boolean, timing: StageBTiming): StageBCounts {
  const percents = new Set<number>()
  const canaryCodes: Record<string, number> = {}
  const legacyCodes: Record<string, number> = {}
  const canaryDurations: number[] = []
  const callDurations: number[] = []
  const ownDurations: number[] = []
  const legacyDurations: number[] = []
  let canaryAttempts = 0
  let canaryAccepted = 0
  let callUnmeasured = 0
  let legacyAttempts = 0
  let legacyAccepted = 0
  const bidCheck = { canary_missing: 0, canary_multiple: 0, legacy_missing: 0, legacy_multiple: 0, settling: 0, window_complete: windowComplete }

  const checkBid = (e: ParityExecution, arm: 'canary' | 'legacy') => {
    if (!('rows' in bids)) return
    if (Date.parse(e.started_at) > settleBeforeMs) { bidCheck.settling += 1; return }
    const n = bids.rows.get(e.execution_id) ?? 0
    if (n === 0) bidCheck[`${arm}_missing`] += 1
    else if (n > 1) bidCheck[`${arm}_multiple`] += 1
  }

  for (const e of executions) {
    if (e.node?.mode_effective === 'live' && typeof e.node.live_percent_in_force === 'number') percents.add(e.node.live_percent_in_force)

    if (isCanaryAttempt(e)) {
      const sale = e.node!.sale as Record<string, unknown>
      canaryAttempts += 1
      if (sale.accepted === true) canaryAccepted += 1
      const code = codeOf(sale.result_code)
      canaryCodes[code] = (canaryCodes[code] ?? 0) + 1
      if (typeof e.node_duration_ms === 'number') {
        canaryDurations.push(e.node_duration_ms)
        const call = e.node!.buyer_call_ms
        if (typeof call === 'number') {
          callDurations.push(call)
          ownDurations.push(e.node_duration_ms - call)
        } else {
          callUnmeasured += 1
        }
      }
      checkBid(e, 'canary')
    }

    if (isLegacyAttempt(e)) {
      legacyAttempts += 1
      if (e.incumbent!.qualified === true) legacyAccepted += 1
      const code = codeOf(e.incumbent!.resultCode)
      legacyCodes[code] = (legacyCodes[code] ?? 0) + 1
      if (typeof e.incumbent_duration_ms === 'number') legacyDurations.push(e.incumbent_duration_ms)
      checkBid(e, 'legacy')
    }
  }

  const canaryP50 = nearestRank(canaryDurations, 0.5)
  const canaryP95 = nearestRank(canaryDurations, 0.95)
  const legacyP50 = nearestRank(legacyDurations, 0.5)
  const legacyP95 = nearestRank(legacyDurations, 0.95)
  return {
    live_percent_seen: [...percents].sort((a, b) => a - b),
    canary: {
      attempts: canaryAttempts,
      accepted: canaryAccepted,
      result_codes: canaryCodes,
      duration_p50_ms: canaryP50,
      duration_p95_ms: canaryP95,
      buyer_call_p50_ms: nearestRank(callDurations, 0.5),
      buyer_call_p95_ms: nearestRank(callDurations, 0.95),
      own_p50_ms: nearestRank(ownDurations, 0.5),
      own_p95_ms: nearestRank(ownDurations, 0.95),
      buyer_call_unmeasured: callUnmeasured,
      timing,
    },
    legacy: {
      attempts: legacyAttempts,
      accepted: legacyAccepted,
      result_codes: legacyCodes,
      duration_p50_ms: legacyP50,
      duration_p95_ms: legacyP95,
    },
    added_p50_ms: minus(canaryP50, legacyP50),
    added_p95_ms: minus(canaryP95, legacyP95),
    bid_rows: 'rows' in bids ? bidCheck : { unmeasured: bids.unmeasured },
  }
}

// ── The per call split (#1909) ────────────────────────────────────────────────

const finiteMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function spread(values: number[]): TimingSpread {
  return { attempts: values.length, p50_ms: nearestRank(values, 0.5), p95_ms: nearestRank(values, 0.95), total_ms: values.reduce((a, b) => a + b, 0) }
}

const callName = (field: (typeof ATTEMPT_CALLS)[number]): AttemptCallName => field.slice(0, -'_ms'.length) as AttemptCallName

/** `canaryIds` are the day's canary executions, so a lead with no timing row is counted rather than vanishing. */
export function summariseAttemptTiming(rows: AttemptTimingRow[], canaryIds: string[]): StageBTiming {
  const before: number[] = []
  const call: number[] = []
  const after: number[] = []
  const overhead: number[] = []
  const perCall = new Map<AttemptCallName, number[]>()
  let callsUnmeasured = 0
  let unreadable = 0
  const timed = new Set(rows.map((r) => r.execution_id))
  for (const row of rows) {
    const t = row.timing
    if (!isRecord(t) || !finiteMs(t.before_call_ms) || !finiteMs(t.call_ms) || !finiteMs(t.after_call_ms)) {
      unreadable += 1
      continue
    }
    before.push(t.before_call_ms)
    call.push(t.call_ms)
    after.push(t.after_call_ms)
    overhead.push(t.before_call_ms + t.after_call_ms)
    let named = 0
    for (const field of ATTEMPT_CALLS) {
      const ms = t[field]
      if (!finiteMs(ms)) continue
      named += 1
      const name = callName(field)
      perCall.set(name, [...(perCall.get(name) ?? []), ms])
    }
    if (named === 0) callsUnmeasured += 1
  }
  const calls: Partial<Record<AttemptCallName, TimingSpread>> = {}
  for (const field of ATTEMPT_CALLS) {
    const values = perCall.get(callName(field))
    if (values) calls[callName(field)] = spread(values)
  }
  return {
    attempts: before.length,
    before_call: spread(before),
    call: spread(call),
    after_call: spread(after),
    overhead: spread(overhead),
    calls,
    calls_unmeasured: callsUnmeasured,
    unreadable,
    executions_untimed: canaryIds.filter((id) => !timed.has(id)).length,
  }
}

export interface StageBTimingReadDeps {
  /** The stored timing of every live buyer_select attempt row of the executions given, started inside [fromIso, toIso), every page. */
  listAttemptTiming(executionIds: string[], fromIso: string, toIso: string): Promise<AttemptTimingRow[]>
}

/**
 * Reads the day's canary attempts' timing. Its own failure boundary (L73): a failed read is
 * unmeasured with the reason and leaves the rest of the row to be written, never zero attempts.
 */
export async function readStageBTiming(deps: StageBTimingReadDeps, executions: ParityExecution[], day: string): Promise<StageBTiming> {
  const ids = executions.filter(isCanaryAttempt).map((e) => e.execution_id)
  if (ids.length === 0) return summariseAttemptTiming([], [])
  const from = new Date(easternDayStartUtc(day)).toISOString()
  // The next Eastern day's own start, never start plus 24 hours, which is wrong on a clock change.
  const to = new Date(easternDayStartUtc(nextIsoDate(day))).toISOString()
  try {
    return summariseAttemptTiming(await deps.listAttemptTiming(ids, from, to), ids)
  } catch (err) {
    return { unmeasured: `the attempt rows could not be read: ${err instanceof Error ? err.message : 'non Error thrown'}` }
  }
}

/** Executions asked for per query; at most a few attempt rows each, and the reader pages past the cap anyway. */
export const TIMING_ID_SLICE = 200

export function productionStageBTimingDeps(supabase: SupabaseClient): StageBTimingReadDeps {
  return {
    // About 25 canary attempts a day at 1 percent, one or two rows each; at a full
    // live share a slice could pass PostgREST's 1,000 row cap, so every slice is
    // paged in a stable order rather than trusted to fit (L24, L746).
    listAttemptTiming: async (executionIds, fromIso, toIso) => {
      const out: AttemptTimingRow[] = []
      for (let i = 0; i < executionIds.length; i += TIMING_ID_SLICE) {
        const slice = executionIds.slice(i, i + TIMING_ID_SLICE)
        const rows = await fetchAllPaged<AttemptTimingRow>(
          (from, to) => supabase
            .from('execution_steps')
            .select('execution_id, timing:output->timing')
            .eq('step_type', 'partner_bid')
            .in('execution_id', slice)
            .not('output->timing', 'is', null)
            .gte('execution_started_at', fromIso)
            .lt('execution_started_at', toIso)
            .order('execution_started_at', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to),
          'execution_steps attempt timing',
          { maxPages: 20 },
        )
        out.push(...rows)
      }
      return out
    },
  }
}

// ── Reading the day's bid rows ────────────────────────────────────────────────

export interface StageBBidReadDeps {
  /** The attempted_at of the oldest Tripoint bid row still held, as a UTC ISO instant; null when none is held. */
  earliestBidRowIso(): Promise<string | null>
  /** One execution id per attempted Tripoint bid row (one with a classification) inside [fromIso, toIso), every page. */
  listBidExecutions(fromIso: string, toIso: string): Promise<string[]>
}

export async function readStageBBids(deps: StageBBidReadDeps, day: string): Promise<StageBBids> {
  const start = easternDayStartUtc(day)
  const earliest = await deps.earliestBidRowIso()
  if (earliest === null) return { unmeasured: 'no Tripoint bid row is held at all, so none can be counted' }
  if (Date.parse(earliest) > start) {
    return { unmeasured: `the bid rows for this day have already been exported and removed (the oldest still held is from ${earliest})` }
  }
  // The next Eastern day's own start, never start plus 24 hours, which is wrong on a clock change.
  const end = easternDayStartUtc(nextIsoDate(day)) + BID_READ_MARGIN_MS
  const ids = await deps.listBidExecutions(new Date(start).toISOString(), new Date(end).toISOString())
  const rows = new Map<string, number>()
  for (const id of ids) rows.set(id, (rows.get(id) ?? 0) + 1)
  return { rows }
}

/** attempted_at_utc is a timestamp WITHOUT a zone holding UTC, so it comes back with no zone and is read as UTC. */
function utcIso(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

export function productionStageBBidDeps(supabase: SupabaseClient): StageBBidReadDeps {
  // Every day of one refresh asks the same question, and the answer is a scan of
  // the table's Tripoint rows (about 1.3 s measured on 2026-10-06), so it is read
  // once per set of deps, which is once per refresh run. A failed read is not kept.
  let earliest: Promise<string | null> | null = null
  return {
    earliestBidRowIso: () => {
      earliest ??= readEarliest().catch((err: unknown) => { earliest = null; throw err })
      return earliest
    },
    // About 3,500 attempted rows a day on the Engine and Main flows together, so a
    // few pages (55 ms each, measured 2026-10-06). Ordered by the partition key with
    // id as the tiebreaker so offset pages neither skip nor repeat a row (L746).
    listBidExecutions: async (fromIso, toIso) => {
      const rows = await fetchAllPaged<{ execution_id: string | null }>(
        (from, to) => supabase
          .from('lead_sighting_bids')
          .select('execution_id')
          .eq('partner_slug', STAGE_B_BUYER_SLUG)
          // An attempt is a row with a classification. A bail row has none (skip_reason
          // 'skipped'), but the legacy arm's declines carry a skip_reason too ('duplicate',
          // 'rejected'), so keying on skip_reason would count them as missing (2026-10-06).
          .not('classification', 'is', null)
          .not('is_test', 'is', true)
          .gte('attempted_at_utc', fromIso)
          .lt('attempted_at_utc', toIso)
          .order('attempted_at_utc', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
        'lead_sighting_bids',
      )
      return rows.map((r) => r.execution_id).filter((id): id is string => typeof id === 'string')
    },
  }

  async function readEarliest(): Promise<string | null> {
    const { data, error } = await supabase
      .from('lead_sighting_bids')
      .select('attempted_at_utc')
      .eq('partner_slug', STAGE_B_BUYER_SLUG)
      .order('attempted_at_utc', { ascending: true })
      .limit(1)
    if (error) throw new Error(`lead_sighting_bids oldest row: ${error.message}`)
    const rows = (data ?? []) as Array<{ attempted_at_utc?: unknown }>
    if (rows.length === 0) return null
    // A row whose time cannot be read is not "no row held" (L11): say what failed.
    const iso = utcIso(rows[0].attempted_at_utc)
    if (iso === null) throw new Error(`lead_sighting_bids oldest row: attempted_at_utc ${JSON.stringify(rows[0].attempted_at_utc)} could not be read as a time`)
    return iso
  }
}
