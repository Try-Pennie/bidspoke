import type { Context, Next } from 'hono'
import type { Env } from '../index'
import { verifyJwt } from '../lib/jwt'
import { createSupabaseClient } from '../lib/supabase'

export interface AuthUser {
  userId: string
  orgId: string
  email: string
  name: string | null
}

export type AuthVariables = { user: AuthUser }

export async function jwtAuth(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  next: Next
) {
  const authHeader = c.req.header('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401)
  }

  const token = authHeader.slice(7)

  let payload: { sub: string; email?: string; user_metadata?: { full_name?: string; name?: string } }
  try {
    payload = await verifyJwt(token, c.env.SUPABASE_JWKS_URL)
  } catch (err) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  // Look up the user's organization
  const supabase = createSupabaseClient(c.env)
  const { data: user, error } = await supabase
    .from('users')
    .select('id, organization_id, email, display_name')
    .eq('id', payload.sub)
    .single()

  if (error || !user) {
    return c.json({ error: 'User not found' }, 401)
  }

  // Enforce the access allowlist at the API boundary. A valid token plus an
  // auto-provisioned users row is NOT enough — the email must be on
  // user_allowlist. The browser middleware gate is not authoritative; a token
  // can hit this API directly, so the check must live here too.
  const { data: allowed, error: allowlistError } = await supabase
    .from('user_allowlist')
    .select('email')
    .eq('email', user.email.toLowerCase())
    .maybeSingle()

  if (allowlistError) {
    // Fail closed but distinguish a lookup failure from a genuine deny so it is
    // diagnosable and not silently conflated with "not on the list".
    return c.json({ error: 'Access check failed' }, 500)
  }
  if (!allowed) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Prefer the most current name from the JWT (refreshed on every login from Google)
  // Fall back to the stored display_name, but skip it if it looks like an email prefix
  const jwtName = payload.user_metadata?.full_name ?? payload.user_metadata?.name ?? null
  const storedName = user.display_name
  const isEmailPrefix = storedName === user.email.split('@')[0]
  const name = jwtName ?? (isEmailPrefix ? null : storedName) ?? null

  c.set('user', {
    userId: user.id,
    orgId: user.organization_id,
    email: user.email,
    name,
  })

  await next()
  return
}
