import type { Json } from '../types/database'

/**
 * Assert a runtime-JSON value as the generated `Json` type at a jsonb insert/
 * update boundary. Our request bodies and config objects are JSON-serializable
 * but TS can't prove a typed object/array matches the recursive `Json` type, so
 * the typed Supabase client rejects them. Use this only where the value is known
 * to be plain JSON (never to launder a wrong column name past the type checker).
 */
export function asJson(value: unknown): Json {
  return value as Json
}

/**
 * Parse a `Response` body as typed JSON (issue #300).
 *
 * `Response.json<T>()` is generic, so this returns `Promise<T>` with no cast.
 * Use it after any status checks: `if (!res.ok) throw ...; const x = await parseJson<X>(res)`.
 * It does not inspect `res.ok` — the caller owns status branching (some APIs
 * return a meaningful JSON body on non-2xx, e.g. Slack's `{ ok: false, error }`).
 *
 * Replaces `await res.json() as X`, which eslint flags as an unnecessary
 * assertion (the `as X` contextually pins the generic, so removing it would
 * leave `unknown` and break tsc) — the helper sidesteps that divergence.
 */
export function parseJson<T>(res: Response): Promise<T> {
  return res.json<T>()
}

/**
 * Fetch a URL and parse its JSON body as `T` (issue #300).
 *
 * The production analogue of the test-side `stubFetch` helper. Use this when you
 * do not need to branch on the response status; when you do, call `fetch`
 * yourself and pass the `Response` to `parseJson<T>` after checking `res.ok`.
 */
export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  return parseJson<T>(res)
}
