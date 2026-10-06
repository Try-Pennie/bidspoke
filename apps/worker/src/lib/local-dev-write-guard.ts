/**
 * The local dev write guard, for every Supabase client a Worker builds (#669,
 * #1409, generalised for the ops database in #1709).
 *
 * Local `wrangler dev` has no separate backend: it points at the real hosted
 * database, and the Worker connects as service_role, which bypasses RLS. So a
 * local run can write anywhere in production. This guard blocks writes from
 * local dev unless the operator explicitly opts in.
 *
 * Reads stay allowed, and so do the rpcs a client's classification names as
 * read only. Every other rpc, a mutating one or one nobody has classified, is
 * refused with the same message as a blocked insert, because an rpc can write.
 *
 * One implementation for both databases (L370): the bidding client
 * (./supabase.ts) passes its rpc lists from read-only-rpcs.json, the ops client
 * (../ops/ops-db.ts) passes its own. This module imports neither, so the ops
 * Worker's bundle carries no part of the bidding database's configuration.
 */

export interface LocalDevFlags {
  /** Set only in apps/worker/.dev.vars, never in production. */
  LOCAL_DEV?: string
  /** Set to 'true' alongside LOCAL_DEV to opt a local run in to writing. */
  ALLOW_PROD_WRITES?: string
}

export interface RpcClassification {
  readOnly: ReadonlySet<string>
  mutating: ReadonlySet<string>
  /** Where the lists live, named in a refusal so the reader knows what to edit. */
  listFile: string
}

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
function shouldGuardProdWrites(flags: LocalDevFlags, databaseUrl: string): boolean {
  if (!flags.LOCAL_DEV) return false
  if (flags.ALLOW_PROD_WRITES) return false
  return !isLocalDatabase(databaseUrl)
}

function blockedWriteMessage(table: string, method: string): string {
  return (
    `Blocked ${method}() on '${table}': local dev is pointed at a remote Supabase database. ` +
    'The Worker connects as service_role and bypasses RLS, so this would write to production data. ' +
    'Set ALLOW_PROD_WRITES=true in apps/worker/.dev.vars if you intend this (see issue #669).'
  )
}

function blockedRpcMessage(name: string, rpcs: RpcClassification): string {
  const why = rpcs.mutating.has(name)
    ? 'it is on the mutating list'
    : `it is on neither list in ${rpcs.listFile}, and an unclassified rpc is treated as a write`
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

type FromMethod = (table: string) => object
type RpcMethod = (name: string, ...rest: unknown[]) => unknown

function withProdWriteGuard<C extends object>(client: C, rpcs: RpcClassification): C {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        const from = Reflect.get(target, 'from', receiver) as FromMethod
        return (table: string) => guardQueryBuilder(from.call(target, table), table)
      }
      if (prop === 'rpc') {
        const rpc = Reflect.get(target, 'rpc', receiver) as RpcMethod
        return (name: string, ...rest: unknown[]) => {
          if (!rpcs.readOnly.has(name)) throw new Error(blockedRpcMessage(name, rpcs))
          return rpc.call(target, name, ...rest)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * The client as given when the guard does not apply (always, on a deployed
 * Worker), or wrapped so writes and unclassified rpcs throw when a local run
 * points at a database that is not provably local.
 */
export function guardLocalDevWrites<C extends object>(client: C, flags: LocalDevFlags, databaseUrl: string, rpcs: RpcClassification): C {
  return shouldGuardProdWrites(flags, databaseUrl) ? withProdWriteGuard(client, rpcs) : client
}
