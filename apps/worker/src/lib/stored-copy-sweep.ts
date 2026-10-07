/**
 * The stored copy sweep (#1846): every minute, compare each stored outage copy
 * with the row it was made from, and repair the ones that disagree.
 *
 * Every edit route refreshes or clears its copies right after its write. When KV
 * refuses that, the route says so and carries on, but repeating the edit cannot
 * always repeat the clear: a deleted row is gone, a created endpoint answers 409,
 * and a re-applied rename finds nothing left to rewrite. So nothing would ever
 * clear such a copy, and in a database outage it would serve the old version.
 * This sweep is what clears it, whatever route left it, while the database is up.
 *
 * - Endpoint copies (`ep-lastgood:`): cleared, with their hot copy, when no row
 *   holds the address, or the row there is another endpoint, is switched off or
 *   on, or points at another workflow or source.
 * - Partner copies (`partner-lastgood:`): cleared when the partner is gone or its
 *   updated_at has moved since the copy was written.
 * - Workflow definition copies (`workflow-def-lastgood:`): refreshed through the
 *   route's own refreshWorkflowCaches when the row is gone, its stamp is newer
 *   than the copy's, or the copy is marked unverified. The refresh writes a
 *   refusing tombstone for a deleted or switched off workflow, never deletes.
 *
 * The copies a healthy read rewrites (org env vars, partner constants, buyer
 * profiles) are rebuilt from the database by the prewarm in the same cron, so
 * they need no sweep.
 *
 * Each kind is swept on its own, so a failed read of one leaves only that kind
 * unswept. A row read that fails leaves every copy of that kind alone rather
 * than reading absence as deletion (L211). A clear KV refuses is named and
 * retried on the next run.
 */
import { endpointLastGoodKey, retireEndpointCopies } from './endpoint-copies'
import { partnerLastGoodKey, retirePartnerLastGood } from './partner-last-good'
import { postgresTimeMicros, refreshWorkflowCaches, workflowCopyKey } from '../engine/definition-loader'
import { formatErr } from './format-error'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { fetchAllPaged } from './paginate'

export interface EndpointRow { id: string; subdomain: string; path: string; workflow_id: string; source_name: string; is_active: boolean }
export interface StampedRow { id: string; updated_at: string }

/** Where the sweep reads rows from. Each read throws when it cannot answer. */
export interface SweepSources {
  /** Every webhook endpoint. */
  endpoints(): Promise<EndpointRow[]>
  /** The partners with these ids that still exist. */
  partners(ids: string[]): Promise<StampedRow[]>
  /** The workflows with these ids that still exist. */
  workflows(ids: string[]): Promise<StampedRow[]>
  /** Rewrite a workflow's caches and copy from its row. */
  refreshWorkflow(id: string): Promise<void>
}

export interface SweepResult {
  /** Copies seen. */
  checked: number
  /** Keys of copies cleared or refreshed. */
  repaired: string[]
  /** What could not be swept, and why. */
  failed: string[]
}

/** `ep-lastgood:`, taken from the key builder so the two cannot drift. */
const ENDPOINT_PREFIX = endpointLastGoodKey('', '').slice(0, -1)
const PARTNER_PREFIX = partnerLastGoodKey('')
const WORKFLOW_PREFIX = workflowCopyKey('')

async function listKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page: KVNamespaceListResult<unknown> = await kv.list({ prefix, cursor })
    for (const k of page.keys) names.push(k.name)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return names
}

async function readJson(kv: KVNamespace, key: string): Promise<Record<string, unknown> | null> {
  const raw = await kv.get(key)
  if (raw === null) return null
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export async function sweepStoredCopies(kv: KVNamespace, sources: SweepSources): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, repaired: [], failed: [] }

  const repair = async (key: string, work: () => Promise<void>) => {
    try {
      await work()
      result.repaired.push(key)
    } catch (e) {
      result.failed.push(`${key}: ${formatErr(e)}`)
    }
  }

  const kind = async (name: string, sweep: () => Promise<void>) => {
    try {
      await sweep()
    } catch (e) {
      result.failed.push(`${name}: ${formatErr(e)}`)
    }
  }

  await kind('endpoint copies', async () => {
    const keys = await listKeys(kv, ENDPOINT_PREFIX)
    if (keys.length === 0) return
    const rows = await sources.endpoints()
    const byAddress = new Map(rows.map((r) => [endpointLastGoodKey(r.subdomain, r.path), r]))
    for (const key of keys) {
      result.checked++
      // The subdomain holds no colon; the path after it may.
      const rest = key.slice(ENDPOINT_PREFIX.length)
      const cut = rest.indexOf(':')
      const subdomain = rest.slice(0, cut)
      const path = rest.slice(cut + 1)
      const copy = await readJson(kv, key)
      if (copy === null) continue
      const row = byAddress.get(key)
      const same = row !== undefined && copy.id === row.id && copy.is_active === row.is_active && copy.workflow_id === row.workflow_id && copy.source_name === row.source_name
      if (!same) await repair(key, () => retireEndpointCopies(kv, subdomain, path))
    }
  })

  await kind('partner copies', async () => {
    const keys = await listKeys(kv, PARTNER_PREFIX)
    if (keys.length === 0) return
    const ids = keys.map((k) => k.slice(PARTNER_PREFIX.length)).sort()
    const stamps = new Map((await sources.partners(ids)).map((r) => [r.id, r.updated_at]))
    for (const id of ids) {
      result.checked++
      const key = partnerLastGoodKey(id)
      const copy = await readJson(kv, key)
      if (copy === null) continue
      const stamp = stamps.get(id)
      if (stamp === undefined || copy.updated_at !== stamp) await repair(key, () => retirePartnerLastGood(kv, id))
    }
  })

  await kind('workflow definition copies', async () => {
    const keys = await listKeys(kv, WORKFLOW_PREFIX)
    if (keys.length === 0) return
    const ids = keys.map((k) => k.slice(WORKFLOW_PREFIX.length)).sort()
    const stamps = new Map((await sources.workflows(ids)).map((r) => [r.id, postgresTimeMicros(r.updated_at)]))
    for (const id of ids) {
      result.checked++
      const key = workflowCopyKey(id)
      const copy = await readJson(kv, key)
      if (copy === null) continue
      const rowStamp = stamps.get(id)
      const copyStamp = typeof copy.row_updated_at === 'string' ? postgresTimeMicros(copy.row_updated_at) : Number.NaN
      // A tombstone for a row that is gone is already right.
      if (rowStamp === undefined && copy.is_active === false && copy.unverified !== true) continue
      const stale = rowStamp === undefined || !Number.isFinite(copyStamp) || copyStamp < rowStamp || copy.unverified === true
      if (stale) await repair(key, () => sources.refreshWorkflow(id))
    }
  })

  return result
}

/** Ids per `in` filter, which travels in the request address. */
const ID_CHUNK = 100

/** Reads rows by id, ID_CHUNK at a time. */
async function inChunks(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<StampedRow[]> {
  const rows: StampedRow[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await read(ids.slice(i, i + ID_CHUNK))
    if (error) throw new Error(error.message)
    rows.push(...((data ?? []) as StampedRow[]))
  }
  return rows
}

/**
 * The sweep's rows, read with the cron's own client. Each read throws on a
 * database error, so the sweep leaves that kind of copy alone (L211).
 */
export function sweepSources(supabase: SupabaseClient<Database>, kv: KVNamespace): SweepSources {
  return {
    endpoints: () =>
      fetchAllPaged<EndpointRow>(
        (from, to) => supabase.from('webhook_endpoints').select('id, subdomain, path, workflow_id, source_name, is_active').order('id').range(from, to),
        'stored copy sweep: webhook_endpoints',
        // Every row or none: a short read would clear copies whose rows exist.
        { maxPages: 50 },
      ),
    // paginate-ok: at most ID_CHUNK rows a request, one per id asked for.
    partners: (ids) => inChunks(ids, (chunk) => supabase.from('partner_configs').select('id, updated_at').in('id', chunk)),
    // paginate-ok: at most ID_CHUNK rows a request, one per id asked for.
    workflows: (ids) => inChunks(ids, (chunk) => supabase.from('workflows').select('id, updated_at').in('id', chunk)),
    refreshWorkflow: (id) => refreshWorkflowCaches(id, kv, supabase),
  }
}
