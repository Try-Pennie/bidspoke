/**
 * buyer_select (#1411, milestone 52): sell a sell-off lead to the highest
 * ranked eligible buyer, or say precisely why not.
 *
 * The node is walker-only (see NODE_TRAITS): engine/index.ts calls
 * executeBuyerSelectNode, writes the parent step row from `output`, one
 * `partner_bid` child row per buyer actually attempted from `attempts`, and
 * routes on `output._route`. It never runs through executeNode's retry loop,
 * because a retried sale is a duplicate send (tripoint_ping's `retries: 0`).
 *
 * Order of decisions, each a named reason (L11):
 *   1. mode valid                     mode_invalid fails the step in any mode
 *   2. applicability                  sell_off_when true AND bid_when_positive > 0 (L620),
 *                                     before any database or object call
 *   3. lead key                       empty fails live, defers otherwise
 *   4. live share                     unset or non numeric defers (L72), out of share defers
 *   5. rehearsal caps (decide_only)   invalid JSON defers
 *   6. profiles                       the loader's last good copy, or unavailable
 *   7. eligibility and ranking        the shared evaluator, one reason per buyer
 *   8. the payload                    resolved only now, so a non sell-off lead pays nothing
 *   9. attempts in rank order         runBuyerSaleAttempt per buyer; a decline moves on,
 *                                     outcome_unknown stops and holds
 *
 * Three effective modes (L319): `live` sells; `decide_only` does everything but
 * the buyer call under the rehearsal ledger kind and never throws (L142);
 * `report_only` (Test Runner, shadow, local dev) evaluates and touches nothing
 * (L719). The output never carries a Tripoint shaped key, so the legacy
 * `isTripointBidOutput` cannot mistake it for tripoint_ping's output.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BUYER_SELECT_MODES,
  DeadlineError,
  canaryBucket,
  canonicalBodySha256,
  evaluateEligibility,
  evaluateSaleOutcome,
  getBodyField,
  leadFieldWired,
  matchSignal,
  rankBuyers,
  withDeadline,
  type BuyerSelectMode,
  type ConsideredOutcome,
  type LedgerKind,
  type ModeEffective,
  type NodeReason,
  parsePositiveAmount,
  parseUsState,
  responseClassOf,
  type ResponseClass,
  type UsState,
  type OutReason,
  type Population,
  type SalePayloadSpec,
  type Signal,
  type Timers,
} from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { CapLimits, EntryKey, LedgerEntry, SaleOutcomeRecord } from '../../durable-objects/buyer-ledger'
import type { CheckResult } from '../../durable-objects/circuit-breaker'
import { BuyerLedgerClient, LEDGER_RELEASE_OP, LeadSaleClient, MEASURED_OBJECT_CALL_P99_MS, OBJECT_CALL_DEADLINE_MS, SALE_FREE_OP, type ClientOptions } from '../../lib/buyer-object-clients'
import { loadBuyerProfiles, type BuyerProfilesSnapshot, type LoadedBuyer } from '../../lib/buyer-profile-loader'
import { ClaimTally, runBuyerSaleAttempt, type AttemptResult, type AttemptStep, type BuyerCall, type LedgerApi, type MirrorOutcome, type SaleApi } from '../../lib/buyer-sale-attempt'
import { buildBuyerSaleRow, mirrorBuyerSale, type BuyerSaleRow } from '../../lib/buyer-sale-mirror'
import type { AttemptTiming } from '../../lib/attempt-timing'
import { postToPartner, type PartnerCallResult, type PartnerCallTarget } from '../../lib/post-to-partner'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'
import { applyOutboundMapping } from '../../lib/field-mapper'
import { log as structuredLog } from '../../lib/logger'
import { leadDatabaseDown, noteLeadWriteUnanswered } from '../../lib/lead-read-budget'
import { PartnerApiError } from '../partner-bid-error'
import { makeBidLogger, type BidLogger } from '../bid-logger'
import { resolveValue } from '../context'
import { nodeReportsOnly, runRealityOf } from '../run-reality'
import { resolveSalePayload } from './buyer-select-payload'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * decide_only sits on Engine's response path, so it gives up before it costs a bid.
 *
 * The budget bounds the WHOLE node, not each wait (#1491): every object call
 * inside the attempt is given what is left of it, read at the call, and the
 * attempt stops between steps once it is spent. Before that, each call was
 * bounded by the remaining budget only at the moment it started, so a call
 * starting with 1 ms left could run its own full time. Measured on the Engine
 * Bidding Workflow during Stage A (2026-09-23 19:18 to 19:45 UTC, per wait):
 * deferred rows p50 648 ms, p95 1,087 ms, max 1,209 ms, and by 21:00 UTC a
 * max of 4,998 ms, none reporting rehearsal_deadline. The after figures go on
 * #1491 and #1414 from the first full day with this in force.
 */
export const BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS = 800
/**
 * Live has a ceiling of its own BEFORE the buyer call (#1508): the profile read,
 * the breaker check, the claim, the reservation and any wait on another holder
 * share this budget from the node's start, read between steps and given to each
 * object call as what is left of it. The buyer call is not under it (it keeps
 * BUYER_CALL_TIMEOUT_MS), and neither is anything after it: commit and mark
 * sold keep OBJECT_CALL_DEADLINE_MS and the outcome_unknown page, because an
 * accepted answer must be recorded whatever the clock says. A spent budget
 * routes no_sale with object_deadline, holding nothing.
 *
 * The value is proposed from Stage A day 2 (2026-09-24, on #1508) and is Dan's
 * to confirm before the 1 percent step: the rehearsal, which runs the same steps
 * without the buyer call, sat at p50 635 / p95 913 ms over 691 rows under an 800
 * ms budget that refused 4.1 percent of leads; the worst object call p99 across
 * the Phase 3 drills is MEASURED_OBJECT_CALL_P99_MS; Engine allows 20 s for the
 * whole response and the buyer call alone reached 10.5 s that day. Two seconds
 * clears both measured figures with room and leaves the rest of the window to
 * the buyer.
 */
export const BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS = 2_000
export { MEASURED_OBJECT_CALL_P99_MS }
/** The whole buyer call, the same budget tripoint_ping's fetch carried. */
export const BUYER_CALL_TIMEOUT_MS = 20_000
/**
 * How long a lead waits on its buyer_sales copy (record_buyer_sale) after the
 * buyer answered (#1849). It had no deadline, so a database that hung held a
 * sold lead's answer for ever. Measured 2026-10-07 from Supabase edge logs over
 * 24 hours: 50 calls, p99 403 ms, the slowest 488 ms. Past it the copy is left
 * to the minute drain, which writes the same row through the same idempotent
 * rpc, and the copy is reported as outcome_unknown, never undone.
 */
export const BUYER_SALE_MIRROR_DEADLINE_MS = 1_000
/** How often a live attempt re-reads a claim another execution holds. */
export const CLAIM_WAIT_INTERVAL_MS = 250
export const REHEARSAL_CAPS_ENV = 'BUYER_SELECT_REHEARSAL_CAPS'
export const REHEARSAL_RESULT_CODE = 'rehearsal_no_call'

const NO_CAPS: CapLimits = { hourly_lead_cap: null, daily_lead_cap: null, hourly_spend_cap_cents: null, daily_spend_cap_cents: null }

// ── Config and output shapes ──────────────────────────────────────────────────

export interface BuyerSelectConfig {
  population: Population
  mode: BuyerSelectMode
  live_percent_env?: string
  sell_off_when: string
  /** L620: the incumbent also bails on a zero bid. Optional, so a population without a bid can leave it out. */
  bid_when_positive?: string
  lead_key: string
  state?: string
  debt?: string
  loan_amount?: string
  /**
   * The lead's collections balance (#2111), judged only against a profile that
   * caps collections. Unset or blank, a capped buyer is out as
   * collections_not_wired on every lead.
   */
  collections?: string
  sale_payload: SalePayloadSpec
  /** Ignored, and reported as such: the node runs once whatever the definition says. */
  retries?: number
}

export type BuyerSelectRoute = 'sold' | 'no_sale' | 'not_applicable' | 'deferred'
export type BuyerSelectReason = NodeReason | OutReason
// The considered outcomes and the effective modes are the package's, so the
// execution view labels the same words the engine writes (#1412, L113).
export type { ConsideredOutcome, ModeEffective }

export interface ConsideredBuyer {
  partner: string
  priority: number | null
  payout_cents: number | null
  outcome: ConsideredOutcome
  reason?: BuyerSelectReason
  detail?: string
}

/**
 * The sale, in the shape the Engine response and Salesforce patch scripts read
 * (docs/nodes/buyer-select.md). The winner's own facts travel on it (#1416):
 * the name Salesforce records, where the sold lead lands, the routing code the
 * prospect patch carries, and the Success, Duplicate or Fail class, so a
 * second buyer needs no script change. A decline carries the declining buyer,
 * its code and its class, and no landing page or routing code, because nothing
 * was sold; a skipped sale carries nothing.
 */
export interface BuyerSelectSale {
  skipped: boolean
  accepted: boolean
  buyer_reference: string | null
  result_code: string | null
  partner_slug: string | null
  partner_name: string | null
  click_url: string | null
  routing_code: number | null
  response_class: ResponseClass | null
}

export interface BuyerSelectOutput {
  _route: BuyerSelectRoute
  reason: BuyerSelectReason
  detail?: string
  mode_effective: ModeEffective
  population: string
  lead_key: string | null
  sale: BuyerSelectSale
  /** The state the node resolved for the lead, null when the value was not a state; the parity summary counts it (#1413). */
  lead_state?: UsState | null
  /** The debt the node priced the lead on, in whole dollars, null when the value was not an amount; the lead sighting records it as external_debt (#1482). */
  lead_debt?: number | null
  considered: ConsideredBuyer[]
  live_percent_in_force: number | null
  caps_in_force: Array<{ partner: string } & CapLimits>
  profiles_served_from?: BuyerProfilesSnapshot['served_from']
  would_send_body_sha256?: string
  /** Whether the buyer_sales copy landed; outcome_unknown when it ran out of time and may have (#1849). */
  mirrored?: MirrorOutcome
  replay?: boolean
  retries_ignored?: number
  /**
   * How many of this execution's lead sale claims found the holder past its
   * deadline and moved it to in_doubt, and how many in_doubt claims its attempts
   * healed from the ledger (#1643). The parity reader sums both per day. Written,
   * as 0 when nothing happened, whenever at least one claim answered; left out
   * when none did (not for sale, no eligible buyer, a claim that never answered),
   * because such a lead measured nothing. The names are the parity reader's: in
   * live the same facts are recorded under them, about the live claim namespace.
   */
  rehearsal_expired_in_flight?: number
  rehearsal_in_doubt_heals?: number
  /**
   * The total time spent inside buyer calls, in milliseconds, so the node's own cost is
   * duration_ms minus this on one row (#1804). Each attempt row carries its own split as
   * `timing`. Left out when no buyer was called, so an unmeasured lead is never a zero (L90).
   */
  buyer_call_ms?: number
  duration_ms: number
}

/** One `partner_bid` child step row, written by the walker under the node's id. */
export interface BuyerAttemptRow {
  partner_slug: string
  namespace: string
  status: 'completed' | 'failed'
  input: Record<string, unknown>
  output: Record<string, unknown>
  error: string | null
  error_type: 'transient' | 'permanent' | null
  started_at: Date
  completed_at: Date
}

export interface BuyerSelectFailure {
  message: string
  errorType: 'transient' | 'permanent'
  reason: BuyerSelectReason
}

export interface BuyerSelectResult {
  output: BuyerSelectOutput
  attempts: BuyerAttemptRow[]
  failure?: BuyerSelectFailure
}

// ── Injectable dependencies ───────────────────────────────────────────────────

export interface BreakerApi {
  check(): Promise<CheckResult>
  recordSuccess(): Promise<unknown>
  recordError(): Promise<unknown>
  releaseProbe(): Promise<unknown>
}

export interface BuyerSelectDeps {
  loadProfiles: () => Promise<BuyerProfilesSnapshot>
  /** The node passes a deadline function reading what is left of its budget: the whole run in decide_only (#1491), the steps before the buyer call in live (#1508); cleanup and everything after the call get the client's standard deadline. */
  saleClient: (key: EntryKey, opts?: ClientOptions) => SaleApi
  /**
   * A read of the lead's sale record that changes nothing in it, sent without waiting before the
   * profiles read so the record is already running when the claim arrives (#1804). The first call
   * to a new record measured p50 270 ms against 24 ms for a later call to the same record.
   */
  wakeSale: (key: EntryKey) => Promise<unknown>
  ledgerClient: (partnerId: string, opts?: ClientOptions) => LedgerApi
  /** Where cleanup after a rehearsal budget ending runs, off the response path (#1512). The work never rejects. */
  background?: (work: Promise<void>) => void
  callBuyer: (target: PartnerCallTarget, body: unknown, opts: { traceId: string; timeoutMs: number }) => Promise<PartnerCallResult>
  breaker: (slug: string) => BreakerApi
  mirror: (row: BuyerSaleRow, entry: LedgerEntry, partnerId: string) => Promise<void>
  logBid: BidLogger
  clock: () => number
  sleep: (ms: number) => Promise<void>
  timers?: Timers
  log: (fields: { event: string } & Record<string, unknown>) => void
  /** Says a database write this lead waited on did not answer in time, so its later reads take their copies at once (#1849). */
  writeUnanswered: (what: string) => void
  localDev: boolean
}

export function productionDeps(ctx: ExecutionContext, env: Env, supabase: SupabaseClient): BuyerSelectDeps {
  const orgId = ctx.trigger.org_id
  // Fire and forget, the pattern partner-bid's breaker writes use (#129): the walk is still
  // inside the request, so the isolate stays alive for it, and the work never rejects.
  const background = (work: Promise<unknown>) => { void work }
  return {
    // The loader rebuilds an ageing cached snapshot in the background (#1492), so the read this lead pays stays a cache hit.
    loadProfiles: () => loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase, { background }),
    saleClient: (key, opts) => new LeadSaleClient(env.LEAD_SALE, key, opts),
    wakeSale: (key) => new LeadSaleClient(env.LEAD_SALE, key).read(),
    ledgerClient: (partnerId, opts) => new BuyerLedgerClient(env.BUYER_LEDGER, partnerId, opts),
    background,
    callBuyer: (target, body, opts) => postToPartner(target, body, env, opts),
    breaker: (slug) => new CircuitBreakerClient(env, slug),
    mirror: async (row, entry, partnerId) => {
      // Not sent into a database this lead has already seen fail (#1849): the
      // entry stays unmirrored and the minute drain delivers it through the same
      // idempotent rpc, so waiting out a deadline here would only hold the answer.
      const down = leadDatabaseDown(supabase)
      if (down) throw new Error(`record_buyer_sale not sent: ${down}`)
      const ledger = new BuyerLedgerClient(env.BUYER_LEDGER, partnerId)
      await mirrorBuyerSale(supabase, row, entry, { markMirrored: (stamp) => ledger.markMirrored([stamp]).then(() => undefined) })
    },
    logBid: makeBidLogger(supabase, ctx, 'buyer_select'),
    clock: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (fields) => structuredLog({ ...fields, trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, execution_id: ctx.trigger.execution_id } as Parameters<typeof structuredLog>[0]),
    writeUnanswered: (what) => noteLeadWriteUnanswered(supabase, what),
    localDev: runRealityOf(ctx, env).localDev,
  }
}

// ── The executor ──────────────────────────────────────────────────────────────

const SKIPPED_SALE: BuyerSelectSale = {
  skipped: true, accepted: false, buyer_reference: null, result_code: null, partner_slug: null,
  partner_name: null, click_url: null, routing_code: null, response_class: null,
}

export async function executeBuyerSelectNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  deps: BuyerSelectDeps
): Promise<BuyerSelectResult> {
  void env
  const run = new Run(node, ctx, deps)
  try {
    return await run.execute()
  } finally {
    run.finish()
  }
}

class Run {
  private readonly config: BuyerSelectConfig
  private readonly startedAt: number
  private readonly modeEffective: ModeEffective
  private readonly configuredMode: BuyerSelectMode | null
  private readonly out: BuyerSelectOutput
  private readonly attempts: BuyerAttemptRow[] = []
  private leadKey: string | null = null
  /** Set the moment a live buyer call starts: from then on the pre-call budget no longer applies (#1508). */
  private buyerCallStarted = false
  /** Every claim answer and heal across this execution's attempts (#1643). */
  private readonly claims = new ClaimTally()

  constructor(private readonly node: NodeDefinition, private readonly ctx: ExecutionContext, private readonly deps: BuyerSelectDeps) {
    this.config = node.config as unknown as BuyerSelectConfig
    this.startedAt = deps.clock()
    this.configuredMode = (BUYER_SELECT_MODES as readonly string[]).includes(String(this.config.mode)) ? this.config.mode : null
    const reportOnly = nodeReportsOnly('buyer_select', runRealityOf(ctx, { LOCAL_DEV: deps.localDev }))
    this.modeEffective = reportOnly ? 'report_only' : this.configuredMode ?? 'live'
    this.out = {
      _route: 'no_sale',
      reason: 'no_eligible_buyer',
      mode_effective: this.modeEffective,
      population: String(this.config.population ?? ''),
      lead_key: null,
      sale: SKIPPED_SALE,
      considered: [],
      live_percent_in_force: null,
      caps_in_force: [],
      duration_ms: 0,
    }
    if (typeof this.config.retries === 'number') this.out.retries_ignored = this.config.retries
  }

  finish(): void {
    this.out.duration_ms = this.deps.clock() - this.startedAt
    if (this.claims.measured) {
      this.out.rehearsal_expired_in_flight = this.claims.expiredInFlight
      this.out.rehearsal_in_doubt_heals = this.claims.inDoubtHeals
    }
    if (this.modeEffective === 'decide_only') {
      this.deps.log({ event: 'buyer_select_decide_only_latency', mode: 'decide_only', duration_ms: this.out.duration_ms, route: this.out._route, reason: this.out.reason, step_namespace: this.node.namespace })
    }
  }

  // ── Outcomes ─────────────────────────────────────────────────────────────────

  private done(route: BuyerSelectRoute, reason: BuyerSelectReason, detail?: string): BuyerSelectResult {
    this.out._route = route
    this.out.reason = reason
    if (detail !== undefined) this.out.detail = detail
    this.deps.log({ event: 'buyer_select_reason', step_namespace: this.node.namespace, route, reason, detail, mode_effective: this.modeEffective })
    return { output: this.out, attempts: this.attempts }
  }

  private fail(reason: BuyerSelectReason, errorType: 'transient' | 'permanent', detail: string): BuyerSelectResult {
    const result = this.done('no_sale', reason, detail)
    return { ...result, failure: { message: `buyer_select ${reason}: ${detail}`, errorType, reason } }
  }

  /** Live fails the step; decide_only and report_only route onward with the reason (L142). */
  private refuse(reason: BuyerSelectReason, detail: string, errorType: 'transient' | 'permanent' = 'permanent'): BuyerSelectResult {
    return this.modeEffective === 'live' ? this.fail(reason, errorType, detail) : this.done('deferred', reason, detail)
  }

  // ── The walk ─────────────────────────────────────────────────────────────────

  async execute(): Promise<BuyerSelectResult> {
    // 1. mode. No default, in any mode (L72).
    if (!this.configuredMode) {
      return this.fail('mode_invalid', 'permanent', `mode is ${JSON.stringify(this.config.mode ?? null)}, expected one of ${BUYER_SELECT_MODES.join(', ')}`)
    }

    // 2. applicability, before any database or object call.
    const applicability = this.applicability()
    if (applicability) return applicability

    // 3. lead key.
    const leadKey = this.resolveString(this.config.lead_key)
    if (!leadKey) return this.refuse('lead_key_empty', `lead_key template ${JSON.stringify(this.config.lead_key ?? null)} resolved to nothing`)
    this.leadKey = leadKey
    this.out.lead_key = leadKey

    // 4. the live share. Computed whenever the variable is named, routed on only when live.
    if (this.config.live_percent_env) {
      const percent = this.livePercent(this.config.live_percent_env)
      this.out.live_percent_in_force = percent
      if (this.modeEffective === 'live') {
        if (percent === null) return this.done('deferred', 'live_percent_unset', `${this.config.live_percent_env} is unset or not a whole number from 0 to 100`)
        const bucket = canaryBucket(leadKey)
        if (bucket >= percent) return this.done('deferred', 'canary_out', `bucket ${bucket} is outside the ${percent} percent live share`)
      }
    }

    // The live claim's record, woken now so its start up overlaps the profiles read and the
    // ranking rather than sitting in front of the buyer call (#1804). Not awaited: the claim does
    // the real work and reports its own failure, so a failed wake only costs the time it saved.
    if (this.modeEffective === 'live') {
      const key: EntryKey = { kind: 'live', population: this.out.population as Population, lead_key: leadKey }
      this.deps.wakeSale(key).catch((err: unknown) => {
        this.deps.log({ event: 'buyer_select_wake_failed', step_namespace: this.node.namespace, error_message: messageOf(err) })
      })
    }

    // 5. rehearsal caps.
    let rehearsalCaps: CapLimits = NO_CAPS
    if (this.modeEffective === 'decide_only') {
      const parsed = this.rehearsalCaps()
      if (!parsed.ok) return this.done('deferred', 'rehearsal_caps_invalid', parsed.detail)
      rehearsalCaps = parsed.caps
    }

    // 6. profiles.
    let snapshot: BuyerProfilesSnapshot
    try {
      snapshot = await this.bounded(this.deps.loadProfiles(), 'buyer profiles read')
    } catch (err) {
      return this.refuse('profiles_unavailable', messageOf(err), 'transient')
    }
    this.out.profiles_served_from = snapshot.served_from
    if (this.pastDeadline()) return this.budgetEnded(`profiles took the whole ${this.budgetMs()} ms budget`)

    // 7. eligibility and ranking.
    const candidates = this.rank(snapshot, leadKey)
    if (candidates.length === 0) {
      return this.done(this.modeEffective === 'live' ? 'no_sale' : 'deferred', 'no_eligible_buyer')
    }

    // 8. the payload, resolved only now.
    let payload: Record<string, unknown>
    try {
      payload = resolveSalePayload(this.config.sale_payload, this.ctx)
    } catch (err) {
      return this.refuse('payload_invalid', messageOf(err))
    }

    if (this.modeEffective === 'report_only') {
      for (const c of candidates) this.consider(c, 'eligible')
      this.out.would_send_body_sha256 = await canonicalBodySha256(payload)
      return this.done('deferred', 'report_only')
    }

    // 9. attempts in rank order.
    return this.attemptAll(candidates, payload, leadKey, rehearsalCaps)
  }

  // ── Steps ────────────────────────────────────────────────────────────────────

  private applicability(): BuyerSelectResult | null {
    const flag = this.resolveMaybe(this.config.sell_off_when)
    if (!flag.ok || flag.value === undefined) {
      return this.done('deferred', 'sell_off_unresolved', `sell_off_when ${JSON.stringify(this.config.sell_off_when ?? null)} could not be resolved`)
    }
    if (typeof flag.value !== 'boolean') {
      this.deps.log({ event: 'sell_off_flag_not_boolean', step_namespace: this.node.namespace, value_type: typeof flag.value, value: summarise(flag.value) })
      return this.done('not_applicable', 'sell_off_false', `sell_off_when resolved to a ${typeof flag.value}, treated as false`)
    }
    if (!flag.value) return this.done('not_applicable', 'sell_off_false')

    if (this.config.bid_when_positive) {
      const bid = this.resolveMaybe(this.config.bid_when_positive)
      const value = bid.ok ? bid.value : undefined
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return this.done('not_applicable', 'bid_not_positive', `bid_when_positive resolved to ${summarise(value)}`)
      }
    }
    return null
  }

  private livePercent(envName: string): number | null {
    const raw = this.ctx.env[envName]
    if (raw === undefined || raw === null) return null
    const text = String(raw).trim()
    if (!/^\d{1,3}$/.test(text)) return null
    const n = Number(text)
    return n >= 0 && n <= 100 ? n : null
  }

  private rehearsalCaps(): { ok: true; caps: CapLimits } | { ok: false; detail: string } {
    const raw = this.ctx.env[REHEARSAL_CAPS_ENV]
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      this.deps.log({ event: 'buyer_select_rehearsal_caps_unset', step_namespace: this.node.namespace, variable: REHEARSAL_CAPS_ENV })
      return { ok: true, caps: NO_CAPS }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return { ok: false, detail: `${REHEARSAL_CAPS_ENV} is not JSON` }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, detail: `${REHEARSAL_CAPS_ENV} is not an object` }
    const obj = parsed as Record<string, unknown>
    const caps: Record<string, number | null> = {}
    for (const key of Object.keys(NO_CAPS) as Array<keyof CapLimits>) {
      if (!(key in obj)) return { ok: false, detail: `${REHEARSAL_CAPS_ENV} is missing ${key}` }
      const v = obj[key]
      if (v === null) caps[key] = null
      else if (typeof v === 'number' && Number.isInteger(v) && v >= 0) caps[key] = v
      else return { ok: false, detail: `${REHEARSAL_CAPS_ENV}.${key} must be null or a non negative whole number` }
    }
    return { ok: true, caps: caps as unknown as CapLimits }
  }

  private rank(snapshot: BuyerProfilesSnapshot, leadKey: string): Candidate[] {
    const lead = {
      state: this.resolveMaybe(this.config.state).value,
      debt: this.resolveMaybe(this.config.debt).value,
      loanAmount: this.resolveMaybe(this.config.loan_amount).value,
      collections: this.resolveMaybe(this.config.collections).value,
      collectionsWired: leadFieldWired(this.config, 'collections'),
    }
    this.out.lead_state = parseUsState(lead.state)
    this.out.lead_debt = recordedAmount(lead.debt)
    const now = this.deps.clock()
    const eligible: Candidate[] = []
    for (const buyer of snapshot.buyers) {
      // A click sold buyer (#1541) is offered by buyer_click_check and sold by the
      // click workflow, never here, so it is not one of this node's buyers at all
      // and is left out of the considered list (#1543): listing it as "No pricing
      // for this lead source" said something false about it on every lead.
      if (buyer.profile.soldOn === 'click') continue
      const priority = buyer.profile.priority
      if (!buyer.partner.is_active) {
        this.out.considered.push({ partner: buyer.partner.slug, priority, payout_cents: null, outcome: 'ineligible', reason: 'inactive' })
        continue
      }
      const verdict = evaluateEligibility(buyer.profile, lead, this.out.population, now)
      if (!verdict.eligible) {
        this.out.considered.push({ partner: buyer.partner.slug, priority, payout_cents: null, outcome: 'ineligible', reason: verdict.reason })
        continue
      }
      eligible.push({ buyer, partnerId: buyer.partner.id, priority: priority ?? Number.MAX_SAFE_INTEGER, payoutCents: verdict.price.payoutCents, debtCents: verdict.debtCents, multiplier: verdict.price.multiplier })
    }
    return rankBuyers(eligible, leadKey).order
  }

  private async attemptAll(candidates: Candidate[], payload: Record<string, unknown>, leadKey: string, rehearsalCaps: CapLimits): Promise<BuyerSelectResult> {
    const live = this.modeEffective === 'live'
    const kind: LedgerKind = live ? 'live' : 'rehearsal'
    let lastReason: BuyerSelectReason = 'no_eligible_buyer'
    let lastDetail: string | undefined

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]
      if (this.pastDeadline()) {
        // A rehearsal ran out of time before this buyer (not_reached); a live node did too, and the
        // buyer is skipped by name rather than told an earlier buyer took the lead.
        for (const rest of candidates.slice(i)) this.consider(rest, live ? 'skipped' : 'not_reached', this.deadlineReason())
        return this.budgetEnded(`${i} of ${candidates.length} buyers attempted`)
      }
      const limits: CapLimits = live ? profileCaps(c.buyer.profile) : rehearsalCaps
      this.out.caps_in_force.push({ partner: c.buyer.partner.slug, ...limits })

      // The breaker: the same upstream Main Flow's Partner Bid talks to, so the same breaker.
      const breaker = c.buyer.partner.circuit_enabled ? this.deps.breaker(c.buyer.partner.slug) : null
      let probeClaimed = false
      if (breaker) {
        let check: CheckResult
        try {
          check = await this.bounded(breaker.check(), `circuit check ${c.buyer.partner.slug}`)
        } catch (err) {
          // An unreadable breaker is not an allow, and not an open breaker either (#1530): skip this buyer by name.
          this.consider(c, 'skipped', 'breaker_unreadable', messageOf(err))
          lastReason = 'breaker_unreadable'
          continue
        }
        if (!check.allowed) {
          this.consider(c, 'skipped', 'circuit_open', check.reason ?? check.state)
          lastReason = 'circuit_open'
          continue
        }
        probeClaimed = check.state === 'half_open'
      }

      const attempt = await this.attemptOne(c, payload, leadKey, kind, limits, breaker, probeClaimed)
      if (attempt.kind !== 'next') return attempt.result
      lastReason = attempt.reason
      lastDetail = attempt.detail
    }

    if (live) return this.done('no_sale', lastReason, lastDetail)
    return this.done('deferred', lastReason, lastDetail)
  }

  private async attemptOne(
    c: Candidate,
    payload: Record<string, unknown>,
    leadKey: string,
    kind: LedgerKind,
    limits: CapLimits,
    breaker: BreakerApi | null,
    probeClaimed: boolean
  ): Promise<{ kind: 'sold' | 'stop'; result: BuyerSelectResult } | { kind: 'next'; reason: BuyerSelectReason; detail?: string }> {
    const partner = c.buyer.partner
    const live = kind === 'live'
    const population = this.out.population as Population
    const key: EntryKey = { kind, population, lead_key: leadKey }
    const startedAt = new Date(this.deps.clock())
    const executionId = this.ctx.trigger.execution_id ?? this.ctx.trigger.trace_id

    const body = applyOutboundMapping(payload, partner.outbound_field_mapping)
    if (!live) this.out.would_send_body_sha256 = await canonicalBodySha256(body)

    // What the buyer call saw, for the breaker and for deciding whether an unknown outcome fails the step.
    let lastCall: { status: number | null; thrown: boolean } | null = null
    let buyerCalled = false
    // When the request left and when it answered or threw, read on the node's clock (#1804).
    let callWindow: { startMs: number; endMs: number } | null = null
    // When each step of the attempt landed, read on the same clock, to time each object call (#1804).
    const landed: Partial<Record<AttemptStep, number>> = {}
    // What the buyer answered, kept beside the outcome so a decline's sale can name
    // the code and the class Salesforce records (#1416). Null until an answer arrives.
    let lastAnswer: { record: SaleOutcomeRecord; response_class: ResponseClass | null } | null = null

    const callBuyer = async (): Promise<BuyerCall> => {
      if (!live) {
        return { outcome: 'accepted', record: { buyer_reference: null, result_code: REHEARSAL_RESULT_CODE, http_status: null, payout_cents: c.payoutCents } }
      }
      buyerCalled = true
      this.buyerCallStarted = true
      const target: PartnerCallTarget = { slug: partner.slug, api_endpoint: partner.api_endpoint, cf_secret_key: partner.cf_secret_key }
      let res: PartnerCallResult
      const callStartMs = this.deps.clock()
      try {
        res = await this.deps.callBuyer(target, body, { traceId: this.ctx.trigger.trace_id, timeoutMs: BUYER_CALL_TIMEOUT_MS })
      } catch (err) {
        callWindow = { startMs: callStartMs, endMs: this.deps.clock() }
        if (err instanceof PartnerApiError && err.isConfigError) {
          callWindow = null
          // Never sent: our configuration, not the buyer. The breaker does not count it (#417).
          lastCall = { status: null, thrown: false }
          buyerCalled = false
          return { outcome: 'buyer_error', record: { buyer_reference: null, result_code: 'config_error', http_status: null, payout_cents: c.payoutCents } }
        }
        // A timeout, an abort or a reset: the buyer may have received the lead.
        lastCall = { status: null, thrown: true }
        await this.breakerOutcome(breaker, 'error', partner.slug)
        return { outcome: 'outcome_unknown', record: { buyer_reference: null, result_code: err instanceof Error ? err.name : 'thrown', http_status: null, payout_cents: c.payoutCents } }
      }
      // Stopped before the breaker is told, so our own bookkeeping never counts as the buyer's time.
      callWindow = { startMs: callStartMs, endMs: this.deps.clock() }
      lastCall = { status: res.status, thrown: false }
      await this.breakerOutcome(breaker, res.status >= 500 ? 'error' : 'success', partner.slug)
      const decline = partner.response_classification?.rejection_signals ?? []
      const verdict = evaluateSaleOutcome(partner.accept_signals, decline as unknown as Signal[], res.status, res.json, res.isHtml, true)
      const record = recordFrom(partner, res, c.payoutCents)
      lastAnswer = { record, response_class: responseClassOf(verdict.outcome, partner.duplicate_signals, res.json) }
      return { outcome: verdict.outcome, record }
    }

    /** The winner's own facts on a sale (#1416); a decline names the buyer and its class but has no landing page or route. */
    const saleOf = (accepted: boolean, record: SaleOutcomeRecord | null, response_class: ResponseClass | null): BuyerSelectSale => ({
      skipped: false,
      accepted,
      buyer_reference: record?.buyer_reference ?? null,
      result_code: record?.result_code ?? null,
      partner_slug: partner.slug,
      partner_name: partner.name,
      click_url: accepted ? partner.click_url : null,
      routing_code: accepted ? partner.external_routing_code : null,
      response_class,
    })

    const mirror = async (entry: LedgerEntry) => {
      const row = await buildBuyerSaleRow(entry, {
        partner_id: partner.id,
        organization_id: this.ctx.trigger.org_id,
        workflow_id: this.ctx.trigger.workflow_id,
        trace_id: this.ctx.trigger.trace_id,
        debt: c.debtCents / 100,
        multiplier: c.multiplier,
        live_percent_in_force: this.out.live_percent_in_force,
        caps_in_force: limits,
      })
      // Bounded (#1849), by what is left of a budget when the node is under one.
      // A copy that runs out of time may still land, so nothing undoes it.
      const allowedMs = Math.min(BUYER_SALE_MIRROR_DEADLINE_MS, Math.max(1, this.remaining()))
      try {
        await withDeadline(this.deps.mirror(row, entry, partner.id), allowedMs, 'buyer_sales copy', this.deps.timers)
      } catch (err) {
        const mirrorOutcome = err instanceof DeadlineError ? 'outcome_unknown' : 'not_mirrored'
        // Only a copy given its whole allowance says the database is not
        // answering; one cut short by the node's own spent budget says nothing
        // about it, and must not send the rest of the lead to its copies.
        if (mirrorOutcome === 'outcome_unknown' && allowedMs >= BUYER_SALE_MIRROR_DEADLINE_MS) this.deps.writeUnanswered('buyer_sales copy')
        this.deps.log({ event: 'buyer_select_mirror_failed', step_namespace: this.node.namespace, partner_id: partner.id, mirror_outcome: mirrorOutcome, error_message: messageOf(err) })
        throw err
      }
    }

    // In decide_only the WHOLE attempt shares the node's budget (#1491): every object call is
    // bounded by what is left of it, read at the call, and the attempt stops between steps
    // once it is spent. In live the steps BEFORE the buyer call share the pre-call budget the
    // same way (#1508); once the call has started, every object call keeps the client's own
    // deadline, because commit and mark sold record an answer the buyer already gave.
    // Cleanup after a budget has ended (releasing a reservation that may have landed, freeing the
    // claim) keeps the standard deadline in both modes: bounded by a spent budget it would be a
    // 1 ms attempt, and the ledger would hold a reservation nobody settles (#1512).
    const budget: ClientOptions = {
      deadlineMs: (op) => (op === LEDGER_RELEASE_OP || op === SALE_FREE_OP || this.buyerCallStarted ? OBJECT_CALL_DEADLINE_MS : Math.max(1, this.remaining())),
      timers: this.deps.timers,
    }
    let result: AttemptResult
    try {
      result = await runBuyerSaleAttempt(
        { partner_id: partner.id, execution_id: executionId, lead_key: leadKey, population, kind, payout_cents: c.payoutCents, limits },
        {
          sale: this.deps.saleClient(key, budget),
          ledger: this.deps.ledgerClient(partner.id, budget),
          callBuyer,
          mirror,
          clock: this.deps.clock,
          sleep: this.deps.sleep,
          buyerTimeoutMs: live ? BUYER_CALL_TIMEOUT_MS : Math.max(1, this.remaining()),
          waitIntervalMs: live ? CLAIM_WAIT_INTERVAL_MS : 50,
          budgetLeftMs: live ? undefined : () => this.remaining(),
          preCallBudgetLeftMs: live ? () => this.remaining() : undefined,
          background: live ? undefined : this.deps.background,
          onClaimEvent: this.claims.observe,
          onStep: (s) => { landed[s] = this.deps.clock() },
        }
      )
    } catch (err) {
      // The orchestrator enumerates every answer; a throw here is a defect in a dependency, not a buyer outcome.
      result = { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) }
    }

    if (breaker && probeClaimed && !buyerCalled) await breaker.releaseProbe().catch(() => undefined)

    const completedAt = new Date(this.deps.clock())
    const status = lastCall === null ? null : (lastCall as { status: number | null }).status
    const timing = this.timeAttempt(c, startedAt, completedAt, callWindow, landed, result.result === 'sold' ? 'accepted' : result.reason)

    if (result.result === 'sold') {
      // An accepted sale is Success whichever answer produced it, a replayed earlier sale included.
      this.out.sale = saleOf(true, result.outcome, 'Success')
      this.out.mirrored = result.mirrored
      this.out.replay = result.replay
      this.consider(c, live ? 'sold' : 'rehearsed', undefined, result.replay ? 'replay of an earlier sale' : undefined)
      this.attempts.push(this.row(c, kind, startedAt, completedAt, timing, 'completed', { outcome: 'accepted', replay: result.replay, mirrored: result.mirrored, http_status: status, result_code: result.outcome.result_code }, null, null))
      if (live && buyerCalled) this.logBid(c, startedAt, completedAt, status, 'accept', null)
      return { kind: 'sold', result: this.done(live ? 'sold' : 'deferred', live ? 'sold' : 'decide_only') }
    }

    const { reason, detail } = result
    switch (reason) {
      case 'declined_by_buyer':
      case 'buyer_error': {
        // The declining buyer, its code and its class travel on the sale so the reject
        // patch can record them (#1471, #1416); a buyer that was never reached has none.
        const answer = lastAnswer as { record: SaleOutcomeRecord; response_class: ResponseClass | null } | null
        this.out.sale = saleOf(false, answer?.record ?? null, answer?.response_class ?? null)
        this.consider(c, reason, reason, detail)
        this.attempts.push(this.row(c, kind, startedAt, completedAt, timing, 'completed', { outcome: reason, detail, http_status: status }, null, null))
        if (live && buyerCalled) this.logBid(c, startedAt, completedAt, status, 'decline', detail ?? reason)
        return { kind: 'next', reason, detail }
      }
      case 'outcome_unknown': {
        // The buyer may have taken the lead: the reservation and the claim are held, and the cascade stops.
        this.out.sale = saleOf(false, null, null)
        this.consider(c, 'outcome_unknown', 'outcome_unknown', detail)
        const failing = lastCall === null || (lastCall as { thrown: boolean }).thrown || status === null || status >= 500
        this.attempts.push(this.row(c, kind, startedAt, completedAt, timing, failing ? 'failed' : 'completed', { outcome: 'outcome_unknown', detail, http_status: status, held: true }, failing ? detail ?? 'outcome_unknown' : null, failing ? 'transient' : null))
        if (live && buyerCalled) this.logBid(c, startedAt, completedAt, status, 'transient', detail ?? 'outcome_unknown')
        if (failing) return { kind: 'stop', result: this.refuse('outcome_unknown', detail ?? 'the buyer answer could not be classified', 'transient') }
        return { kind: 'stop', result: this.done(live ? 'no_sale' : 'deferred', 'outcome_unknown', detail) }
      }
      case 'sale_in_flight':
      case 'already_sold': {
        this.consider(c, 'skipped', reason, detail)
        return { kind: 'stop', result: this.done(live ? 'no_sale' : 'deferred', reason, detail) }
      }
      case 'rehearsal_deadline': {
        // The rehearsal budget ran out inside this buyer's attempt; the attempt let go of what it held.
        this.consider(c, 'not_reached', reason, detail)
        this.attempts.push(this.row(c, kind, startedAt, completedAt, timing, 'completed', { outcome: 'not_reached', detail }, null, null))
        return { kind: 'stop', result: this.done('deferred', reason, detail) }
      }
      case 'object_deadline': {
        // An object did not answer before the buyer was called, or the live pre-call budget ran out
        // (#1508): the attempt released and freed what it held, the buyer was never contacted, and the
        // cascade stops because the time is gone for every buyer after this one too.
        this.consider(c, 'skipped', reason, detail)
        this.attempts.push(this.row(c, kind, startedAt, completedAt, timing, 'completed', { outcome: 'skipped', detail }, null, null))
        return { kind: 'stop', result: this.done(live ? 'no_sale' : 'deferred', reason, detail) }
      }
      default: {
        // A cap, cap_check_error, or anything else the ledger said: this buyer was never contacted.
        this.consider(c, 'skipped', reason, detail)
        return { kind: 'next', reason, detail }
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private consider(c: Candidate, outcome: ConsideredOutcome, reason?: BuyerSelectReason, detail?: string): void {
    const entry: ConsideredBuyer = { partner: c.buyer.partner.slug, priority: c.buyer.profile.priority, payout_cents: c.payoutCents, outcome }
    if (reason) entry.reason = reason
    if (detail) entry.detail = detail
    this.out.considered.push(entry)
  }

  /**
   * Splits a live attempt at its buyer call, adds the call to the output's total and logs the
   * split (#1804). Null when no request left, which includes decide_only and a config error.
   */
  private timeAttempt(c: Candidate, startedAt: Date, completedAt: Date, callWindow: { startMs: number; endMs: number } | null, landed: Partial<Record<AttemptStep, number>>, outcome: string): AttemptTiming | null {
    if (callWindow === null) return null
    const timing: AttemptTiming = {
      before_call_ms: callWindow.startMs - startedAt.getTime(),
      call_ms: callWindow.endMs - callWindow.startMs,
      after_call_ms: completedAt.getTime() - callWindow.endMs,
    }
    const between = (field: keyof AttemptTiming, from: number | undefined, to: number | undefined) => {
      if (from !== undefined && to !== undefined) timing[field] = to - from
    }
    between('claim_ms', startedAt.getTime(), landed.claimed)
    between('reserve_ms', landed.claimed, landed.reserved)
    // The breaker records the answer inside the call wrapper, after the call window closes.
    between('breaker_ms', callWindow.endMs, landed.buyer_called)
    between('commit_ms', landed.buyer_called, landed.committed)
    between('mark_sold_ms', landed.committed, landed.marked_sold)
    between('release_ms', landed.buyer_called, landed.released)
    // Only the copy runs after a sale is marked or a decline released, so a failed copy runs to the attempt's end.
    between('mirror_ms', landed.marked_sold ?? landed.released, landed.mirrored ?? completedAt.getTime())
    this.out.buyer_call_ms = (this.out.buyer_call_ms ?? 0) + timing.call_ms
    this.deps.log({ event: 'buyer_select_attempt_timing', step_namespace: this.node.namespace, partner_slug: c.buyer.partner.slug, outcome, ...timing })
    return timing
  }

  private row(c: Candidate, kind: LedgerKind, startedAt: Date, completedAt: Date, timing: AttemptTiming | null, status: 'completed' | 'failed', output: Record<string, unknown>, error: string | null, errorType: 'transient' | 'permanent' | null): BuyerAttemptRow {
    return {
      partner_slug: c.buyer.partner.slug,
      namespace: `${this.node.namespace}.${c.buyer.partner.slug}`,
      status,
      // Never the payload: it carries the lead's identity (L222).
      input: { partner_slug: c.buyer.partner.slug, kind, lead_key: this.leadKey, payout_cents: c.payoutCents, priority: c.buyer.profile.priority },
      output: { ...output, partner_slug: c.buyer.partner.slug, payout_cents: c.payoutCents, kind, ...(timing ? { timing } : {}) },
      error,
      error_type: errorType,
      started_at: startedAt,
      completed_at: completedAt,
    }
  }

  private logBid(c: Candidate, startedAt: Date, completedAt: Date, status: number | null, classification: 'accept' | 'decline' | 'transient', declineReason: string | null): void {
    this.deps.logBid({
      partner_slug: c.buyer.partner.slug,
      attempted_at_utc: startedAt,
      responded_at_utc: completedAt,
      http_status: status,
      bid_cents: null,
      classification,
      decline_reason: declineReason,
    })
  }

  private async breakerOutcome(breaker: BreakerApi | null, outcome: 'success' | 'error', slug: string): Promise<void> {
    if (!breaker) return
    try {
      if (outcome === 'success') await breaker.recordSuccess()
      else await breaker.recordError()
    } catch (err) {
      this.deps.log({ event: 'circuit_breaker_record_failed', step_namespace: this.node.namespace, partner_id: slug, error_message: messageOf(err) })
    }
  }

  private resolveMaybe(template: string | undefined): { ok: boolean; value: unknown } {
    if (template === undefined || template === null || template === '') return { ok: true, value: undefined }
    try {
      return { ok: true, value: resolveValue(template, this.ctx) }
    } catch {
      return { ok: false, value: undefined }
    }
  }

  private resolveString(template: string | undefined): string | null {
    const r = this.resolveMaybe(template)
    if (!r.ok || r.value === undefined || r.value === null) return null
    const s = typeof r.value === 'string' ? r.value : typeof r.value === 'number' ? String(r.value) : ''
    return s.trim() === '' ? null : s
  }

  /** The budget the node is currently under, or null: decide_only for its whole run, live until the buyer call starts (#1508). */
  private budgetMs(): number | null {
    if (this.modeEffective === 'decide_only') return BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS
    if (this.modeEffective === 'live' && !this.buyerCallStarted) return BUYER_SELECT_LIVE_PRE_CALL_BUDGET_MS
    return null
  }

  /** What an object call may be given now: what is left of the budget when under one, never more than the standard deadline. */
  private remaining(): number {
    const budget = this.budgetMs()
    if (budget === null) return OBJECT_CALL_DEADLINE_MS
    return Math.min(OBJECT_CALL_DEADLINE_MS, budget - (this.deps.clock() - this.startedAt))
  }

  private pastDeadline(): boolean {
    return this.budgetMs() !== null && this.remaining() <= 0
  }

  private deadlineReason(): BuyerSelectReason {
    return this.modeEffective === 'live' ? 'object_deadline' : 'rehearsal_deadline'
  }

  /** The budget ran out between steps: a rehearsal hands the lead to the workflow, a live node sells nothing. */
  private budgetEnded(detail: string): BuyerSelectResult {
    return this.modeEffective === 'live'
      ? this.done('no_sale', 'object_deadline', detail)
      : this.done('deferred', 'rehearsal_deadline', detail)
  }

  /** Every await on the path is bounded (L110); under a budget by what is left of it. */
  private bounded<T>(promise: Promise<T>, operation: string): Promise<T> {
    return withDeadline(promise, Math.max(1, this.remaining()), operation, this.deps.timers)
  }
}

/**
 * The debt as a figure to RECORD, in whole dollars: the evaluator's positive
 * amount, plus zero, because a lead with no debt is a real answer for the
 * sighting (it is exactly the lead that must not be bid on) even though the
 * evaluator refuses to price it. Anything else is null.
 */
function recordedAmount(v: unknown): number | null {
  const positive = parsePositiveAmount(v)
  if (positive !== null) return Math.round(positive)
  if (v === 0 || (typeof v === 'string' && /^\s*\$?0+(\.0+)?\s*$/.test(v))) return 0
  return null
}

interface Candidate {
  buyer: LoadedBuyer
  partnerId: string
  priority: number
  payoutCents: number
  debtCents: number
  multiplier: number
}

function profileCaps(profile: LoadedBuyer['profile']): CapLimits {
  return {
    hourly_lead_cap: profile.hourlyLeadCap,
    daily_lead_cap: profile.dailyLeadCap,
    hourly_spend_cap_cents: profile.hourlySpendCapCents,
    daily_spend_cap_cents: profile.dailySpendCapCents,
  }
}

/**
 * The buyer's reference and result code, read from the paths the partner's
 * extra_extraction names (`buyer_reference`, `result_code`). Without a
 * result_code path, the value of the first accept rule's field that matched
 * stands in, because that is the field the accept decision was made on.
 */
function recordFrom(partner: LoadedBuyer['partner'], res: PartnerCallResult, payoutCents: number): SaleOutcomeRecord {
  const extraction = partner.extra_extraction ?? {}
  const pathOf = (key: string): string | null => {
    const spec = extraction[key]
    if (typeof spec === 'string') return spec
    if (spec && typeof spec === 'object' && typeof (spec as { path?: unknown }).path === 'string') return (spec as { path: string }).path
    return null
  }
  const asText = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null)
  const refPath = pathOf('buyer_reference')
  const codePath = pathOf('result_code')
  let result_code = codePath ? asText(getBodyField(res.json, codePath)) : null
  if (result_code === null && !codePath) {
    const matched = partner.accept_signals.find((sig) => sig.field && (sig.in !== undefined || sig.equals !== undefined) && matchSignal(sig, res.json))
    if (matched) result_code = asText(getBodyField(res.json, matched.field))
  }
  return {
    buyer_reference: refPath ? asText(getBodyField(res.json, refPath)) : null,
    result_code,
    http_status: res.status,
    payout_cents: payoutCents,
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'non Error thrown'
}

function summarise(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object'
  const text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : typeof value
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}
