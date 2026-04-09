import { Hono } from 'hono'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { writeAuditLog } from '../../lib/audit'

const access = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

// GET /api/access — list all allowed emails
access.get('/', async (c) => {
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase
    .from('user_allowlist')
    .select('email, added_by, added_at')
    .order('added_at', { ascending: true })
  if (error) return c.json({ error: error.message }, 500)
  return c.json(data)
})

// POST /api/access — add an email to the allowlist
access.post('/', async (c) => {
  const body = await c.req.json<{ email?: string }>().catch(() => ({ email: undefined }))
  const email = body.email?.trim().toLowerCase()

  if (!email) return c.json({ error: 'email is required' }, 400)
  if (!email.endsWith('@trypennie.com')) {
    return c.json({ error: 'Only @trypennie.com addresses are permitted' }, 400)
  }

  const { orgId, userId, email: addedByEmail } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { error } = await supabase
    .from('user_allowlist')
    .insert({ email, added_by: addedByEmail ?? 'unknown' })
  if (error) {
    if (error.code === '23505') return c.json({ error: 'Already on the allowlist' }, 409)
    return c.json({ error: error.message }, 500)
  }

  await writeAuditLog(supabase, orgId, 'user_allowlist', crypto.randomUUID(), 'created', userId, { email })
  return c.json({ email, added_by: addedByEmail }, 201)
})

// DELETE /api/access/:email — remove an email
access.delete('/:email', async (c) => {
  const email = decodeURIComponent(c.req.param('email')).toLowerCase()
  const { orgId, userId, email: callerEmail } = c.get('user')

  // Prevent self-removal — you can't lock yourself out
  if (email === callerEmail?.toLowerCase()) {
    return c.json({ error: 'You cannot remove yourself from the allowlist' }, 400)
  }

  const supabase = createSupabaseClient(c.env)
  const { error } = await supabase
    .from('user_allowlist')
    .delete()
    .eq('email', email)
  if (error) return c.json({ error: error.message }, 500)

  await writeAuditLog(supabase, orgId, 'user_allowlist', crypto.randomUUID(), 'deleted', userId, { email })
  return c.json({ ok: true })
})

export default access
