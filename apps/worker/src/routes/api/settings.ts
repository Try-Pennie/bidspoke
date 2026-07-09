import { Hono } from 'hono'
import { dbError } from '../../lib/api-error'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { encryptSecret } from '../../lib/secret-crypto'
import { writeAuditLog } from '../../lib/audit'

type Variables = AuthVariables

const settings = new Hono<{ Bindings: Env; Variables: Variables }>()

const ANTHROPIC_KEY_SETTING = 'anthropic_api_key'

function maskKey(plaintextLastFour: string | null): string | null {
  if (!plaintextLastFour) return null
  return `••••${plaintextLastFour}`
}

// GET /api/settings/anthropic-key — returns whether configured + masked tail
settings.get('/anthropic-key', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('app_settings')
    .select('value_encrypted, updated_at, updated_by_email')
    .eq('organization_id', orgId)
    .eq('key', ANTHROPIC_KEY_SETTING)
    .maybeSingle()

  if (error) return dbError(c, error)

  if (!data?.value_encrypted) {
    return c.json({ configured: false })
  }

  // We could decrypt and return the last 4 chars, but storing them separately
  // avoids a decrypt on every page load. Simpler: return configured=true only.
  return c.json({
    configured: true,
    updated_at: data.updated_at,
    updated_by_email: data.updated_by_email,
  })
})

// PUT /api/settings/anthropic-key — set the key
settings.put('/anthropic-key', async (c) => {
  const { orgId, userId, email } = c.get('user')

  if (!c.env.SECRET_ENCRYPTION_KEY) {
    return c.json({ error: 'SECRET_ENCRYPTION_KEY not configured' }, 500)
  }

  let body: { key?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON' }, 400)
  }

  const key = body.key?.trim()
  if (!key) return c.json({ error: 'key required' }, 400)
  if (!key.startsWith('sk-ant-')) {
    return c.json({ error: 'Anthropic API keys start with sk-ant-' }, 400)
  }

  const supabase = createSupabaseClient(c.env)
  const value_encrypted = await encryptSecret(key, c.env.SECRET_ENCRYPTION_KEY)

  const { error } = await supabase
    .from('app_settings')
    .upsert(
      {
        organization_id: orgId,
        key: ANTHROPIC_KEY_SETTING,
        value_encrypted,
        updated_by: userId,
        updated_by_email: email,
      },
      { onConflict: 'organization_id,key' }
    )

  if (error) return dbError(c, error)

  await writeAuditLog(supabase, orgId, 'app_setting', ANTHROPIC_KEY_SETTING, 'updated', userId, {
    changed_by_email: email,
  })

  return c.json({ configured: true })
})

// DELETE /api/settings/anthropic-key — clear the key
settings.delete('/anthropic-key', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  // Clearing a key that was never set is a no-op, and the response is true
  // either way, so this stays 200. Only the audit row is gated on the rows the
  // delete actually removed (#588).
  const { data: deleted, error } = await supabase
    .from('app_settings')
    .delete()
    .eq('organization_id', orgId)
    .eq('key', ANTHROPIC_KEY_SETTING)
    .select('key')

  if (error) return dbError(c, error)

  if (deleted?.length) {
    await writeAuditLog(supabase, orgId, 'app_setting', ANTHROPIC_KEY_SETTING, 'deleted', userId, {
      changed_by_email: email,
    })
  }

  return c.json({ configured: false })
})

export default settings
export { ANTHROPIC_KEY_SETTING, maskKey }
