/**
 * The Stage B daily report (#1809): beside each Stage A parity row, what the
 * canary arm (buyer_select selling live) and the legacy arm (tripoint_ping) did
 * that day. Each live percent step of #1414 is judged against the same
 * criteria (attempts, the accept rate against the legacy arm, the added latency
 * against the ceiling, one bid row per execution), and the 1 percent review on
 * 2026-10-06 took a few dozen hand queries over tables purged within a week,
 * with the bid rows already gone for most of the period. This row outlives both.
 *
 * Computed from the rows the parity refresh already reads (no new read of
 * execution_steps), plus one read of Tripoint's bid rows for the day. Those
 * drain within about a day of export, so a day whose bid rows are no longer all
 * held is unmeasured, never a count of zero missing (L98, L90), and an
 * execution too recent for its bid row to have landed is settling, never
 * missing. A failed bid read marks that check unmeasured and leaves every other
 * figure, and the Stage A counts, standing (L73).
 *
 * Not part of the counts hash: a sign off approves the Stage A counts, and a
 * Stage B figure moving must not clear it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { easternDayStartUtc } from '@bidspoke/buyer-profile'
import { nextIsoDate, type ParityExecution } from './buyer-select-parity'
import { fetchAllPaged } from './paginate'

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

export function summariseStageB(executions: ParityExecution[], bids: StageBBids, settleBeforeMs: number, windowComplete: boolean): StageBCounts {
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
