/**
 * Reads and writes porting.pipedream_inventory through the Data API (#1710).
 *
 * Plain fetch with the service key, so the operator scripts need no client
 * library. Every failure throws with the status and the body (L10, L11): a read
 * that fails must never come back as an empty inventory, which the planner would
 * read as nothing stored. Reads page in hashid order, the unique key, so pages
 * neither skip nor repeat (L746). Writes are upserts on the hashid and carry
 * every column but porting_stage; each batch's returned rows are counted and a
 * short count refuses (L12).
 */
import { INVENTORY_COLUMNS, type InventoryRow, type StoredRow } from './plan-load.ts'

export const PAGE = 1000
const BATCH = 200
const TABLE = 'pipedream_inventory'

const headers = (key: string, extra: Record<string, string>) => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra })

async function failure(res: Response, what: string): Promise<Error> {
  const body = await res.text().catch(() => '')
  return new Error(`${what} failed with ${res.status}: ${body.slice(0, 500)}`)
}

export async function readStoredRows(f: typeof fetch, url: string, key: string): Promise<StoredRow[]> {
  const out: StoredRow[] = []
  for (let offset = 0; ; offset += PAGE) {
    const q = `select=${INVENTORY_COLUMNS.join(',')}&order=pipedream_hashid.asc&limit=${PAGE}&offset=${offset}`
    const res = await f(`${url}/rest/v1/${TABLE}?${q}`, { headers: headers(key, { 'Accept-Profile': 'porting' }) })
    if (!res.ok) throw await failure(res, `reading porting.${TABLE}`)
    const page = (await res.json()) as unknown
    if (!Array.isArray(page)) throw new Error(`reading porting.${TABLE}: the answer is not a list`)
    out.push(...(page as StoredRow[]))
    if (page.length < PAGE) return out
  }
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
