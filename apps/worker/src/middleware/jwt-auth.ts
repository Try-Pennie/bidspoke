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

  // Look up the user's organization AND enforce the access allowlist in a single
  // round-trip. A valid token plus an auto-provisioned users row is NOT enough —
  // the email must be on user_allowlist. The browser middleware gate is not
  // authoritative; a token can hit this API directly, so the check lives here.
  // The auth_user_with_allowlist RPC returns the user row joined to an `allowed`
  // flag, so the two formerly-sequential queries collapse into one (#329).
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase.rpc('auth_user_with_allowlist', {
    p_user_id: payload.sub,
  })

  if (error) {
    // A real lookup failure (DB down / schema reload). Fail closed but with a
    // 500 so it is diagnosable and not conflated with "user not found" (401) or
    // "not on the list" (403).
    return c.json({ error: 'Access check failed' }, 500)
  }
  const user = Array.isArray(data) ? data[0] : data
  if (!user) {
    return c.json({ error: 'User not found' }, 401)
  }
  if (!user.allowed) {
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
