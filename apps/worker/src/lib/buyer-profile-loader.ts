/**
 * loadBuyerProfiles (#1411): the buyer_select node's one read of the profile
 * tables. Enabled profiles for the org, joined in one query to their partner
 * (the accept and decline rules, the endpoint, the credential name, the breaker
 * settings), the operating windows, the blackout dates and the pricing tiers,
 * shaped for the shared evaluator.
 *
 * Caching: a KV copy for the hot path that the profile save route and the
 * partner routes REBUILD on every save (#1492), so the very next lead is served
 * warm rather than paying the cold read inside its 800 ms budget. A cache hit
 * older than the refresh age hands a rebuild to the caller's background, so
 * under steady traffic the copy never expires; the TTL is the bound on a save
 * that bypassed the routes. Traffic alone did not keep it warm overnight, when a
 * gap over five minutes let it expire and the next lead paid the cold read past
 * its budget (#1632), so the per minute prewarm rebuilds it too
 * (keepBuyerProfilesWarm), and a miss answers from the rows and hands its KV
 * writes to the caller's background. A separate last good copy with no TTL is served
 * ONLY when the read fails, never when it returns empty (L682, L214): an org
 * with no enabled buyer is a true answer, and a transient error must never be
 * cached as one. The last good copy is rewritten when its content hash changes
 * (every field of every enabled buyer, partner rows included, in partner id
 * order), or when the copy held is older than BUYER_PROFILES_LAST_GOOD_REFRESH_AFTER_MS,
 * so a hot path re-reading unchanged rows never hits KV's one write a second per
 * key, and the copy's loaded_at says when its content was last confirmed. It used
 * to be keyed on the newest updated_at over the ENABLED rows, which disabling a
 * buyer that did not hold the newest one never moved (#1557).
 *
 * This module is the only reader of the six profile tables outside the profile
 * routes, the parity route and the mirror job; a web guard fails on any other
 * (L692).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { SOLD_ON, clickDeliveryFromDocument, type BuyerProfile, type ClickDelivery, type ClickDeliveryDocument, type Signal, type SoldOn } from '@bidspoke/buyer-profile'
import type { ResponseClassificationConfig } from '../engine/error-classifier'
import { leadRead } from './lead-read-budget'

/** How long a cached snapshot may serve without a rebuild reaching it: the staleness bound on a save that bypassed the routes (#1492). */
export const BUYER_PROFILES_CACHE_TTL_SECONDS = 300
/** A cache hit older than this hands a background rebuild, so steady traffic keeps the copy warm long before it expires (#1492). */
export const BUYER_PROFILES_REFRESH_AFTER_SECONDS = 60
/**
 * A last good copy whose content is unchanged is still rewritten once it is
 * older than this, so its loaded_at stays recent under traffic (#1557):
 * buyer_click_check refuses to offer from a copy older than
 * CLICK_CHECK_LAST_GOOD_MAX_AGE_MS, and a copy stamped only when its content
 * last changed would read as old however recently it was confirmed. At most one
 * extra write per org per five minutes.
 */
export const BUYER_PROFILES_LAST_GOOD_REFRESH_AFTER_MS = 5 * 60 * 1000

export interface LoadOptions {
  now?: () => number
  /** Where an early rebuild runs; without it a hit is served as is and the copy expires on its TTL. The work never rejects. */
  background?: (work: Promise<unknown>) => void
}

const cacheKey = (orgId: string) => `buyer-profiles:${orgId}`
const lastGoodKey = (orgId: string) => `buyer-profiles:${orgId}:lastgood`
/** When a save route last rebuilt this org's profiles; a refresh or prewarm whose read began before it never writes (review of #1646). */
const savedAtKey = (orgId: string) => `buyer-profiles:${orgId}:saved_at`
/** Far above the cache TTL and any read's duration, so the marker outlives every refresh that could race the save. */
export const BUYER_PROFILES_SAVED_AT_TTL_SECONDS = 3600

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
  /**
   * The winner's own facts the sale carries to the Engine response and the
   * Salesforce patch (#1416), so the scripts that write them hold no Tripoint
   * literal: the name Salesforce records, where a sold lead lands, the routing
   * code the patch carries, and the decline answers that mean "already held".
   */
  name: string
  click_url: string | null
  external_routing_code: number | null
  duplicate_signals: Signal[]
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
  /** SHA-256 of the buyers in partner id order, the key the last good rewrite is gated on (#1557). */
  content_hash: string
  served_from: 'database' | 'cache' | 'last_good'
  buyers: LoadedBuyer[]
}

const SELECT =
  'partner_id, version, sold_on, is_enabled, priority, allowed_states, debt_min, debt_max, loan_amount_min, ' +
  'hourly_lead_cap, daily_lead_cap, hourly_spend_cap_cents, daily_spend_cap_cents, click_delivery, updated_at, ' +
  'partner_configs!inner(id, slug, name, is_active, api_endpoint, cf_secret_key, outbound_field_mapping, extra_extraction, ' +
  'accept_signals, response_classification, click_url, external_routing_code, duplicate_signals, ' +
  'circuit_enabled, circuit_error_threshold, circuit_window_seconds, circuit_cooldown_seconds), ' +
  'buyer_operating_windows(day_of_week, opens_minute, closes_minute), ' +
  'buyer_blackout_dates(blackout_date), ' +
  'buyer_pricing_tiers(population, debt_from, debt_to, multiplier)'

interface ProfileRow {
  partner_id: string
  version: number
  sold_on: SoldOn
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
  /** A click buyer's delivery (#1639); its structure is refused on save by save_buyer_profile. */
  click_delivery: ClickDeliveryDocument | null
  updated_at: string
  partner_configs: LoadedBuyerPartner & { accept_signals: unknown; duplicate_signals: unknown }
  buyer_operating_windows: Array<{ day_of_week: number; opens_minute: number; closes_minute: number }> | null
  buyer_blackout_dates: Array<{ blackout_date: string }> | null
  buyer_pricing_tiers: Array<{ population: string; debt_from: number | string; debt_to: number | string | null; multiplier: number | string }> | null
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v))

/**
 * partner_configs.duplicate_signals as the buyer_select node reads it: a stored
 * value that is not a list is no duplicate rules at all, so every decline is
 * Fail. Exported so the daily Tripoint duplicate codes check (#1647) judges the
 * record by this same reading rather than a copy of it (L370).
 */
export function duplicateSignalsOf(raw: unknown): Signal[] {
  return Array.isArray(raw) ? (raw as Signal[]) : []
}

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
      name: p.name,
      click_url: p.click_url,
      external_routing_code: p.external_routing_code,
      duplicate_signals: duplicateSignalsOf(p.duplicate_signals),
      circuit_enabled: p.circuit_enabled,
      circuit_error_threshold: p.circuit_error_threshold,
      circuit_window_seconds: p.circuit_window_seconds,
      circuit_cooldown_seconds: p.circuit_cooldown_seconds,
    },
    profile: {
      partnerId: row.partner_id,
      soldOn: row.sold_on,
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
      // buyer_click_send picks its route and success line from this (#1639); it re-checks it with the shared rules before sending.
      clickDelivery: row.click_delivery ? clickDeliveryFromDocument(row.click_delivery) : null,
    },
    version: row.version,
    updated_at: row.updated_at,
  }
}

/** A cache hit whose KV get took longer than this is logged with its duration (#1632); a normal hit is 3 to 16 ms. */
export const BUYER_PROFILES_SLOW_KV_GET_MS = 100

/**
 * The deadline on a lead's profile read (#1844). Tighter than the lead default
 * because the read runs inside the buyer steps' own budgets, the tightest 800 ms,
 * which must also hold the cache read before it and the last-good read after a
 * failure (a test holds the sum inside every budget). Healthy reads, measured
 * 2026-10-07: 1 in 100 under 396 ms.
 */
export const BUYER_PROFILES_READ_DEADLINE_MS = 500

export async function loadBuyerProfiles(orgId: string, kv: KVNamespace, supabase: SupabaseClient, opts: LoadOptions = {}): Promise<BuyerProfilesSnapshot> {
  const now = opts.now ?? Date.now
  const getStarted = now()
  const cached = await kv.get<BuyerProfilesSnapshot>(cacheKey(orgId), 'json')
  const kvGetMs = now() - getStarted
  if (cached) {
    if (kvGetMs > BUYER_PROFILES_SLOW_KV_GET_MS) console.log(`[buyer-profiles] slow cache hit org=${orgId} kv_get_ms=${kvGetMs}`)
    const ageMs = now() - Date.parse(cached.loaded_at)
    if (opts.background && ageMs > BUYER_PROFILES_REFRESH_AFTER_SECONDS * 1000) {
      // Serve this lead from the copy and rebuild for the next ones. A failed
      // rebuild leaves the copy as it was; the TTL is still the bound on it.
      opts.background(readAndCache(orgId, kv, supabase, now, true).catch((err: unknown) => {
        console.error(`[buyer-profiles] background refresh failed for org ${orgId}: ${err instanceof Error ? err.message : 'unknown error'}`)
      }))
    }
    return { ...cached, served_from: 'cache' }
  }

  // A miss is the slow path (#1632): say how long each part took, so the next
  // slow read names its cause rather than only its total.
  const readStarted = now()
  let snapshot: BuyerProfilesSnapshot
  try {
    snapshot = await readSnapshot(orgId, supabase, now)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error'
    console.error(`[buyer-profiles] read failed for org ${orgId}, not caching: ${message}`)
    const lastGood = await kv.get<BuyerProfilesSnapshot>(lastGoodKey(orgId), 'json')
    if (lastGood) return { ...lastGood, served_from: 'last_good' }
    throw new Error(`buyer profiles read failed for org ${orgId}: ${message}`, { cause: err })
  }
  console.log(`[buyer-profiles] cache miss org=${orgId} kv_get_ms=${kvGetMs} db_read_ms=${now() - readStarted}`)

  // The lead needs the rows, not the cache writes: with a background hook the
  // KV calls (up to five: the save marker and held copy reads, the cache put,
  // and the last good read and put) run after it is answered (#1632), and a failed write costs
  // the next lead a cold read rather than costing this one its answer.
  if (opts.background) {
    opts.background(writeSnapshot(orgId, kv, snapshot, now, readStarted).catch((err: unknown) => {
      console.error(`[buyer-profiles] cache write failed for org ${orgId}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }))
    return snapshot
  }
  try {
    await writeSnapshot(orgId, kv, snapshot, now, readStarted)
  } catch (err) {
    console.error(`[buyer-profiles] cache write failed for org ${orgId}: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  return snapshot
}

/** The one read of the profile tables, shaped and hashed. Throws on a failed read. */
async function readSnapshot(orgId: string, supabase: SupabaseClient, now: () => number): Promise<BuyerProfilesSnapshot> {
  const { data, error } = await leadRead(
    supabase,
    supabase.from('buyer_profiles').select(SELECT).eq('organization_id', orgId).eq('is_enabled', true),
    'buyer profiles',
    { deadlineMs: BUYER_PROFILES_READ_DEADLINE_MS }
  )
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as unknown as ProfileRow[]
  const buyers = rows.map(shape)
  const content_hash = await contentHash(buyers)
  return { org_id: orgId, loaded_at: new Date(now()).toISOString(), content_hash, served_from: 'database', buyers }
}

/**
 * Read the profiles and write the cache and last good copy. Throws on a failed
 * read or write. `yieldToNewer` is for every writer that is not a save: the
 * prewarm, the background refresh on a hit and a miss. Only the save routes
 * (refreshBuyerProfilesCache) write unconditionally, because theirs is the
 * newest truth by construction.
 */
async function readAndCache(orgId: string, kv: KVNamespace, supabase: SupabaseClient, now: () => number, yieldToNewer: boolean): Promise<BuyerProfilesSnapshot> {
  const readStartedAt = now()
  const snapshot = await readSnapshot(orgId, supabase, now)
  await writeSnapshot(orgId, kv, snapshot, now, yieldToNewer ? readStartedAt : undefined)
  return snapshot
}

/**
 * Write the cache, and the last good copy when its content changed or it has
 * aged. Throws on a failed KV call.
 *
 * With `readStartedAt`, the write first re-reads the held copy and skips both
 * writes when that copy was loaded at or after this read began: a save rebuilt
 * it meanwhile, and writing these older rows over it would put a buyer the save
 * just disabled back on sale (review of #1646). KV has no compare and swap, so
 * this narrows the race to the gap between that re-read and the put rather than
 * closing it, and the re-read can itself be served from KV's edge cache; the
 * 300 s TTL and the next prewarm remain the bound on what slips through.
 */
async function writeSnapshot(orgId: string, kv: KVNamespace, snapshot: BuyerProfilesSnapshot, now: () => number, readStartedAt?: number): Promise<void> {
  if (readStartedAt !== undefined) {
    // The save's own marker comes first: a save whose rebuild failed deletes the
    // cached copy, so the held copy alone would show nothing newer.
    const savedAtRaw = await kv.get(savedAtKey(orgId))
    const savedAt = savedAtRaw === null ? null : Number(savedAtRaw)
    if (savedAt !== null && !Number.isFinite(savedAt)) {
      // Only this module writes the marker, as String(Date.now()), so an
      // unreadable one is damage, not a save. Blocking on it would stop every
      // refresh for the marker's whole hour and cold read every lead after the
      // cache expires, so say so loudly, drop it, and write (L50).
      console.error(`[buyer-profiles] the save marker for org ${orgId} is not a time (${JSON.stringify(savedAtRaw)}); deleting it and writing`)
      await kv.delete(savedAtKey(orgId))
    } else if (savedAt !== null && savedAt >= readStartedAt) {
      console.log(`[buyer-profiles] skipped the cache write for org ${orgId}: a save at ${new Date(savedAt).toISOString()} came after this read began at ${new Date(readStartedAt).toISOString()}`)
      return
    }
    const held = await kv.get<BuyerProfilesSnapshot>(cacheKey(orgId), 'json')
    const heldLoadedAt = held ? Date.parse(held.loaded_at) : Number.NaN
    if (Number.isFinite(heldLoadedAt) && heldLoadedAt >= readStartedAt) {
      console.log(`[buyer-profiles] skipped the cache write for org ${orgId}: the held copy was loaded at ${held?.loaded_at}, after this read began at ${new Date(readStartedAt).toISOString()}`)
      return
    }
  }
  const content_hash = snapshot.content_hash
  const serialized = JSON.stringify(snapshot)
  await kv.put(cacheKey(orgId), serialized, { expirationTtl: BUYER_PROFILES_CACHE_TTL_SECONDS })

  const previous = await kv.get<BuyerProfilesSnapshot>(lastGoodKey(orgId), 'json')
  const previousAgeMs = previous ? now() - Date.parse(previous.loaded_at) : Number.POSITIVE_INFINITY
  if (!previous || previous.content_hash !== content_hash || !(previousAgeMs <= BUYER_PROFILES_LAST_GOOD_REFRESH_AFTER_MS)) {
    await kv.put(lastGoodKey(orgId), serialized)
  }
}

/**
 * Called by the per minute prewarm (#1632): rebuilds the cached snapshot whether
 * or not a copy is held, so the copy never reaches its TTL on a quiet night and
 * the first lead after one is still a cache hit. The TTL stays the staleness
 * bound on a save that bypassed the routes. Unlike a failed refresh after a
 * save, a failed rebuild here keeps the copy that is held: nothing changed, so
 * the copy is as right as it was. Answers null on failure and never throws.
 */
export async function keepBuyerProfilesWarm(orgId: string, kv: KVNamespace, supabase: SupabaseClient, opts: Pick<LoadOptions, 'now'> = {}): Promise<BuyerProfilesSnapshot | null> {
  try {
    return await readAndCache(orgId, kv, supabase, opts.now ?? Date.now, true)
  } catch (err) {
    console.error(`[buyer-profiles] keep warm failed for org ${orgId}: ${err instanceof Error ? err.message : 'unknown error'}`)
    return null
  }
}

/**
 * The whole content of the enabled buyers, in partner id order so the order the
 * database happens to return rows in does not count as a change (L343). Every
 * field is in it: a partner switched off changes a partner row, which no
 * profile version or updated_at records.
 */
async function contentHash(buyers: readonly LoadedBuyer[]): Promise<string> {
  const ordered = [...buyers].sort((a, b) => (a.partner.id < b.partner.id ? -1 : a.partner.id > b.partner.id ? 1 : 0))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(ordered)))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Called by the profile save route and the partner routes after a save (#1492):
 * rebuilds the cached snapshot in the same request, so the very next lead is
 * served warm instead of paying the cold read inside its budget. A failed
 * rebuild drops the stale copy (the next lead reads cold, as before) and
 * answers null rather than throwing: the save itself has already landed.
 */
export async function refreshBuyerProfilesCache(orgId: string, kv: KVNamespace, supabase: SupabaseClient): Promise<BuyerProfilesSnapshot | null> {
  // The marker is written BEFORE the rebuild, so it stands whether or not the
  // rebuild succeeds: every other writer whose read began before it yields.
  try {
    await kv.put(savedAtKey(orgId), String(Date.now()), { expirationTtl: BUYER_PROFILES_SAVED_AT_TTL_SECONDS })
  } catch (err) {
    console.error(`[buyer-profiles] save marker write failed for org ${orgId}, a refresh already under way may still write older rows: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  try {
    return await readAndCache(orgId, kv, supabase, Date.now, false)
  } catch (err) {
    console.error(`[buyer-profiles] refresh after save failed for org ${orgId}, dropping the cached copy: ${err instanceof Error ? err.message : 'unknown error'}`)
    await invalidateBuyerProfilesCache(orgId, kv)
    return null
  }
}

/** Drops the cached snapshot so the next read goes to the database. The routes rebuild instead (refreshBuyerProfilesCache); this is the fallback when a rebuild fails. */
export async function invalidateBuyerProfilesCache(orgId: string, kv: KVNamespace): Promise<void> {
  await kv.delete(cacheKey(orgId))
}

/** The partners a buyer_select node on this population sells to: those with an enabled profile priced for it. */
export function partnersPricedFor(snapshot: BuyerProfilesSnapshot, population: string): string[] {
  return snapshot.buyers
    .filter((b) => b.profile.isEnabled && b.profile.tiers.some((t) => t.population === population))
    .map((b) => b.partner.id)
}

/**
 * How one buyer is sold (#1541), for the routes that show ledger counts: a
 * click sold buyer never reserves in the buyer ledger or the Partner Bid daily
 * cap object, so their numbers for it would read as zero sales against a cap
 * that counts clicks. Null means the partner has no profile. A failed read or a
 * value outside the vocabulary throws, never guessing offer (L10).
 */
export async function readBuyerSoldOn(supabase: SupabaseClient, orgId: string, partnerId: string): Promise<SoldOn | null> {
  return (await readBuyerSale(supabase, orgId, partnerId))?.soldOn ?? null
}

/**
 * How one buyer is sold and whether it is switched on, from its one profile row.
 * The partner save reads both (#1561): only an ENABLED click buyer is offered on
 * the partner's click URL, so only its URL is refused when it loses the prospect
 * id placeholder. Null means no profile; a failed read, a kind outside the
 * vocabulary or an enabled flag that is not a boolean throws (L10).
 */
export async function readBuyerSale(supabase: SupabaseClient, orgId: string, partnerId: string): Promise<{ soldOn: SoldOn; isEnabled: boolean } | null> {
  const row = await readSaleRow(supabase, orgId, partnerId, 'sold_on, is_enabled')
  return row ? { soldOn: row.soldOn, isEnabled: row.isEnabled } : null
}

/**
 * One buyer's profile row whether or not it is switched on, with its click
 * delivery (Dan, 2026-09-30): switching a click buyer off stops new offers only,
 * so buyer_click_send still sends a click on an offer already shown through the
 * profile's delivery. The node reads this only for a buyer the enabled snapshot
 * does not hold; the delivery is shaped by the snapshot's own shaper
 * (clickDeliveryFromDocument), so the two reads cannot disagree on it. Null
 * means no profile; a failed read or a malformed row throws (L10).
 */
export async function readBuyerClickDelivery(supabase: SupabaseClient, orgId: string, partnerId: string): Promise<{ soldOn: SoldOn; isEnabled: boolean; clickDelivery: ClickDelivery | null } | null> {
  const row = await readSaleRow(supabase, orgId, partnerId, 'sold_on, is_enabled, click_delivery')
  if (!row) return null
  const doc = row.data.click_delivery as ClickDeliveryDocument | null | undefined
  return { soldOn: row.soldOn, isEnabled: row.isEnabled, clickDelivery: doc ? clickDeliveryFromDocument(doc) : null }
}

/** The one row read behind readBuyerSale and readBuyerClickDelivery, with the kind and flag checks both need. */
async function readSaleRow(supabase: SupabaseClient, orgId: string, partnerId: string, select: string): Promise<{ soldOn: SoldOn; isEnabled: boolean; data: Record<string, unknown> } | null> {
  const { data, error } = await supabase
    .from('buyer_profiles')
    .select(select)
    .eq('partner_id', partnerId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (error) throw new Error(`buyer_profiles: ${error.message}`)
  if (!data) return null
  const row = data as unknown as Record<string, unknown>
  const { sold_on: soldOn, is_enabled: isEnabled } = row
  if (typeof soldOn !== 'string' || !(SOLD_ON as readonly string[]).includes(soldOn)) {
    throw new Error(`buyer_profiles: sold_on ${String(soldOn)} is not one of ${SOLD_ON.join(', ')}`)
  }
  if (typeof isEnabled !== 'boolean') throw new Error(`buyer_profiles: is_enabled ${String(isEnabled)} is not a boolean`)
  return { soldOn: soldOn as SoldOn, isEnabled, data: row }
}
