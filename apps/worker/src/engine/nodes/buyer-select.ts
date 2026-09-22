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
  canaryBucket,
  canonicalBodySha256,
  evaluateEligibility,
  evaluateSaleOutcome,
  getBodyField,
  matchSignal,
  rankBuyers,
  withDeadline,
  type BuyerSelectMode,
  type ConsideredOutcome,
  type LedgerKind,
  type ModeEffective,
  type NodeReason,
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
import { BuyerLedgerClient, LeadSaleClient, OBJECT_CALL_DEADLINE_MS } from '../../lib/buyer-object-clients'
import { loadBuyerProfiles, type BuyerProfilesSnapshot, type LoadedBuyer } from '../../lib/buyer-profile-loader'
import { runBuyerSaleAttempt, type AttemptResult, type BuyerCall, type LedgerApi, type SaleApi } from '../../lib/buyer-sale-attempt'
import { buildBuyerSaleRow, mirrorBuyerSale, type BuyerSaleRow } from '../../lib/buyer-sale-mirror'
import { postToPartner, type PartnerCallResult, type PartnerCallTarget } from '../../lib/post-to-partner'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'
import { applyOutboundMapping } from '../../lib/field-mapper'
import { log as structuredLog } from '../../lib/logger'
import { PartnerApiError } from '../partner-bid-error'
import { makeBidLogger, type BidLogger } from '../bid-logger'
import { resolveValue } from '../context'
import { isShadowDryRun } from '../shadow'
import { resolveSalePayload } from './buyer-select-payload'

// ── Constants ─────────────────────────────────────────────────────────────────

/** decide_only sits on Engine's response path, so it gives up before it costs a bid. */
export const BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS = 800
/** The whole buyer call, the same budget tripoint_ping's fetch carried. */
export const BUYER_CALL_TIMEOUT_MS = 20_000
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

export interface BuyerSelectOutput {
  _route: BuyerSelectRoute
  reason: BuyerSelectReason
  detail?: string
  mode_effective: ModeEffective
  population: string
  lead_key: string | null
  sale: { skipped: boolean; accepted: boolean; buyer_reference: string | null; result_code: string | null; partner_slug: string | null }
  considered: ConsideredBuyer[]
  live_percent_in_force: number | null
  caps_in_force: Array<{ partner: string } & CapLimits>
  profiles_served_from?: BuyerProfilesSnapshot['served_from']
  would_send_body_sha256?: string
  mirrored?: boolean
  replay?: boolean
  retries_ignored?: number
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
  saleClient: (key: EntryKey) => SaleApi
  ledgerClient: (partnerId: string) => LedgerApi
  callBuyer: (target: PartnerCallTarget, body: unknown, opts: { traceId: string; timeoutMs: number }) => Promise<PartnerCallResult>
  breaker: (slug: string) => BreakerApi
  mirror: (row: BuyerSaleRow, entry: LedgerEntry, partnerId: string) => Promise<void>
  logBid: BidLogger
  clock: () => number
  sleep: (ms: number) => Promise<void>
  timers?: Timers
  log: (fields: { event: string } & Record<string, unknown>) => void
  localDev: boolean
}

export function productionDeps(ctx: ExecutionContext, env: Env, supabase: SupabaseClient): BuyerSelectDeps {
  const orgId = ctx.trigger.org_id
  return {
    loadProfiles: () => loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase),
    saleClient: (key) => new LeadSaleClient(env.LEAD_SALE, key),
    ledgerClient: (partnerId) => new BuyerLedgerClient(env.BUYER_LEDGER, partnerId),
    callBuyer: (target, body, opts) => postToPartner(target, body, env, opts),
    breaker: (slug) => new CircuitBreakerClient(env, slug),
    mirror: async (row, entry, partnerId) => {
      const ledger = new BuyerLedgerClient(env.BUYER_LEDGER, partnerId)
      await mirrorBuyerSale(supabase, row, entry, { markMirrored: (key) => ledger.markMirrored([key]).then(() => undefined) })
    },
    logBid: makeBidLogger(supabase, ctx, 'buyer_select'),
    clock: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (fields) => structuredLog({ ...fields, trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, execution_id: ctx.trigger.execution_id } as Parameters<typeof structuredLog>[0]),
    localDev: Boolean(env.LOCAL_DEV),
  }
}

// ── The executor ──────────────────────────────────────────────────────────────

const SKIPPED_SALE: BuyerSelectOutput['sale'] = { skipped: true, accepted: false, buyer_reference: null, result_code: null, partner_slug: null }

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

  constructor(private readonly node: NodeDefinition, private readonly ctx: ExecutionContext, private readonly deps: BuyerSelectDeps) {
    this.config = node.config as unknown as BuyerSelectConfig
    this.startedAt = deps.clock()
    this.configuredMode = (BUYER_SELECT_MODES as readonly string[]).includes(String(this.config.mode)) ? this.config.mode : null
    const reportOnly = Boolean(ctx.isTest) || isShadowDryRun(ctx) || deps.localDev
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
    if (this.pastDeadline()) return this.done('deferred', 'rehearsal_deadline', `profiles took the whole ${BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS} ms budget`)

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
    }
    const now = this.deps.clock()
    const eligible: Candidate[] = []
    for (const buyer of snapshot.buyers) {
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
        for (const rest of candidates.slice(i)) this.consider(rest, 'not_reached', 'rehearsal_deadline')
        return this.done('deferred', 'rehearsal_deadline', `${i} of ${candidates.length} buyers attempted`)
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
          // An unreadable breaker is not an allow: skip this buyer by name.
          this.consider(c, 'skipped', 'circuit_open', `breaker unreadable: ${messageOf(err)}`)
          lastReason = 'circuit_open'
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

    const callBuyer = async (): Promise<BuyerCall> => {
      if (!live) {
        return { outcome: 'accepted', record: { buyer_reference: null, result_code: REHEARSAL_RESULT_CODE, http_status: null, payout_cents: c.payoutCents } }
      }
      buyerCalled = true
      const target: PartnerCallTarget = { slug: partner.slug, api_endpoint: partner.api_endpoint, cf_secret_key: partner.cf_secret_key }
      let res: PartnerCallResult
      try {
        res = await this.deps.callBuyer(target, body, { traceId: this.ctx.trigger.trace_id, timeoutMs: BUYER_CALL_TIMEOUT_MS })
      } catch (err) {
        if (err instanceof PartnerApiError && err.isConfigError) {
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
      lastCall = { status: res.status, thrown: false }
      await this.breakerOutcome(breaker, res.status >= 500 ? 'error' : 'success', partner.slug)
      const decline = partner.response_classification?.rejection_signals ?? []
      const verdict = evaluateSaleOutcome(partner.accept_signals, decline as unknown as Signal[], res.status, res.json, res.isHtml, true)
      return { outcome: verdict.outcome, record: recordFrom(partner, res, c.payoutCents) }
    }

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
      try {
        await this.deps.mirror(row, entry, partner.id)
      } catch (err) {
        this.deps.log({ event: 'buyer_select_mirror_failed', step_namespace: this.node.namespace, partner_id: partner.id, error_message: messageOf(err) })
        throw err
      }
    }

    let result: AttemptResult
    try {
      result = await runBuyerSaleAttempt(
        { partner_id: partner.id, execution_id: executionId, lead_key: leadKey, population, kind, payout_cents: c.payoutCents, limits },
        {
          sale: this.deps.saleClient(key),
          ledger: this.deps.ledgerClient(partner.id),
          callBuyer,
          mirror,
          clock: this.deps.clock,
          sleep: this.deps.sleep,
          buyerTimeoutMs: live ? BUYER_CALL_TIMEOUT_MS : Math.max(1, this.remaining()),
          waitIntervalMs: live ? CLAIM_WAIT_INTERVAL_MS : 50,
        }
      )
    } catch (err) {
      // The orchestrator enumerates every answer; a throw here is a defect in a dependency, not a buyer outcome.
      result = { result: 'no_sale', reason: 'cap_check_error', detail: messageOf(err) }
    }

    if (breaker && probeClaimed && !buyerCalled) await breaker.releaseProbe().catch(() => undefined)

    const completedAt = new Date(this.deps.clock())
    const status = lastCall === null ? null : (lastCall as { status: number | null }).status

    if (result.result === 'sold') {
      this.out.sale = { skipped: false, accepted: true, buyer_reference: result.outcome.buyer_reference, result_code: result.outcome.result_code, partner_slug: partner.slug }
      this.out.mirrored = result.mirrored
      this.out.replay = result.replay
      this.consider(c, live ? 'sold' : 'rehearsed', undefined, result.replay ? 'replay of an earlier sale' : undefined)
      this.attempts.push(this.row(c, kind, startedAt, completedAt, 'completed', { outcome: 'accepted', replay: result.replay, mirrored: result.mirrored, http_status: status, result_code: result.outcome.result_code }, null, null))
      if (live && buyerCalled) this.logBid(c, startedAt, completedAt, status, 'accept', null)
      return { kind: 'sold', result: this.done(live ? 'sold' : 'deferred', live ? 'sold' : 'decide_only') }
    }

    const { reason, detail } = result
    switch (reason) {
      case 'declined_by_buyer':
      case 'buyer_error': {
        this.out.sale = { ...SKIPPED_SALE, skipped: false }
        this.consider(c, reason, reason, detail)
        this.attempts.push(this.row(c, kind, startedAt, completedAt, 'completed', { outcome: reason, detail, http_status: status }, null, null))
        if (live && buyerCalled) this.logBid(c, startedAt, completedAt, status, 'decline', detail ?? reason)
        return { kind: 'next', reason, detail }
      }
      case 'outcome_unknown': {
        // The buyer may have taken the lead: the reservation and the claim are held, and the cascade stops.
        this.out.sale = { ...SKIPPED_SALE, skipped: false }
        this.consider(c, 'outcome_unknown', 'outcome_unknown', detail)
        const failing = lastCall === null || (lastCall as { thrown: boolean }).thrown || status === null || status >= 500
        this.attempts.push(this.row(c, kind, startedAt, completedAt, failing ? 'failed' : 'completed', { outcome: 'outcome_unknown', detail, http_status: status, held: true }, failing ? detail ?? 'outcome_unknown' : null, failing ? 'transient' : null))
        if (live && buyerCalled) this.logBid(c, startedAt, completedAt, status, 'transient', detail ?? 'outcome_unknown')
        if (failing) return { kind: 'stop', result: this.refuse('outcome_unknown', detail ?? 'the buyer answer could not be classified', 'transient') }
        return { kind: 'stop', result: this.done(live ? 'no_sale' : 'deferred', 'outcome_unknown', detail) }
      }
      case 'sale_in_flight':
      case 'already_sold': {
        this.consider(c, 'skipped', reason, detail)
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

  private row(c: Candidate, kind: LedgerKind, startedAt: Date, completedAt: Date, status: 'completed' | 'failed', output: Record<string, unknown>, error: string | null, errorType: 'transient' | 'permanent' | null): BuyerAttemptRow {
    return {
      partner_slug: c.buyer.partner.slug,
      namespace: `${this.node.namespace}.${c.buyer.partner.slug}`,
      status,
      // Never the payload: it carries the lead's identity (L222).
      input: { partner_slug: c.buyer.partner.slug, kind, lead_key: this.leadKey, payout_cents: c.payoutCents, priority: c.buyer.profile.priority },
      output: { ...output, partner_slug: c.buyer.partner.slug, payout_cents: c.payoutCents, kind },
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

  private remaining(): number {
    if (this.modeEffective !== 'decide_only') return OBJECT_CALL_DEADLINE_MS
    return BUYER_SELECT_DECIDE_ONLY_DEADLINE_MS - (this.deps.clock() - this.startedAt)
  }

  private pastDeadline(): boolean {
    return this.modeEffective === 'decide_only' && this.remaining() <= 0
  }

  /** Every await on the path is bounded (L110); in decide_only by what is left of the budget. */
  private bounded<T>(promise: Promise<T>, operation: string): Promise<T> {
    return withDeadline(promise, Math.max(1, this.remaining()), operation, this.deps.timers)
  }
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
