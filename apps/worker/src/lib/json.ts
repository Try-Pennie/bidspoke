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
