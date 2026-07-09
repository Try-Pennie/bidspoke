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
import { linkAbort } from './retry'
import { PartnerApiError } from './partner-bid-error'
import { lookupMatrixBid } from '../lib/bid-matrix-lookup'
import { applyOutboundMapping } from '../lib/field-mapper'
import { parseJsonSafe } from '../lib/json'

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
  /**
   * Why an API resolver produced a null bid — set only when the partner
   * responded (2xx) but no bid could be read (unrecognized response shape or a
   * bid_path that resolved to nothing). Distinguishes a config/shape problem
   * from a genuine decline, which otherwise both look like "no bid".
   */
  bid_reason?: string
  /** HTTP status from the partner API. null for formula/matrix resolvers. */
  status?: number | null
  /** Response headers from the partner API (sensitive headers stripped). null for formula/matrix. */
  response_headers?: Record<string, string> | null
  /** Partner-specific extras pulled from the API response (clickUrl, leadId, classification, …). */
  extra?: Record<string, unknown>
  matrix?: {
    config_id: string
    matched_row_id: string | null
    last_synced_at: string | null
    is_sell_off?: boolean
    reason?: string
  }
  /**
   * Resolved values used to produce the bid — surfaced to the partner-bid
   * executor so failed/skipped attempts can show what was actually computed.
   *   api    → the outbound JSON body sent (post outbound_field_mapping)
   *   matrix → the lookup key fields read from the lead (credit_score, debt, etc.)
   *   formula → the formula string + the variables that were in scope
   */
  resolved_input?: Record<string, unknown>
}

const SENSITIVE_HEADER_KEYS = new Set([
  'authorization',
  'set-cookie',
  'cookie',
  'proxy-authorization',
])

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
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
  supabase?: SupabaseClient,
  signal?: AbortSignal
): Promise<BidResolverResult> {
  const type = effectiveResolverType(partner)

  switch (type) {
    case 'formula': {
      const formula = readFormula(partner)
      if (!formula) return { bid: null, raw: null }
      return {
        bid: evaluateFormula(formula, ctx),
        raw: null,
        resolved_input: { formula, payload: ctx.trigger.payload },
      }
    }
    case 'api': {
      if (!partner.api_endpoint) return { bid: null, raw: null }
      return callBidApi(partner, ctx, env, signal)
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
        resolved_input: { lookup_payload: ctx.trigger.payload, use_sell_off: useSellOff },
      }
    }
  }
}

/**
 * Read the resolver type with a legacy fallback.
 * If bid_resolver_type isn't set (pre-migration row) use the same precedence the old
 * code path used: api_endpoint wins over bid_formula.
 */
export function effectiveResolverType(partner: PartnerForResolver): BidResolverType {
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
  env: Env,
  signal?: AbortSignal
): Promise<BidResolverResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Trace-Id': ctx.trigger.trace_id,
  }

  if (partner.cf_secret_key) {
    const secretValue = (env as unknown as Record<string, string | undefined>)[partner.cf_secret_key]
    if (secretValue) {
      headers['Authorization'] = `Bearer ${secretValue}`
    } else {
      // The partner is configured to require a credential but it resolved empty
      // (the secret is unset or blank). Previously we silently dropped the auth
      // header and sent an unauthenticated request, which just 401s and surfaces as
      // a generic transient with no hint that the real cause is a missing credential
      // (#411). Fail loudly instead: a distinct, permanent (retry can't help) error
      // that names the missing key, and skip the doomed call.
      const credErr = new PartnerApiError(
        `Partner ${partner.slug} requires credential '${partner.cf_secret_key}' but it is missing or blank`,
        'permanent',
        false,
      ) as PartnerApiError & { resolved_input?: Record<string, unknown> }
      credErr.resolved_input = {
        endpoint: partner.api_endpoint,
        method: 'POST',
        missing_credential: partner.cf_secret_key,
      }
      throw credErr
    }
  }

  // Apply per-partner outbound field mapping (TODO 4.9). Null mapping = identity.
  const wireBody = applyOutboundMapping(ctx.trigger.payload, partner.outbound_field_mapping ?? null)
  const body = JSON.stringify(wireBody)
  const resolvedInputForCaller: Record<string, unknown> = {
    endpoint: partner.api_endpoint,
    method: 'POST',
    outbound_body: wireBody,
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  linkAbort(controller, signal)  // also cancel on the step-level timeout (#66)

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

  const raw = await parseJsonSafe(res)

  const resHeaders: Record<string, string> = {}
  res.headers.forEach((v, k) => { resHeaders[k] = v })
  const safeHeaders = scrubHeaders(resHeaders)
  const httpStatus = res.status

  if (partner.response_classification) {
    const override = evaluateResponseClassification(
      partner.response_classification,
      res.status,
      raw,
      resHeaders
    )
    if (override === 'rejection') {
      // Pull extras even on rejection — partners like Tripoint return useful
      // identifiers (e.g. leadId on a Duplicate result code) that downstream
      // engine-fallback handlers need for SF write-back. Without this, the
      // engine_no_bids SF body would have TripointLeadID__c=null on a Duplicate
      // even though Tripoint returned the existing lead's id in the body.
      const rejectedExtra = extractExtras(partner.extra_extraction, raw)
      return {
        bid: null,
        raw,
        rejected: true,
        status: httpStatus,
        response_headers: safeHeaders,
        ...(rejectedExtra ? { extra: rejectedExtra } : {}),
        resolved_input: resolvedInputForCaller,
      }
    }
    if (override === 'transient' || override === 'permanent') {
      const suppress = shouldSuppressAlert(partner.alert_config, override)
      const apiErr = new PartnerApiError(
        `Partner API returned ${res.status} (classified as ${override} by override)`,
        override,
        suppress
      ) as PartnerApiError & { resolved_input?: Record<string, unknown>; status?: number; response_headers?: Record<string, string> }
      apiErr.resolved_input = resolvedInputForCaller
      apiErr.status = httpStatus
      apiErr.response_headers = safeHeaders
      throw apiErr
    }
  }

  if (!res.ok) {
    const httpErr = new Error(`Partner API returned ${res.status}`) as Error & { resolved_input?: Record<string, unknown>; status?: number; response_headers?: Record<string, string> }
    httpErr.resolved_input = resolvedInputForCaller
    httpErr.status = httpStatus
    httpErr.response_headers = safeHeaders
    throw httpErr
  }

  const extra = extractExtras(partner.extra_extraction, raw)
  const comparison = partner.bid_comparison_source ?? 'auto'
  let bid: number | null
  let bidReason: string | undefined
  if (comparison === 'formula') {
    bid = evaluatePricing(partner, ctx)
  } else {
    const bidPath = readBidPath(partner)
    if (bidPath) {
      bid = coerceNumeric(readPath(raw, bidPath))
      if (bid === null) bidReason = `bid_path '${bidPath}' resolved to no numeric value`
    } else {
      bid = extractBid(raw)
      // Responded with an object but none of bid/bid_amount/amount/price/offer
      // held a number — likely a response-shape drift or a missing bid_path,
      // not a real decline. Surface it so "why no bid?" isn't a mystery.
      if (bid === null && raw !== null && typeof raw === 'object') {
        bidReason = 'no recognized bid field in response'
      }
    }
  }

  return {
    bid,
    raw,
    status: httpStatus,
    response_headers: safeHeaders,
    ...(extra ? { extra } : {}),
    ...(bidReason ? { bid_reason: bidReason } : {}),
    resolved_input: resolvedInputForCaller,
  }
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
  if (
    path.includes('.') ||
    path === 'trigger' ||
    path === 'env' ||
    path === 'steps' ||
    path === 'context'
  ) {
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

// Tripoint result-code classification (single source of truth, shared with the
// code-node bid-log derivation in bid-log.ts). Approved 1000-1001 and 1013-1017;
// 1002-1005 and 1020 are Duplicate; everything else is a rejection.
export function classifyTripointResultCode(code: number): 'Success' | 'Duplicate' | 'Fail' {
  if ((code >= 1002 && code <= 1005) || code === 1020) return 'Duplicate'
  if (code === 1000 || code === 1001 || (code >= 1013 && code <= 1017)) return 'Success'
  return 'Fail'
}

function tripointResult(body: unknown): 'Success' | 'Duplicate' | 'Fail' {
  const code = readPath(body, 'data.createLead.resultCode')
  if (typeof code !== 'number') return 'Fail'
  return classifyTripointResultCode(code)
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

// Coercion goes through coerceNumeric, which rejects NaN and +/-Infinity. A
// non-finite bid would beat every honest bid and corrupt bid_cents, and it is
// reachable from plain JSON: JSON.parse('1e999') is Infinity, and
// parseFloat('Infinity') is too (#506). A non-finite value is treated like any
// other unparseable one: skip the field and keep scanning.
function extractBid(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  for (const field of ['bid', 'bid_amount', 'amount', 'price', 'offer']) {
    const n = coerceNumeric(r[field])
    if (n !== null) return n
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
  const pathPattern = /\b(?:steps|trigger|env|context)(?:\.[a-zA-Z0-9_]+)+\b/g
  const pathVars: Record<string, number> = {}
  let pathIdx = 0
  const stage1 = formula.replace(pathPattern, (match) => {
    const name = `__path${pathIdx++}`
    const val = resolvePath(match, ctx)
    const num = toNumber(val)
    if (num !== null) pathVars[name] = num
    return name
  })

  // Second pass: substitute bare payload references (e.g. `amount`, or the dotted
  // `loanInformation.amount`) with generated identifiers too. A dotted bare
  // reference cannot be a JS parameter name, so passing it straight to the
  // Function constructor — as the old code did — threw a SyntaxError that the
  // catch below swallowed, silently yielding no bid. Longest-first so a dotted
  // id is replaced before any prefix of it.
  const identifiers = Array.from(
    new Set(stage1.match(/[a-zA-Z_][a-zA-Z0-9_.]*/g) ?? [])
  ).filter(
    (id) =>
      !/^(Math|floor|ceil|round|min|max|abs|sqrt|pow|true|false|null)$/.test(id) &&
      !(id in pathVars)
  ).sort((a, b) => b.length - a.length)

  const payload = ctx.trigger.payload
  const payloadVars: Record<string, number> = {}
  let stage2 = stage1
  let varIdx = 0
  for (const id of identifiers) {
    const num = toNumber(getPath(payload, id.split('.')))
    if (num === null) continue // unresolved → leave as-is (evaluates to null below)
    const name = `__var${varIdx++}`
    payloadVars[name] = num
    stage2 = stage2.replace(new RegExp(`\\b${escapeRegExp(id)}\\b`, 'g'), name)
  }

  try {
    const paramNames = ['Math', ...Object.keys(pathVars), ...Object.keys(payloadVars)]
    const paramValues = [Math, ...Object.values(pathVars), ...Object.values(payloadVars)]
    // SECURITY (reviewed #299): `formula` is author-only — it comes solely from
    // partner_configs.bid_formula / bid_resolver_config, written through the
    // jwt-authed, org-scoped /api/partners endpoints. Request payloads and partner
    // responses supply only VALUES, bound here as numeric params (not concatenated
    // into the code string), so untrusted input cannot inject code. Residual risk
    // is author-only: an unresolved identifier (e.g. `fetch`) is left in `stage2`
    // and would execute. Before enabling formula bidding in production, add a
    // grammar allowlist that rejects any token outside {Math, the bound vars,
    // numbers, arithmetic/comparison/ternary} — see #299.
    // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
    const fn = new Function(...paramNames, `return (${stage2})`) as (...args: unknown[]) => unknown
    const result = fn(...paramValues)
    if (typeof result !== 'number' || !isFinite(result)) return null
    return result
  } catch {
    return null
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  // context.<key> — BidGroup-scoped values. ctx.bidGroupContext is set by
  // walkGraph before partner attempts run and cleared after the group resolves.
  // Lets partner formulas reference workflow-supplied values (e.g. finalDebt)
  // without coupling the partner config to a specific workflow's step names.
  if (head === 'context') {
    const bidCtx = ctx.bidGroupContext
    if (!bidCtx) return undefined
    if (rest.length === 0) return bidCtx
    const key = rest[0]
    if (rest.length === 1) return bidCtx[key]
    return getPath(bidCtx[key], rest.slice(1))
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
