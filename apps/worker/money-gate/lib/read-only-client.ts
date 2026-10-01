/**
 * A Supabase client that can only read (#1704).
 *
 * The fixture shape export runs by hand against production. It must be unable to
 * write, not merely written not to: insert, update, upsert and delete throw at
 * any point in a query chain, before supabase-js sees them, and so do rpc (a
 * function can write) and schema (an escape to an unchecked builder).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

function refuse(what: string): never {
  throw new Error(`money gate export: this client is read only, ${what} refused`)
}

function guard<T extends object>(target: T, table: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === 'string' && WRITES.has(prop)) return () => refuse(`${table}.${prop}`)
      const v = Reflect.get(obj, prop, receiver)
      if (typeof v !== 'function' || prop === 'then' || prop === 'catch' || prop === 'finally') {
        return typeof v === 'function' ? v.bind(obj) : v
      }
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
      if (prop === 'rpc') return (name: string) => refuse(`rpc ${name}`)
      if (prop === 'schema') return (name: string) => refuse(`schema ${name}`)
      return Reflect.get(obj, prop)
    },
  }) as unknown as Pick<SupabaseClient, 'from'>
}
