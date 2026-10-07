/**
 * Partner Bid node — PRD Section 5.3
 *
 * Execution flow:
 *   1. Load partner config from Supabase (by partner_id in node config)
 *   2. Circuit breaker check → skip if open
 *   3. Daily cap check → skip if exceeded
 *   4. Dedup endpoint check → skip if duplicate
 *   5. Resolve bid via resolveBid() — formula / api / matrix per partner config
 *   6. Classify response → accepted / rejected / error
 *   7. Report outcome back to circuit breaker
 *   8. Return bid result
 *
 * Output shape:
 *   { partner, bid, accepted, skipped, skip_reason?, raw_response?, status?, cap_count? }
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput } from '../../types'
import type { ErrorType } from '../../types'
import type { Env } from '../../index'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'
import { readSlackConnectionForLead, sendCircuitAlert, type SlackConnection } from '../../lib/slack'
import { resolveSlackForBlockAlert } from '../../lib/partner-block-alert'
import { readLastGoodSlackConnections } from '../../lib/volume-cliff'
import { secretKeys } from '../../lib/secret-crypto'
import { withDeadline, type Timers } from '@bidspoke/buyer-profile'
import { parseJson } from '../../lib/json'
import { formatErr } from '../../lib/format-error'
import { isNotFoundError } from '../../lib/api-error'
import type { CapCheckResult } from '../../durable-objects/daily-cap'
import { dailyCapObjectName } from '../../lib/daily-cap-name'
import { log } from '../../lib/logger'
import { dropPartnerLastGoodIfPresent, readPartnerLastGood, rememberPartnerLastGood } from '../../lib/partner-last-good'
import { classifyHttpErrorWithBody, shouldSuppressAlert } from '../error-classifier'
import { noteBlockSighting, sightingFromResponse } from '../block-sightings'
import type { ResponseClassificationConfig, AlertConfig } from '../error-classifier'
import type { BidResolverType, BidMode, BidComparisonSource, ExtraExtractionConfig } from '../bid-resolver'
import { resolveBid, effectiveResolverType } from '../bid-resolver'
import { linkAbort } from '../retry'
import { PartnerApiError } from '../partner-bid-error'
import { makeBidLogger } from '../bid-logger'
import { runRealityOf, shadowOf } from '../run-reality'
import { leadRead } from '../../lib/lead-read-budget'

// Re-exports — keep external imports stable.
export { PartnerApiError } from '../partner-bid-error'
export { evaluateFormula } from '../bid-resolver'

// ── Types ─────────────────────────────────────────────────────────────────────

interface PartnerBidConfig {
  partner_id: string
}

interface PartnerConfig {
  id: string
  slug: string
  api_endpoint: string | null
  cf_secret_key: string | null
  daily_cap: number | null
  min_bid: number | null
  bid_formula: string | null
  bid_resolver_type: BidResolverType | null
  bid_resolver_config: Record<string, unknown> | null
  outbound_field_mapping: Record<string, unknown> | null
  bid_mode: BidMode | null
  bid_comparison_source: BidComparisonSource | null
  extra_extraction: ExtraExtractionConfig | null
  dedup_endpoint: string | null
  response_classification: ResponseClassificationConfig | null
  alert_config: AlertConfig | null
  circuit_error_threshold: number
  circuit_window_seconds: number
  circuit_cooldown_seconds: number
  circuit_enabled: boolean
  is_active: boolean
  /**
   * The latency gate's window for this partner (#1849), read with the rest of the
   * row so the gate shares this read and its last-good copy. Absent only on a copy
   * written before it was selected.
   */
  confirmation_window_ms?: number | null
  updated_at?: string | null
}

type SkipReason = 'partner_inactive' | 'circuit_open' | 'cap_exceeded' | 'cap_check_error' | 'duplicate' | 'bid_below_min' | 'rejected' | 'shadow'

export interface PartnerBidOutput {
  partner: string         // slug
  bid: number | null
  accepted: boolean
  skipped: boolean
  skip_reason?: SkipReason
  raw_response?: unknown
  /** HTTP status from the partner API. Null/absent for non-API resolvers (formula/matrix).
   *  Renamed from http_status 2026-06-11 — step outputs persisted before then
   *  carry the old key (readers fall back until those rows age out). */
  status?: number | null
  /** Response headers from the partner API (sensitive headers stripped). */
  response_headers?: Record<string, string> | null
  /** Set on synthesized rows for failed/timed-out attempts so the UI can show
   *  "Errored" with a message. Real executePartnerBidNode outputs never set
   *  these — errors there bubble up as thrown PartnerApiError. */
  error?: string
  error_type?: 'transient' | 'permanent' | null
  cap_count?: number      // today's cap count after this request
  resolver_type?: BidResolverType | null
  /**
   * Partner-specific values extracted from the API response (clickUrl, leadId,
   * classifier outputs). Configured via partner_configs.extra_extraction.
   */
  extra?: Record<string, unknown>
  /**
   * Populated when bid_resolver_type='matrix'. Lets the execution detail page
   * answer "why didn't this lead get a bid from this partner?" without re-running
   * the lookup.
   */
  matrix?: {
    config_id: string
    matched_row_id: string | null
    last_synced_at: string | null
    is_sell_off?: boolean
    reason?: string
  } | null
  /** Why an API resolver returned a null bid despite a 2xx response — set when
   *  no bid field could be read (shape drift / missing bid_path), so "no bid"
   *  isn't confused with a genuine decline. */
  bid_reason?: string
}

// ── Main ──────────────────────────────────────────────────────────────────────

const PARTNER_SELECT =
  'id, slug, api_endpoint, cf_secret_key, daily_cap, min_bid, bid_formula, ' +
  'bid_resolver_type, bid_resolver_config, outbound_field_mapping, ' +
  'bid_mode, bid_comparison_source, extra_extraction, ' +
  'dedup_endpoint, response_classification, alert_config, ' +
  'circuit_error_threshold, circuit_window_seconds, circuit_cooldown_seconds, ' +
  'circuit_enabled, is_active, confirmation_window_ms, updated_at'

// ── Last-good partner config (#1296, #1846) ───────────────────────────────────
//
// The copy, its key, its write rate and how a partner route retires it live in
// lib/partner-last-good.ts, which every route writing partner_configs shares.

// Record a circuit-breaker outcome with a bounded retry so a transient
// Durable Object blip (network hiccup, brief overload) doesn't silently drop
// the count. A dropped record-error is the dangerous case: the failure never
// reaches the sliding-error window, so the breaker can fail to OPEN on a real
// outage and we keep hammering a down partner. On final failure we log a
// structured event so the under-count is visible instead of silent (#129).
//
// The caller decides whether to await: record-error (and other terminal-path
// records) are awaited so the count durably lands; the success record on the
// live winning-bid path is fired without awaiting so a healthy bid never waits.
export async function recordBreakerOutcome<T>(
  ctx: ExecutionContext,
  slug: string,
  kind: 'success' | 'error',
  call: () => Promise<T>,
): Promise<T | undefined> {
  const MAX_ATTEMPTS = 3
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await call()
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        log({
          event: 'circuit_breaker_record_failed',
          trace_id: ctx.trigger.trace_id,
          workflow_id: ctx.trigger.workflow_id,
          partner_id: slug,
          kind,
          error_message: formatErr(err),
        })
        return undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt))
    }
  }
  return undefined
}

/**
 * Fire a Slack page when a partner's circuit breaker just tripped open (audit
 * finding 1.2). `recordError` returns `tripped: true` both on the threshold breach
 * (closed -> open) and on a failed half-open probe re-opening, so this surfaces
 * stuck-open breakers too. Best-effort: a failed alert delivery must never break
 * the bid path, and a dropped breaker record (undefined outcome) is not a trip.
 * Uses the org default channel (null override). Returns whether an alert was sent.
 */
export type BreakerRecordResult = Awaited<ReturnType<CircuitBreakerClient['recordError']>>

/**
 * Both flags mean the same thing: this run is not production traffic, so a trip here
 * is not a partner outage worth paging anyone about. They are an options object rather
 * than two positional booleans because two adjacent booleans at a call site are a
 * silent-swap waiting to happen.
 */
export interface CircuitAlertGate {
  /** LOCAL_DEV: set only in .dev.vars, never in production. */
  isLocalDev?: boolean
  /** The run came from the in-app Test Runner. */
  isTest?: boolean
}

/**
 * The longest the lead waits on a circuit breaker page (#1849): the connection
 * lookup (at most LEAD_READ_DEADLINE_MS, then the KV copy) and the Slack post.
 * The page runs on partner_bid's error path while the lead waits, and neither
 * half had a deadline. A page that runs out of time is logged, never thrown.
 */
export const CIRCUIT_ALERT_DEADLINE_MS = 3_000

export interface CircuitAlertDeps {
  /**
   * The last-good copy of the Slack connections (lib/volume-cliff.ts), the page's
   * fallback when the connection row cannot be read. Required, so no caller can
   * page without one by forgetting it (L168).
   */
  lastGoodSlack: () => Promise<Map<string, Pick<SlackConnection, 'bot_token' | 'default_channel'>>>
  /** Tests fire the page deadline by hand. */
  timers?: Timers
}

export async function alertIfTripped(
  supabase: SupabaseClient,
  orgId: string,
  slug: string,
  outcome: BreakerRecordResult | undefined,
  gate: CircuitAlertGate,
  deps: CircuitAlertDeps,
): Promise<boolean> {
  if (!outcome?.tripped) return false
  // LOCAL_DEV (set only in .dev.vars, never in production) means this run is
  // against the real production Supabase/Slack connection from a local
  // `wrangler dev` process — paging the real org's Slack here would be a false
  // alarm from local testing, not a real partner outage.
  if (gate.isLocalDev) return false
  // A Test Runner run against a live partner can genuinely trip the breaker, but it is
  // someone clicking Test Run, not an incident. Every other failure alert (execution
  // failure, duration, dead-letter) already skips test runs; this one did not (#547).
  if (gate.isTest) return false
  // The connection from the database in one bounded read, else from the last-good
  // copy, so a database outage neither holds the lead nor drops the page (#1849).
  const connection = () => resolveSlackForBlockAlert(orgId, () => readSlackConnectionForLead(supabase, orgId), deps.lastGoodSlack)
  await withDeadline(sendCircuitAlert(supabase, orgId, null, { service_name: slug, state: 'opened' }, connection), CIRCUIT_ALERT_DEADLINE_MS, 'circuit breaker page', deps.timers)
    .catch((e: unknown) => console.error(`[partner-bid] circuit breaker page for ${slug} was not sent: ${formatErr(e)}`))
  return true
}

// A bid must clear the partner's floor to count as a real, winnable bid. With an
// explicit min_bid the floor is `bid >= min_bid`; with no min_bid the floor is
// `bid >= 0`, so a $0 bid is accepted by default. A partner that treats $0 as a
// decline opts in by setting a positive min_bid (e.g. 0.01), which rejects $0
// and anything below it. Negative bids are always rejected (#109).
export function meetsBidFloor(bid: number, minBid: number | null | undefined): boolean {
  if (minBid != null) return bid >= minBid
  return bid >= 0
}

export async function executePartnerBidNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase: SupabaseClient,
  signal?: AbortSignal
): Promise<StepExecutionResult> {
  const config = node.config as unknown as PartnerBidConfig

  if (!config.partner_id) {
    throw new Error('Partner Bid node is missing required config: partner_id')
  }

  // 1. Load partner config. A failed READ falls back to the last-good copy
  // (#1296); a row that is genuinely absent does not.
  const loaded = await loadPartnerConfigForLead(supabase, env.WORKFLOW_CACHE, config.partner_id)
  if (!loaded) throw new Error(`Partner config not found: ${config.partner_id}`)
  const p = loaded.partner

  // Built once and merged onto every return/throw path so the Results panel
  // surfaces both the partner config the author set up and the resolved values
  // (lead payload, outbound body) the resolver actually used.
  const baseTemplate = {
    partner_id: config.partner_id,
    partner_slug: p.slug,
    bid_resolver_type: p.bid_resolver_type,
    bid_mode: p.bid_mode,
    api_endpoint: p.api_endpoint,
    bid_formula: p.bid_formula,
    bid_resolver_config: p.bid_resolver_config,
    outbound_field_mapping: p.outbound_field_mapping,
    dedup_endpoint: p.dedup_endpoint,
    daily_cap: p.daily_cap,
    min_bid: p.min_bid,
  }
  const buildInput = (resolved: Record<string, unknown>): ResolvedStepInput => ({
    template: baseTemplate,
    resolved: { partner_slug: p.slug, payload: ctx.trigger.payload, ...resolved },
  })

  // Shadow stand-in (#232): resolve a deterministic bid WITHOUT the outbound
  // submission, cap increment, dedup call, circuit-breaker writes, or bid-attempt
  // write — so downstream Bid Group / bid-evaluation / routing can be rehearsed.
  // Checked before the plain dry-run skip (stand_in also stubs outbound, so outboundStubbed is true for it too).
  if (shadowOf(ctx).standIn) {
    return standInBid(p, ctx, env, supabase, signal, buildInput)
  }

  // Shadow dry-run: skip the partner submission, dedup call, and bid-attempt
  // write. The partner config load above is a harmless DB read, so we still have
  // the slug for a canonical skip.
  if (shadowOf(ctx).outboundStubbed) {
    return { ...skip(p.slug, 'shadow'), resolvedInput: buildInput({ skip_reason: 'shadow' }) }
  }

  const attemptedAt = new Date()
  // The lead_sighting_bids writer, shared with the buyer_select node (#1411).
  // No sighting id means no row; the write is registered on ctx so the sighting
  // finalize can await it before its winner UPDATE (#88).
  const logBid = makeBidLogger(supabase, ctx, p.bid_resolver_type ?? null)

  // 2. Inactive check
  if (!p.is_active) {
    logBid({ partner_slug: p.slug, attempted_at_utc: attemptedAt, skip_reason: 'partner_inactive' })
    return { ...skip(p.slug, 'partner_inactive'), resolvedInput: buildInput({ skip_reason: 'partner_inactive' }) }
  }

  // One breaker client reused across the check, the cap/dedup probe release,
  // and the success/error reports below.
  const cb = p.circuit_enabled ? new CircuitBreakerClient(env, p.slug) : null
  // True only when THIS lead claimed the half-open probe. The cap/dedup skips
  // below use it to release the probe — the partner was never actually called,
  // so it must neither record success nor stay claimed (which would exclude
  // the partner until the lease expires).
  let probeClaimed = false

  // 3. Circuit breaker check
  if (cb) {
    const cbCheck = await cb.check()
    if (!cbCheck.allowed) {
      log({ event: 'circuit_open', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: p.slug })
      logBid({ partner_slug: p.slug, attempted_at_utc: attemptedAt, skip_reason: 'circuit_open' })
      return { ...skip(p.slug, 'circuit_open'), resolvedInput: buildInput({ skip_reason: 'circuit_open' }) }
    }
    probeClaimed = cbCheck.state === 'half_open'
  }

  // 4. Daily cap check
  let capCount: number | undefined
  // Set once a slot is reserved below. Refunds it (decrement) when the lead is
  // NOT a real partner submission — a duplicate or an error/timeout — so the cap
  // counts leads the partner actually evaluated, and retries (which re-run this
  // whole node) don't multiply consumption (#68). Kept for accept / below-min /
  // business rejection (the partner received and responded).
  let refundCap: (() => Promise<void>) | null = null
  if (p.daily_cap !== null) {
    // The Eastern day, through the one derivation the cap count route also uses (#1410).
    const doId = env.DAILY_CAP.idFromName(dailyCapObjectName(p.slug, Date.now()).name)
    const stub = env.DAILY_CAP.get(doId)
    const capRes = await stub.fetch('http://do/check-and-increment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cap: p.daily_cap }),
    })
    if (!capRes.ok) {
      // The cap DO errored. A non-200 with a parseable body would make capResult.allowed
      // undefined and silently bench the partner as 'cap_exceeded' — a real cap hit it
      // never was (#413). Fail safe (skip, so we never over-spend a cap we couldn't read)
      // but with a distinct reason + log so it doesn't masquerade as a normal cap.
      log({ event: 'cap_check_failed', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: p.slug, http_status: capRes.status })
      if (cb && probeClaimed) await cb.releaseProbe().catch(() => {})
      logBid({ partner_slug: p.slug, attempted_at_utc: attemptedAt, skip_reason: 'cap_check_error' })
      return { ...skip(p.slug, 'cap_check_error'), resolvedInput: buildInput({ skip_reason: 'cap_check_error', http_status: capRes.status }) }
    }
    const capResult = await capRes.json<CapCheckResult>()
    capCount = capResult.count
    log({ event: 'cap_check', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: p.slug, allowed: capResult.allowed, count: capCount, cap: p.daily_cap })
    if (!capResult.allowed) {
      // Partner never called — release the half-open probe so the next lead can.
      if (cb && probeClaimed) await cb.releaseProbe().catch(() => {})
      logBid({ partner_slug: p.slug, attempted_at_utc: attemptedAt, skip_reason: 'cap_exceeded' })
      return { ...skip(p.slug, 'cap_exceeded'), resolvedInput: buildInput({ skip_reason: 'cap_exceeded', cap_count: capCount, daily_cap: p.daily_cap }) }
    }
    refundCap = async () => {
      await stub.fetch('http://do/decrement', { method: 'POST' }).catch(() => {})
    }
  }

  // 5. Dedup check
  if (p.dedup_endpoint) {
    const isDuplicate = await checkDedup(p.dedup_endpoint, ctx, p.slug, signal)
    if (isDuplicate) {
      // Partner never called — release the half-open probe + refund the cap slot
      // reserved above (a duplicate is not a real submission, #68).
      if (cb && probeClaimed) await cb.releaseProbe().catch(() => {})
      if (refundCap) await refundCap()
      logBid({ partner_slug: p.slug, attempted_at_utc: attemptedAt, skip_reason: 'duplicate' })
      return { ...skip(p.slug, 'duplicate'), resolvedInput: buildInput({ skip_reason: 'duplicate' }) }
    }
  }

  // 6. Resolve bid via the bid-resolver abstraction
  let bid: number | null = null
  let rawResponse: unknown = null
  let matrixInfo: PartnerBidOutput['matrix'] = null
  let extra: Record<string, unknown> | undefined

  try {
    const result = await resolveBid(p, ctx, env, supabase, signal)
    const respondedAt = new Date()
    matrixInfo = result.matrix ?? null
    extra = result.extra
    const resolverInput = result.resolved_input ?? {}
    if (result.rejected) {
      // A business rejection is a HEALTHY partner response — record success so
      // a half-open breaker closes (no-op when the breaker is already closed).
      // Non-blocking with background retry + visibility on failure (#129).
      if (cb) void recordBreakerOutcome(ctx, p.slug, 'success', () => cb.recordSuccess())
      logBid({
        partner_slug: p.slug,
        attempted_at_utc: attemptedAt,
        responded_at_utc: respondedAt,
        http_status: result.status ?? null,
        classification: 'decline',
        skip_reason: 'rejected',
      })
      return {
        output: {
          partner: p.slug,
          bid: null,
          accepted: false,
          skipped: true,
          skip_reason: 'rejected' as const,
          raw_response: result.raw,
          status: result.status ?? null,
          response_headers: result.response_headers ?? null,
          cap_count: capCount,
          resolver_type: p.bid_resolver_type ?? null,
          ...(extra ? { extra } : {}),
          matrix: matrixInfo,
        },
        resolvedInput: buildInput({ ...resolverInput, skip_reason: 'rejected' }),
      }
    }
    bid = result.bid
    rawResponse = result.raw

    // Live winning-bid path — fire-and-forget so a healthy bid never waits on the
    // breaker write; still retried + logged in the background (#129).
    if (cb) void recordBreakerOutcome(ctx, p.slug, 'success', () => cb.recordSuccess())

    if (bid !== null && !meetsBidFloor(bid, p.min_bid)) {
      logBid({
        partner_slug: p.slug,
        attempted_at_utc: attemptedAt,
        responded_at_utc: respondedAt,
        bid_cents: Math.round(bid * 100),
        http_status: result.status ?? null,
        classification: 'decline',
        skip_reason: 'bid_below_min',
      })
      const output: PartnerBidOutput = {
        partner: p.slug,
        bid: null,
        accepted: false,
        skipped: true,
        skip_reason: 'bid_below_min',
        raw_response: rawResponse,
        status: result.status ?? null,
        response_headers: result.response_headers ?? null,
        cap_count: capCount,
        resolver_type: p.bid_resolver_type ?? null,
        ...(extra ? { extra } : {}),
        matrix: matrixInfo,
      }
      return { output, resolvedInput: buildInput({ ...resolverInput, skip_reason: 'bid_below_min', bid }) }
    }

    logBid({
      partner_slug: p.slug,
      attempted_at_utc: attemptedAt,
      responded_at_utc: respondedAt,
      bid_cents: bid !== null ? Math.round(bid * 100) : null,
      http_status: result.status ?? null,
      classification: bid !== null ? 'accept' : 'no_bid',
    })

    const output: PartnerBidOutput = {
      partner: p.slug,
      bid,
      accepted: bid !== null,
      skipped: false,
      raw_response: rawResponse,
      status: result.status ?? null,
      response_headers: result.response_headers ?? null,
      cap_count: capCount,
      resolver_type: p.bid_resolver_type ?? null,
      ...(extra ? { extra } : {}),
      ...(bid === null && result.bid_reason ? { bid_reason: result.bid_reason } : {}),
      matrix: matrixInfo,
    }
    log({ event: 'partner_bid', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: p.slug, bid, accepted: output.accepted })
    return { output, resolvedInput: buildInput({ ...resolverInput, bid }) }
  } catch (err) {
    const respondedAt = new Date()
    // The call failed (network/timeout/HTTP error), so the partner didn't get a
    // real submission — refund the reserved cap slot. This also stops retries from
    // multiplying consumption: each failed attempt refunds before withRetry
    // re-runs this node and reserves a fresh slot (#68).
    if (refundCap) await refundCap()
    // A fault in OUR configuration (a declared credential that is unset or blank)
    // is not an upstream outage, so it must not count toward the breaker's error
    // threshold. Charging it there opens the breaker after
    // `circuit_error_threshold` leads and turns every later one into a generic
    // 'circuit_open' skip, burying the precise "missing credential" reason #411
    // added. The condition is "we caused it", not "it is permanent": a permanent
    // 4xx from the partner is real upstream signal and still counts (#417).
    const isConfigFault = err instanceof PartnerApiError && err.isConfigError
    // Await the error record so the count durably lands (with retry) — a dropped
    // record-error is the dangerous case: the breaker fails to OPEN on a real
    // outage. This is the terminal error path (the node rethrows below), so the
    // extra round-trip is off the live winning-bid path (#129).
    if (cb && !isConfigFault) {
      const outcome = await recordBreakerOutcome(ctx, p.slug, 'error', () => cb.recordError({
        error_threshold: p.circuit_error_threshold,
        window_seconds: p.circuit_window_seconds,
        cooldown_seconds: p.circuit_cooldown_seconds,
      }))
      // Page ops if this error just tripped the breaker open — otherwise the
      // partner silently drops out of bidding for hours with no signal (1.2).
      const reality = runRealityOf(ctx, env)
      await alertIfTripped(supabase, ctx.trigger.org_id, p.slug, outcome, {
        isLocalDev: reality.localDev,
        isTest: reality.isTest,
      }, {
        lastGoodSlack: () => readLastGoodSlackConnections(env.IDEMPOTENCY, secretKeys(env)),
      })
    }

    // Pull resolver-side input off the thrown error (callBidApi attaches its
    // outbound body before throwing). Then re-wrap and attach to the rethrow
    // so failed partner_bid steps still surface the wire payload.
    const errResolverInput = (err as { resolved_input?: Record<string, unknown> }).resolved_input ?? {}
    const errResolvedInput = buildInput({ ...errResolverInput, threw: true })

    // Determine error classification — check if err already carries it
    let errorType: ErrorType
    let httpStatus: number | null = null
    if (err instanceof PartnerApiError) {
      logBid({
        partner_slug: p.slug,
        attempted_at_utc: attemptedAt,
        responded_at_utc: respondedAt,
        classification: err.errorType ?? 'transient',
      })
      ;(err as PartnerApiError & { resolvedInput?: ResolvedStepInput }).resolvedInput = errResolvedInput
      throw err
    } else if (err instanceof Response) {
      errorType = classifyHttpErrorWithBody(err.status, (err as Response & { bodyText?: string }).bodyText)
      httpStatus = err.status
    } else {
      // callBidApi throws a plain Error with `.status` attached for a non-ok
      // response that has no response_classification override. Classify by that
      // status so a permanent 4xx isn't mislabeled transient (and then retried).
      const status = (err as { status?: number }).status
      if (typeof status === 'number') {
        // classifyHttpErrorWithBody, not classifyHttpError: callBidApi attaches
        // the response text, and an HTML document means the request died at an
        // edge and was never processed, so it is transient at any status (#756).
        // Without this an HTML 400 from any partner was permanent with
        // retries_used=0 and the lead was dropped.
        errorType = classifyHttpErrorWithBody(status, (err as { bodyText?: string }).bodyText)
        httpStatus = status
      } else {
        errorType = 'transient'
      }
    }

    logBid({
      partner_slug: p.slug,
      attempted_at_utc: attemptedAt,
      responded_at_utc: respondedAt,
      http_status: httpStatus,
      classification: errorType ?? 'transient',
    })

    const suppress = shouldSuppressAlert(p.alert_config, errorType)
    const message = formatErr(err)
    const wrapped = new PartnerApiError(message, errorType, suppress) as PartnerApiError & { resolvedInput?: ResolvedStepInput }
    wrapped.resolvedInput = errResolvedInput
    throw wrapped
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function skip(slug: string, reason: SkipReason): StepExecutionResult {
  const output: PartnerBidOutput = {
    partner: slug,
    bid: null,
    accepted: false,
    skipped: true,
    skip_reason: reason,
  }
  return { output }
}

// Shadow stand-in resolution (#232). Produces a deterministic bid for routing
// rehearsal with NO partner submission: formula is pure and matrix is a DB read
// (so resolveBid is safe), while an api partner — whose only bid comes from the
// outbound call we must not make — gets a stand-in from its floor (min_bid, or 0
// when unset), tagged bid_reason='shadow_standin'. Cap/dedup/circuit-breaker and
// bid-attempt writes are all bypassed by returning here.
async function standInBid(
  p: PartnerConfig,
  ctx: ExecutionContext,
  env: Env,
  supabase: SupabaseClient,
  signal: AbortSignal | undefined,
  buildInput: (resolved: Record<string, unknown>) => ResolvedStepInput,
): Promise<StepExecutionResult> {
  // An inactive partner wouldn't bid live, so it shouldn't win a rehearsal either.
  if (!p.is_active) {
    return { ...skip(p.slug, 'partner_inactive'), resolvedInput: buildInput({ skip_reason: 'partner_inactive' }) }
  }

  const type = effectiveResolverType(p)
  let bid: number | null = null
  let matrixInfo: PartnerBidOutput['matrix'] = null
  let resolverInput: Record<string, unknown> = {}

  if (type === 'api') {
    bid = p.min_bid ?? 0
    resolverInput = { shadow_standin: true }
  } else {
    const result = await resolveBid(p, ctx, env, supabase, signal)
    bid = result.bid
    matrixInfo = result.matrix ?? null
    resolverInput = result.resolved_input ?? {}
  }

  const belowFloor = bid !== null && !meetsBidFloor(bid, p.min_bid)
  const accepted = bid !== null && !belowFloor
  const output: PartnerBidOutput = {
    partner: p.slug,
    bid: accepted ? bid : null,
    accepted,
    skipped: !accepted,
    ...(belowFloor
      ? { skip_reason: 'bid_below_min' as const }
      : bid === null
        ? { skip_reason: 'rejected' as const }
        : {}),
    resolver_type: p.bid_resolver_type ?? null,
    matrix: matrixInfo,
    ...(type === 'api' ? { bid_reason: 'shadow_standin' } : {}),
  }
  return { output, resolvedInput: buildInput({ ...resolverInput, shadow: 'stand_in', bid }) }
}

const DEDUP_TIMEOUT_MS = 5000

// Returns true only when the partner's dedup endpoint positively reports a
// duplicate. Any failure (non-2xx, network error, timeout) fails OPEN — returns
// false so the lead still bids — but is now logged: a silently-down dedup
// endpoint would otherwise re-submit every duplicate (potentially double-charged)
// with no signal. (Whether dedup should fail open vs closed is a separate
// product decision — see issue notes — not changed here.)
export async function checkDedup(
  endpoint: string,
  ctx: ExecutionContext,
  slug: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEDUP_TIMEOUT_MS)
  linkAbort(controller, signal)  // also cancel on the step-level timeout (#66)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trace-Id': ctx.trigger.trace_id },
      body: JSON.stringify(ctx.trigger.payload),
      signal: controller.signal,
    })
    if (!res.ok) {
      // The body is read only to recognise a firewall block page (#1265); the fail-open
      // answer below is unchanged and is its own question (#1388).
      const text = await res.text().catch(() => '')
      noteBlockSighting(ctx, sightingFromResponse(endpoint, res.status, text, res.headers, `dedup:${slug}`))
      log({ event: 'dedup_check_failed', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: slug, reason: 'non_2xx', http_status: res.status })
      return false
    }
    const data = await parseJson<Record<string, unknown>>(res)
    return !!(data.duplicate || data.is_duplicate)
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    log({
      event: 'dedup_check_failed',
      trace_id: ctx.trigger.trace_id,
      workflow_id: ctx.trigger.workflow_id,
      partner_id: slug,
      reason: aborted ? 'timeout' : 'error',
      error_message: formatErr(err),
    })
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The partner config read for a bid. On a lead's client it is bounded and never
 * retried, so a database outage reaches the last-good copy at once (#1844).
 */
export function readPartnerConfig(supabase: SupabaseClient, partnerId: string) {
  return leadRead(supabase, supabase.from('partner_configs').select(PARTNER_SELECT).eq('id', partnerId).single(), 'partner config')
}

/**
 * A partner's config for a lead, the one way the nodes that read partner_configs
 * on a lead's path get it (partner_bid, and the latency gate's threshold since
 * #1849): the bounded read, the last-good copy rewritten when due, and the copy
 * served only when the read FAILS. Null when the partner is genuinely gone (its
 * copy removed too, #1846). Throws, naming the failed read, when there is no
 * copy to serve, and StoredCopyRefusedError, logged, for a copy past the
 * maximum age (#1847).
 */
export async function loadPartnerConfigForLead(supabase: SupabaseClient, kv: KVNamespace | undefined, partnerId: string): Promise<{ partner: PartnerConfig; fromCopy: boolean } | null> {
  const { data, error } = await readPartnerConfig(supabase, partnerId)
  if (!error && data) {
    const partner = data as unknown as PartnerConfig
    await rememberPartnerLastGood(kv, partner, Date.now())
    return { partner, fromCopy: false }
  }
  if (!error || isNotFoundError(error)) {
    // The row is genuinely gone: a copy a racing lead wrote after the delete
    // route retired it must not outlive the partner (#1846).
    await dropPartnerLastGoodIfPresent(kv, partnerId)
    return null
  }
  const stale = await readPartnerLastGood<PartnerConfig>(kv, partnerId, error.message, Date.now())
  // A failed read with nothing to serve is not a missing partner (L11): null
  // is kept for a row that is genuinely gone.
  if (!stale) throw new Error(`partner config ${partnerId} could not be read (${error.message}), and there is no stored copy to use`)
  console.error(`[partner-bid] partner_configs read failed; using last-good copy for ${partnerId}: ${formatErr(error)}`)
  return { partner: stale, fromCopy: true }
}
