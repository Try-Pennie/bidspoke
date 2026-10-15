/**
 * The cookies a signed in browser carries, built from a Supabase session (#2132).
 *
 * Next.js middleware reads the session with @supabase/ssr from COOKIES, not
 * localStorage, so anything that wants to be signed in without a browser
 * (Playwright's global setup, and the deploy check that reads /partners as the
 * e2e user) must build the same cookies createBrowserClient would. One module,
 * so the two cannot drift apart (L613).
 *
 * Written with erasable TypeScript only, so `node --experimental-strip-types`
 * can import it from a plain .mjs script in CI with no build step.
 */

/** @supabase/ssr chunks a cookie value at this many URL encoded characters. */
export const MAX_CHUNK_SIZE = 3180

/** The cookie name @supabase/ssr derives from the project ref. */
export function sessionStorageKey(supabaseUrl: string): string {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]
  return `sb-${projectRef}-auth-token`
}

/** Replicates @supabase/ssr's createChunks. */
export function buildCookieChunks(key: string, value: string): Array<{ name: string; value: string }> {
  let encoded = encodeURIComponent(value)
  if (encoded.length <= MAX_CHUNK_SIZE) {
    return [{ name: key, value }]
  }
  const chunks: string[] = []
  while (encoded.length > 0) {
    let head = encoded.slice(0, MAX_CHUNK_SIZE)
    const lastEscape = head.lastIndexOf('%')
    if (lastEscape > MAX_CHUNK_SIZE - 3) head = head.slice(0, lastEscape)
    let valueHead = ''
    while (head.length > 0) {
      try { valueHead = decodeURIComponent(head); break }
      catch { head = head.slice(0, head.length - 3) }
    }
    chunks.push(valueHead)
    encoded = encoded.slice(encodeURIComponent(valueHead).length)
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }))
}

/** The session as one Cookie request header, each value URL encoded as a browser would send it. */
export function sessionCookieHeader(supabaseUrl: string, session: unknown): string {
  return buildCookieChunks(sessionStorageKey(supabaseUrl), JSON.stringify(session))
    .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
    .join('; ')
}
