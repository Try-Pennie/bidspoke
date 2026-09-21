import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import type { Database } from '../types/database'
import rpcLists from './read-only-rpcs.json'

// Local `wrangler dev` shares the real production Supabase project (there is no
// separate local backend), and the Worker connects as service_role, which
// bypasses RLS. So a local run can write anywhere in production. This guard
// blocks writes from local dev unless the operator explicitly opts in (#669).
//
// Reads stay allowed, and so do the rpcs on the READ ONLY list in
// read-only-rpcs.json (#1409, L96). The old rule let every rpc through on the
// claim that all of them read; record_archive_day_measurement already wrote,
// and save_buyer_profile is a user facing write path, so the rule is now an
// allowlist: a mutating rpc, or one nobody has classified, is refused with the
// same message as a blocked insert. auth_user_with_allowlist runs on every
// authenticated request and is on the read only list, so local dev stays usable.
const GUARDED_WRITE_METHODS: ReadonlySet<string> = new Set(['insert', 'update', 'upsert', 'delete'])

const READ_ONLY_RPCS: ReadonlySet<string> = new Set(rpcLists.readOnly)
/** Exported for the guard tests and so a scan can name the writers (L41). */
export const MUTATING_RPCS: ReadonlySet<string> = new Set(rpcLists.mutating)

const LOCAL_DB_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])

// Any database we can't prove is local counts as remote. Keyed on the hostname
// rather than a hardcoded prod project ref so an unrecognised database fails
// safe instead of only the one ref we remembered to list.
function isLocalDatabase(url: string): boolean {
  try {
    return LOCAL_DB_HOSTNAMES.has(new URL(url).hostname)
  } catch {
    return false
  }
}

// LOCAL_DEV is set only in apps/worker/.dev.vars, never in production, so this
// is inert on the deployed Worker.
function shouldGuardProdWrites(env: Env): boolean {
  if (!env.LOCAL_DEV) return false
  if (env.ALLOW_PROD_WRITES) return false
  return !isLocalDatabase(env.SUPABASE_URL)
}

function blockedWriteMessage(table: string, method: string): string {
  return (
    `Blocked ${method}() on '${table}': local dev is pointed at a remote Supabase database. ` +
    'The Worker connects as service_role and bypasses RLS, so this would write to production data. ' +
    'Set ALLOW_PROD_WRITES=true in apps/worker/.dev.vars if you intend this (see issue #669).'
  )
}

function blockedRpcMessage(name: string): string {
  const why = MUTATING_RPCS.has(name)
    ? 'it is on the mutating list'
    : 'it is on neither list in apps/worker/src/lib/read-only-rpcs.json, and an unclassified rpc is treated as a write'
  return (
    `Blocked rpc('${name}'): local dev is pointed at a remote Supabase database and ${why}. ` +
    'The Worker connects as service_role, so this would write to production data. ' +
    'Set ALLOW_PROD_WRITES=true in apps/worker/.dev.vars if you intend this (see issues #669 and #1409).'
  )
}

function guardQueryBuilder<T extends object>(builder: T, table: string): T {
  return new Proxy(builder, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && GUARDED_WRITE_METHODS.has(prop)) {
        return () => {
          throw new Error(blockedWriteMessage(table, prop))
        }
      }
      const value = Reflect.get(target, prop, receiver)
      // Bind to the real builder: supabase-js relies on `this`, and handing back
      // a method bound to the proxy breaks its internal chaining.
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function withProdWriteGuard(client: SupabaseClient<Database>): SupabaseClient<Database> {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => guardQueryBuilder(target.from(table as never), table)
      }
      if (prop === 'rpc') {
        return (name: string, ...rest: unknown[]) => {
          if (!READ_ONLY_RPCS.has(name)) throw new Error(blockedRpcMessage(name))
          return (target.rpc as (n: string, ...a: unknown[]) => unknown)(name, ...rest)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

export function createSupabaseClient(env: Env): SupabaseClient<Database> {
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  })
  return shouldGuardProdWrites(env) ? withProdWriteGuard(client) : client
}
