/**
 * Partner management API — PRD Section 2.1
 * CRUD for partner_configs. Daily cap count comes from the DailyCapDO.
 */
import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'
import { invalidatePartnerConstantsCache } from '../../lib/partner-constants-loader'

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
  partner_type?: 'source' | 'buyer'
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

  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// ── Get ───────────────────────────────────────────────────────────────────────

partners.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('partner_configs')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (error || !data) return c.json({ error: 'Partner not found' }, 404)
  return c.json(data)
})

// ── Create ────────────────────────────────────────────────────────────────────

partners.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<PartnerBody>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)
  if (!body.slug) return c.json({ error: 'slug is required' }, 400)

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
      bid_resolver_config: body.bid_resolver_config ?? deriveResolverConfig(body),
      outbound_field_mapping: body.outbound_field_mapping ?? null,
      bid_mode: body.bid_mode ?? 'commit',
      bid_comparison_source: body.bid_comparison_source ?? 'auto',
      extra_extraction: body.extra_extraction ?? null,
      last_probe_response: body.last_probe_response ?? null,
      dedup_endpoint: body.dedup_endpoint ?? null,
      response_classification: body.response_classification ?? null,
      alert_config: body.alert_config ?? null,
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
    return c.json({ error: error.message }, 500)
  }

  await writeAuditLog(supabase, orgId, 'partner_config', data.id, 'created', userId, {
    name: body.name,
    slug,
  })

  if (body.sell_off_offer_title || body.sell_off_offer_details || body.click_url || body.sub_account_min_bids) {
    await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  }

  return c.json(data, 201)
})

// ── Update ────────────────────────────────────────────────────────────────────

partners.put('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<PartnerBody>()

  const { error: fetchError } = await supabase
    .from('partner_configs')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (fetchError) return c.json({ error: 'Partner not found' }, 404)

  const updates: Record<string, unknown> = {
    updated_by: userId,
    updated_by_email: email,
    updated_by_name: c.get('user').name,
  }

  const fields: (keyof PartnerBody)[] = [
    'name', 'api_endpoint', 'cf_secret_key', 'daily_cap', 'min_bid',
    'bid_formula', 'bid_resolver_type', 'bid_resolver_config', 'outbound_field_mapping',
    'bid_mode', 'bid_comparison_source', 'extra_extraction', 'last_probe_response',
    'dedup_endpoint', 'response_classification', 'alert_config',
    'circuit_error_threshold', 'circuit_window_seconds', 'circuit_cooldown_seconds',
    'circuit_enabled', 'confirmation_window_ms', 'is_active', 'priority',
    'sell_off_offer_title', 'sell_off_offer_details',
    'click_url', 'partner_type', 'sub_account_min_bids',
  ]
  for (const f of fields) {
    if (body[f] !== undefined) updates[f] = body[f]
  }

  const { data, error } = await supabase
    .from('partner_configs')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(supabase, orgId, 'partner_config', id, 'updated', userId, {
    changed_fields: Object.keys(updates).filter((k) => k !== 'updated_by' && k !== 'updated_by_email' && k !== 'updated_by_name'),
  })

  const affectsConstants =
    'sell_off_offer_title' in updates ||
    'sell_off_offer_details' in updates ||
    'click_url' in updates ||
    'sub_account_min_bids' in updates
  if (affectsConstants) {
    await invalidatePartnerConstantsCache(orgId, c.env.WORKFLOW_CACHE)
  }

  return c.json(data)
})

// ── Delete ────────────────────────────────────────────────────────────────────

partners.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  // Fetch slug for audit log before deleting
  const { data: existing } = await supabase
    .from('partner_configs')
    .select('slug, name')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!existing) return c.json({ error: 'Partner not found' }, 404)

  const { error } = await supabase
    .from('partner_configs')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(supabase, orgId, 'partner_config', id, 'deleted', userId, {
    name: existing.name,
    slug: existing.slug,
  })

  return c.json({ ok: true })
})

// ── Today's cap count from the Durable Object ─────────────────────────────────

partners.get('/:id/cap-count', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id') as string
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('partner_configs')
    .select('slug')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (error || !data) return c.json({ error: 'Partner not found' }, 404)

  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD UTC
  const doId = c.env.DAILY_CAP.idFromName(`cap-${data.slug}-${today}`)
  const stub = c.env.DAILY_CAP.get(doId)
  const res = await stub.fetch('http://do/get-count')
  const { count } = await res.json<{ count: number }>()

  return c.json({ count, date: today })
})

export default partners
