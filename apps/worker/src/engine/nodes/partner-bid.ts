/**
 * Partner Bid node — PRD Section 5.3
 *
 * Execution flow:
 *   1. Load partner config from Supabase (by partner_id in node config)
 *   2. Circuit breaker check → skip if open
 *   3. Daily cap check → skip if exceeded
 *   4. Dedup endpoint check → skip if duplicate
 *   5. API call (if api_endpoint set) OR formula evaluation
 *   6. Classify response → accepted / rejected / error
 *   7. Report outcome back to circuit breaker
 *   8. Return bid result
 *
 * Output shape:
 *   { partner, bid, accepted, skipped, skip_reason?, raw_response?, cap_count? }
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult } from '../../types'
import type { Env } from '../../index'
import { CircuitBreakerClient } from '../../lib/circuit-breaker-client'
import type { CapCheckResult } from '../../durable-objects/daily-cap'

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
  dedup_endpoint: string | null
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
    .select('id, slug, api_endpoint, cf_secret_key, daily_cap, min_bid, bid_formula, dedup_endpoint, circuit_error_threshold, circuit_window_seconds, circuit_cooldown_seconds, circuit_enabled, is_active')
    .eq('id', config.partner_id)
    .single()

  if (error || !partner) {
    throw new Error(`Partner config not found: ${config.partner_id}`)
  }

  const p = partner as PartnerConfig

  // 2. Inactive check
  if (!p.is_active) {
    return skip(p.slug, 'partner_inactive')
  }

  // 3. Circuit breaker check
  if (p.circuit_enabled) {
    const cb = new CircuitBreakerClient(env, p.slug)
    const cbCheck = await cb.check()
    if (!cbCheck.allowed) {
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

  // 6. Get bid — formula or API call
  let bid: number | null = null
  let rawResponse: unknown = null
  const cb = p.circuit_enabled ? new CircuitBreakerClient(env, p.slug) : null

  try {
    if (p.api_endpoint) {
      const { bid: apiBid, raw } = await callBidApi(p, ctx, env)
      bid = apiBid
      rawResponse = raw
    } else if (p.bid_formula) {
      bid = evaluateFormula(p.bid_formula, ctx)
    }

    if (cb) cb.recordSuccess().catch(() => {})
  } catch (err) {
    if (cb) cb.recordError({
      error_threshold: p.circuit_error_threshold,
      window_seconds: p.circuit_window_seconds,
      cooldown_seconds: p.circuit_cooldown_seconds,
    }).catch(() => {})
    throw err
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

async function callBidApi(
  partner: PartnerConfig,
  ctx: ExecutionContext,
  env: Env
): Promise<{ bid: number | null; raw: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  // Load partner auth secret if configured
  if (partner.cf_secret_key) {
    const secretValue = (env as unknown as Record<string, string | undefined>)[partner.cf_secret_key]
    if (secretValue) {
      headers['Authorization'] = `Bearer ${secretValue}`
    }
  }

  const body = JSON.stringify(ctx.trigger.payload)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  let res: Response
  try {
    res = await fetch(partner.api_endpoint!, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  const raw = await res.json().catch(() => null)

  if (!res.ok) {
    const err = Object.assign(new Error(`Partner API returned ${res.status}`), { status: res.status })
    throw err
  }

  // Extract bid amount — look for common response shapes
  const bid = extractBid(raw)
  return { bid, raw }
}

function extractBid(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  // Common field names for bid amounts
  for (const field of ['bid', 'bid_amount', 'amount', 'price', 'offer']) {
    const val = r[field]
    if (typeof val === 'number') return val
    if (typeof val === 'string') {
      const n = parseFloat(val)
      if (!isNaN(n)) return n
    }
  }
  return null
}

async function checkDedup(
  endpoint: string,
  ctx: ExecutionContext
): Promise<boolean> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ctx.trigger.payload),
    })
    if (!res.ok) return false
    const data = await res.json() as Record<string, unknown>
    // Truthy `duplicate` or `is_duplicate` field = this lead is a dup
    return !!(data.duplicate || data.is_duplicate)
  } catch {
    // Dedup endpoint failure — treat as not duplicate (don't skip bids due to infra issues)
    return false
  }
}

/**
 * Evaluate a bid formula string against the execution context.
 * Only arithmetic and dot-path field references are supported.
 * Formula is user-authored (authenticated user), so Function constructor is safe here.
 *
 * Example: "debt_amount * 0.65" with ctx.trigger.payload.debt_amount = 10000 → 6500
 */
export function evaluateFormula(formula: string, ctx: ExecutionContext): number | null {
  if (!formula.trim()) return null

  // Extract all identifier tokens (potential field references)
  const identifiers = Array.from(
    new Set(formula.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) ?? [])
  ).filter((id) => !/^(Math|floor|ceil|round|min|max|abs|sqrt|pow)$/.test(id))

  // Build variable bindings from trigger.payload
  const vars: Record<string, number> = {}
  const payload = ctx.trigger.payload
  for (const id of identifiers) {
    const val = getPath(payload, id.split('.'))
    if (typeof val === 'number') vars[id] = val
    else if (typeof val === 'string') {
      const n = parseFloat(val)
      if (!isNaN(n)) vars[id] = n
    }
  }

  try {
    // Create a restricted function with only Math and the resolved variables
    const paramNames = ['Math', ...Object.keys(vars)]
    const paramValues = [Math, ...Object.values(vars)]
    // eslint-disable-next-line no-new-func
    const fn = new Function(...paramNames, `return (${formula})`)
    const result = fn(...paramValues)
    if (typeof result !== 'number' || !isFinite(result)) return null
    return result
  } catch {
    return null
  }
}

function getPath(obj: unknown, parts: string[]): unknown {
  let cur = obj
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
