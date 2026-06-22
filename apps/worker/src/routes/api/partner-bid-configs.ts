/**
 * Partner Bid Configs (matrix definitions) — CRUD + manual sync trigger.
 *
 * One config owns one matrix. Multiple configs may belong to the same partner;
 * exactly one is_default. Rows live in bid_matrix_rows.
 */
import { Hono } from 'hono'
import { dbError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'
import { syncBidConfig } from '../../lib/bid-matrix-sync'
import { fetchAllPaged } from '../../lib/paginate'
import { asJson } from '../../lib/json'

type Variables = AuthVariables

interface BidConfigBody {
  partner_id?: string
  slug?: string
  name?: string
  is_default?: boolean
  is_active?: boolean
  sync_source?: 'salesforce' | 'manual'
  sf_object?: string | null
  sf_filters?: Record<string, unknown> | null
  dimensions?: Array<{ name: string; payload_field: string; column: 'row' | 'range' }>
}

const route = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── List ──────────────────────────────────────────────────────────────────────

route.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const partnerId = c.req.query('partner_id')

  let query = supabase
    .from('partner_bid_configs')
    .select('id, partner_id, slug, name, is_default, is_active, sync_source, sf_object, sf_filters, dimensions, last_synced_at, last_sync_error, created_at, updated_at, updated_by_email, updated_by_name')
    .eq('organization_id', orgId)
    .order('partner_id', { ascending: true })
    .order('is_default', { ascending: false })

  if (partnerId) query = query.eq('partner_id', partnerId)

  const { data, error } = await query
  if (error) return dbError(c, error)
  return c.json(data)
})

// ── Get one (with rows) ───────────────────────────────────────────────────────

route.get('/:id', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: config, error } = await supabase
    .from('partner_bid_configs')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (error || !config) return c.json({ error: 'Config not found' }, 404)

  // Page the full matrix — a fine-grained matrix (score bands × debt bands ×
  // sell-off) can exceed the 1,000-row PostgREST cap, which would silently
  // truncate the matrix shown in the viewer. The engine's matrix lookup pages
  // this same read for the same reason (#185).
  const rows = await fetchAllPaged<Record<string, unknown>>(
    (from, to) => supabase
      .from('bid_matrix_rows')
      .select('id, is_sell_off, row_id, row_low, row_high, range_low, range_high, bid_amount, source_synced_at')
      .eq('config_id', id)
      .order('is_sell_off', { ascending: true })
      .order('row_low', { ascending: true })
      .order('range_low', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    'partner matrix rows',
  )

  return c.json({ config, rows })
})

// ── Create ────────────────────────────────────────────────────────────────────

route.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<BidConfigBody>()

  if (!body.partner_id) return c.json({ error: 'partner_id is required' }, 400)
  if (!body.slug) return c.json({ error: 'slug is required' }, 400)
  if (!body.name) return c.json({ error: 'name is required' }, 400)

  const slug = body.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')

  const { data, error } = await supabase
    .from('partner_bid_configs')
    .insert({
      organization_id: orgId,
      partner_id: body.partner_id,
      slug,
      name: body.name,
      is_default: body.is_default ?? false,
      is_active: body.is_active ?? true,
      sync_source: body.sync_source ?? 'salesforce',
      sf_object: body.sf_object ?? null,
      sf_filters: asJson(body.sf_filters ?? null),
      dimensions: asJson(body.dimensions ?? []),
      updated_by: userId,
      updated_by_email: email,
      updated_by_name: c.get('user').name,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return c.json({ error: 'Slug already exists for this partner' }, 409)
    return dbError(c, error)
  }

  await writeAuditLog(supabase, orgId, 'partner_bid_config', data.id, 'created', userId, { slug, name: body.name })
  return c.json(data, 201)
})

// ── Update ────────────────────────────────────────────────────────────────────

route.put('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<BidConfigBody>()

  const { error: fetchErr } = await supabase
    .from('partner_bid_configs')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (fetchErr) return c.json({ error: 'Config not found' }, 404)

  const updates: Record<string, unknown> = {
    updated_by: userId,
    updated_by_email: email,
    updated_by_name: c.get('user').name,
    updated_at: new Date().toISOString(),
  }
  const fields: (keyof BidConfigBody)[] = [
    'name', 'is_default', 'is_active', 'sync_source', 'sf_object', 'sf_filters', 'dimensions',
  ]
  for (const f of fields) {
    if (body[f] !== undefined) updates[f] = body[f]
  }

  const { data, error } = await supabase
    .from('partner_bid_configs')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) return dbError(c, error)
  await writeAuditLog(supabase, orgId, 'partner_bid_config', id, 'updated', userId, {
    changed_fields: Object.keys(updates).filter((k) => !k.startsWith('updated_')),
  })
  return c.json(data)
})

// ── Delete ────────────────────────────────────────────────────────────────────

route.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: existing } = await supabase
    .from('partner_bid_configs')
    .select('slug, name')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (!existing) return c.json({ error: 'Config not found' }, 404)

  const { error } = await supabase
    .from('partner_bid_configs')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) return dbError(c, error)
  await writeAuditLog(supabase, orgId, 'partner_bid_config', id, 'deleted', userId, existing)
  return c.json({ ok: true })
})

// ── Sync now ──────────────────────────────────────────────────────────────────

route.post('/:id/sync', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: existing, error: fetchErr } = await supabase
    .from('partner_bid_configs')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (fetchErr || !existing) return c.json({ error: 'Config not found' }, 404)

  try {
    const result = await syncBidConfig(id, c.env, supabase)
    return c.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return c.json({ error: message }, 500)
  }
})

// ── History ───────────────────────────────────────────────────────────────────

route.get('/:id/history', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { error: fetchErr } = await supabase
    .from('partner_bid_configs')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (fetchErr) return c.json({ error: 'Config not found' }, 404)

  const { data, error } = await supabase
    .from('bid_config_history')
    .select('id, changed_at, changed_by, source, diff')
    .eq('config_id', id)
    .order('changed_at', { ascending: false })
    .limit(50)

  if (error) return dbError(c, error)
  return c.json(data)
})

export default route
