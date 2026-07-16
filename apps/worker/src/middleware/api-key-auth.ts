import type { Context, Next } from 'hono'
import type { Env } from '../index'
import { formatErr } from '../lib/format-error'

export type Variables = { source: string }

// API keys stored as a JSON secret: { "key1": "wallet_owl", "key2": "website_form" }
// Set via: wrangler secret put API_KEY_MAP
export async function apiKeyAuth(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  const apiKey = c.req.header('X-API-Key')

  if (!apiKey) {
    return c.json({ error: 'Missing X-API-Key header' }, 401)
  }

  let keyMap: Record<string, string>
  try {
    keyMap = JSON.parse(c.env.API_KEY_MAP)
  } catch (e) {
    // Log the underlying parse error (server-side only) so a corrupted secret is
    // diagnosable; the caller still gets a generic message (never leak config).
    console.error('API_KEY_MAP secret is not valid JSON:', formatErr(e))
    return c.json({ error: 'Internal configuration error' }, 500)
  }

  const source = keyMap[apiKey]
  if (!source) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  // Attach source to context for use in the webhook handler
  c.set('source', source)
  await next()
  return
}
