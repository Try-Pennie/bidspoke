/**
 * loadBuyerProfiles (#1411): the buyer_select node's one read of the profile
 * tables. Enabled profiles for the org, joined in one query to their partner
 * (the accept and decline rules, the endpoint, the credential name, the breaker
 * settings), the operating windows, the blackout dates and the pricing tiers,
 * shaped for the shared evaluator.
 *
 * Caching: a 60 second KV copy for the hot path, invalidated by the profile save
 * route and the partner save route. A separate last good copy with no TTL is
 * served ONLY when the read fails, never when it returns empty (L682, L214): an
 * org with no enabled buyer is a true answer, and a transient error must never
 * be cached as one. The last good copy is rewritten only when the newest
 * updated_at moves, so a hot path re-reading unchanged rows never hits KV's one
 * write a second per key.
 *
 * This module is the only reader of the six profile tables outside the profile
 * routes, the parity route and the mirror job; a web guard fails on any other
 * (L692).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BuyerProfile, Signal } from '@bidspoke/buyer-profile'
import type { ResponseClassificationConfig } from '../engine/error-classifier'

export const BUYER_PROFILES_CACHE_TTL_SECONDS = 60

const cacheKey = (orgId: string) => `buyer-profiles:${orgId}`
const lastGoodKey = (orgId: string) => `buyer-profiles:${orgId}:lastgood`

export interface LoadedBuyerPartner {
  id: string
  slug: string
  is_active: boolean
  api_endpoint: string | null
  cf_secret_key: string | null
  outbound_field_mapping: Record<string, unknown> | null
  extra_extraction: Record<string, unknown> | null
  accept_signals: Signal[]
  response_classification: ResponseClassificationConfig | null
  circuit_enabled: boolean
  circuit_error_threshold: number
  circuit_window_seconds: number
  circuit_cooldown_seconds: number
}

export interface LoadedBuyer {
  partner: LoadedBuyerPartner
  profile: BuyerProfile
  version: number
  updated_at: string
}

export interface BuyerProfilesSnapshot {
  org_id: string
  loaded_at: string
  /** The newest updated_at across the rows, the key the last good rewrite is gated on. */
  updated_at_max: string | null
  served_from: 'database' | 'cache' | 'last_good'
  buyers: LoadedBuyer[]
}

const SELECT =
  'partner_id, version, is_enabled, priority, allowed_states, debt_min, debt_max, loan_amount_min, ' +
  'hourly_lead_cap, daily_lead_cap, hourly_spend_cap_cents, daily_spend_cap_cents, updated_at, ' +
  'partner_configs!inner(id, slug, is_active, api_endpoint, cf_secret_key, outbound_field_mapping, extra_extraction, ' +
  'accept_signals, response_classification, circuit_enabled, circuit_error_threshold, circuit_window_seconds, circuit_cooldown_seconds), ' +
  'buyer_operating_windows(day_of_week, opens_minute, closes_minute), ' +
  'buyer_blackout_dates(blackout_date), ' +
  'buyer_pricing_tiers(population, debt_from, debt_to, multiplier)'

interface ProfileRow {
  partner_id: string
  version: number
  is_enabled: boolean
  priority: number | null
  allowed_states: string[] | null
  debt_min: number | string | null
  debt_max: number | string | null
  loan_amount_min: number | string | null
  hourly_lead_cap: number | null
  daily_lead_cap: number | null
  hourly_spend_cap_cents: number | null
  daily_spend_cap_cents: number | null
  updated_at: string
  partner_configs: LoadedBuyerPartner & { accept_signals: unknown }
  buyer_operating_windows: Array<{ day_of_week: number; opens_minute: number; closes_minute: number }> | null
  buyer_blackout_dates: Array<{ blackout_date: string }> | null
  buyer_pricing_tiers: Array<{ population: string; debt_from: number | string; debt_to: number | string | null; multiplier: number | string }> | null
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v))

function shape(row: ProfileRow): LoadedBuyer {
  const p = row.partner_configs
  return {
    partner: {
      id: p.id,
      slug: p.slug,
      is_active: p.is_active,
      api_endpoint: p.api_endpoint,
      cf_secret_key: p.cf_secret_key,
      outbound_field_mapping: p.outbound_field_mapping,
      extra_extraction: p.extra_extraction,
      accept_signals: Array.isArray(p.accept_signals) ? (p.accept_signals as Signal[]) : [],
      response_classification: p.response_classification,
      circuit_enabled: p.circuit_enabled,
      circuit_error_threshold: p.circuit_error_threshold,
      circuit_window_seconds: p.circuit_window_seconds,
      circuit_cooldown_seconds: p.circuit_cooldown_seconds,
    },
    profile: {
      partnerId: row.partner_id,
      isEnabled: row.is_enabled,
      priority: row.priority,
      allowedStates: row.allowed_states ?? [],
      debtMin: num(row.debt_min),
      debtMax: num(row.debt_max),
      loanAmountMin: num(row.loan_amount_min),
      hourlyLeadCap: row.hourly_lead_cap,
      dailyLeadCap: row.daily_lead_cap,
      hourlySpendCapCents: row.hourly_spend_cap_cents,
      dailySpendCapCents: row.daily_spend_cap_cents,
      windows: (row.buyer_operating_windows ?? []).map((w) => ({ dayOfWeek: w.day_of_week, opensMinute: w.opens_minute, closesMinute: w.closes_minute })),
      blackoutDates: (row.buyer_blackout_dates ?? []).map((b) => b.blackout_date),
      tiers: (row.buyer_pricing_tiers ?? []).map((t) => ({ population: t.population, debtFrom: Number(t.debt_from), debtTo: num(t.debt_to), multiplier: Number(t.multiplier) })),
    },
    version: row.version,
    updated_at: row.updated_at,
  }
}

export async function loadBuyerProfiles(orgId: string, kv: KVNamespace, supabase: SupabaseClient): Promise<BuyerProfilesSnapshot> {
  const cached = await kv.get<BuyerProfilesSnapshot>(cacheKey(orgId), 'json')
  if (cached) return { ...cached, served_from: 'cache' }

  const { data, error } = await supabase
    .from('buyer_profiles')
    .select(SELECT)
    .eq('organization_id', orgId)
    .eq('is_enabled', true)

  if (error) {
    console.error(`[buyer-profiles] read failed for org ${orgId}, not caching: ${error.message}`)
    const lastGood = await kv.get<BuyerProfilesSnapshot>(lastGoodKey(orgId), 'json')
    if (lastGood) return { ...lastGood, served_from: 'last_good' }
    throw new Error(`buyer profiles read failed for org ${orgId}: ${error.message}`)
  }

  const rows = (data ?? []) as unknown as ProfileRow[]
  const buyers = rows.map(shape)
  const updated_at_max = buyers.reduce<string | null>((max, b) => (max === null || b.updated_at > max ? b.updated_at : max), null)
  const snapshot: BuyerProfilesSnapshot = { org_id: orgId, loaded_at: new Date().toISOString(), updated_at_max, served_from: 'database', buyers }
  const serialized = JSON.stringify(snapshot)
  await kv.put(cacheKey(orgId), serialized, { expirationTtl: BUYER_PROFILES_CACHE_TTL_SECONDS })

  const previous = await kv.get<BuyerProfilesSnapshot>(lastGoodKey(orgId), 'json')
  if (!previous || previous.updated_at_max !== updated_at_max) {
    await kv.put(lastGoodKey(orgId), serialized)
  }
  return snapshot
}

/** Called by the profile save route and the partner save route, so an edit applies to the very next lead. */
export async function invalidateBuyerProfilesCache(orgId: string, kv: KVNamespace): Promise<void> {
  await kv.delete(cacheKey(orgId))
}

/** The partners a buyer_select node on this population sells to: those with an enabled profile priced for it. */
export function partnersPricedFor(snapshot: BuyerProfilesSnapshot, population: string): string[] {
  return snapshot.buyers
    .filter((b) => b.profile.isEnabled && b.profile.tiers.some((t) => t.population === population))
    .map((b) => b.partner.id)
}
