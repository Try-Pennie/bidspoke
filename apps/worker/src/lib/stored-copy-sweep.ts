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
 *   on, points at another workflow or source, or its workflow trigger now asks
 *   for another auth method.
 * - Partner copies (`partner-lastgood:`): cleared when the partner is gone or its
 *   updated_at has moved since the copy was written.
 *
 * It also CONFIRMS (#1847). A copy is served for at most STORED_COPY_MAX_AGE_MS
 * after it was last confirmed against the database, and a busy address or
 * partner is confirmed by its own lookups, but one no lead has reached for half
 * an hour would age out on a healthy day. So an endpoint or partner copy that
 * agrees with its row, and is due (STORED_COPY_RECONFIRM_AFTER_MS old or
 * unstamped), is rewritten stamped now: the endpoint copy from the row, the
 * partner copy as held, since an equal updated_at means an equal row (the
 * partner_configs_updated_at trigger moves it on every update). Only what was
 * compared is confirmed; a copy that disagrees is cleared, never stamped.
 *
 * A confirmation races an edit like any other writer: one whose row read came
 * before an edit can rewrite the old copy just after the edit's route retired
 * it. The next run, a minute later, finds it disagreeing with the row and clears
 * it, so the window is one run, the same one every lookup's own write has.
 * - Workflow definition copies (`workflow-def-lastgood:`): refreshed through the
 *   route's own refreshWorkflowCaches when the row is gone, its stamp is newer
 *   than the copy's, or the copy is marked unverified. The refresh writes a
 *   refusing tombstone for a deleted or switched off workflow, never deletes.
 * - Bid matrix copies (`bid-matrix-lastgood:`, #1849): no single stamp moves
 *   when a matrix row changes, so each held copy's config and rows are read
 *   through the lookup's own reader every run and compared by content: a copy
 *   that differs is rewritten stamped now, one whose config is gone is deleted,
 *   and an equal one is confirmed when due. No route retires these copies, so
 *   this run is what bounds a matrix edit's reach into an outage, to a minute.
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
import { endpointCopyOf, endpointLastGoodKey, retireEndpointCopies, sameEndpointCopy } from './endpoint-copies'
import { confirmedAt, isDueForReconfirm, readConfirmedCopy } from './stored-copy-age'
import { partnerLastGoodKey, retirePartnerLastGood } from './partner-last-good'
import { bidMatrixLastGoodKey, readBidMatrix, type BidMatrix } from './bid-matrix-lookup'
import { postgresTimeMicros, refreshWorkflowCaches, workflowCopyKey } from '../engine/definition-loader'
import { formatErr } from './format-error'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../types/database'
import { fetchAllPaged } from './paginate'

export interface EndpointRow {
  id: string
  subdomain: string
  path: string
  workflow_id: string
  source_name: string
  is_active: boolean
  /** The auth method the endpoint's workflow trigger names, as the lookup reads it. */
  trigger_auth_method: string | null
}
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
  /** A bid matrix config and one side of its rows, read as the lookup reads them; null when the config is gone. */
  bidMatrix(configId: string, sellOff: boolean): Promise<BidMatrix | null>
}

export interface SweepResult {
  /** Copies seen. */
  checked: number
  /** Keys of copies cleared or refreshed. */
  repaired: string[]
  /** Keys of copies that agreed with their rows and were stamped as confirmed now (#1847). */
  reconfirmed: string[]
  /** What could not be swept, and why. */
  failed: string[]
}

/** `ep-lastgood:`, taken from the key builder so the two cannot drift. */
export const ENDPOINT_PREFIX = endpointLastGoodKey('', '').slice(0, -1)
export const PARTNER_PREFIX = partnerLastGoodKey('')
export const WORKFLOW_PREFIX = workflowCopyKey('')
/** `bid-matrix-lastgood:`, taken from the key builder so the two cannot drift. */
const MATRIX_PREFIX = `${bidMatrixLastGoodKey('', false).split(':')[0]}:`

/** A matrix copy's config and side, read back through the key builder; null for a key no lookup writes. */
function matrixCopyOf(key: string): { configId: string; sellOff: boolean } | null {
  const rest = key.slice(MATRIX_PREFIX.length)
  const cut = rest.lastIndexOf(':')
  if (cut <= 0) return null
  const configId = rest.slice(0, cut)
  for (const sellOff of [false, true]) if (bidMatrixLastGoodKey(configId, sellOff) === key) return { configId, sellOff }
  return null
}

/** Every key under `prefix`, all pages. Throws when KV does. The stale copy check lists with it too (#1848). */
export async function listKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
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
  return (await readJsonConfirmed(kv, key))?.copy ?? null
}

/** A copy parsed (an unparseable one as an empty object, which matches no row) with its confirmation time. */
async function readJsonConfirmed(kv: KVNamespace, key: string): Promise<{ copy: Record<string, unknown>; raw: string; confirmedAt: unknown } | null> {
  const held = await readConfirmedCopy(kv, key)
  if (held === null) return null
  let copy: Record<string, unknown> = {}
  try {
    const v = JSON.parse(held.value) as unknown
    if (v && typeof v === 'object') copy = v as Record<string, unknown>
  } catch {
    copy = {}
  }
  return { copy, raw: held.value, confirmedAt: held.confirmedAt }
}

export async function sweepStoredCopies(kv: KVNamespace, sources: SweepSources, options: { now?: () => number } = {}): Promise<SweepResult> {
  const now = options.now ?? Date.now
  const result: SweepResult = { checked: 0, repaired: [], reconfirmed: [], failed: [] }

  const reconfirm = async (key: string, value: string) => {
    try {
      await kv.put(key, value, confirmedAt(now()))
      result.reconfirmed.push(key)
    } catch (e) {
      result.failed.push(`${key}: ${formatErr(e)}`)
    }
  }

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
      if (cut < 0) {
        // No route reads a key without an address in it, so it is deleted exactly.
        await repair(key, () => kv.delete(key))
        continue
      }
      const subdomain = rest.slice(0, cut)
      const path = rest.slice(cut + 1)
      const held = await readJsonConfirmed(kv, key)
      if (held === null) continue
      const row = byAddress.get(key)
      const expected = row === undefined ? undefined : endpointCopyOf(row, row.trigger_auth_method)
      if (expected === undefined || !sameEndpointCopy(held.copy, expected)) {
        await repair(key, () => retireEndpointCopies(kv, subdomain, path))
      } else if (isDueForReconfirm(held.confirmedAt, now())) {
        await reconfirm(key, JSON.stringify(expected))
      }
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
      const held = await readJsonConfirmed(kv, key)
      if (held === null) continue
      const stamp = stamps.get(id)
      if (stamp === undefined || held.copy.updated_at !== stamp) {
        await repair(key, () => retirePartnerLastGood(kv, id))
      } else if (isDueForReconfirm(held.confirmedAt, now())) {
        await reconfirm(key, held.raw)
      }
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
      const stale = rowStamp === undefined || !Number.isFinite(rowStamp) || !Number.isFinite(copyStamp) || copyStamp < rowStamp || copy.unverified === true
      if (stale) await repair(key, () => sources.refreshWorkflow(id))
    }
  })

  await kind('bid matrix copies', async () => {
    const keys = await listKeys(kv, MATRIX_PREFIX)
    for (const key of keys) {
      result.checked++
      const subject = matrixCopyOf(key)
      if (subject === null) {
        // No lookup reads a key it cannot have written, so it is deleted exactly.
        await repair(key, () => kv.delete(key))
        continue
      }
      const held = await readConfirmedCopy(kv, key)
      if (held === null) continue
      let fresh: BidMatrix | null
      try {
        fresh = await sources.bidMatrix(subject.configId, subject.sellOff)
      } catch (e) {
        // A read that failed is not a config that is gone (L211): leave the copy.
        result.failed.push(`${key}: ${formatErr(e)}`)
        continue
      }
      if (fresh === null) {
        await repair(key, () => kv.delete(key))
        continue
      }
      const value = JSON.stringify(fresh)
      if (value !== held.value) {
        await repair(key, () => kv.put(key, value, confirmedAt(now())))
      } else if (isDueForReconfirm(held.confirmedAt, now())) {
        await reconfirm(key, value)
      }
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
    endpoints: async () => {
      // The trigger's auth method is read as one field, not the whole
      // definition, and through the same inner join the lookup uses, so an
      // endpoint whose workflow is gone has no row here, as it has none there.
      const rows = await fetchAllPaged<Omit<EndpointRow, 'trigger_auth_method'> & { workflows: { auth_method: string | null } | null }>(
        (from, to) => supabase
          .from('webhook_endpoints')
          .select('id, subdomain, path, workflow_id, source_name, is_active, workflows!inner(auth_method:definition->trigger->config->>auth_method)')
          .order('id')
          .range(from, to),
        'stored copy sweep: webhook_endpoints',
        // Every row or none: a short read would clear copies whose rows exist.
        { maxPages: 50 },
      )
      return rows.map(({ workflows, ...row }) => ({ ...row, trigger_auth_method: workflows?.auth_method ?? null }))
    },
    // paginate-ok: at most ID_CHUNK rows a request, one per id asked for.
    partners: (ids) => inChunks(ids, (chunk) => supabase.from('partner_configs').select('id, updated_at').in('id', chunk)),
    // paginate-ok: at most ID_CHUNK rows a request, one per id asked for.
    workflows: (ids) => inChunks(ids, (chunk) => supabase.from('workflows').select('id, updated_at').in('id', chunk)),
    refreshWorkflow: (id) => refreshWorkflowCaches(id, kv, supabase),
    // The lookup's own reader, so the sweep compares exactly what a lead would copy.
    bidMatrix: (configId, sellOff) => readBidMatrix(supabase as unknown as SupabaseClient, configId, sellOff),
  }
}
