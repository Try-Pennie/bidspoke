// Pure serialization for the partner form: form-state snapshot -> API body, plus
// the shared rule/floor helpers. Extracted from PartnerForm so the body mapping
// is testable without the React component — it's what the Undo affordance re-saves
// (#98), so a missing field here would silently drop a real-money setting.
import type { PartnerBody, BidResolverType, BidMode, BidComparisonSource, ExtraExtractionConfig } from '@/lib/api'
import type { PartnerType } from '@/lib/partner-roles'

export type BodyCondition = 'equals' | 'contains' | 'in' | 'not_in' | 'present'
export type StatusCondition = 'contains' | 'in' | 'not_in' | 'present'
export type SignalCategory = 'rejection' | 'transient' | 'permanent'

export interface BodyRule { id: string; kind: 'body'; field: string; condition: BodyCondition; value: string }
export interface StatusRule { id: string; kind: 'status'; code: string; bodyField: string; condition: StatusCondition; value: string }
export type Rule = BodyRule | StatusRule
export type SignalRules = Record<SignalCategory, Rule[]>

export interface SubAccountFloor { id: string; uuid: string; bid: string }

export interface FormSnapshot {
  name: string; apiEndpoint: string; cfSecretKey: string; clickUrl: string; isActive: boolean
  priority: string; dailyCap: string; minBid: string; bidFormula: string
  resolverType: BidResolverType; resolverConfig: Record<string, unknown>
  outboundMapping: Record<string, unknown> | null
  bidMode: BidMode; bidComparisonSource: BidComparisonSource
  extraExtraction: ExtraExtractionConfig | null; lastProbeResponse: unknown
  dedupEndpoint: string; circuitEnabled: boolean; circuitThreshold: string
  circuitWindow: string; circuitCooldown: string; signalRules: SignalRules
  alertTransient: boolean; alertPermanent: boolean
  sellOffOfferTitle: string; sellOffOfferDetails: string
  partnerType: PartnerType
  confirmationWindowMs: string
  subAccountFloors: SubAccountFloor[]
}

/** Parse a comma-separated value list for in/not_in. Numeric tokens coerced to numbers. */
export function parseList(s: string): unknown[] {
  return s
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => {
      const n = Number(t)
      return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(t) ? n : t
    })
}

export function listToString(arr: unknown[]): string {
  return arr.map((v) => (v == null ? '' : String(v))).join(',')
}

export function floorsToMap(floors: SubAccountFloor[]): Record<string, number> | null {
  const out: Record<string, number> = {}
  for (const f of floors) {
    const uuid = f.uuid.trim()
    if (!uuid) continue
    // A blank bid is "no override", not a $0 floor. Number('') === 0 passes
    // isFinite, so without this guard an unfilled row would persist a floor of
    // 0 — which accepts any bid and silently bypasses the partner-wide min_bid.
    // Treat blank or non-positive as no floor.
    if (f.bid.trim() === '') continue
    const n = Number(f.bid)
    if (!Number.isFinite(n) || n <= 0) continue
    out[uuid] = n
  }
  return Object.keys(out).length > 0 ? out : null
}

export function serializeRules(rules: SignalRules): unknown {
  const map: [SignalCategory, string][] = [
    ['rejection', 'rejection_signals'],
    ['transient', 'transient_signals'],
    ['permanent', 'permanent_signals'],
  ]
  const result: Record<string, unknown[]> = {}
  let hasAny = false
  for (const [cat, key] of map) {
    const signals: unknown[] = []
    for (const r of rules[cat]) {
      if (r.kind === 'body' && r.field.trim()) {
        if      (r.condition === 'present')  signals.push({ field: r.field, present: true })
        else if (r.condition === 'in')       signals.push({ field: r.field, in: parseList(r.value) })
        else if (r.condition === 'not_in')   signals.push({ field: r.field, not_in: parseList(r.value) })
        else if (r.condition === 'contains') signals.push({ field: r.field, contains: r.value })
        else                                 signals.push({ field: r.field, equals: r.value })
      } else if (r.kind === 'status' && (r.code.trim() || r.bodyField.trim())) {
        const obj: Record<string, unknown> = {}
        if (r.code.trim())      obj.status_code = parseInt(r.code)
        if (r.bodyField.trim()) obj.body_field   = r.bodyField
        if (r.condition === 'present')        obj.present  = true
        else if (r.condition === 'in')        obj.in       = parseList(r.value)
        else if (r.condition === 'not_in')    obj.not_in   = parseList(r.value)
        else if (r.value.trim())              obj.contains = r.value
        signals.push(obj)
      }
    }
    if (signals.length > 0) { result[key] = signals; hasAny = true }
  }
  return hasAny ? result : null
}

/** Build the API body from a form snapshot. Used by Save and by Undo's re-save
 *  (#98) — keep every field in sync with the form's own submit. */
export function buildPartnerBody(snap: FormSnapshot, ctx: { slug: string; isExisting: boolean }): PartnerBody {
  return {
    name: snap.name,
    slug: ctx.isExisting ? undefined : ctx.slug,
    partner_type: snap.partnerType,
    api_endpoint: snap.apiEndpoint || null,
    cf_secret_key: snap.cfSecretKey || null,
    click_url: snap.clickUrl || null,
    is_active: snap.isActive,
    priority: parseInt(snap.priority) || 0,
    daily_cap: snap.dailyCap ? parseInt(snap.dailyCap) : null,
    min_bid: snap.minBid ? parseFloat(snap.minBid) : null,
    bid_formula: snap.bidFormula || null,
    bid_resolver_type: snap.resolverType,
    bid_resolver_config: snap.resolverConfig,
    outbound_field_mapping: snap.outboundMapping,
    bid_mode: snap.bidMode,
    bid_comparison_source: snap.bidComparisonSource,
    extra_extraction: snap.extraExtraction,
    last_probe_response: snap.lastProbeResponse,
    dedup_endpoint: snap.dedupEndpoint || null,
    circuit_enabled: snap.circuitEnabled,
    circuit_error_threshold: parseInt(snap.circuitThreshold) || 5,
    circuit_window_seconds: parseInt(snap.circuitWindow) || 60,
    circuit_cooldown_seconds: parseInt(snap.circuitCooldown) || 300,
    response_classification: serializeRules(snap.signalRules),
    alert_config: {
      transient_errors: { alert: snap.alertTransient },
      permanent_errors: { alert: snap.alertPermanent },
    },
    sell_off_offer_title: snap.sellOffOfferTitle || null,
    sell_off_offer_details: snap.sellOffOfferDetails || null,
    sub_account_min_bids: floorsToMap(snap.subAccountFloors),
    confirmation_window_ms: snap.confirmationWindowMs ? parseInt(snap.confirmationWindowMs) : null,
  }
}
