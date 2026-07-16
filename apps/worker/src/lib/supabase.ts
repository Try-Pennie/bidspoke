import { createClient, SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../index'
import type { Database } from '../types/database'

// Local `wrangler dev` shares the real production Supabase project (there is no
// separate local backend), and the Worker connects as service_role, which
// bypasses RLS. So a local run can write anywhere in production. This guard
// blocks writes from local dev unless the operator explicitly opts in (#669).
//
// Reads and rpc stay allowed on purpose. Local dev has to remain usable, and
// every rpc in this codebase is read-only (auth_user_with_allowlist runs on
// every authenticated request). Blocking those would break local dev outright
// for no gain, since the exposure is writes.
const GUARDED_WRITE_METHODS: ReadonlySet<string> = new Set(['insert', 'update', 'upsert', 'delete'])

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
      if (prop !== 'from') return Reflect.get(target, prop, receiver)
      return (table: string) => guardQueryBuilder(target.from(table as never), table)
    },
  })
}

export function createSupabaseClient(env: Env): SupabaseClient<Database> {
  const client = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  })
  return shouldGuardProdWrites(env) ? withProdWriteGuard(client) : client
}
