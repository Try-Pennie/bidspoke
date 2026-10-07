/**
 * Bid matrix lookup: given a partner_bid_config and the trigger payload, find
 * the bid_matrix_row whose row/range bands contain the payload values.
 *
 * Used by bid-resolver.ts when bid_resolver_type='matrix'.
 *
 * The last-good copy (#1849). The config and its rows were read on every
 * attempt with no copy behind either, so in a database outage every matrix bid
 * threw. Each successful read now keeps a copy of the config and the rows it
 * read (`bid-matrix-lastgood:<config>:<offer|sell_off>`), stamped in its KV
 * metadata with when it was confirmed, and a read that FAILS bids from it. A
 * config that is genuinely gone is refused and its copy removed, never served.
 * Past STORED_COPY_MAX_AGE_MS the copy is refused by name, like every stored
 * copy. A read rewrites the copy only when it differs from the held copy or the
 * held copy is STORED_COPY_RECONFIRM_AFTER_MS old, keeping KV inside one write
 * a second per key; the per minute stored copy sweep compares every held copy
 * with the database and rewrites one that differs or is due, so a matrix edit
 * reaches the copy within a minute and an idle copy never ages out on a healthy
 * day. Both reads go through leadRead, so on a lead's client they are bounded
 * and never retried.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext } from '../types'
import { isNotFoundError } from './api-error'
import { formatErr } from './format-error'
import { leadRead } from './lead-read-budget'
import { fetchAllPaged } from './paginate'
import { confirmedAt, isDueForReconfirm, judgeCopyAge, readConfirmedCopy, refuseStoredCopy, serveStoredCopy } from './stored-copy-age'

export interface MatrixDimension {
  name: string
  payload_field: string
  column: 'row' | 'range'
}

export interface MatrixLookupResult {
  bid: number | null
  matched_row: {
    id: string
    is_sell_off: boolean
    row_id: string | null
    bid_amount: number
  } | null
  config_id: string
  last_synced_at: string | null
  reason?: string
  /** Present only when the database read failed and the bid came from the last-good copy (#1849). */
  served_from?: 'last_good'
}

interface BidConfigForLookup {
  id: string
  is_active: boolean
  dimensions: MatrixDimension[]
  last_synced_at: string | null
}

interface MatrixRow {
  id: string
  is_sell_off: boolean
  row_id: string | null
  row_low: number | null
  row_high: number | null
  range_low: number | null
  range_high: number | null
  bid_amount: number
}

/** A config and the rows of one side of its matrix, as read: the content of the last-good copy. */
export interface BidMatrix {
  config: BidConfigForLookup
  rows: MatrixRow[]
}

/** The KV key of a config's last-good copy, one per side of the matrix. */
export const bidMatrixLastGoodKey = (configId: string, sellOff: boolean): string => `bid-matrix-lastgood:${configId}:${sellOff ? 'sell_off' : 'offer'}`

/** A read of the config or its rows that failed, as distinct from a config that is not there. */
export class BidMatrixReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BidMatrixReadError'
  }
}

/**
 * The config and one side of its rows, from the database. Null when the config
 * is genuinely gone; throws BidMatrixReadError when either read fails. The rows
 * of an inactive config are not read: it bids nothing. Used by the lookup and by
 * the stored copy sweep, so both see the same content.
 */
export async function readBidMatrix(supabase: SupabaseClient, configId: string, sellOff: boolean): Promise<BidMatrix | null> {
  const { data, error } = await leadRead(
    supabase,
    supabase.from('partner_bid_configs').select('id, is_active, dimensions, last_synced_at').eq('id', configId).single(),
    'bid matrix config',
  )
  if (error) {
    if (isNotFoundError(error)) return null
    throw new BidMatrixReadError(`partner_bid_config ${configId} could not be read (${error.message})`)
  }
  if (!data) return null
  const config = data as unknown as BidConfigForLookup
  if (!config.is_active) return { config, rows: [] }

  // Fetch every row for this config, deterministically ordered, and paged so a
  // matrix larger than the PostgREST page cap isn't silently truncated (#71).
  // Order: row_low, then range_low, then id. With inclusive bands, the first
  // matching row in this order is the LOWEST band, so an overlap or a lead
  // sitting exactly on a shared boundary always resolves to the same row
  // (lower band wins) instead of whatever the database happened to return
  // first. nullsFirst puts an unbounded-low row (row_low/range_low = null)
  // first: it is the lowest possible band. The id tiebreaker makes the order
  // fully stable, which fetchAllPaged needs to page without skips or dupes.
  try {
    const rows = await fetchAllPaged<MatrixRow>(
      (from, to) => leadRead(
        supabase,
        supabase
          .from('bid_matrix_rows')
          .select('id, is_sell_off, row_id, row_low, row_high, range_low, range_high, bid_amount')
          .eq('config_id', configId)
          .eq('is_sell_off', sellOff)
          .order('row_low', { ascending: true, nullsFirst: true })
          .order('range_low', { ascending: true, nullsFirst: true })
          .order('id', { ascending: true })
          .range(from, to),
        'bid matrix rows',
      ),
      'bid_matrix_rows lookup',
    )
    return { config, rows }
  } catch (err) {
    throw new BidMatrixReadError(`partner_bid_config ${configId} could not be read (its rows: ${formatErr(err)})`)
  }
}

/**
 * Write the copy, stamped as confirmed at `nowMs`, when the held copy differs or
 * is due to be confirmed again. Judged against the held copy itself rather than
 * a record kept in the isolate, so the module holds no state. Never throws: the
 * bid must not fail because the safety copy could not be written.
 */
export async function rememberBidMatrix(kv: KVNamespace | undefined, configId: string, sellOff: boolean, matrix: BidMatrix, nowMs: number): Promise<void> {
  if (!kv) return
  const key = bidMatrixLastGoodKey(configId, sellOff)
  try {
    const value = JSON.stringify(matrix)
    const held = await readConfirmedCopy(kv, key)
    if (held && held.value === value && !isDueForReconfirm(held.confirmedAt, nowMs)) return
    await kv.put(key, value, confirmedAt(nowMs))
  } catch (e) {
    console.error(`[bid-matrix] last-good write failed for ${key}: ${formatErr(e)}`)
  }
}

/** Remove both sides' copies of a config the database says is gone. Never throws: the caller is already refusing the bid. */
async function dropBidMatrixCopies(kv: KVNamespace | undefined, configId: string): Promise<void> {
  for (const sellOff of [false, true]) {
    const key = bidMatrixLastGoodKey(configId, sellOff)
    if (!kv) continue
    try {
      if ((await kv.get(key)) !== null) await kv.delete(key)
    } catch (e) {
      console.error(`[bid-matrix] could not remove the last-good copy ${key} of a missing config: ${formatErr(e)}`)
    }
  }
}

/**
 * The copy, read only after a failed database read: null when there is none, or
 * when KV would not hand it back or it does not parse, each counted and logged
 * as its own refusal (#1848). Throws StoredCopyRefusedError, with the refusal
 * logged, when it is past the maximum age or carries no readable confirmation
 * (#1847). A copy served is counted and logged through the shared serve.
 */
async function readBidMatrixLastGood(kv: KVNamespace | undefined, configId: string, sellOff: boolean, dbError: string, nowMs: number): Promise<BidMatrix | null> {
  if (!kv) return null
  const subject = `${configId} (${sellOff ? 'sell off' : 'offer'})`
  let held: Awaited<ReturnType<typeof readConfirmedCopy>>
  try {
    held = await readConfirmedCopy(kv, bidMatrixLastGoodKey(configId, sellOff))
  } catch (e) {
    console.error(`[bid-matrix] the last-good copy of ${subject} could not be read: ${formatErr(e)}`)
    refuseStoredCopy({ copy: 'bid_matrix', subject, reason: 'copy_unusable', ageMs: null, dbError })
    return null
  }
  if (!held) {
    refuseStoredCopy({ copy: 'bid_matrix', subject, reason: 'no_copy', ageMs: null, dbError })
    return null
  }
  let copy: BidMatrix | null
  try {
    copy = JSON.parse(held.value) as BidMatrix
  } catch {
    copy = null
  }
  if (!copy || typeof copy !== 'object' || !copy.config || !Array.isArray(copy.rows)) {
    refuseStoredCopy({ copy: 'bid_matrix', subject, reason: 'copy_unusable', ageMs: null, dbError })
    return null
  }
  const age = judgeCopyAge(held.confirmedAt, nowMs)
  if (!age.usable) throw refuseStoredCopy({ copy: 'bid_matrix', subject, reason: age.reason, ageMs: age.ageMs, dbError })
  serveStoredCopy({ copy: 'bid_matrix', subject, ageMs: age.ageMs, dbError })
  return copy
}

export async function lookupMatrixBid(
  configId: string,
  ctx: ExecutionContext,
  supabase: SupabaseClient,
  options: { use_sell_off?: boolean; kv?: KVNamespace; now?: () => number } = {}
): Promise<MatrixLookupResult> {
  const isSellOff = options.use_sell_off ?? false
  const now = options.now ?? Date.now

  let matrix: BidMatrix
  let fromCopy = false
  try {
    const read = await readBidMatrix(supabase, configId, isSellOff)
    if (!read) {
      await dropBidMatrixCopies(options.kv, configId)
      throw new Error(`partner_bid_config not found: ${configId}`)
    }
    matrix = read
    await rememberBidMatrix(options.kv, configId, isSellOff, matrix, now())
  } catch (err) {
    if (!(err instanceof BidMatrixReadError)) throw err
    // A copy past the maximum age is refused by name inside the read (#1847).
    const copy = await readBidMatrixLastGood(options.kv, configId, isSellOff, err.message, now())
    if (!copy) throw new Error(`${err.message}, and there is no stored copy to bid from`, { cause: err })
    console.error(`[bid-matrix] read failed; bidding from the last-good copy of ${configId}: ${err.message}`)
    matrix = copy
    fromCopy = true
  }

  const result = evaluateMatrix(configId, matrix, ctx)
  return fromCopy ? { ...result, served_from: 'last_good' } : result
}

/** The bid the matrix gives this lead: the same answer from the database and from the copy. */
function evaluateMatrix(configId: string, matrix: BidMatrix, ctx: ExecutionContext): MatrixLookupResult {
  const { config, rows } = matrix

  if (!config.is_active) {
    return { bid: null, matched_row: null, config_id: configId, last_synced_at: config.last_synced_at, reason: 'config_inactive' }
  }

  const dims = Array.isArray(config.dimensions) ? config.dimensions : []
  const rowDim = dims.find((d) => d.column === 'row')
  if (!rowDim) {
    throw new Error(`partner_bid_config ${configId} has no row dimension configured`)
  }
  const rangeDim = dims.find((d) => d.column === 'range') ?? null

  const payload = (ctx.trigger.payload ?? {}) as Record<string, unknown>
  const rowVal = readPayloadNumber(payload, rowDim.payload_field)
  const rangeVal = rangeDim ? readPayloadNumber(payload, rangeDim.payload_field) : null

  if (rowVal === null) {
    return {
      bid: null,
      matched_row: null,
      config_id: configId,
      last_synced_at: config.last_synced_at,
      reason: `missing_payload_field:${rowDim.payload_field}`,
    }
  }
  if (rangeDim && rangeVal === null) {
    return {
      bid: null,
      matched_row: null,
      config_id: configId,
      last_synced_at: config.last_synced_at,
      reason: `missing_payload_field:${rangeDim.payload_field}`,
    }
  }

  const match = rows.find((r) => {
    if (!withinBand(rowVal, r.row_low, r.row_high)) return false
    if (rangeDim) {
      if (rangeVal === null) return false
      if (!withinBand(rangeVal, r.range_low, r.range_high)) return false
    }
    return true
  })

  if (!match) {
    return {
      bid: null,
      matched_row: null,
      config_id: configId,
      last_synced_at: config.last_synced_at,
      reason: 'no_matching_cell',
    }
  }

  return {
    bid: Number(match.bid_amount),
    matched_row: {
      id: match.id,
      is_sell_off: match.is_sell_off,
      row_id: match.row_id,
      bid_amount: Number(match.bid_amount),
    },
    config_id: configId,
    last_synced_at: config.last_synced_at,
  }
}

function readPayloadNumber(payload: Record<string, unknown>, field: string): number | null {
  const parts = field.split('.')
  let cur: unknown = payload
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[part]
  }
  if (typeof cur === 'number') return cur
  if (typeof cur === 'string') {
    const n = parseFloat(cur)
    return isNaN(n) ? null : n
  }
  return null
}

function withinBand(value: number, low: number | null, high: number | null): boolean {
  if (low !== null && value < Number(low)) return false
  if (high !== null && value > Number(high)) return false
  return true
}
