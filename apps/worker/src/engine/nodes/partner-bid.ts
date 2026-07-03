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
import { sendCircuitAlert } from '../../lib/slack'
import { parseJson } from '../../lib/json'
import type { CapCheckResult } from '../../durable-objects/daily-cap'
import { log } from '../../lib/logger'
import { classifyHttpError, shouldSuppressAlert } from '../error-classifier'
import type { ResponseClassificationConfig, AlertConfig } from '../error-classifier'
import type { BidResolverType, BidMode, BidComparisonSource, ExtraExtractionConfig } from '../bid-resolver'
import { resolveBid, effectiveResolverType } from '../bid-resolver'
import { linkAbort } from '../retry'
import { PartnerApiError } from '../partner-bid-error'
import { recordBidAttempt } from '../lead-sightings'
import { isShadowDryRun, isShadowStandIn } from '../shadow'

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
  'circuit_enabled, is_active'

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
          error_message: err instanceof Error ? err.message : String(err),
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

export async function alertIfTripped(
  supabase: SupabaseClient,
  orgId: string,
  slug: string,
  outcome: BreakerRecordResult | undefined,
  isLocalDev?: boolean,
): Promise<boolean> {
  if (!outcome?.tripped) return false
  // LOCAL_DEV (set only in .dev.vars, never in production) means this run is
  // against the real production Supabase/Slack connection from a local
  // `wrangler dev` process — paging the real org's Slack here would be a false
  // alarm from local testing, not a real partner outage.
  if (isLocalDev) return false
  await sendCircuitAlert(supabase, orgId, null, { service_name: slug, state: 'opened' }).catch(() => {})
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

  // 1. Load partner config
  const { data: partner, error } = await supabase
    .from('partner_configs')
    .select(PARTNER_SELECT)
    .eq('id', config.partner_id)
    .single()

  if (error || !partner) {
    throw new Error(`Partner config not found: ${config.partner_id}`)
  }

  const p = partner as unknown as PartnerConfig

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
  // Checked before the plain dry-run skip (stand_in also satisfies isShadowDryRun).
  if (isShadowStandIn(ctx)) {
    return standInBid(p, ctx, env, supabase, signal, buildInput)
  }

  // Shadow dry-run: skip the partner submission, dedup call, and bid-attempt
  // write. The partner config load above is a harmless DB read, so we still have
  // the slug for a canonical skip.
  if (isShadowDryRun(ctx)) {
    return { ...skip(p.slug, 'shadow'), resolvedInput: buildInput({ skip_reason: 'shadow' }) }
  }

  const attemptedAt = new Date()
  const logBid = (input: Partial<Parameters<typeof recordBidAttempt>[1]> & { partner_slug: string; attempted_at_utc: Date }) => {
    if (!ctx.trigger.sighting_id) return
    const write = recordBidAttempt(supabase, {
      sighting_id: ctx.trigger.sighting_id,
      trace_id: ctx.trigger.trace_id,
      execution_id: ctx.trigger.execution_id ?? '',
      partner_slug: input.partner_slug,
      attempted_at_utc: input.attempted_at_utc,
      attempted_at_et: input.attempted_at_et ?? input.attempted_at_utc,
      responded_at_utc: input.responded_at_utc ?? null,
      responded_at_et: input.responded_at_et ?? input.responded_at_utc ?? null,
      http_status: input.http_status ?? null,
      bid_cents: input.bid_cents ?? null,
      classification: input.classification ?? null,
      decline_reason: input.decline_reason ?? null,
      resolver_type: p.bid_resolver_type ?? null,
      skip_reason: input.skip_reason ?? null,
      is_test: false,
    })
    // Track the insert so finalizeSighting can await it before its winner
    // UPDATE. Otherwise the UPDATE (matched on execution_id + partner_slug)
    // races the unawaited insert, matches zero rows, and the winning bid stays
    // is_winner=false permanently (#88). recordBidAttempt never rejects.
    ;(ctx.pendingBidWrites ??= []).push(write)
  }

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
    const today = new Date().toISOString().slice(0, 10)
    const doId = env.DAILY_CAP.idFromName(`cap-${p.slug}-${today}`)
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
    // Await the error record so the count durably lands (with retry) — a dropped
    // record-error is the dangerous case: the breaker fails to OPEN on a real
    // outage. This is the terminal error path (the node rethrows below), so the
    // extra round-trip is off the live winning-bid path (#129).
    if (cb) {
      const outcome = await recordBreakerOutcome(ctx, p.slug, 'error', () => cb.recordError({
        error_threshold: p.circuit_error_threshold,
        window_seconds: p.circuit_window_seconds,
        cooldown_seconds: p.circuit_cooldown_seconds,
      }))
      // Page ops if this error just tripped the breaker open — otherwise the
      // partner silently drops out of bidding for hours with no signal (1.2).
      await alertIfTripped(supabase, ctx.trigger.org_id, p.slug, outcome, !!env.LOCAL_DEV)
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
      errorType = classifyHttpError(err.status)
      httpStatus = err.status
    } else {
      // callBidApi throws a plain Error with `.status` attached for a non-ok
      // response that has no response_classification override. Classify by that
      // status so a permanent 4xx isn't mislabeled transient (and then retried).
      const status = (err as { status?: number }).status
      if (typeof status === 'number') {
        errorType = classifyHttpError(status)
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
    const message = err instanceof Error ? err.message : String(err)
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
async function checkDedup(
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
      error_message: err instanceof Error ? err.message : String(err),
    })
    return false
  } finally {
    clearTimeout(timer)
  }
}

