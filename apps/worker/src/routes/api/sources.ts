// Source API key management
// GET    /api/sources        — list sources, including the full api_key. Keys are
//                              org-scoped (a user only sees their own org's) and
//                              power the Sources page reveal/copy + curl example.
//                              Intra-org visibility is acceptable for this team.
// POST   /api/sources        — create new source, returns the new api_key
// DELETE /api/sources/:name  (revokes the key of a source; one per name, as api_sources is UNIQUE organization_id, name)

import { Hono } from 'hono'
import type { Context } from 'hono'
import { dbError, isNotFoundError, requireRowOr404, rowsTouched } from '../../lib/api-error'
import { fetchAllPaged, fetchUpTo } from '../../lib/paginate'
import { CONFIG_LIST_BOUNDS } from '../../lib/config-list-bounds'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { setCfSecret } from '../../lib/cf-secrets'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'
import { isNoRowMatchedError, requireRowsAffected } from '../../lib/db-retry'
import { formatErr } from '../../lib/format-error'

type Variables = AuthVariables

const sources = new Hono<{ Bindings: Env; Variables: Variables }>()

function parseKeyMap(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

// Rebuild the global API_KEY_MAP from the api_sources table (the authoritative
// record of every UI-managed key) rather than read-modify-writing the c.env
// snapshot. The snapshot is point-in-time, so two concurrent mutations — or one
// issued before a prior setCfSecret reaches the isolate — would clobber each
// other and silently drop an unrelated source's key. Deriving from the table on
// every mutation makes each write reflect the current DB state.
//
// Keys present in the live secret but NOT in the table (manually-seeded keys,
// which have no org association and can't live in api_sources) are preserved.
// `removeKeys` drops specific keys from the result even though they may still be
// in the table — used on delete to revoke the key before the row is removed.
//
// Returns the error rather than a map when the read fails, and the callers must
// not write on that path. A discarded error here was not a missing map, it was a
// WRONG one: `data` comes back null, every key in the table drops out of
// `dbMap`, every key in the live secret is "preserved" instead, and the result
// is precisely the point-in-time snapshot the comment above says this function
// exists to avoid. Writing it answered 200 while the change the operator asked
// for (a new source's key) never reached production (L12, #877).
//
// When `api_sources` gains `deleted_at`, the select needs `.is('deleted_at',
// null)`: an unfiltered read returns tombstoned rows, so the next mutation
// merges a revoked partner key back into the live secret and re-authorises a
// source somebody deliberately cut off. The column does not exist yet and
// PostgREST answers 42703 for one that is not there, so the filter cannot be
// written ahead of it; the guard in __tests__/key-map-integrity.test.ts fails
// the moment the column appears without it.
type KeyMapResult = { map: Record<string, string>; error?: undefined } | { map?: undefined; error: unknown }

async function rebuildKeyMap(
  supabase: ReturnType<typeof createSupabaseClient>,
  currentEnvMap: Record<string, string>,
  removeKeys: Set<string> = new Set(),
): Promise<KeyMapResult> {
  // Every organization's sources, paged by the primary key past PostgREST's
  // 1,000 row cap (#1437): a map rebuilt from a cut list would drop the keys of
  // the sources it never saw. A failed page answers the error, never a part.
  let rows: { name: string; api_key: string }[]
  try {
    rows = await fetchAllPaged<{ name: string; api_key: string }>(
      (from, to) => supabase.from('api_sources').select('name, api_key').order('id', { ascending: true }).range(from, to),
      'api_sources key map read',
    )
  } catch (error) {
    return { error }
  }
  const dbMap: Record<string, string> = {}
  const dbKeys = new Set<string>()
  for (const r of rows) {
    dbMap[r.api_key] = r.name
    dbKeys.add(r.api_key)
  }
  const preserved: Record<string, string> = {}
  for (const [k, v] of Object.entries(currentEnvMap)) {
    if (!dbKeys.has(k)) preserved[k] = v
  }
  const merged: Record<string, string> = { ...preserved, ...dbMap }
  for (const k of removeKeys) delete merged[k]
  return { map: merged }
}

// Undo a just-inserted source when the key map could not be brought in line
// with it. The insert deliberately happens FIRST (so the rebuilt map, derived
// from the table, includes the new row), which means every path that gives up
// after the insert owns this rollback. Skipping it leaves a source in the table
// and absent from the auth map: it does not authenticate, and it blocks
// re-creating the same name with a 409 the operator can see no reason for (L33).
//
// A rollback that errors, or that matches nothing, leaves exactly that state and
// nothing here can recover it, so it is logged loudly rather than swallowed
// (#588). onMiss 'error' covers the zero-row case.
async function rollbackCreatedSource(
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  name: string,
): Promise<void> {
  const { error: rollbackError } = await requireRowsAffected(
    'api_sources.rollback',
    () => supabase.from('api_sources').delete().eq('organization_id', orgId).eq('name', name).select('id'),
    { onMiss: 'error', context: { source_name: name, organization_id: orgId } },
  )
  if (rollbackError && !isNoRowMatchedError(rollbackError)) {
    console.error(
      JSON.stringify({
        event: 'api_source_rollback_failed',
        source_name: name,
        organization_id: orgId,
        reason: rollbackError.message,
      }),
    )
  }
}

// One wording for both callers, naming the secret that was NOT touched. An
// operator reading it needs to know the live key map is unchanged, which is the
// difference between "retry this" and "go and check what production is using".
function keyMapReadFailed(c: Context, error: unknown): Response {
  console.error('[sources] API_KEY_MAP rebuild aborted: api_sources read failed', error)
  return c.json(
    {
      error: 'Could not rebuild the API key map because the api_sources read failed. The live API_KEY_MAP secret was not changed.',
      details: formatErr(error),
    },
    500,
  )
}

// GET /api/sources — return list of {name, api_key} from Supabase
sources.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  // Read whole or refused, never cut at the row cap (#1437).
  try {
    return c.json(await fetchUpTo((limit) => supabase
      .from('api_sources')
      .select('name, api_key, created_at')
      .eq('organization_id', orgId)
      .order('name')
      .limit(limit), CONFIG_LIST_BOUNDS.apiSources, 'api sources list'))
  } catch (err) {
    return dbError(c, err)
  }
})

// POST /api/sources — body: { name: string, assign_workflow_id?: string }
sources.post('/', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await c.req.json<{ name: string; assign_workflow_id?: string }>()

  if (!body.name) return c.json({ error: 'name is required' }, 400)
  // Enforce the charset (lowercase, numbers, underscores). Source names are
  // interpolated into API paths and used as trigger.source, so URL-breaking
  // characters must never reach the DB (#100). Mirror of web sanitizeSourceName.
  const name = body.name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
  if (!name) return c.json({ error: 'name must contain a letter, number, or underscore' }, 400)

  // Generate a 32-char hex key
  const keyBytes = crypto.getRandomValues(new Uint8Array(16))
  const apiKey = Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('')

  const supabase = createSupabaseClient(c.env)

  // Insert first so the rebuilt map (derived from the table) includes the new
  // source. UNIQUE(organization_id, name) enforces uniqueness race-free.
  const { data: created, error: insertError } = await supabase
    .from('api_sources')
    .insert({ organization_id: orgId, name, api_key: apiKey })
    .select('id')
    .single()
  if (insertError) {
    if (insertError.code === '23505') return c.json({ error: `Source "${name}" already exists` }, 409)
    return dbError(c, insertError)
  }

  const rebuilt = await rebuildKeyMap(supabase, parseKeyMap(c.env.API_KEY_MAP ?? '{}'))
  if (rebuilt.error) {
    await rollbackCreatedSource(supabase, orgId, name)
    return keyMapReadFailed(c, rebuilt.error)
  }
  const newMap = rebuilt.map
  try {
    await setCfSecret('API_KEY_MAP', JSON.stringify(newMap), c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  } catch (err) {
    await rollbackCreatedSource(supabase, orgId, name)
    return c.json({ error: err instanceof Error ? err.message : 'Failed to update API_KEY_MAP secret' }, 500)
  }

  await writeAuditLog(supabase, orgId, 'api_source', (created as { id: string }).id, 'created', userId, {
    source_name: name,
    action: 'api_key_created',
  })

  // Optional one-shot assignment — used by the trigger panel so a new key
  // is immediately scoped to the workflow the user is configuring.
  if (body.assign_workflow_id) {
    await supabase.from('source_workflow_assignments').upsert(
      { organization_id: orgId, source_name: name, workflow_id: body.assign_workflow_id },
      { onConflict: 'organization_id,source_name,workflow_id' }
    )
  }

  return c.json({ name, api_key: apiKey }, 201)
})

// GET /api/sources/assignments — bulk list of all (source_name, workflow_id) assignments in org
sources.get('/assignments', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  // Read whole or refused, never cut at the row cap (#1437).
  try {
    return c.json(await fetchUpTo((limit) => supabase
      .from('source_workflow_assignments')
      .select('source_name, workflow_id')
      .eq('organization_id', orgId)
      .limit(limit), CONFIG_LIST_BOUNDS.sourceAssignments, 'source assignments list'))
  } catch (err) {
    return dbError(c, err)
  }
})

// GET /api/sources/:name/workflows — list workflow_ids assigned to this source
sources.get('/:name/workflows', async (c) => {
  const { orgId } = c.get('user')
  const name = c.req.param('name')
  const supabase = createSupabaseClient(c.env)
  // Read whole or refused, never cut at the row cap (#1437).
  try {
    const rows = await fetchUpTo<{ workflow_id: string }>((limit) => supabase
      .from('source_workflow_assignments')
      .select('workflow_id')
      .eq('organization_id', orgId)
      .eq('source_name', name)
      .limit(limit), CONFIG_LIST_BOUNDS.sourceAssignments, 'source workflows list')
    return c.json(rows.map((r) => r.workflow_id))
  } catch (err) {
    return dbError(c, err)
  }
})

// POST /api/sources/:name/workflows — body: { workflow_id }
sources.post('/:name/workflows', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')
  const body = await c.req.json<{ workflow_id: string }>()
  if (!body.workflow_id) return c.json({ error: 'workflow_id is required' }, 400)

  const supabase = createSupabaseClient(c.env)

  // Verify the source exists in this org
  const { data: src, error: srcError } = await supabase
    .from('api_sources')
    .select('id, name')
    .eq('organization_id', orgId)
    .eq('name', name)
    .single()
  // PGRST116 = not found / not this org (→ 404); a real error must not look like
  // a 404, which would block a legitimate assignment (#303).
  if (srcError && !isNotFoundError(srcError)) return dbError(c, srcError)
  if (!src) return c.json({ error: 'Source not found' }, 404)

  // Verify the workflow belongs to this org
  const { data: wf, error: wfError } = await supabase
    .from('workflows')
    .select('id')
    .eq('id', body.workflow_id)
    .eq('organization_id', orgId)
    .single()
  if (wfError && !isNotFoundError(wfError)) return dbError(c, wfError)
  if (!wf) return c.json({ error: 'Workflow not found' }, 404)

  const { error: insertError } = await supabase
    .from('source_workflow_assignments')
    .upsert(
      { organization_id: orgId, source_name: name, workflow_id: body.workflow_id },
      { onConflict: 'organization_id,source_name,workflow_id' }
    )
  if (insertError) return dbError(c, insertError)

  await writeAuditLog(supabase, orgId, 'api_source', (src as { id: string }).id, 'updated', userId, {
    source_name: name,
    workflow_id: body.workflow_id,
    action: 'source_assigned_to_workflow',
  })

  return c.json({ ok: true }, 201)
})

// DELETE /api/sources/:name/workflows/:workflow_id — unassign
sources.delete('/:name/workflows/:workflow_id', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')
  const workflowId = c.req.param('workflow_id')

  const supabase = createSupabaseClient(c.env)
  // Unassigning a source that is not assigned is a no-op, so this stays 200 and
  // stays idempotent. Only the audit row is gated on the row actually removed,
  // so an unassign that changed nothing no longer logs one (#588).
  const { rows, blocked } = await rowsTouched(c, 'source_workflow_assignments.unassign', () =>
    supabase
      .from('source_workflow_assignments')
      .delete()
      .eq('organization_id', orgId)
      .eq('source_name', name)
      .eq('workflow_id', workflowId)
      .select('workflow_id')
  )
  if (blocked) return blocked

  if (rows.length > 0) {
    const { data: src } = await supabase
      .from('api_sources')
      .select('id')
      .eq('organization_id', orgId)
      .eq('name', name)
      .single()
    await writeAuditLog(supabase, orgId, 'api_source', (src as { id: string } | null)?.id ?? workflowId, 'updated', userId, {
      source_name: name,
      workflow_id: workflowId,
      action: 'source_unassigned_from_workflow',
    })
  }

  return c.json({ ok: true })
})

// DELETE /api/sources/:name: revoke the key of a source. One row per name (api_sources is UNIQUE organization_id, name).
sources.delete('/:name', async (c) => {
  const { orgId, userId } = c.get('user')
  const name = c.req.param('name')

  const supabase = createSupabaseClient(c.env)

  // Authoritative existence check + grab the id and key being revoked. One row at
  // most: api_sources is UNIQUE (organization_id, name). A failed read is not a
  // missing source, so it is a 500 rather than a 404 (#1437).
  const { data: existing, error: existingError } = await supabase
    .from('api_sources')
    .select('id, api_key')
    .eq('organization_id', orgId)
    .eq('name', name)
    .maybeSingle()

  if (existingError) return dbError(c, existingError)
  if (!existing) return c.json({ error: 'Source not found' }, 404)
  const row = existing as { id: string; api_key: string }
  const deletedKeys = new Set([row.api_key])
  const sourceId = row.id

  // Revoke first: rebuild the map from the table minus the deleted key, so
  // auth is cut before the row is removed and a stale-snapshot read-modify-write
  // can't drop an unrelated source's key. Manual keys are preserved.
  // A delete whose rebuild read failed must not write either. The alternative is
  // worse than it looks: the merged map would be the stale env snapshot minus
  // the deleted key, so the revocation appears to work while any key added by a
  // concurrent mutation is silently dropped from production.
  const rebuilt = await rebuildKeyMap(supabase, parseKeyMap(c.env.API_KEY_MAP ?? '{}'), deletedKeys)
  if (rebuilt.error) return keyMapReadFailed(c, rebuilt.error)
  const newMap = rebuilt.map
  await setCfSecret('API_KEY_MAP', JSON.stringify(newMap), c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)

  const deleteBlocked = await requireRowOr404(c, 'Source not found', () =>
    supabase.from('api_sources').delete().eq('organization_id', orgId).eq('name', name).select('id')
  )
  if (deleteBlocked) return deleteBlocked

  await writeAuditLog(supabase, orgId, 'api_source', sourceId, 'deleted', userId, {
    source_name: name,
    action: 'api_key_revoked',
  })

  return c.json({ ok: true })
})

export default sources
