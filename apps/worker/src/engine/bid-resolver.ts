/**
 * Bid resolver — picks how a Partner Bid node gets a bid for a partner.
 *
 * Three resolver types live on partner_configs.bid_resolver_type:
 *   'formula' — evaluate config.formula against the trigger payload
 *   'matrix'  — look up config.bid_config_id in partner_bid_configs (Slice 2)
 *   'api'     — POST to partner.api_endpoint and read the bid from the response
 *
 * resolveBid() is the only entry point Partner Bid uses. Adding a new resolver type
 * (e.g., 'matrix_bidspoke' if/when the matrix moves out of Salesforce) is one switch
 * case here; nothing in Partner Bid or workflow definitions changes.
 */

import type { ExecutionContext } from '../types'
import type { Env } from '../index'
import type { ResponseClassificationConfig, AlertConfig } from './error-classifier'
import { evaluateResponseClassification, shouldSuppressAlert } from './error-classifier'
import { PartnerApiError } from './partner-bid-error'

export type BidResolverType = 'formula' | 'matrix' | 'api'

export interface PartnerForResolver {
  id: string
  slug: string
  api_endpoint: string | null
  cf_secret_key: string | null
  bid_formula: string | null
  bid_resolver_type: BidResolverType | null
  bid_resolver_config: Record<string, unknown> | null
  response_classification: ResponseClassificationConfig | null
  alert_config: AlertConfig | null
}

export interface BidResolverResult {
  bid: number | null
  raw: unknown
  rejected?: boolean
}

export class BidResolverConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BidResolverConfigError'
  }
}

export async function resolveBid(
  partner: PartnerForResolver,
  ctx: ExecutionContext,
  env: Env
): Promise<BidResolverResult> {
  const type = effectiveResolverType(partner)

  switch (type) {
    case 'formula': {
      const formula = readFormula(partner)
      if (!formula) return { bid: null, raw: null }
      return { bid: evaluateFormula(formula, ctx), raw: null }
    }
    case 'api': {
      if (!partner.api_endpoint) return { bid: null, raw: null }
      return callBidApi(partner, ctx, env)
    }
    case 'matrix': {
      throw new BidResolverConfigError(
        `Partner ${partner.slug} uses matrix resolver but matrix lookup is not yet implemented (Slice 2)`
      )
    }
  }
}

/**
 * Read the resolver type with a legacy fallback.
 * If bid_resolver_type isn't set (pre-migration row) use the same precedence the old
 * code path used: api_endpoint wins over bid_formula.
 */
function effectiveResolverType(partner: PartnerForResolver): BidResolverType {
  if (partner.bid_resolver_type) return partner.bid_resolver_type
  if (partner.api_endpoint) return 'api'
  if (partner.bid_formula) return 'formula'
  return 'api'
}

function readFormula(partner: PartnerForResolver): string | null {
  const cfg = partner.bid_resolver_config
  if (cfg && typeof cfg.formula === 'string' && cfg.formula.trim()) return cfg.formula
  return partner.bid_formula
}

// ── API call ──────────────────────────────────────────────────────────────────

async function callBidApi(
  partner: PartnerForResolver,
  ctx: ExecutionContext,
  env: Env
): Promise<BidResolverResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Trace-Id': ctx.trigger.trace_id,
  }

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

  const resHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => { resHeaders[k] = v })

  if (partner.response_classification) {
    const override = evaluateResponseClassification(
      partner.response_classification,
      res.status,
      raw,
      resHeaders
    )
    if (override === 'rejection') {
      return { bid: null, raw, rejected: true }
    }
    if (override === 'transient' || override === 'permanent') {
      const suppress = shouldSuppressAlert(partner.alert_config, override)
      throw new PartnerApiError(
        `Partner API returned ${res.status} (classified as ${override} by override)`,
        override,
        suppress
      )
    }
  }

  if (!res.ok) {
    throw new Error(`Partner API returned ${res.status}`)
  }

  return { bid: extractBid(raw), raw }
}

function extractBid(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
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

// ── Formula ───────────────────────────────────────────────────────────────────

/**
 * Evaluate a bid formula string against the execution context.
 * Only arithmetic and dot-path field references are supported.
 * Formula is user-authored (authenticated user), so Function constructor is safe here.
 *
 * Example: "debt_amount * 0.65" with ctx.trigger.payload.debt_amount = 10000 -> 6500
 */
export function evaluateFormula(formula: string, ctx: ExecutionContext): number | null {
  if (!formula.trim()) return null

  const identifiers = Array.from(
    new Set(formula.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) ?? [])
  ).filter((id) => !/^(Math|floor|ceil|round|min|max|abs|sqrt|pow)$/.test(id))

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
