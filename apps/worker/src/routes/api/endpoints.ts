/**
 * Webhook endpoints API — CRUD for custom partner endpoint mappings.
 *
 * GET    /api/endpoints          — list all org endpoints (includes workflow name)
 * POST   /api/endpoints          — create endpoint
 * PUT    /api/endpoints/:id      — update endpoint (invalidates KV cache)
 * DELETE /api/endpoints/:id      — delete endpoint (invalidates KV cache)
 */

import { Hono } from 'hono'
import { dbError, isNotFoundError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

interface EndpointBody {
  subdomain?: string
  path?: string
  workflow_id?: string
  source_name?: string
  is_active?: boolean
}

// Matches valid DNS label: lowercase alphanumeric + hyphens, no leading/trailing hyphen
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
// Only lowercase letters, numbers, hyphens, underscores, slashes
const PATH_RE = /^\/[a-z0-9\-_/]*$/
const RESERVED_SUBDOMAINS = new Set([
  'bidspoke', 'worker', 'api', 'app', 'www', 'mail', 'admin',
  'staging', 'dev', 'localhost', 'smtp', 'pop', 'imap', 'ftp',
])

function validateSubdomain(sub: string): string | null {
  if (!SUBDOMAIN_RE.test(sub)) return 'Subdomain must be lowercase letters, numbers, and hyphens only'
  if (RESERVED_SUBDOMAINS.has(sub)) return `"${sub}" is reserved`
  return null
}

// Normalize a webhook path. Strips leading/trailing slashes and lowercases.
// An empty input becomes '/' — the marker for a single-segment endpoint
// (URL is hook.trypennie.dev/<subdomain> with no second path segment).
function normalizePath(raw: string): string {
  const stripped = raw.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
  return stripped === '' ? '/' : '/' + stripped
}

function validatePath(path: string): string | null {
  if (!PATH_RE.test(path)) return 'Path must start with / and contain only letters, numbers, hyphens, underscores, and slashes'
  if (path.length > 64) return 'Path must be 64 characters or less'
  return null
}

function cacheKey(subdomain: string, path: string): string {
  return `ep:${subdomain}:${path}`
}

const endpoints = new Hono<{ Bindings: Env; Variables: Variables }>()

// ── List ──────────────────────────────────────────────────────────────────────

endpoints.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('webhook_endpoints')
    .select('id, subdomain, path, workflow_id, source_name, is_active, created_at, updated_at, workflows(name)')
    .eq('organization_id', orgId)
    .order('subdomain')
    .order('path')

  if (error) return dbError(c, error)

  // Flatten the workflows join (Supabase returns the related row as an array)
  const rows = (data ?? []).map((row) => {
    const wf = Array.isArray(row.workflows) ? row.workflows[0] : row.workflows
    return {
      ...row,
      workflow_name: (wf as { name: string } | null | undefined)?.name ?? null,
      workflows: undefined,
    }
  })

  return c.json(rows)
})

// ── Create ────────────────────────────────────────────────────────────────────

endpoints.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await c.req.json<EndpointBody>()

  if (!body.subdomain) return c.json({ error: 'subdomain is required' }, 400)
  if (!body.workflow_id) return c.json({ error: 'workflow_id is required' }, 400)
  if (!body.source_name) return c.json({ error: 'source_name is required' }, 400)

  const subdomain = body.subdomain.trim().toLowerCase()
  // Empty path = single-segment endpoint (hook.trypennie.dev/<subdomain>).
  // Non-empty path = two-segment (hook.trypennie.dev/<subdomain>/<path>).
  const path = normalizePath(body.path?.trim() ?? '')
  const source_name = body.source_name.trim().toLowerCase().replace(/\s+/g, '_')

  const subErr = validateSubdomain(subdomain)
  if (subErr) return c.json({ error: subErr }, 400)

  const pathErr = validatePath(path)
  if (pathErr) return c.json({ error: pathErr }, 400)

  const supabase = createSupabaseClient(c.env)

  // Verify the workflow belongs to this org — the service-role key bypasses RLS,
  // so without this an org-A caller could publish a public endpoint that
  // executes an org-B workflow (with org B's env vars/secrets at runtime).
  const { data: ownWf, error: ownWfError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', body.workflow_id)
    .eq('organization_id', orgId)
    .is('deleted_at', null)
    .single()
  // PGRST116 = not found / not this org (→ 404). A real error must not be
  // reported as 404, which would block a legitimate publish (#303).
  if (ownWfError && !isNotFoundError(ownWfError)) return dbError(c, ownWfError)
  if (!ownWf) return c.json({ error: 'Workflow not found' }, 404)

  const { data, error } = await supabase
    .from('webhook_endpoints')
    .insert({
      organization_id: orgId,
      subdomain,
      path,
      workflow_id: body.workflow_id,
      source_name,
      is_active: body.is_active ?? true,
    })
    .select('id, subdomain, path, workflow_id, source_name, is_active, created_at, updated_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return c.json({ error: `An endpoint already exists at ${subdomain}.trypennie.dev${path}` }, 409)
    }
    return dbError(c, error)
  }

  await writeAuditLog(supabase, orgId, 'webhook_endpoint', data.id, 'created', userId, {
    subdomain,
    path,
    action: 'webhook_endpoint_created',
  })

  return c.json(data, 201)
})

// ── Update ────────────────────────────────────────────────────────────────────

endpoints.put('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const body = await c.req.json<EndpointBody>()
  const supabase = createSupabaseClient(c.env)

  // Fetch existing to get current subdomain+path for cache invalidation
  const { data: existing, error: existingError } = await supabase
    .from('webhook_endpoints')
    .select('subdomain, path')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (existingError && !isNotFoundError(existingError)) return dbError(c, existingError)
  if (!existing) return c.json({ error: 'Endpoint not found' }, 404)

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (body.subdomain !== undefined) {
    const sub = body.subdomain.trim().toLowerCase()
    const err = validateSubdomain(sub)
    if (err) return c.json({ error: err }, 400)
    updates.subdomain = sub
  }
  if (body.path !== undefined) {
    const p = normalizePath(body.path.trim())
    const err = validatePath(p)
    if (err) return c.json({ error: err }, 400)
    updates.path = p
  }
  if (body.workflow_id !== undefined) {
    // Re-pointing the endpoint at a different workflow must stay within the org.
    const { data: ownWf, error: ownWfError } = await supabase
      .from('workflows')
      .select('id')
      .eq('id', body.workflow_id)
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .single()
    if (ownWfError && !isNotFoundError(ownWfError)) return dbError(c, ownWfError)
    if (!ownWf) return c.json({ error: 'Workflow not found' }, 404)
    updates.workflow_id = body.workflow_id
  }
  if (body.source_name !== undefined) {
    updates.source_name = body.source_name.trim().toLowerCase().replace(/\s+/g, '_')
  }
  if (body.is_active !== undefined) updates.is_active = body.is_active

  const { data, error } = await supabase
    .from('webhook_endpoints')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, subdomain, path, workflow_id, source_name, is_active, created_at, updated_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return c.json({ error: 'An endpoint already exists at that subdomain + path' }, 409)
    }
    return dbError(c, error)
  }

  // Invalidate KV cache for old and new subdomain+path
  const oldKey = cacheKey(existing.subdomain, existing.path)
  const newSub = (updates.subdomain as string | undefined) ?? existing.subdomain
  const newPath = (updates.path as string | undefined) ?? existing.path
  const newKey = cacheKey(newSub, newPath)

  await c.env.WORKFLOW_CACHE.delete(oldKey)
  if (newKey !== oldKey) await c.env.WORKFLOW_CACHE.delete(newKey)

  await writeAuditLog(supabase, orgId, 'webhook_endpoint', id, 'updated', userId, {
    action: 'webhook_endpoint_updated',
  })

  return c.json(data)
})

// ── Delete ────────────────────────────────────────────────────────────────────

endpoints.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: existing, error: existingError } = await supabase
    .from('webhook_endpoints')
    .select('subdomain, path')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (existingError && !isNotFoundError(existingError)) return dbError(c, existingError)
  if (!existing) return c.json({ error: 'Endpoint not found' }, 404)

  const { error } = await supabase
    .from('webhook_endpoints')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) return dbError(c, error)

  await c.env.WORKFLOW_CACHE.delete(cacheKey(existing.subdomain, existing.path))

  await writeAuditLog(supabase, orgId, 'webhook_endpoint', id, 'deleted', userId, {
    subdomain: existing.subdomain,
    path: existing.path,
    action: 'webhook_endpoint_deleted',
  })

  return c.json({ ok: true })
})

export default endpoints
