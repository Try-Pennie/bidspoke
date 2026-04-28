/**
 * Bid matrix lookup — given a partner_bid_config and the trigger payload,
 * find the bid_matrix_row whose row/range bands contain the payload values.
 *
 * Used by bid-resolver.ts when bid_resolver_type='matrix'.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext } from '../types'

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

export async function lookupMatrixBid(
  configId: string,
  ctx: ExecutionContext,
  supabase: SupabaseClient,
  options: { use_sell_off?: boolean } = {}
): Promise<MatrixLookupResult> {
  const { data: configRaw, error: configErr } = await supabase
    .from('partner_bid_configs')
    .select('id, is_active, dimensions, last_synced_at')
    .eq('id', configId)
    .single()

  if (configErr || !configRaw) {
    throw new Error(`partner_bid_config not found: ${configId}`)
  }

  const config = configRaw as unknown as BidConfigForLookup

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

  const isSellOff = options.use_sell_off ?? false

  const { data: rowsRaw, error: rowsErr } = await supabase
    .from('bid_matrix_rows')
    .select('id, is_sell_off, row_id, row_low, row_high, range_low, range_high, bid_amount')
    .eq('config_id', configId)
    .eq('is_sell_off', isSellOff)

  if (rowsErr) {
    throw new Error(`bid_matrix_rows query failed: ${rowsErr.message}`)
  }

  const rows = (rowsRaw ?? []) as unknown as MatrixRow[]

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
