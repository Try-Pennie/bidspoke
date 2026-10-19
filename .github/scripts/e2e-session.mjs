// The e2e user's session from the Supabase auth API's password grant, for the
// deploy checks that act as a signed in person (#2132 partners-page-commit.mjs,
// #2335 ops-connections-probe.mjs). One implementation, so both sign in the same
// way and fail with the same sentence.

/**
 * @param {typeof fetch} fetchFn
 * @returns {Promise<{ access_token: string, expires_at: number } & Record<string, unknown>>}
 */
export async function passwordSession(fetchFn, supabaseUrl, anonKey, email, password) {
  const res = await fetchFn(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body || typeof body.access_token !== 'string') {
    throw new Error(`the auth API answered ${res.status}${body && body.error_description ? `: ${body.error_description}` : ''}`)
  }
  if (typeof body.expires_at !== 'number' && typeof body.expires_in === 'number') body.expires_at = Math.floor(Date.now() / 1000) + body.expires_in
  return body
}
