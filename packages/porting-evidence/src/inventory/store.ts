/**
 * Reads and writes porting.pipedream_inventory through the Data API (#1710).
 *
 * Plain fetch with the service key, so the operator scripts need no client
 * library. Every failure throws with the status and the body (L10, L11): a read
 * that fails must never come back as an empty inventory, which the planner would
 * read as nothing stored. Reads page in hashid order, the unique key, so pages
 * neither skip nor repeat (L746). Writes are upserts on the hashid and carry
 * every export column and none of BIDSPOKE_OWNED_COLUMNS; each batch's returned
 * rows are counted and a short count refuses (L12). A person's decisions (#2979)
 * are read and written here too, one decision at a time.
 */
import type { DecisionTarget, DecisionWrite, Decisions, DroppedStep, Retirement } from './decisions.ts'
import { INVENTORY_COLUMNS, type InventoryRow, type StoredRow } from './plan-load.ts'

export const PAGE = 1000
const BATCH = 200
const TABLE = 'pipedream_inventory'
const DROPPED = 'dropped_steps'
const RETIREMENT = 'pipedream_hashid,retired_by,retired_reason,retired_at'
const DROPPED_COLUMNS = 'pipedream_hashid,step,dropped_by,reason,dropped_at'

const headers = (key: string, extra: Record<string, string>) => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra })

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  return new Error(`${what} failed with ${res.status}: ${body.slice(0, 500)}`)
}

/** Every row of a porting table a query selects, paged in an order over a unique key so pages neither skip nor repeat (L746). */
async function readAll<T>(f: typeof fetch, url: string, key: string, table: string, query: Record<string, string>): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const q = new URLSearchParams({ ...query, limit: String(PAGE), offset: String(offset) })
    const res = await f(`${url}/rest/v1/${table}?${q.toString()}`, { headers: headers(key, { 'Accept-Profile': 'porting' }) })
    if (!res.ok) throw await failure(res, `reading porting.${table}`)
    const page = (await res.json()) as unknown
    if (!Array.isArray(page)) throw new Error(`reading porting.${table}: the answer is not a list`)
    out.push(...(page as T[]))
    if (page.length < PAGE) return out
  }
}

/**
 * The stored row of one workflow, or null when the inventory holds none (#1695).
 * The converter reads it to decide whether the export it was given is the newest
 * recorded snapshot. A failed read throws rather than answering null, which
 * would read as a workflow never loaded.
 */
export async function readStoredRow(f: typeof fetch, url: string, key: string, hashid: string): Promise<StoredRow | null> {
  // The same shape the table's CHECK holds every hashid to, so nothing else reaches the query string.
  if (!/^p_[A-Za-z0-9]+$/.test(hashid)) throw new Error(`${hashid} is not a Pipedream workflow id`)
  const q = `select=${INVENTORY_COLUMNS.join(',')}&pipedream_hashid=eq.${hashid}&limit=2`
  const res = await f(`${url}/rest/v1/${TABLE}?${q}`, { headers: headers(key, { 'Accept-Profile': 'porting' }) })
  if (!res.ok) throw await failure(res, `reading porting.${TABLE} for ${hashid}`)
  const rows = (await res.json()) as unknown
  if (!Array.isArray(rows)) throw new Error(`reading porting.${TABLE} for ${hashid}: the answer is not a list`)
  if (rows.length > 1) throw new Error(`reading porting.${TABLE}: ${rows.length} rows for ${hashid}, where the hashid is the key`)
  return rows.length === 0 ? null : (rows[0] as StoredRow)
}

export async function readStoredRows(f: typeof fetch, url: string, key: string): Promise<StoredRow[]> {
  return readAll<StoredRow>(f, url, key, TABLE, { select: INVENTORY_COLUMNS.join(','), order: 'pipedream_hashid.asc' })
}

/** Every retirement and every dropped step (#2979). A failed read throws, never reading as no decisions. */
export async function readDecisions(f: typeof fetch, url: string, key: string): Promise<Decisions> {
  const retired = await readAll<Retirement>(f, url, key, TABLE, { select: RETIREMENT, porting_stage: 'eq.retired', order: 'pipedream_hashid.asc' })
  const dropped = await readAll<DroppedStep>(f, url, key, DROPPED, { select: DROPPED_COLUMNS, order: 'pipedream_hashid.asc,step.asc' })
  return { retired, dropped }
}

/** What is stored for one workflow a decision names: its inventory row (null when absent) and its dropped steps. */
export async function readDecisionTarget(f: typeof fetch, url: string, key: string, hashid: string): Promise<DecisionTarget> {
  const rows = await readAll<NonNullable<DecisionTarget['row']>>(f, url, key, TABLE, { select: `name,porting_stage,${RETIREMENT}`, pipedream_hashid: `eq.${hashid}`, order: 'pipedream_hashid.asc' })
  if (rows.length > 1) throw new Error(`reading porting.${TABLE}: ${rows.length} rows for ${hashid}, which is its primary key`)
  const dropped = await readAll<DroppedStep>(f, url, key, DROPPED, { select: DROPPED_COLUMNS, pipedream_hashid: `eq.${hashid}`, order: 'step.asc' })
  return { row: rows[0] ?? null, dropped }
}

/**
 * Writes one planned decision. A retirement and its undoing are filtered on the
 * stage they were planned from, so a change made since the read writes nothing,
 * and any count but one row refuses (L12): the decision is never reported as
 * recorded when it was not.
 */
export async function writeDecision(f: typeof fetch, url: string, key: string, write: DecisionWrite, now: string): Promise<void> {
  const writeHeaders = headers(key, { 'Content-Profile': 'porting', 'Content-Type': 'application/json', Prefer: 'return=representation' })
  let req: { table: string; filter: Record<string, string>; method: string; body?: unknown }
  switch (write.kind) {
    case 'retire':
      req = { table: TABLE, method: 'PATCH', filter: { pipedream_hashid: `eq.${write.hashid}`, porting_stage: 'eq.none' }, body: { ...write.set, updated_at: now } }
      break
    case 'unretire':
      req = { table: TABLE, method: 'PATCH', filter: { pipedream_hashid: `eq.${write.hashid}`, porting_stage: 'eq.retired' }, body: { porting_stage: 'none', retired_by: null, retired_reason: null, retired_at: null, updated_at: now } }
      break
    case 'drop_step':
      req = { table: DROPPED, method: 'POST', filter: {}, body: [write.row] }
      break
    case 'keep_step':
      req = { table: DROPPED, method: 'DELETE', filter: { pipedream_hashid: `eq.${write.hashid}`, step: `eq.${write.step}` } }
      break
  }
  const q = new URLSearchParams(req.filter).toString()
  const res = await f(`${url}/rest/v1/${req.table}${q ? `?${q}` : ''}`, { method: req.method, headers: writeHeaders, ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }) })
  if (!res.ok) throw await failure(res, `writing porting.${req.table}`)
  const back = (await res.json()) as unknown
  const n = Array.isArray(back) ? back.length : 0
  if (n !== 1) throw new Error(`writing porting.${req.table}: ${n} row(s) changed, expected 1; what is stored changed since it was read, so read the plan again`)
}

/** Upserts the rows, stamping updated_at; returns the number written. */
export async function writeRows(f: typeof fetch, url: string, key: string, rows: InventoryRow[], now: string): Promise<number> {
  let written = 0
  for (let at = 0; at < rows.length; at += BATCH) {
    const batch = rows.slice(at, at + BATCH).map((r) => ({ ...r, updated_at: now }))
    const res = await f(`${url}/rest/v1/${TABLE}?on_conflict=pipedream_hashid`, {
      method: 'POST',
      headers: headers(key, { 'Content-Profile': 'porting', 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(batch),
    })
    if (!res.ok) {
      const err = await failure(res, `writing porting.${TABLE}`)
      throw new Error(`${err.message}; ${written} row(s) already written`)
    }
    const back = (await res.json()) as unknown
    const n = Array.isArray(back) ? back.length : 0
    if (n !== batch.length) throw new Error(`writing porting.${TABLE}: ${batch.length} sent but ${n} written; ${written} row(s) already written before this batch`)
    written += n
  }
  return written
}

/**
 * Every way the stored rows differ from the rows just written: a missing row, or a
 * column stored as something else. Times compare as instants, since the database
 * spells them its own way. Empty means the write landed as planned.
 */
export function differencesAfterWrite(planned: InventoryRow[], stored: StoredRow[]): string[] {
  const by = new Map(stored.map((r) => [r.pipedream_hashid, r]))
  const out: string[] = []
  for (const r of planned) {
    const got = by.get(r.pipedream_hashid)
    if (!got) { out.push(`${r.pipedream_hashid} missing`); continue }
    for (const c of INVENTORY_COLUMNS) {
      const a = r[c]
      const b = got[c]
      const same = c.endsWith('_at') && typeof a === 'string' && typeof b === 'string'
        ? Date.parse(a) === Date.parse(b)
        : JSON.stringify(a) === JSON.stringify(b)
      if (!same) out.push(`${r.pipedream_hashid}.${c}: planned ${JSON.stringify(a)}, stored ${JSON.stringify(b)}`)
    }
  }
  return out
}
