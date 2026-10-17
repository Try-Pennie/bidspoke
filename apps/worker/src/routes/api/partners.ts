/**
 * Partner management API — PRD Section 2.1
 * CRUD for partner_configs. Daily cap count comes from the DailyCapDO.
 */
import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { invalidatePartnerConstantsCache } from '../../lib/partner-constants-loader'
import { readBuyerProfileVersion, refreshBuyerProfilesCache } from '../../lib/buyer-profile-loader'
import { retirePartnerLastGood } from '../../lib/partner-last-good'
import { copyCleared, copyWarning } from '../../lib/stored-copy'
import { asJson } from '../../lib/json'
import type { Json } from '../../types/database'
import { PARTNER_TYPES, isPartnerType, type PartnerType } from '../../lib/partner-roles'
import { partnerCredentialMissing } from '../../lib/partner-credential'
import { dailyCapObjectName } from '../../lib/daily-cap-name'
import { clickCountIfClickSold, refuseClickUrlWithoutProspectId, refuseSwitchAwayFromClick } from './buyer-profiles'
import { documentToProfile, parseProfileDocument, registryPathOf, validateProfile, type Signal } from '@bidspoke/buyer-profile'
import { parseLiveMissReport, type PartnerPageChange, type PartnerPageVersions } from '@bidspoke/partner-page-live'

type Variables = AuthVariables

interface PartnerBody {
  name?: string
  slug?: string
  api_endpoint?: string
  cf_secret_key?: string
  daily_cap?: number | null
  min_bid?: number | null
  bid_formula?: string | null
  bid_resolver_type?: 'formula' | 'matrix' | 'api'
  bid_resolver_config?: Record<string, unknown>
  outbound_field_mapping?: Record<string, unknown> | null
  bid_comparison_source?: 'auto' | 'api' | 'formula' | 'matrix'
  extra_extraction?: Record<string, unknown> | null
  last_probe_response?: unknown
  dedup_endpoint?: string | null
  response_classification?: unknown
  /** The buyer_select accept rules, beside the decline rules in response_classification (#1412). */
  accept_signals?: unknown
  /** The decline answers that mean the buyer already holds the lead, recorded as Duplicate (#1416). */
  duplicate_signals?: unknown
  /** The Salesforce routing code the prospect patch carries for a sale to this buyer (#1416). */
  external_routing_code?: number | null
  alert_config?: unknown
  circuit_error_threshold?: number
  circuit_window_seconds?: number
  circuit_cooldown_seconds?: number
  circuit_enabled?: boolean
  confirmation_window_ms?: number | null
  is_active?: boolean
  priority?: number
  sell_off_offer_title?: string | null
  sell_off_offer_details?: string | null
  click_url?: string | null
  sub_account_min_bids?: Record<string, number> | null
  partner_type?: PartnerType
}

// #416. A partner may name a worker secret in cf_secret_key; the name is config,
// the value is a binding that may never have been provisioned. #411 made that
// fail loudly on a live lead. This is the preventive half: the same condition,
// reported on the settings surface.
//
// Attached on READ as well as on write, because a missing credential PERSISTS in
// the config (LESSONS L126): a notice living only in the save response would be
// gone by the next visit while the fault stayed.
//
// The presence question is answered by partnerCredentialMissing, which is the
// same predicate the bid path uses to decide whether to make the call, so the
// warning cannot contradict the runtime behaviour (LESSONS L144). The value never
// enters the message; only the key name, which the person already typed.
function credentialWarning(env: Env, row: unknown): string | null {
  const partner = row as { cf_secret_key?: string | null; is_active?: boolean | null; name?: string | null } | null
  const key = partner?.cf_secret_key ?? null
  if (!partnerCredentialMissing(env, key)) return null
  // Distinct causes, distinct messages (LESSONS L11). An inactive partner is not
  // losing leads today, and saying it is would teach the reader to discount the
  // warning on the partner that IS live. The words are the settled design's
  // (PM-23, #2326): where the secret lives and who adds it, since the reader on
  // the partners page cannot set a Worker secret themselves.
  const name = partner?.name?.trim() || 'this partner'
  return partner?.is_active
    ? `${key} is not set as a Worker secret, so ${name}'s next bid will fail. An engineer adds it in Cloudflare.`
    : `${key} is not set as a Worker secret. An engineer adds it in Cloudflare before ${name} is turned on.`
}

function withCredentialWarning<T>(env: Env, row: T): T & { credential_warning: string | null } {
  return { ...(row as object), credential_warning: credentialWarning(env, row) } as T & { credential_warning: string | null }
}

// #306. One refusal shared by POST and PUT, so the create and update paths cannot
// disagree about which partner types exist. Returns the message rather than the
// response so each caller keeps its own status shape.
function partnerTypeRefusal(body: PartnerBody): string | null {
  if (body.partner_type === undefined) return null
  if (isPartnerType(body.partner_type)) return null
  return (
    `Invalid partner_type ${JSON.stringify(body.partner_type)}. ` +
    `Accepted values: ${PARTNER_TYPES.join(', ')}.`
  )
}

// #2182: bid_mode is retired. Nothing acts on it since PM-9 (#2136), and its
// column is dropped (20261016220000_drop_partner_bid_mode_2182.sql). A body
// naming it is refused by name before anything is read, the same answer
// save_partner_config gives a field it may not write, so a stale client is told
// which field to leave out before any database call.
const RETIRED_FIELD = 'bid_mode'
const RETIRED_FIELD_MESSAGE = 'bid_mode is retired: nothing reads it, and its column was removed (#2182). Send the save without it.'
function namesRetiredField(body: object): boolean {
  return Object.prototype.hasOwnProperty.call(body, RETIRED_FIELD)
}

// Derive resolver type from legacy fields when a client posts without bid_resolver_type.
// Mirrors the precedence in bid-resolver.ts::effectiveResolverType so behavior stays bit-identical.
function deriveResolverType(body: PartnerBody): 'formula' | 'matrix' | 'api' {
  if (body.api_endpoint) return 'api'
  if (body.bid_formula) return 'formula'
  return 'api'
}

function deriveResolverConfig(body: PartnerBody): Record<string, unknown> {
  if (!body.api_endpoint && body.bid_formula) {
    return { formula: body.bid_formula }
  }
  return {}
}

/**
 * The answer to a save from a page opened before saves were versioned (#2132).
 * The edits are still on screen; a release can take a few minutes to reach a
 * browser, so the sentence says to wait if it comes back after a reload (L598).
 */
export const RELOAD_REQUIRED_MESSAGE =
  'This page was opened before an update to how partners are saved, so this save was not made. Your changes are still on screen. Copy them and reload. A release can take a few minutes to reach your browser, so if this message comes back after reloading, wait a few minutes and try again.'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The partner fields the partner constants copy is built from (readFromDb in partner-constants-loader.ts). */
const CONSTANTS_FIELDS = ['sell_off_offer_title', 'sell_off_offer_details', 'click_url', 'sub_account_min_bids', 'is_active'] as const

/** The profile rebuild, made to throw when it fails, so copyCleared counts it as not cleared. */
export async function rebuildBuyerProfiles(orgId: string, kv: KVNamespace, supabase: ReturnType<typeof createSupabaseClient>): Promise<void> {
  const snapshot = await refreshBuyerProfilesCache(orgId, kv, supabase)
  if (snapshot === null) throw new Error('the buyer profiles copy could not be rebuilt')
}

/** What a stale version refusal carries (save_partner_config's DETAIL), each part null when absent. */
function staleDetail(detail: string | null): { current: unknown; last_save_id: unknown; changed_by_name: unknown; changed_at: unknown } {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = detail ? JSON.parse(detail) : null
    if (value && typeof value === 'object') parsed = value as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return {
    current: parsed.current ?? null,
    last_save_id: parsed.last_save_id ?? null,
    changed_by_name: parsed.changed_by_name ?? null,
    changed_at: parsed.changed_at ?? null,
  }
}

const partners = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── List ──────────────────────────────────────────────────────────────────────

partners.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('partner_configs')
    .select('*')
    .eq('organization_id', orgId)
    .order('priority', { ascending: true })

  if (error) return dbError(c, error)
  return c.json((data ?? []).map((row) => withCredentialWarning(c.env, row)))
})

// ── Get ───────────────────────────────────────────────────────────────────────

partners.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('partner_configs')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'Partner not found' }, 404)
  return c.json(withCredentialWarning(c.env, data))
})

// ── Create ────────────────────────────────────────────────────────────────────

partners.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<PartnerBody>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)
  if (!body.slug) return c.json({ error: 'slug is required' }, 400)
  const createTypeRefusal = partnerTypeRefusal(body)
  if (createTypeRefusal) return c.json({ error: createTypeRefusal }, 400)
  if (namesRetiredField(body)) return c.json({ error: 'field_not_editable', field: RETIRED_FIELD, message: RETIRED_FIELD_MESSAGE }, 400)

  // slug must be lowercase URL-safe
  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  const { data, error } = await supabase
    .from('partner_configs')
    .insert({
      organization_id: orgId,
      name: body.name,
      slug,
      api_endpoint: body.api_endpoint ?? null,
      cf_secret_key: body.cf_secret_key ?? null,
      daily_cap: body.daily_cap ?? null,
      min_bid: body.min_bid ?? null,
      bid_formula: body.bid_formula ?? null,
      bid_resolver_type: body.bid_resolver_type ?? deriveResolverType(body),
      bid_resolver_config: asJson(body.bid_resolver_config ?? deriveResolverConfig(body)),
      outbound_field_mapping: asJson(body.outbound_field_mapping ?? null),
      bid_comparison_source: body.bid_comparison_source ?? 'auto',
      extra_extraction: asJson(body.extra_extraction ?? null),
      last_probe_response: asJson(body.last_probe_response ?? null),
      dedup_endpoint: body.dedup_endpoint ?? null,
      response_classification: asJson(body.response_classification ?? null),
      alert_config: asJson(body.alert_config ?? null),
      circuit_error_threshold: body.circuit_error_threshold ?? 5,
      circuit_window_seconds: body.circuit_window_seconds ?? 60,
      circuit_cooldown_seconds: body.circuit_cooldown_seconds ?? 300,
      circuit_enabled: body.circuit_enabled ?? true,
      confirmation_window_ms: body.confirmation_window_ms ?? null,
      is_active: body.is_active ?? true,
      priority: body.priority ?? 0,
      partner_type: body.partner_type ?? 'buyer',
      sell_off_offer_title: body.sell_off_offer_title ?? null,
      sell_off_offer_details: body.sell_off_offer_details ?? null,
      click_url: body.click_url ?? null,
      sub_account_min_bids: body.sub_account_min_bids ?? null,
      updated_by: userId,
      updated_by_email: email,
      updated_by_name: c.get('user').name,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return c.json({ error: `Slug "${slug}" already exists` }, 409)
    return dbError(c, error)
  }

  // Audited by the partner_configs table trigger, which records every column's
  // old and new value with updated_by as the actor (#1409). No second row here.

  // A new partner always affects the constants set (subAccountIdsMap / activeBidding),
  // so invalidate unconditionally rather than gating on the copy fields.
  await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  await refreshBuyerProfilesCache(orgId, c.env.WORKFLOW_CACHE, supabase)

  return c.json(withCredentialWarning(c.env, data), 201)
})

// ── Update ────────────────────────────────────────────────────────────────────

partners.put('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const raw = await c.req.json<PartnerBody & { expected_version?: unknown; save_id?: unknown }>()
  const { expected_version: expectedVersion, save_id: saveId, ...body } = raw

  // A save names the version it was edited from and the press that made it
  // (#2132). A page opened before this release sends neither, and its save
  // would write every field it holds over whatever is newer, so it is refused
  // before anything is read, with its edits left on screen (L598).
  if (expectedVersion === undefined || saveId === undefined) {
    return c.json({ error: 'reload_required', message: RELOAD_REQUIRED_MESSAGE }, 428)
  }
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return c.json({ error: 'expected_version_invalid', message: 'expected_version must be a whole number, 0 or more.' }, 400)
  }
  if (typeof saveId !== 'string' || !UUID.test(saveId)) {
    return c.json({ error: 'save_id_invalid', message: 'save_id must be a UUID.' }, 400)
  }

  const updateTypeRefusal = partnerTypeRefusal(body)
  if (updateTypeRefusal) return c.json({ error: updateTypeRefusal }, 400)
  if (namesRetiredField(body)) return c.json({ error: 'field_not_editable', field: RETIRED_FIELD, message: RETIRED_FIELD_MESSAGE }, 400)

  const { data: partner, error: fetchError } = await supabase
    .from('partner_configs')
    .select('id, click_url')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  const fetchBlocked = dbErrorUnlessNotFound(c, fetchError)
  if (fetchBlocked) return fetchBlocked
  if (!partner) return c.json({ error: 'Partner not found' }, 404)

  // An enabled click buyer is offered on this URL, and the offer refuses one
  // without {prospect_id} on every lead (#1561). Judged before any write.
  const clickUrlRefusal = await refuseClickUrlWithoutProspectId(c, supabase, orgId, id, partner.click_url ?? null, body.click_url)
  if (clickUrlRefusal) return clickUrlRefusal

  // Only the keys the body names are written (#2132): a field the page did not
  // send is left exactly as stored. save_partner_config holds the one list of
  // fields a save may write and refuses any other by name; it locks the row,
  // refuses a version that is no longer stored, and the table's trigger audits
  // the change with this actor.
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) if (v !== undefined) patch[k] = v
  const { data, error } = await supabase.rpc('save_partner_config', {
    p_org: orgId,
    p_id: id,
    p_expected_version: expectedVersion,
    p_patch: patch as unknown as Json,
    p_save_id: saveId,
    p_actor: userId,
    p_actor_email: email,
    p_actor_name: c.get('user').name ?? '',
  })
  if (error) {
    const detail = (error as { details?: string | null }).details ?? null
    if (error.code === 'BP409') return c.json({ error: 'stale_version', ...staleDetail(detail) }, 409)
    if (error.code === 'BP422') return c.json({ error: error.message, field: detail }, 400)
    if (error.code === 'P0002') return c.json({ error: 'Partner not found' }, 404) // db-guard-ok: P0002 is the function's own named refusal for no such partner in this org, raised after its locked read, never a transport or query error
    return dbError(c, error)
  }
  const saved = data as unknown as Record<string, unknown>

  // The save is committed. Nothing below may turn it into an error (L33): each
  // stored copy of the old version is refreshed or cleared inside copyCleared,
  // all three run whatever the others did, and any failure answers the save
  // with stored_copy_warning. Nothing durable is written for a retry: the per
  // minute prewarm rewrites the constants copy from the rows within the bound
  // in BIDDING_PICKUP, and the stored copy sweep clears the partner copy once
  // updated_at has moved.
  const affectsConstants = CONSTANTS_FIELDS.some((f) => f in patch)
  // The Partner Bid node bids from a stored copy of this row when the database
  // read fails (#1296). Retired on every edit, so a partner switched off or
  // changed is never bid with as it was in an outage (#1846).
  const retired = await copyCleared(() => retirePartnerLastGood(c.env.WORKFLOW_CACHE, id), `partner copy ${id}`)
  const constantsCleared = affectsConstants
    ? await copyCleared(() => invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE), `partner constants of org ${orgId}`)
    : true
  // The buyer profile snapshot joins the partner row (endpoint, credential name,
  // accept rules, mapping, active flag), so every edit rebuilds it (#1411). The
  // rebuild answers null rather than throwing when it fails, so it is adapted to
  // throw here, or a failed rebuild would read as a cleared copy.
  const profilesRebuilt = await copyCleared(() => rebuildBuyerProfiles(orgId, c.env.WORKFLOW_CACHE, supabase), `buyer profiles of org ${orgId}`)

  return c.json({ ...withCredentialWarning(c.env, saved), ...copyWarning(retired && constantsCleared && profilesRebuilt) })
})

// ── The whole page in one save (#2133) ────────────────────────────────────────

interface PageSaveBody {
  expected_partner_version?: unknown
  patch?: unknown
  expected_profile_version?: unknown
  profile?: unknown
  save_id?: unknown
  /** The browser tab that pressed save (#2135), carried on the page notice so that tab can recognise its own echo. Optional. */
  client_id?: unknown
}

const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Each database refusal of the page save that is about one field, keyed by its
 * code, to that field's validator path, so the form can put it beside its
 * control and registryPathOf can name its registry field. A code missing here
 * (the click cap rule covers three fields) is answered with no field error.
 */
const REFUSAL_PATHS: Readonly<Record<string, string>> = {
  tiers_gap: 'tiers',
  population_not_wired: 'tiers',
  click_buyer_priced: 'tiers',
  sold_on_invalid: 'soldOn',
  sold_on_locked: 'soldOn',
  click_delivery_on_offer_buyer: 'clickDelivery',
  click_delivery_invalid: 'clickDelivery',
  display_time_zone_invalid: 'displayTimeZone',
  collections_max_percent_invalid: 'collectionsMaxPercent',
}

/** The 409 a stale page save is answered with (save_partner_page's DETAIL), each part null when absent. */
function stalePageDetail(detail: string | null): Record<string, unknown> {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = detail ? JSON.parse(detail) : null
    if (isPlainObject(value)) parsed = value
  } catch {
    parsed = {}
  }
  const keys = ['partner', 'profile', 'partner_version', 'profile_version', 'last_save_id', 'changed_by_name', 'changed_at'] as const
  return Object.fromEntries(keys.map((k) => [k, parsed[k] ?? null]))
}

/**
 * PUT /partners/:id/page: the partner record and the buyer profile together
 * (#2133). Who may call it: any allowlisted member of the org, the same as
 * every partner route (jwtAuth). Whose rows it touches: only this org's, since
 * orgId comes from the token and every read and the RPC carry it.
 *
 * Every check the two old routes ran runs first, and the profile is judged
 * against the partner as THIS save leaves it (stored rules overlaid with the
 * patch). Then one call, save_partner_page, writes both halves at the pair of
 * versions the page was edited from, or neither, and records save_id on both
 * rows, so a press resent after a lost answer can tell its own landed save
 * from someone else's by the 409's last_save_id (L747).
 */
partners.put('/:id/page', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<PageSaveBody>()

  if (!isVersion(body.expected_partner_version)) {
    return c.json({ error: 'expected_version_invalid', message: 'expected_partner_version must be a whole number, 0 or more.' }, 400)
  }
  if (typeof body.save_id !== 'string' || !UUID.test(body.save_id)) {
    return c.json({ error: 'save_id_invalid', message: 'save_id must be a UUID.' }, 400)
  }
  const clientId = body.client_id ?? null
  if (clientId !== null && (typeof clientId !== 'string' || !UUID.test(clientId))) {
    return c.json({ error: 'client_id_invalid', message: 'client_id must be a UUID when sent.' }, 400)
  }
  if (!isPlainObject(body.patch)) {
    return c.json({ error: 'patch_invalid', message: 'patch must be an object of the partner fields this save changes.' }, 400)
  }
  const profileSent = body.profile !== undefined && body.profile !== null
  const expectedProfileVersion = body.expected_profile_version ?? null
  // A profile is saved from the version it was edited from; a save that never
  // read the profile may name none, and is then not compared on it.
  if (profileSent ? !isVersion(expectedProfileVersion) : expectedProfileVersion !== null && !isVersion(expectedProfileVersion)) {
    return c.json({ error: 'expected_version_invalid', message: 'expected_profile_version must be a whole number, 0 or more, whenever a profile is saved.' }, 400)
  }

  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body.patch)) if (v !== undefined) patch[k] = v
  const typeRefusal = partnerTypeRefusal(patch as PartnerBody)
  if (typeRefusal) return c.json({ error: typeRefusal }, 400)
  if (namesRetiredField(patch)) {
    const refusal = { code: 'field_not_editable', path: RETIRED_FIELD, field: RETIRED_FIELD, message: RETIRED_FIELD_MESSAGE }
    return c.json({ error: refusal.code, message: RETIRED_FIELD_MESSAGE, errors: [refusal] }, 422)
  }

  const { data: stored, error: fetchError } = await supabase
    .from('partner_configs')
    .select('id, click_url, accept_signals, external_routing_code')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const fetchBlocked = dbErrorUnlessNotFound(c, fetchError)
  if (fetchBlocked) return fetchBlocked
  if (!stored) return c.json({ error: 'Partner not found' }, 404)

  const clickUrlRefusal = await refuseClickUrlWithoutProspectId(c, supabase, orgId, id, stored.click_url ?? null, patch.click_url as string | null | undefined)
  if (clickUrlRefusal) return clickUrlRefusal

  let profileToSave: Record<string, unknown> | null = null
  if (profileSent) {
    const parsed = parseProfileDocument(body.profile)
    if (!parsed.ok) return c.json({ error: 'profile_malformed', errors: parsed.errors }, 400)
    const profile = documentToProfile({ ...parsed.document, partner_id: id })
    // The partner rules as this save leaves them, so a rule added or removed in
    // the same save is the one the profile is judged against.
    const merged = { ...stored, ...patch } as { accept_signals?: unknown; click_url?: unknown; external_routing_code?: unknown }
    const validation = validateProfile(profile, {
      acceptSignals: Array.isArray(merged.accept_signals) ? (merged.accept_signals as Signal[]) : [],
      clickUrl: typeof merged.click_url === 'string' ? merged.click_url : null,
      externalRoutingCode: typeof merged.external_routing_code === 'number' ? merged.external_routing_code : null,
    })
    if (!validation.ok) {
      const routeNames = profile.clickDelivery?.routes.map((r) => r.name) ?? []
      return c.json({ error: 'profile_invalid', errors: validation.errors.map((e) => ({ ...e, field: registryPathOf(e.path, routeNames) })) }, 422)
    }
    const inUse = await refuseSwitchAwayFromClick(c, supabase, orgId, id, profile.soldOn)
    if (inUse) return inUse
    const { partner_id: _partner, version: _version, ...rest } = parsed.document
    profileToSave = rest as Record<string, unknown>
  }

  const { data, error } = await supabase.rpc('save_partner_page', {
    p_org: orgId,
    p_partner_id: id,
    p_expected_partner_version: body.expected_partner_version,
    p_patch: patch as unknown as Json,
    // The generated types make every argument required and non null; the
    // function takes NULL here for a save that never read the profile.
    p_expected_profile_version: expectedProfileVersion as number,
    p_profile: profileToSave as unknown as Json,
    p_save_id: body.save_id,
    // The generated types make every argument non null; the function takes
    // NULL for a page that names no tab.
    p_client_id: clientId as string,
    p_actor: userId,
    p_actor_email: email,
    p_actor_name: c.get('user').name ?? '',
  })
  if (error) {
    const detail = (error as { details?: string | null }).details ?? null
    if (error.code === 'BP409') return c.json({ error: 'stale_version', ...stalePageDetail(detail) }, 409)
    if (error.code === 'BP422') {
      const code = error.message
      const path = code === 'field_not_editable' ? detail : REFUSAL_PATHS[code] ?? null
      const field = code === 'field_not_editable' ? detail : path ? registryPathOf(path) : null
      return c.json({ error: code, message: detail ?? code, errors: path && field ? [{ code, path, field, message: detail ?? code }] : [] }, 422)
    }
    if (error.code === 'P0002') return c.json({ error: 'Partner not found' }, 404) // db-guard-ok: P0002 is the function's own named refusal for no such partner in this org, raised after its locked read, never a transport or query error
    return dbError(c, error)
  }
  const saved = data as unknown as { partner: Record<string, unknown>; profile: unknown; partner_version: number; profile_version: number }

  // Committed. Nothing below may turn it into an error (L33): each stored copy
  // is refreshed or cleared inside copyCleared, all three run whatever the
  // others did, and any failure answers 200 with stored_copy_warning.
  const affectsConstants = CONSTANTS_FIELDS.some((f) => f in patch)
  const retired = await copyCleared(() => retirePartnerLastGood(c.env.WORKFLOW_CACHE, id), `partner copy ${id}`)
  const constantsCleared = affectsConstants
    ? await copyCleared(() => invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE), `partner constants of org ${orgId}`)
    : true
  const profilesRebuilt = await copyCleared(() => rebuildBuyerProfiles(orgId, c.env.WORKFLOW_CACHE, supabase), `buyer profiles of org ${orgId}`)

  return c.json({
    partner: withCredentialWarning(c.env, saved.partner),
    profile: saved.profile ?? null,
    partner_version: saved.partner_version,
    profile_version: saved.profile_version,
    ...copyWarning(retired && constantsCleared && profilesRebuilt),
  })
})

// ── Delete ────────────────────────────────────────────────────────────────────
// DELETE /partners/:id and its check live in partner-delete.ts (#2140).

// ── The live channel's versions probe and its misses (#2135) ──────────────────

interface AuditRow {
  changed_at: string
  changed_by: string | null
  changes: unknown
}

/**
 * One audit row as the page reads it. Direct means the row the audit triggers
 * write for a change with no actor (`_source: direct_sql`), the one predicate
 * both triggers use. Fields: the keys whose value is an `{ old, new }` pair, or,
 * for a profile table's hand write, the table it touched.
 */
function pageChange(row: AuditRow | undefined): PartnerPageChange | null {
  if (!row) return null
  const changes = isPlainObject(row.changes) ? row.changes : {}
  const direct = changes._source === 'direct_sql'
  const pairs = Object.entries(changes)
    .filter(([k, v]) => !k.startsWith('_') && isPlainObject(v) && ('old' in v || 'new' in v))
    .map(([k]) => k)
  const fields = pairs.length === 0 && direct && typeof changes.table === 'string' ? [changes.table] : pairs.sort()
  return { changedAt: row.changed_at, direct, fields }
}

/**
 * GET /partners/:id/versions: the page's delivery probe, every 60 seconds
 * while a draft is dirty, and its read of the newest change of each half on
 * open and on every refetch. Who may call: any allowlisted member of the org
 * (jwtAuth). Whose rows: this org's only; every read carries orgId. Four small
 * reads by key, each answered by an index (audit_log by idx_audit_entity).
 */
partners.get('/:id/versions', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: partner, error: partnerError } = await supabase
    .from('partner_configs')
    .select('id, version, last_save_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, partnerError)
  if (blocked) return blocked
  if (!partner) return c.json({ error: 'Partner not found' }, 404)

  const newestAudit = (entityType: 'partner_config' | 'buyer_profile') =>
    supabase
      .from('audit_log')
      .select('changed_at, changed_by, changes')
      .eq('organization_id', orgId)
      .eq('entity_type', entityType)
      .eq('entity_id', id)
      .order('changed_at', { ascending: false })
      .limit(1)
  let profile: Awaited<ReturnType<typeof readBuyerProfileVersion>>
  let partnerAudit: Awaited<ReturnType<typeof newestAudit>>
  let profileAudit: Awaited<ReturnType<typeof newestAudit>>
  try {
    ;[profile, partnerAudit, profileAudit] = await Promise.all([
      readBuyerProfileVersion(supabase, orgId, id),
      newestAudit('partner_config'),
      newestAudit('buyer_profile'),
    ])
  } catch (e) {
    return dbError(c, e)
  }
  for (const read of [partnerAudit, profileAudit]) {
    if (read.error) return dbError(c, read.error)
  }

  const row = partner
  const newest = {
    partner: pageChange(((partnerAudit.data ?? []) as unknown as AuditRow[])[0]),
    profile: pageChange(((profileAudit.data ?? []) as unknown as AuditRow[])[0]),
  }
  const latest = (['partner', 'profile'] as const)
    .flatMap((section) => (newest[section] ? [{ section, ...newest[section] }] : []))
    .sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))[0] ?? null

  const body: PartnerPageVersions = {
    partnerId: row.id,
    partnerVersion: row.version,
    profileVersion: profile?.version ?? 0,
    lastSaveId: row.last_save_id,
    profileLastSaveId: profile?.lastSaveId ?? null,
    latestChange: latest,
    newest,
  }
  return c.json(body)
})

/**
 * POST /partners/live-miss: a page's probe found a version it heard no notice
 * of. Recorded, never alerted on: no miss threshold has been measured, and the
 * issue that sets one from these rows is filed with #2135 (L65). Who may call:
 * any allowlisted member of the org. Whose rows: a partner of this org only,
 * recorded against this org and the person whose page saw it.
 */
partners.post('/live-miss', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    raw = null
  }
  const parsed = parseLiveMissReport(raw)
  if (!parsed.ok) return c.json({ error: 'live_miss_invalid', field: parsed.field }, 400)
  const report = parsed.report

  const { data: partner, error: partnerError } = await supabase
    .from('partner_configs')
    .select('id')
    .eq('id', report.partnerId)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, partnerError)
  if (blocked) return blocked
  if (!partner) return c.json({ error: 'Partner not found' }, 404)

  const { data, error } = await supabase
    .from('partner_page_live_misses')
    .insert({
      organization_id: orgId,
      partner_id: report.partnerId,
      reported_by: userId,
      cause: report.cause,
      noticed_partner_version: report.noticed.partnerVersion,
      noticed_profile_version: report.noticed.profileVersion,
      observed_partner_version: report.observed.partnerVersion,
      observed_profile_version: report.observed.profileVersion,
      since_last_notice_ms: report.sinceLastNoticeMs,
    })
    .select('id')
    .single()
  if (error) return dbError(c, error)
  return c.json({ ok: true, id: data.id }, 201)
})

// ── Today's cap count from the Durable Object ─────────────────────────────────

partners.get('/:id/cap-count', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('partner_configs')
    .select('slug')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'Partner not found' }, 404)

  // A click sold buyer is never counted by this object (#1541): its zero would
  // read as no clicks today, so it answers with the click counter instead (#1543).
  const clickAnswer = await clickCountIfClickSold(c, supabase, orgId, id)
  if (clickAnswer) return clickAnswer

  // The Eastern day, through the one derivation the Partner Bid node also uses
  // (#1410). The date comes back so the caller can say which day was counted.
  const { name, date } = dailyCapObjectName(data.slug, Date.now())
  const stub = c.env.DAILY_CAP.get(c.env.DAILY_CAP.idFromName(name))
  const res = await stub.fetch('http://do/get-count')
  const { count } = await res.json<{ count: number }>()

  return c.json({ count, date })
})

export default partners
