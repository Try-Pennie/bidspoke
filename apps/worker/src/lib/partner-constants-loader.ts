import type { SupabaseClient } from '@supabase/supabase-js'
import { leadRead } from './lead-read-budget'
import { fetchUpTo } from './paginate'
import { CONFIG_LIST_BOUNDS } from './config-list-bounds'
import { confirmedAt, isDueForReconfirm, judgeCopyAge, readConfirmedCopy, refuseStoredCopy, serveStoredCopy } from './stored-copy-age'
import { formatErr } from './format-error'

// Partner constants change rarely and every mutating route busts this cache
// explicitly (see invalidatePartnerConstantsCache call sites). The long TTL keeps
// the Constants node off the cold-DB path; it's finite only as a self-healing
// backstop so a missed invalidation can't leave bidding data (activeBidding,
// sub_account_min_bids) stale forever.
const TTL = 60 * 60 * 24 * 30 // 30 days (KV)
const cacheKey = (orgId: string) => `partner-constants-v2-${orgId}`
// No-TTL last-good copy, served during a transient DB blip so a cold load never
// degrades to empty bidding constants (the #391 shape, see loadFromKvOrDb). It is
// served for at most STORED_COPY_MAX_AGE_MS after a load last confirmed it
// (#1847), and carries that time in its KV metadata. The 30 day cache means a
// lead almost never reads the database, so the per minute prewarm confirms the
// copy once it is due (keepPartnerConstantsConfirmed).
const lastGoodKey = (orgId: string) => `partner-constants-v2-${orgId}-lastgood`
/** The last-good copy, which the stale copy check judges (#1848). */
export const partnerConstantsLastGoodKey = lastGoodKey

// In front of KV sits a per-isolate memory cache + single-flight. A warm isolate
// serves from memory without touching KV (sub-ms), and concurrent loads on a cold
// isolate coalesce to one KV/DB read instead of stampeding Supabase — the failure
// mode behind the constants-node burst timeouts (cold KV miss -> slow Supabase).
// The TTL is deliberately short: invalidatePartnerConstantsCache busts KV on every
// partner/uuid edit but cannot reach other isolates' memory, so this bounds how
// long a warm isolate can serve a pre-edit copy of bidding-critical data
// (activeBidding, sub_account_min_bids). It only needs to outlast a traffic burst.
const MEMORY_TTL_MS = 15_000
/** Part of the bidding pickup bound (BIDDING_PICKUP in apps/web, #2132). */
export const PARTNER_CONSTANTS_MEMORY_TTL_MS = MEMORY_TTL_MS
const memoryCache = new Map<string, { value: PartnerConstants; expiresAt: number }>()
const inflight = new Map<string, Promise<PartnerConstants>>()

export interface PartnerConstants {
  subAccountIdsMap: Record<string, string>
  sellOff: Record<string, { title: string; details: string }>
  clickUrls: Record<string, string>
  /** Bidding active per partner slug. Missing slug = inactive (safe-by-default). */
  activeBidding: Record<string, boolean>
  /** Per-partner per-sub-account minimum bid floors. Partner slug → uuid → floor. */
  subAccountMinBids: Record<string, Record<string, number>>
  /**
   * Every partner in the org, active or not, by id to its current slug (#1553):
   * how a node that stores a partner id names the partner in its logs and alerts.
   * Absent only on a last good copy written before this field existed, which a
   * reader must treat as could not read, never as no such partner (L11).
   */
  slugsById?: Record<string, string>
}

/**
 * Forget every organization's constants held in this isolate's memory. Only the
 * outage drill calls it (#1305, money-gate/harness/isolate-memory.ts), so a down
 * run meets the outage rather than what an earlier run left in memory.
 */
export function forgetPartnerConstantsMemory(): void {
  memoryCache.clear()
  inflight.clear()
}

export async function loadPartnerConstants(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient
): Promise<PartnerConstants> {
  const memo = memoryCache.get(orgId)
  if (memo && memo.expiresAt > Date.now()) return memo.value

  const existing = inflight.get(orgId)
  if (existing) return existing

  const load = (async () => {
    try {
      const value = await loadFromKvOrDb(orgId, kv, supabase)
      memoryCache.set(orgId, { value, expiresAt: Date.now() + MEMORY_TTL_MS })
      return value
    } finally {
      inflight.delete(orgId)
    }
  })()
  inflight.set(orgId, load)
  return load
}

async function loadFromKvOrDb(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient
): Promise<PartnerConstants> {
  const cached = await kv.get<PartnerConstants>(cacheKey(orgId), 'json')
  // A copy cached before slugsById existed is read again rather than served
  // without it; the 30 day TTL would otherwise keep it for a month (#1553).
  if (cached && cached.slugsById) return cached

  const read = await readFromDb(orgId, supabase)

  // A transient DB error must NEVER be turned into empty bidding constants and
  // cached for 30 days: that silently marks every partner inactive, drops bids,
  // and breaks routing with no signal (the #391 outage shape, the same mistake
  // env-loader.ts was fixed for). On error: do not cache; serve the no-TTL
  // last-good copy while it is within the maximum age (#1847), else throw the
  // named refusal so the Constants node surfaces a real failure instead of
  // fabricating empty data.
  if ('error' in read) {
    console.error(`[partner-constants] load failed for org ${orgId}, not caching: ${read.error}`)
    return serveLastGood(orgId, kv, read.error)
  }

  await writeCopies(orgId, kv, read.constants, Date.now())
  return read.constants
}

async function serveLastGood(orgId: string, kv: KVNamespace, dbError: string): Promise<PartnerConstants> {
  let held: Awaited<ReturnType<typeof readConfirmedCopy>>
  try {
    held = await readConfirmedCopy(kv, lastGoodKey(orgId))
  } catch (err) {
    console.error(`[partner-constants] the last-good copy for org ${orgId} could not be read: ${formatErr(err)}`)
    throw refuseStoredCopy({ copy: 'partner_constants', subject: orgId, reason: 'copy_unusable', ageMs: null, dbError })
  }
  let lastGood: PartnerConstants | null
  try {
    lastGood = held ? (JSON.parse(held.value) as PartnerConstants) : null
  } catch {
    lastGood = null
  }
  if (!held || !lastGood) throw refuseStoredCopy({ copy: 'partner_constants', subject: orgId, reason: held ? 'copy_unusable' : 'no_copy', ageMs: null, dbError })
  const age = judgeCopyAge(held.confirmedAt, Date.now())
  if (!age.usable) throw refuseStoredCopy({ copy: 'partner_constants', subject: orgId, reason: age.reason, ageMs: age.ageMs, dbError })
  serveStoredCopy({ copy: 'partner_constants', subject: orgId, ageMs: age.ageMs, dbError })
  return lastGood
}

/** Short cache for the hot path; no-TTL last-good, stamped as confirmed now, for blip resilience. */
async function writeCopies(orgId: string, kv: KVNamespace, constants: PartnerConstants, nowMs: number): Promise<void> {
  const serialized = JSON.stringify(constants)
  await kv.put(cacheKey(orgId), serialized, { expirationTtl: TTL })
  await kv.put(lastGoodKey(orgId), serialized, confirmedAt(nowMs))
}

/** The constants from the database, or the read's error message. */
async function readFromDb(orgId: string, supabase: SupabaseClient): Promise<{ constants: PartnerConstants } | { error: string }> {
  // Either read failing fails the whole load: the caller serves the last-good
  // copy or refuses, and never caches a half read. A list past its bound fails
  // it the same way (#1437), since cut at the row cap it would be cached as the
  // whole set.
  try {
    const [uuidRows, partnerRows] = await Promise.all([
      fetchUpTo<PartnerConstantsUuidRow>(
        (limit) => leadRead(supabase, supabase.from('partner_uuid_map').select('uuid, partner_slug').eq('org_id', orgId).limit(limit), 'partner uuid map'),
        CONFIG_LIST_BOUNDS.partnerUuids,
        'partner uuid map',
      ),
      fetchUpTo<PartnerConstantsPartnerRow>(
        (limit) => leadRead(
          supabase,
          supabase
            .from('partner_configs')
            .select('id, slug, sell_off_offer_title, sell_off_offer_details, click_url, is_active, sub_account_min_bids')
            .eq('organization_id', orgId)
            .limit(limit),
          'partner constants'
        ),
        CONFIG_LIST_BOUNDS.partnerConfigs,
        'partner constants',
      ),
    ])
    return { constants: partnerConstantsFromRows(uuidRows, partnerRows) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'unknown error' }
  }
}

export interface PartnerConstantsUuidRow {
  uuid: string
  partner_slug: string
}

export interface PartnerConstantsPartnerRow {
  id: string
  slug: string
  sell_off_offer_title: string | null
  sell_off_offer_details: string | null
  click_url: string | null
  is_active: boolean | null
  sub_account_min_bids: unknown
}

/**
 * The constants built from the rows (#2142): the one place a row becomes a
 * partner value, used by the loader for the whole organization and by the
 * partners page's workflow values route for one partner, so the page shows
 * exactly what the Constants node would emit.
 */
export function partnerConstantsFromRows(
  uuidRows: readonly PartnerConstantsUuidRow[],
  partnerRows: readonly PartnerConstantsPartnerRow[]
): PartnerConstants {
  const subAccountIdsMap: Record<string, string> = {}
  for (const row of uuidRows) {
    subAccountIdsMap[row.uuid] = row.partner_slug
  }

  const sellOff: Record<string, { title: string; details: string }> = {}
  const clickUrls: Record<string, string> = {}
  const activeBidding: Record<string, boolean> = {}
  const subAccountMinBids: Record<string, Record<string, number>> = {}
  const slugsById: Record<string, string> = {}
  for (const row of partnerRows) {
    slugsById[row.id] = row.slug
    if (row.sell_off_offer_title || row.sell_off_offer_details) {
      sellOff[row.slug] = {
        title: row.sell_off_offer_title ?? '',
        details: row.sell_off_offer_details ?? '',
      }
    }
    if (row.click_url) {
      clickUrls[row.slug] = row.click_url
    }
    activeBidding[row.slug] = row.is_active === true
    if (row.sub_account_min_bids && typeof row.sub_account_min_bids === 'object') {
      const normalized: Record<string, number> = {}
      for (const [uuid, bid] of Object.entries(row.sub_account_min_bids as Record<string, unknown>)) {
        const n = Number(bid)
        // A 0 (or negative) floor means "accept anything" and would bypass the
        // partner-wide min_bid — never an intended override. Drop it as no floor,
        // backstopping any 0 already persisted by the old blank-input bug.
        if (Number.isFinite(n) && n > 0) normalized[uuid] = n
      }
      if (Object.keys(normalized).length > 0) subAccountMinBids[row.slug] = normalized
    }
  }

  return { subAccountIdsMap, sellOff, clickUrls, activeBidding, subAccountMinBids, slugsById }
}

/**
 * Called by the per minute prewarm (#1847): when the last-good copy is due to
 * be confirmed (STORED_COPY_RECONFIRM_AFTER_MS old, unstamped or absent), read
 * the rows and rewrite both copies, so a quiet organization's copy never ages
 * past the maximum on a healthy day. Answers what it did and never throws: a
 * failed read keeps the held copy, which is as right as it was.
 */
export async function keepPartnerConstantsConfirmed(orgId: string, kv: KVNamespace, supabase: SupabaseClient): Promise<'fresh' | 'confirmed' | 'failed'> {
  try {
    const { metadata } = await kv.getWithMetadata<{ confirmed_at?: unknown }>(lastGoodKey(orgId))
    if (!isDueForReconfirm(metadata?.confirmed_at, Date.now())) return 'fresh'
    const read = await readFromDb(orgId, supabase)
    if ('error' in read) {
      console.error(`[partner-constants] confirming the last-good copy for org ${orgId} failed, keeping the held copy: ${read.error}`)
      return 'failed'
    }
    await writeCopies(orgId, kv, read.constants, Date.now())
    memoryCache.set(orgId, { value: read.constants, expiresAt: Date.now() + MEMORY_TTL_MS })
    return 'confirmed'
  } catch (e) {
    console.error(`[partner-constants] confirming the last-good copy for org ${orgId} failed: ${formatErr(e)}`)
    return 'failed'
  }
}

export async function invalidatePartnerConstantsCache(orgId: string, kv: KVNamespace): Promise<void> {
  // Clears this isolate's memory copy too; other isolates self-heal within MEMORY_TTL_MS.
  memoryCache.delete(orgId)
  inflight.delete(orgId)
  await kv.delete(cacheKey(orgId))
}
