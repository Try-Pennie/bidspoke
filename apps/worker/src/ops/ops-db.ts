/**
 * The ops database: its client and its ONE organization scoped read (#1709,
 * plan 0.E).
 *
 * The ops project ("Bidspoke Ops", supabase-ops/supabase/migrations) holds the
 * ops lane's run data, apart from the bidding database. Every table in it
 * carries organization_id uuid NOT NULL with RLS on, but the ops Worker connects
 * as service_role, which bypasses RLS, so keeping one organization's rows from
 * another is this code's job (L18):
 *
 * - every read goes through readOpsRows, which takes an OrganizationId by type,
 *   re-checks it at run time, filters on it, and refuses a row of any other
 *   organization that comes back anyway;
 * - apps/web/src/lib/__guards__/worker/ops-reads-through-helper.test.ts allows a
 *   `.from(` on this client only inside readOpsRows and a `.rpc(` only inside
 *   callOpsRpc (ops-writes.ts), and fails on any other `.from(`, `.rpc(` or
 *   `.schema(` against it, and on the client being handed to anything typed
 *   wider than OpsSupabaseClient, where that scan could no longer follow it.
 *
 * Nothing reads the ops database yet: the run engine's tables exist (#1948) but
 * nothing calls them until its tick (#1949). So OPS_SUPABASE_URL and
 * OPS_SUPABASE_SECRET_KEY are on the ops Worker's allowlist (lib/secret-lists.ts)
 * and not its required list, which would alert on two secrets no code needs.
 *
 * Writes are not here: every ops write is a database function called through
 * callOpsRpc in ops-writes.ts, the one `.rpc(` on this client, which the same
 * scan allows by name. The database enforces it too: service_role holds only
 * SELECT on the run engine's tables (supabase-ops migration 20261016200000).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { guardLocalDevWrites, type LocalDevFlags, type RpcClassification } from '../lib/local-dev-write-guard'
import { OPS_MUTATING_RPCS, OPS_READ_ONLY_RPCS } from './ops-rpcs'

export interface OpsDbEnv extends LocalDevFlags {
  OPS_SUPABASE_URL?: string
  OPS_SUPABASE_SECRET_KEY?: string
}

declare const OPS_CLIENT: unique symbol
/**
 * A client of the ops database, and nothing else is one. The brand keeps the
 * bidding client out of readOpsRows at compile time, and is how the scan tells
 * this client from the bidding one. Not typed by tables: no ops database types
 * are generated yet, so the run engine's results are checked at run time by
 * each wrapper in ops-writes.ts, and readOpsRows's rows are typed by its caller.
 */
export type OpsSupabaseClient = SupabaseClient & { readonly [OPS_CLIENT]: 'ops' }

declare const ORGANIZATION_ID: unique symbol
/** A uuid checked by organizationIdFrom. A plain string is not one. */
export type OrganizationId = string & { readonly [ORGANIZATION_ID]: true }

/** A missing or wrong ops database setting, refused by name. */
export class OpsDatabaseConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpsDatabaseConfigError'
  }
}

/** A failed or refused ops read. Carries the table and the database's code, never a row. */
export class OpsReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpsReadError'
  }
}

/**
 * The bidding database's project ref. The ops Worker must never hold a client of
 * it (plan 0.E: no main service key on ops), so a URL naming it is refused even
 * when the key beside it would work.
 */
const BIDDING_PROJECT_REF = 'xvrmivmpfykwwtriqwpg'

/**
 * The ops database's functions, classified in ops-rpcs.ts. Under the local dev
 * guard a mutating one, or one on neither list, is refused against a remote
 * database.
 */
const OPS_RPCS: RpcClassification = {
  readOnly: new Set<string>(OPS_READ_ONLY_RPCS),
  mutating: new Set<string>(OPS_MUTATING_RPCS),
  listFile: 'apps/worker/src/ops/ops-rpcs.ts',
}

/** PostgREST answers at most this many rows to one read (the project's max rows). */
export const OPS_READ_ROW_CAP = 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The one way to make an OrganizationId: refuses anything that is not a uuid. */
export function organizationIdFrom(value: unknown): OrganizationId {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new OpsReadError(`An ops read's organization id must be a uuid, and ${JSON.stringify(value) ?? 'undefined'} is not one`)
  }
  return value as OrganizationId
}

function databaseUrlFrom(env: OpsDbEnv): string {
  const raw = env.OPS_SUPABASE_URL
  if (typeof raw !== 'string' || raw.trim() === '') throw new OpsDatabaseConfigError('OPS_SUPABASE_URL is not set, so the ops database cannot be reached')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OpsDatabaseConfigError('OPS_SUPABASE_URL is not a URL, so the ops database cannot be reached')
  }
  if (url.hostname.split('.')[0] === BIDDING_PROJECT_REF) {
    throw new OpsDatabaseConfigError('OPS_SUPABASE_URL names the bidding database, which the ops Worker must never reach')
  }
  return raw
}

/**
 * A client of the ops database, connecting with OPS_SUPABASE_SECRET_KEY: a named
 * secret key (sb_secret_...) that Dan creates for the ops Worker, which acts as
 * service_role. The project's legacy anon and service_role keys are disabled and
 * its legacy JWT secret revoked (2026-10-16), so it is never one of those.
 * Carries the local dev write guard the bidding client carries (#669).
 * `options.fetch` is for tests.
 */
export function createOpsSupabaseClient(env: OpsDbEnv, options: { fetch?: typeof fetch } = {}): OpsSupabaseClient {
  const url = databaseUrlFrom(env)
  if (typeof env.OPS_SUPABASE_SECRET_KEY !== 'string' || env.OPS_SUPABASE_SECRET_KEY.trim() === '') {
    throw new OpsDatabaseConfigError('OPS_SUPABASE_SECRET_KEY is not set, so the ops database cannot be reached')
  }
  const client = createClient(url, env.OPS_SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  })
  return guardLocalDevWrites(client, env, url, OPS_RPCS) as OpsSupabaseClient
}

// The type of `client.from(table).select(columns)`, the builder refine is
// handed. Declared, never emitted: it only names the shape.
declare const opsTable: ReturnType<SupabaseClient['from']>
type OpsQuery = ReturnType<typeof opsTable.select<'*'>>

export interface OpsRead {
  table: string
  /** A PostgREST select list. organization_id is added when absent, so every row can be checked. */
  columns: string
  /** 1 to OPS_READ_ROW_CAP. Required, so nobody takes a capped read for the whole table. */
  limit: number
  /** Further filters and ordering, applied after the organization filter, which they cannot remove. */
  refine?: (query: OpsQuery) => OpsQuery
}

export interface OpsReadResult<Row> {
  rows: Row[]
  /** The read returned as many rows as its limit, so there may be more. */
  reachedLimit: boolean
}

/**
 * Whether the row's OWN columns name organization_id: the select list split at
 * the top level only, so a name inside an embedded resource such as
 * `steps(id,organization_id)` does not count. A renamed column
 * (`org:organization_id`) does not count either, so the plain column is added
 * and every row still carries the key the check below reads.
 */
function namesOwnOrganizationId(columns: string): boolean {
  const top: string[] = []
  let depth = 0
  let current = ''
  for (const ch of columns) {
    if (ch === '(') depth++
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) { top.push(current); current = ''; continue }
    if (depth === 0 && ch !== ')') current += ch
  }
  top.push(current)
  return top.some((c) => c.trim() === 'organization_id')
}

/**
 * The only read of the ops database (L18). Filters on the organization, refuses
 * a row of another one, and throws on a database error rather than answering no
 * rows.
 */
export async function readOpsRows<Row extends object>(
  client: OpsSupabaseClient,
  organizationId: OrganizationId,
  read: OpsRead,
): Promise<OpsReadResult<Row & { organization_id: string }>> {
  // The type erases at run time, so a forced cast is caught here (L688).
  organizationIdFrom(organizationId)
  if (read.table.trim() === '') throw new OpsReadError('An ops read\'s table is required')
  if (read.columns.trim() === '') throw new OpsReadError(`An ops read of ${read.table}: columns are required`)
  if (!Number.isInteger(read.limit) || read.limit < 1 || read.limit > OPS_READ_ROW_CAP) {
    throw new OpsReadError(`An ops read of ${read.table}: limit must be a whole number from 1 to ${OPS_READ_ROW_CAP}, not ${read.limit}`)
  }

  const columns = read.columns.trim() === '*' || namesOwnOrganizationId(read.columns) ? read.columns : `${read.columns},organization_id`
  let query: OpsQuery = client.from(read.table).select(columns as '*').eq('organization_id', organizationId)
  if (read.refine) query = read.refine(query)
  const { data, error } = await query.limit(read.limit)

  if (error) throw new OpsReadError(`An ops read of ${read.table} failed (${error.code ?? 'no code'}): ${error.message}`)
  const rows = (data ?? []) as unknown as Array<Row & { organization_id: string }>
  if (rows.some((row) => row.organization_id !== organizationId)) {
    throw new OpsReadError(`An ops read of ${read.table} returned a row of another organization, so none are returned`)
  }
  return { rows, reachedLimit: rows.length === read.limit }
}
