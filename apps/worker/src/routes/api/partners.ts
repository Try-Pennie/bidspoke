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
import { refreshBuyerProfilesCache } from '../../lib/buyer-profile-loader'
import { retirePartnerLastGood } from '../../lib/partner-last-good'
import { COPY_NOT_CLEARED_MESSAGE, copyCleared } from '../../lib/endpoint-copies'
import { asJson } from '../../lib/json'
import type { Database } from '../../types/database'
import { PARTNER_TYPES, isPartnerType, type PartnerType } from '../../lib/partner-roles'
import { partnerCredentialMissing } from '../../lib/partner-credential'
import { dailyCapObjectName } from '../../lib/daily-cap-name'
import { clickCountIfClickSold, refuseClickUrlWithoutProspectId } from './buyer-profiles'

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
  bid_mode?: 'commit' | 'ping_only'
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
  const partner = row as { cf_secret_key?: string | null; is_active?: boolean | null } | null
  const key = partner?.cf_secret_key ?? null
  if (!partnerCredentialMissing(env, key)) return null
  // Distinct causes, distinct messages (LESSONS L11). An inactive partner is not
  // losing leads today, and saying it is would teach the reader to discount the
  // warning on the partner that IS live.
  return partner?.is_active
    ? `Credential '${key}' is not set, so this partner will fail on the next live lead.`
    : `Credential '${key}' is not set. Set it before activating this partner.`
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
      bid_mode: body.bid_mode ?? 'commit',
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
  const body = await c.req.json<PartnerBody>()

  const updateTypeRefusal = partnerTypeRefusal(body)
  if (updateTypeRefusal) return c.json({ error: updateTypeRefusal }, 400)

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

  const updates: Database['public']['Tables']['partner_configs']['Update'] = {
    updated_by: userId,
    updated_by_email: email,
    updated_by_name: c.get('user').name,
  }

  const fields: (keyof PartnerBody)[] = [
    'name', 'api_endpoint', 'cf_secret_key', 'daily_cap', 'min_bid',
    'bid_formula', 'bid_resolver_type', 'bid_resolver_config', 'outbound_field_mapping',
    'bid_mode', 'bid_comparison_source', 'extra_extraction', 'last_probe_response',
    'dedup_endpoint', 'response_classification', 'accept_signals', 'duplicate_signals', 'external_routing_code', 'alert_config',
    'circuit_error_threshold', 'circuit_window_seconds', 'circuit_cooldown_seconds',
    'circuit_enabled', 'confirmation_window_ms', 'is_active', 'priority',
    'sell_off_offer_title', 'sell_off_offer_details',
    'click_url', 'partner_type', 'sub_account_min_bids',
  ]
  for (const f of fields) {
    if (body[f] !== undefined) (updates as Record<string, unknown>)[f] = body[f]
  }

  const { data, error } = await supabase
    .from('partner_configs')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  const updateBlocked = dbErrorUnlessNotFound(c, error)
  if (updateBlocked) return updateBlocked
  if (!data) return c.json({ error: 'Partner not found' }, 404)

  // Audited by the partner_configs table trigger: the statement sets updated_by,
  // which the trigger reads as the actor, and it records each changed column's
  // old and new value rather than a list of names (#1409).

  const affectsConstants =
    'sell_off_offer_title' in updates ||
    'sell_off_offer_details' in updates ||
    'click_url' in updates ||
    'sub_account_min_bids' in updates ||
    'is_active' in updates
  if (affectsConstants) {
    await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  }
  // The buyer profile snapshot joins the partner row (endpoint, credential name,
  // accept rules, mapping, active flag), so every edit refreshes it (#1411).
  await refreshBuyerProfilesCache(orgId, c.env.WORKFLOW_CACHE, supabase)

  // The Partner Bid node bids from a stored copy of this row when the database
  // read fails (#1296). Retired on every edit, so a partner switched off or
  // changed is never bid with as it was in an outage (#1846). Last, after the
  // other refreshes, so a failure here leaves nothing else stale.
  if (!(await copyCleared(() => retirePartnerLastGood(c.env.WORKFLOW_CACHE, id), `partner copy ${id}`))) return c.json({ error: COPY_NOT_CLEARED_MESSAGE }, 500)

  return c.json(withCredentialWarning(c.env, data))
})

// ── Delete ────────────────────────────────────────────────────────────────────

partners.delete('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  // The delete goes through delete_partner_config (#1409): a delete sets no
  // column, so the table's audit trigger cannot see who did it from the row, and
  // the function carries the actor in for it. The function refuses by name: P0002
  // when there is no such partner in this org (a row that raced away, or another
  // org's, #588, #303), BP023 when sales still reference it, with the detail
  // naming the blocking table. A real database error surfaces as a 500.
  const { error } = await supabase.rpc('delete_partner_config', {
    p_org: orgId,
    p_id: id,
    p_actor: userId,
    p_actor_email: email,
  })
  if (error) {
    if (error.code === 'P0002') return c.json({ error: 'Partner not found' }, 404) // db-guard-ok: P0002 is the function's own named refusal for no such partner in this org, raised after the lookup, never a transport or query error
    if (error.code === 'BP023') {
      const detail = (error as { details?: string | null }).details ?? ''
      return c.json({ error: `Partner cannot be deleted while other records refer to it. ${detail}`.trim() }, 409)
    }
    return dbError(c, error)
  }

  await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  await refreshBuyerProfilesCache(orgId, c.env.WORKFLOW_CACHE, supabase)

  // A deleted partner must never bid from its stored copy in an outage (#1846).
  // Last, after the other refreshes, so a failure here leaves nothing else stale.
  if (!(await copyCleared(() => retirePartnerLastGood(c.env.WORKFLOW_CACHE, id), `partner copy ${id}`))) return c.json({ error: COPY_NOT_CLEARED_MESSAGE }, 500)

  return c.json({ ok: true })
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

