/**
 * A Supabase client that can only read (#1704).
 *
 * The fixture shape export runs by hand against production. It must be unable to
 * write, not merely written not to, so everything is DENIED BY DEFAULT: the client
 * exposes `from` and nothing else (rpc, schema, rest, storage, functions, auth and
 * realtime all throw on access), and a query builder exposes only the read and
 * filter methods below. insert, update, upsert, delete, and any method added to
 * supabase-js later, throw before supabase-js sees them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The builder methods a read uses. Anything else on a builder is refused. */
const READ_METHODS = new Set([
  'select', 'eq', 'neq', 'is', 'in', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'contains', 'not', 'filter', 'match',
  'order', 'limit', 'range', 'single', 'maybeSingle', 'returns', 'abortSignal', 'throwOnError',
])

/** The promise surface awaiting a builder goes through. */
const PROMISE_METHODS = new Set(['then', 'catch', 'finally'])

function refuse(what: string): never {
  throw new Error(`money gate export: this client is read only, ${what} refused`)
}

function guard<T extends object>(target: T, table: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const v = Reflect.get(obj, prop, receiver)
      if (typeof prop !== 'string') return v
      // A method that is not a read is refused even where this builder does not
      // have it, so a write chained onto a filter fails by name, not as a TypeError.
      if (typeof v !== 'function' && v !== undefined) return v
      if (PROMISE_METHODS.has(prop) && typeof v === 'function') return v.bind(obj)
      if (!READ_METHODS.has(prop) || typeof v !== 'function') return () => refuse(`${table}.${String(prop)}`)
      return (...args: unknown[]) => {
        const out = (v as (...a: unknown[]) => unknown).apply(obj, args)
        return out && typeof out === 'object' ? guard(out as object, table) : out
      }
    },
  })
}

export function readOnlyClient(client: SupabaseClient): Pick<SupabaseClient, 'from'> {
  return new Proxy(client, {
    get(obj, prop) {
      if (prop === 'from') return (table: string) => guard(obj.from(table) as unknown as object, table)
      return refuse(String(prop))
    },
  }) as unknown as Pick<SupabaseClient, 'from'>
}
