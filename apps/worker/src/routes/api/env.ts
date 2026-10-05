import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound, requireRowOr404 } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { setCfSecret, deleteCfSecret, listCfSecretNames } from '../../lib/cf-secrets'
import { changedFields, writeAuditLog } from '../../lib/audit'
import { invalidateEnvCache } from '../../lib/env-loader'
import { encryptSecret, decryptSecret, secretKeys } from '../../lib/secret-crypto'
import { isUuid } from '../../lib/query-validators'
import type { Database } from '../../types/database'

type Variables = AuthVariables

const env = new Hono<{ Bindings: Env; Variables: Variables }>()

/**
 * Whether a secret is mirrored to the Cloudflare Worker secret of the same name.
 *
 * Only an org secret is. The Worker holds ONE value per name, read by every
 * workflow, so a workflow's own secret mirrored there would overwrite the org
 * secret of that name (which the Salesforce and Webhook nodes of every workflow
 * read ahead of the database copy), and deleting it would delete the org's. A
 * workflow's own secret lives only in its encrypted database row, which is what
 * the env loader hands that workflow's runs (#1681).
 */
function mirroredToWorker(row: { is_secret: boolean; scope: string }): boolean {
  return row.is_secret && row.scope === 'global'
}

// GET /api/env — list vars; secret values omitted
env.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('environment_variables')
    .select('id, key, value, is_secret, scope, workflow_id, folder_id, updated_at, updated_by_email')
    .eq('organization_id', orgId)
    .order('key', { ascending: true })

  if (error) return dbError(c, error)

  // Mask secret values
  const masked = (data ?? []).map((row) => ({
    ...row,
    value: row.is_secret ? null : row.value,
  }))

  return c.json(masked)
})

// POST /api/env
env.post('/', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{
    key: string
    value?: string
    is_secret?: boolean
    scope?: string
    workflow_id?: string
    folder_id?: string | null
  }>()

  if (!body.key) return c.json({ error: 'key is required' }, 400)
  if (body.is_secret && !body.value) return c.json({ error: 'value is required for secrets' }, 400)

  // Which workflow a variable is saved against decides which runs read it
  // (#1681), and this client is service_role, which RLS does not stop, so the
  // workflow is checked to be one of the caller's own before anything is written.
  // Naming a workflow without a scope means that workflow, as the API reference
  // has always said; it used to be stored as an org variable, read by every run.
  const workflowId = body.workflow_id ?? null
  const scope = body.scope ?? (workflowId !== null ? 'workflow' : 'global')
  if (scope !== 'global' && scope !== 'workflow') {
    return c.json({ error: "scope must be 'global' or 'workflow'" }, 400)
  }
  if (scope === 'global' && workflowId !== null) {
    return c.json({ error: 'a global variable cannot name a workflow' }, 400)
  }
  if (scope === 'workflow') {
    if (!workflowId) return c.json({ error: 'workflow_id is required for a workflow scoped variable' }, 400)
    if (!isUuid(workflowId)) return c.json({ error: 'workflow_id must be a workflow id' }, 400)
    const { data: workflow, error: workflowErr } = await supabase
      .from('workflows')
      .select('id')
      .eq('id', workflowId)
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .single()
    const workflowBlocked = dbErrorUnlessNotFound(c, workflowErr)
    if (workflowBlocked) return workflowBlocked
    if (!workflow) return c.json({ error: 'Workflow not found' }, 404)
  }

  if (body.folder_id) {
    const { data: folder, error: folderErr } = await supabase
      .from('env_var_folders')
      .select('id')
      .eq('id', body.folder_id)
      .eq('organization_id', orgId)
      .single()
    const folderBlocked = dbErrorUnlessNotFound(c, folderErr)
    if (folderBlocked) return folderBlocked
    if (!folder) return c.json({ error: 'folder not found' }, 404)
  }

  // Sync an org secret to Cloudflare; store every secret's encrypted copy, which
  // is what the env loader reads and what reveal decrypts.
  let storedValue: string | null = body.value ?? null
  if (body.is_secret && body.value) {
    if (mirroredToWorker({ is_secret: true, scope })) {
      await setCfSecret(body.key, body.value, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
    }
    storedValue = await encryptSecret(body.value, secretKeys(c.env))
  }

  const { data, error } = await supabase
    .from('environment_variables')
    .insert({
      organization_id: orgId,
      key: body.key,
      value: storedValue,
      is_secret: body.is_secret ?? false,
      scope,
      workflow_id: workflowId,
      folder_id: body.folder_id ?? null,
      created_by: userId,
      updated_by: userId,
      updated_by_email: email,
    })
    .select()
    .single()

  if (error) return dbError(c, error)

  // The entry carries the first value against null so the variable's history
  // starts from its creation (#1085). A secret's value is never recorded, in
  // plaintext or as ciphertext; only that one was set (L222).
  await Promise.all([
    writeAuditLog(supabase, orgId, 'environment_variable', data.id, body.is_secret ? 'secret_rotated' : 'created', userId, {
      key: body.key,
      scope: data.scope,
      workflow_id: data.workflow_id,
      ...(body.is_secret ? { value_set: true } : { value: { old: null, new: data.value } }),
    }),
    invalidateEnvCache(orgId, c.env.WORKFLOW_CACHE, supabase, secretKeys(c.env)),
  ])

  return c.json({ ...data, value: data.is_secret ? null : data.value }, 201)
})

// PUT /api/env/:id
env.put('/:id', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ key?: string; value?: string; folder_id?: string | null }>()

  // `body.key ?? existing.key` would otherwise store an empty-string key.
  if (body.key !== undefined && !body.key.trim()) {
    return c.json({ error: 'key cannot be empty' }, 400)
  }

  const { data: existing, error: fetchError } = await supabase
    .from('environment_variables')
    .select('*')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  const blocked = dbErrorUnlessNotFound(c, fetchError)
  if (blocked) return blocked
  if (!existing) return c.json({ error: 'Variable not found' }, 404)

  const newKey = body.key ?? existing.key
  const keyChanged = newKey !== existing.key
  const isRename = existing.is_secret && keyChanged
  const mirrored = mirroredToWorker(existing)

  // Reject a rename that collides with another var of the same (key, scope,
  // workflow) BEFORE touching Cloudflare — otherwise we'd overwrite that other
  // secret's CF value and only then fail the DB unique constraint (#104).
  if (keyChanged) {
    let dupQuery = supabase
      .from('environment_variables')
      .select('id')
      .eq('organization_id', orgId)
      .eq('key', newKey)
      .eq('scope', existing.scope)
      .neq('id', id)
    dupQuery = existing.workflow_id === null
      ? dupQuery.is('workflow_id', null)
      : dupQuery.eq('workflow_id', existing.workflow_id)
    const { data: dup } = await dupQuery.maybeSingle()
    if (dup) return c.json({ error: 'An environment variable with that name already exists' }, 409)
  }

  let updatedValue: string | null | undefined
  if (existing.is_secret) {
    // Resolve the plaintext to write to Cloudflare: the new value on a rotation,
    // else (a rename with no new value) the current value decrypted from storage
    // so the secret can be copied to the new name. A rename that touches neither
    // a new value nor a recoverable stored value can't be carried over (#104).
    // A workflow's own secret has no Cloudflare copy (#1681), so its rename
    // keeps the stored ciphertext as it is.
    let plaintext: string | null = body.value ?? null
    if (plaintext === null && isRename && mirrored) {
      if (!existing.value) {
        return c.json({ error: 'Provide a new value to rename this secret' }, 400)
      }
      plaintext = await decryptSecret(existing.value, secretKeys(c.env))
    }
    if (plaintext !== null) {
      // Write under the NEW name first (no window without a secret), then drop
      // the old name so it isn't orphaned in Cloudflare.
      if (mirrored) await setCfSecret(newKey, plaintext, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
      updatedValue = await encryptSecret(plaintext, secretKeys(c.env))
    }
    if (isRename && mirrored) {
      await deleteCfSecret(existing.key, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
    }
  } else {
    updatedValue = body.value ?? existing.value
  }

  const updates: Database['public']['Tables']['environment_variables']['Update'] = {
    key: newKey,
    value: updatedValue ?? existing.value,
    updated_by: userId,
    updated_by_email: email,
  }
  if ('folder_id' in body) {
    if (body.folder_id === null) {
      updates.folder_id = null
    } else if (typeof body.folder_id === 'string') {
      const { data: folder, error: folderErr } = await supabase
        .from('env_var_folders')
        .select('id')
        .eq('id', body.folder_id)
        .eq('organization_id', orgId)
        .single()
      const folderBlocked = dbErrorUnlessNotFound(c, folderErr)
      if (folderBlocked) return folderBlocked
      if (!folder) return c.json({ error: 'folder not found' }, 404)
      updates.folder_id = body.folder_id
    }
  }

  const { data, error } = await supabase
    .from('environment_variables')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  const updateBlocked = dbErrorUnlessNotFound(c, error)
  if (updateBlocked) return updateBlocked
  if (!data) return c.json({ error: 'Variable not found' }, 404)

  // What moved, as old and new (#1085, L529): the value for a plain variable,
  // the folder for either kind, the old name on a rename. A secret's value is
  // never recorded; the entry says only whether this save rotated it (L222).
  await Promise.all([
    writeAuditLog(supabase, orgId, 'environment_variable', id, existing.is_secret ? 'secret_rotated' : 'updated', userId, {
      key: newKey,
      ...(keyChanged ? { renamed_from: existing.key } : {}),
      ...(existing.is_secret ? { value_rotated: body.value !== undefined } : changedFields(existing, data, ['value'])),
      ...changedFields(existing, data, ['folder_id']),
    }),
    invalidateEnvCache(orgId, c.env.WORKFLOW_CACHE, supabase, secretKeys(c.env)),
  ])

  return c.json({ ...data, value: existing.is_secret ? null : data.value })
})

// GET /api/env/:id/reveal — decrypt and return secret value; audit logged
env.get('/:id/reveal', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('environment_variables')
    .select('id, key, value, is_secret')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'Not found' }, 404)
  if (!data.is_secret) return c.json({ error: 'Not a secret' }, 400)
  if (!data.value) return c.json({ error: 'Value not available — rotate to enable reveal' }, 422)

  const plaintext = await decryptSecret(data.value, secretKeys(c.env))

  c.executionCtx.waitUntil(
    writeAuditLog(supabase, orgId, 'environment_variable', id, 'secret_revealed', userId, { key: data.key })
  )

  return c.json({ value: plaintext })
})

// POST /api/env/resync-secrets — re-push secrets the database has but Cloudflare
// is missing, from the saved encrypted copy (#199). Repairs the drift the daily
// secret-drift check alerts on. Secrets with no recoverable value (created before
// encryption was enabled) can't be re-pushed and are reported as skipped.
env.post('/resync-secrets', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const cfNames = await listCfSecretNames(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  if (cfNames === null) return c.json({ error: 'Cloudflare secret sync is not configured' }, 503)

  const { data, error } = await supabase
    .from('environment_variables')
    .select('id, key, value')
    .eq('organization_id', orgId)
    .eq('is_secret', true)
    // Org secrets only: a workflow's own secret is never mirrored (#1681).
    .eq('scope', 'global')
  if (error) return dbError(c, error)

  const missing = (data ?? []).filter((s) => !cfNames.has(s.key))
  const resynced: string[] = []
  const skipped: { key: string; reason: string }[] = []

  for (const s of missing) {
    const key = s.key
    const enc = s.value
    if (!enc) {
      skipped.push({ key, reason: 'no saved value (rotate the secret to re-enable sync)' })
      continue
    }
    try {
      const plaintext = await decryptSecret(enc, secretKeys(c.env))
      await setCfSecret(key, plaintext, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
      resynced.push(key)
    } catch (e) {
      skipped.push({ key, reason: e instanceof Error ? e.message : 'resync failed' })
    }
  }

  if (resynced.length > 0) {
    c.executionCtx.waitUntil(
      writeAuditLog(supabase, orgId, 'environment_variable', orgId, 'secrets_resynced', userId, { keys: resynced })
    )
  }

  return c.json({ missing: missing.length, resynced, skipped })
})

// DELETE /api/env/:id
env.delete('/:id', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const { data: existing, error: fetchError } = await supabase
    .from('environment_variables')
    .select('key, is_secret, value, scope')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  const blocked = dbErrorUnlessNotFound(c, fetchError)
  if (blocked) return blocked
  if (!existing) return c.json({ error: 'Variable not found' }, 404)

  // A workflow's own secret has no Cloudflare copy, and the Worker secret of the
  // same name is the org's, so it is left alone (#1681).
  if (mirroredToWorker(existing)) {
    await deleteCfSecret(existing.key, c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN)
  }

  // The Cloudflare secret is already gone by here, so a silent zero-row delete
  // would leave the row in Supabase pointing at a secret that no longer exists,
  // while the response and the audit log both claim it was removed (#588).
  const deleteBlocked = await requireRowOr404(c, 'Variable not found', () =>
    supabase.from('environment_variables').delete().eq('id', id).eq('organization_id', orgId).select('id')
  )
  if (deleteBlocked) return deleteBlocked

  // The last value against null closes the variable's history (#1085); a
  // secret's ciphertext is never recorded (L222).
  await Promise.all([
    writeAuditLog(supabase, orgId, 'environment_variable', id, 'deleted', userId, {
      key: existing.key,
      ...(existing.is_secret ? {} : { value: { old: existing.value, new: null } }),
    }),
    invalidateEnvCache(orgId, c.env.WORKFLOW_CACHE, supabase, secretKeys(c.env)),
  ])

  return c.json({ ok: true })
})

export default env
