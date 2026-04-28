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
 *   { partner, bid, accepted, skipped, skip_reason?, raw_response?, cap_count? }
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { ErrorType } from '../../types'
import type { Env } from '../../index'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'
import type { CapCheckResult } from '../../durable-objects/daily-cap'
import { log } from '../../lib/logger'
import { classifyHttpError, shouldSuppressAlert } from '../error-classifier'
import type { ResponseClassificationConfig, AlertConfig } from '../error-classifier'
import type { BidResolverType } from '../bid-resolver'
import { resolveBid } from '../bid-resolver'
import { PartnerApiError } from '../partner-bid-error'

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
  dedup_endpoint: string | null
  response_classification: ResponseClassificationConfig | null
  alert_config: AlertConfig | null
  circuit_error_threshold: number
  circuit_window_seconds: number
  circuit_cooldown_seconds: number
  circuit_enabled: boolean
  is_active: boolean
}

type SkipReason = 'partner_inactive' | 'circuit_open' | 'cap_exceeded' | 'duplicate' | 'bid_below_min' | 'rejected'

export interface PartnerBidOutput {
  partner: string         // slug
  bid: number | null
  accepted: boolean
  skipped: boolean
  skip_reason?: SkipReason
  raw_response?: unknown
  cap_count?: number      // today's cap count after this request
}

// ── Main ──────────────────────────────────────────────────────────────────────

const PARTNER_SELECT =
  'id, slug, api_endpoint, cf_secret_key, daily_cap, min_bid, bid_formula, ' +
  'bid_resolver_type, bid_resolver_config, outbound_field_mapping, ' +
  'dedup_endpoint, response_classification, alert_config, ' +
  'circuit_error_threshold, circuit_window_seconds, circuit_cooldown_seconds, ' +
  'circuit_enabled, is_active'

export async function executePartnerBidNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase: SupabaseClient
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

  // 2. Inactive check
  if (!p.is_active) {
    return skip(p.slug, 'partner_inactive')
  }

  // 3. Circuit breaker check
  if (p.circuit_enabled) {
    const cb = new CircuitBreakerClient(env, p.slug)
    const cbCheck = await cb.check()
    if (!cbCheck.allowed) {
      log({ event: 'circuit_open', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: p.slug })
      return skip(p.slug, 'circuit_open')
    }
  }

  // 4. Daily cap check
  let capCount: number | undefined
  if (p.daily_cap !== null) {
    const today = new Date().toISOString().slice(0, 10)
    const doId = env.DAILY_CAP.idFromName(`cap-${p.slug}-${today}`)
    const stub = env.DAILY_CAP.get(doId)
    const capRes = await stub.fetch('http://do/check-and-increment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cap: p.daily_cap }),
    })
    const capResult = await capRes.json<CapCheckResult>()
    capCount = capResult.count
    log({ event: 'cap_check', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: p.slug, allowed: capResult.allowed, count: capCount, cap: p.daily_cap })
    if (!capResult.allowed) {
      return skip(p.slug, 'cap_exceeded')
    }
  }

  // 5. Dedup check
  if (p.dedup_endpoint) {
    const isDuplicate = await checkDedup(p.dedup_endpoint, ctx)
    if (isDuplicate) {
      return skip(p.slug, 'duplicate')
    }
  }

  // 6. Resolve bid via the bid-resolver abstraction
  let bid: number | null = null
  let rawResponse: unknown = null
  const cb = p.circuit_enabled ? new CircuitBreakerClient(env, p.slug) : null

  try {
    const result = await resolveBid(p, ctx, env, supabase)
    if (result.rejected) {
      return {
        output: {
          partner: p.slug,
          bid: null,
          accepted: false,
          skipped: true,
          skip_reason: 'rejected' as const,
          raw_response: result.raw,
          cap_count: capCount,
        },
      }
    }
    bid = result.bid
    rawResponse = result.raw

    if (cb) cb.recordSuccess().catch(() => {})
  } catch (err) {
    if (cb) cb.recordError({
      error_threshold: p.circuit_error_threshold,
      window_seconds: p.circuit_window_seconds,
      cooldown_seconds: p.circuit_cooldown_seconds,
    }).catch(() => {})

    // Determine error classification — check if err already carries it
    let errorType: ErrorType
    if (err instanceof PartnerApiError) {
      throw err  // already classified + alert decision made
    } else if (err instanceof Response) {
      errorType = classifyHttpError(err.status)
    } else {
      errorType = 'transient'
    }

    const suppress = shouldSuppressAlert(p.alert_config, errorType)
    const message = err instanceof Error ? err.message : String(err)
    throw new PartnerApiError(message, errorType, suppress)
  }

  // 7. Minimum bid filter
  if (bid !== null && p.min_bid !== null && bid < p.min_bid) {
    const output: PartnerBidOutput = {
      partner: p.slug,
      bid: null,
      accepted: false,
      skipped: true,
      skip_reason: 'bid_below_min',
      raw_response: rawResponse,
      cap_count: capCount,
    }
    return { output }
  }

  const output: PartnerBidOutput = {
    partner: p.slug,
    bid,
    accepted: bid !== null,
    skipped: false,
    raw_response: rawResponse,
    cap_count: capCount,
  }
  log({ event: 'partner_bid', trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, partner_id: p.slug, bid, accepted: output.accepted })
  return { output }
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

async function checkDedup(
  endpoint: string,
  ctx: ExecutionContext
): Promise<boolean> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trace-Id': ctx.trigger.trace_id },
      body: JSON.stringify(ctx.trigger.payload),
    })
    if (!res.ok) return false
    const data = await res.json() as Record<string, unknown>
    return !!(data.duplicate || data.is_duplicate)
  } catch {
    return false
  }
}

