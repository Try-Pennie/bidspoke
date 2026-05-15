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

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext } from '../types'
import type { Env } from '../index'
import type { ResponseClassificationConfig, AlertConfig } from './error-classifier'
import { evaluateResponseClassification, shouldSuppressAlert } from './error-classifier'
import { PartnerApiError } from './partner-bid-error'
import { lookupMatrixBid } from '../lib/bid-matrix-lookup'
import { applyOutboundMapping } from '../lib/field-mapper'

export type BidResolverType = 'formula' | 'matrix' | 'api'
export type BidMode = 'commit' | 'ping_only'
export type BidComparisonSource = 'auto' | 'api' | 'formula' | 'matrix'

/**
 * Declarative response-extraction config. Keys become entries in `output.extra`.
 *   string                                  — dot-path into the response body
 *   { path: string }                        — same, but allows extending the shape later
 *   { classifier: 'tripoint_result' | ... } — runs a named classifier function on the body
 */
export type ExtraExtractionConfig = Record<
  string,
  string | { path?: string; classifier?: string }
>

export interface PartnerForResolver {
  id: string
  slug: string
  api_endpoint: string | null
  cf_secret_key: string | null
  bid_formula: string | null
  bid_resolver_type: BidResolverType | null
  bid_resolver_config: Record<string, unknown> | null
  outbound_field_mapping?: Record<string, unknown> | null
  response_classification: ResponseClassificationConfig | null
  alert_config: AlertConfig | null
  bid_mode?: BidMode | null
  bid_comparison_source?: BidComparisonSource | null
  extra_extraction?: ExtraExtractionConfig | null
}

export interface BidResolverResult {
  bid: number | null
  raw: unknown
  rejected?: boolean
  /** Partner-specific extras pulled from the API response (clickUrl, leadId, classification, …). */
  extra?: Record<string, unknown>
  matrix?: {
    config_id: string
    matched_row_id: string | null
    last_synced_at: string | null
    is_sell_off?: boolean
    reason?: string
  }
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
  env: Env,
  supabase?: SupabaseClient
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
      if (!supabase) {
        throw new BidResolverConfigError(
          `Partner ${partner.slug} uses matrix resolver but no Supabase client was supplied`
        )
      }
      const cfg = partner.bid_resolver_config
      const configId = typeof cfg?.bid_config_id === 'string' ? cfg.bid_config_id : null
      if (!configId) {
        throw new BidResolverConfigError(
          `Partner ${partner.slug} uses matrix resolver but bid_resolver_config.bid_config_id is missing`
        )
      }
      const useSellOff = typeof cfg?.use_sell_off === 'boolean' ? cfg.use_sell_off : false
      const result = await lookupMatrixBid(configId, ctx, supabase, { use_sell_off: useSellOff })
      return {
        bid: result.bid,
        raw: null,
        matrix: {
          config_id: result.config_id,
          matched_row_id: result.matched_row?.id ?? null,
          last_synced_at: result.last_synced_at,
          is_sell_off: result.matched_row?.is_sell_off,
          reason: result.reason,
        },
      }
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

  // Apply per-partner outbound field mapping (TODO 4.9). Null mapping = identity.
  const wireBody = applyOutboundMapping(ctx.trigger.payload, partner.outbound_field_mapping ?? null)
  const body = JSON.stringify(wireBody)
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

  const extra = extractExtras(partner.extra_extraction, raw)
  const comparison = partner.bid_comparison_source ?? 'auto'
  let bid: number | null
  if (comparison === 'formula') {
    bid = evaluatePricing(partner, ctx)
  } else {
    const bidPath = readBidPath(partner)
    bid = bidPath ? coerceNumeric(readPath(raw, bidPath)) : extractBid(raw)
  }

  return { bid, raw, ...(extra ? { extra } : {}) }
}

// ── Structured pricing ────────────────────────────────────────────────────────

/**
 * When bid_comparison_source === 'formula', the resolver dispatches on
 * bid_resolver_config.pricing_mode:
 *   'tiered_multiplier'  — declarative: source_field × tier-matched multiplier
 *   'custom' (or unset)  — falls back to the raw formula string
 *
 * Tiered shape:
 *   {
 *     pricing_mode: 'tiered_multiplier',
 *     source_field: 'steps.eligibility.output.final',
 *     tiers: [{ above: 12499, multiplier: 0.13 }],
 *     default_multiplier: 0.10
 *   }
 * Tiers are evaluated highest-`above` first; first match wins; else default.
 */
function evaluatePricing(partner: PartnerForResolver, ctx: ExecutionContext): number | null {
  const cfg = partner.bid_resolver_config ?? null
  const mode = cfg && typeof cfg.pricing_mode === 'string' ? cfg.pricing_mode : 'custom'
  if (mode === 'tiered_multiplier') {
    return evaluateTieredMultiplier(cfg, ctx)
  }
  const formula = readFormula(partner)
  return formula ? evaluateFormula(formula, ctx) : null
}

interface PricingTier {
  above: number
  multiplier: number
}

function evaluateTieredMultiplier(
  cfg: Record<string, unknown> | null,
  ctx: ExecutionContext
): number | null {
  if (!cfg) return null
  const sourceField = typeof cfg.source_field === 'string' ? cfg.source_field.trim() : ''
  if (!sourceField) return null
  const defaultMultiplier = coerceNumeric(cfg.default_multiplier)
  if (defaultMultiplier === null) return null

  const value = coerceNumeric(resolveFormulaPath(sourceField, ctx))
  if (value === null) return null

  const tiers = readTiers(cfg.tiers)
  for (const tier of tiers) {
    if (value > tier.above) return value * tier.multiplier
  }
  return value * defaultMultiplier
}

function readTiers(raw: unknown): PricingTier[] {
  if (!Array.isArray(raw)) return []
  const tiers: PricingTier[] = []
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue
    const obj = t as Record<string, unknown>
    const above = coerceNumeric(obj.above)
    const multiplier = coerceNumeric(obj.multiplier)
    if (above === null || multiplier === null) continue
    tiers.push({ above, multiplier })
  }
  // Highest threshold first — first match wins
  return tiers.sort((a, b) => b.above - a.above)
}

/**
 * Resolve a path like `steps.eligibility.output.final` or `trigger.payload.x`
 * against the execution context. Bare identifiers (`finalDebt`) fall back to
 * `trigger.payload.<name>` for parity with evaluateFormula.
 */
function resolveFormulaPath(path: string, ctx: ExecutionContext): unknown {
  if (path.includes('.') || path === 'trigger' || path === 'env' || path === 'steps') {
    return resolvePath(path, ctx)
  }
  // Bare identifier — look up on trigger.payload
  const payload = ctx.trigger.payload as Record<string, unknown> | null
  if (payload && typeof payload === 'object') return payload[path]
  return undefined
}

/**
 * Optional `bid_resolver_config.bid_path` lets a partner point extractBid at a
 * specific dot-path in the response (e.g. `data.bid` for AmOne) instead of the
 * default top-level scan over [bid, bid_amount, amount, price, offer].
 */
function readBidPath(partner: PartnerForResolver): string | null {
  const cfg = partner.bid_resolver_config
  if (cfg && typeof cfg.bid_path === 'string' && cfg.bid_path.trim()) return cfg.bid_path
  return null
}

function coerceNumeric(val: unknown): number | null {
  if (typeof val === 'number' && isFinite(val)) return val
  if (typeof val === 'string') {
    const n = parseFloat(val)
    if (!isNaN(n) && isFinite(n)) return n
  }
  return null
}

// ── Extra extraction ──────────────────────────────────────────────────────────

type Classifier = (body: unknown) => unknown

const CLASSIFIERS: Record<string, Classifier> = {
  tripoint_result: tripointResult,
}

function tripointResult(body: unknown): 'Success' | 'Duplicate' | 'Fail' {
  const code = readPath(body, 'data.createLead.resultCode')
  if (typeof code !== 'number') return 'Fail'
  if ((code >= 1002 && code <= 1005) || code === 1020) return 'Duplicate'
  if (code === 1000 || code === 1001 || (code >= 1013 && code <= 1017)) return 'Success'
  return 'Fail'
}

function extractExtras(
  config: ExtraExtractionConfig | null | undefined,
  body: unknown
): Record<string, unknown> | null {
  if (!config) return null
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(config)) {
    if (typeof spec === 'string') {
      out[key] = readPath(body, spec)
    } else if (spec && typeof spec === 'object') {
      if (typeof spec.classifier === 'string') {
        const fn = CLASSIFIERS[spec.classifier]
        out[key] = fn ? fn(body) : undefined
      } else if (typeof spec.path === 'string') {
        out[key] = readPath(body, spec.path)
      } else {
        out[key] = undefined
      }
    }
  }
  return out
}

function readPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return undefined
  const parts = dotPath.split('.').filter(Boolean)
  let cur: unknown = obj
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
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
 *
 * Reference syntax inside the formula:
 *   bare_identifier            — resolved against ctx.trigger.payload (back-compat)
 *   trigger.foo.bar            — resolved against ctx.trigger (e.g. trigger.payload.x)
 *   steps.ns.output.field      — resolved against the named step's output
 *   env.KEY                    — resolved against ctx.env
 *
 * Examples:
 *   "debt_amount * 0.65"
 *   "finalDebt > 12499 ? finalDebt * steps.constants.output.tripointHi
 *                       : finalDebt * steps.constants.output.tripointLo"
 *
 * Only references that resolve to a finite number (or numeric string) are usable.
 * Formula is user-authored, so the Function constructor is acceptable here.
 */
export function evaluateFormula(formula: string, ctx: ExecutionContext): number | null {
  if (!formula.trim()) return null

  // First pass: substitute compound path references (steps.x.y, trigger.x.y, env.X) with
  // generated identifiers. Done before the bare-identifier scan so the regex below
  // doesn't see `steps`, `trigger`, `env` as bare names.
  const pathPattern = /\b(?:steps|trigger|env)(?:\.[a-zA-Z0-9_]+)+\b/g
  const pathVars: Record<string, number> = {}
  let pathIdx = 0
  const stage1 = formula.replace(pathPattern, (match) => {
    const name = `__path${pathIdx++}`
    const val = resolvePath(match, ctx)
    const num = toNumber(val)
    if (num !== null) pathVars[name] = num
    return name
  })

  const identifiers = Array.from(
    new Set(stage1.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) ?? [])
  ).filter(
    (id) =>
      !/^(Math|floor|ceil|round|min|max|abs|sqrt|pow|true|false|null)$/.test(id) &&
      !(id in pathVars)
  )

  const payloadVars: Record<string, number> = {}
  const payload = ctx.trigger.payload
  for (const id of identifiers) {
    const val = getPath(payload, id.split('.'))
    const num = toNumber(val)
    if (num !== null) payloadVars[id] = num
  }

  try {
    const paramNames = ['Math', ...Object.keys(pathVars), ...Object.keys(payloadVars)]
    const paramValues = [Math, ...Object.values(pathVars), ...Object.values(payloadVars)]
    // eslint-disable-next-line no-new-func
    const fn = new Function(...paramNames, `return (${stage1})`)
    const result = fn(...paramValues)
    if (typeof result !== 'number' || !isFinite(result)) return null
    return result
  } catch {
    return null
  }
}

function toNumber(val: unknown): number | null {
  if (typeof val === 'number' && isFinite(val)) return val
  if (typeof val === 'string') {
    const n = parseFloat(val)
    if (!isNaN(n)) return n
  }
  return null
}

function resolvePath(path: string, ctx: ExecutionContext): unknown {
  const segments = path.split('.').filter(Boolean)
  if (segments.length === 0) return undefined
  const head = segments[0]
  const rest = segments.slice(1)
  if (head === 'env') return rest.length ? ctx.env[rest[0]] : undefined
  if (head === 'trigger') return getPath(ctx.trigger, rest)
  if (head === 'steps') {
    const ns = rest[0]
    if (!ns) return undefined
    const step = ctx.steps[ns]
    if (!step) return undefined
    const tail = rest[1] === 'output' ? rest.slice(2) : rest.slice(1)
    if (tail.length === 0) return step.output
    return getPath(step.output, tail)
  }
  return undefined
}

function getPath(obj: unknown, parts: string[]): unknown {
  let cur = obj
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}
