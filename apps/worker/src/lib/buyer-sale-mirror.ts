/**
 * The buyer_sales mirror (#1411, Phase 6 shares it): one ledger entry becomes
 * one buyer_sales row through record_buyer_sale.
 *
 * The row id is DERIVED from the partner and the entry's key rather than minted,
 * so the inline mirror after a sale and the minute drain that delivers what the
 * inline mirror missed write the same row, and the rpc's upsert on id makes the
 * second write harmless (L15, L186). Every row carries the full key set the rpc
 * requires, unknown values as explicit nulls, so a row from either writer
 * touches the same columns (L705).
 *
 * The rpc returns the stored row. The entry is marked mirrored in the ledger
 * only when that row is the one we sent, by id (L581); a different id is a
 * refusal, an error is thrown to the caller, and in both cases the entry stays
 * unmirrored for the drain to deliver (L33).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CapLimits, EntryKey, LedgerEntry } from '../durable-objects/buyer-ledger'

export interface BuyerSaleRowMeta {
  partner_id: string
  organization_id: string
  workflow_id: string | null
  trace_id: string | null
  debt: number | null
  multiplier: number | null
  live_percent_in_force: number | null
  caps_in_force: CapLimits | null
}

export interface BuyerSaleRow {
  id: string
  partner_id: string
  organization_id: string
  lead_key: string
  population: string
  kind: string
  status: string
  payout_cents: number
  debt: number | null
  multiplier: number | null
  et_day: string
  hour_bucket: string
  workflow_id: string | null
  execution_id: string | null
  trace_id: string | null
  http_status: number | null
  result_code: string | null
  buyer_reference: string | null
  live_percent_in_force: number | null
  caps_in_force: CapLimits | null
  resolution_source: 'buyer' | 'rehearsal' | null
  resolved_by: string | null
}

const webCrypto = (globalThis as unknown as { crypto: Crypto }).crypto

/**
 * A UUID (version 8, the RFC 9562 custom version) from the SHA-256 of the
 * partner id and the entry key. Deterministic, so both writers agree.
 */
export async function buyerSaleRowId(partnerId: string, key: EntryKey): Promise<string> {
  const input = new TextEncoder().encode(`buyer_sale\u0000${partnerId}\u0000${key.lead_key}\u0000${key.population}\u0000${key.kind}`)
  const digest = new Uint8Array(await webCrypto.subtle.digest('SHA-256', input)).slice(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x80
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function buildBuyerSaleRow(entry: LedgerEntry, meta: BuyerSaleRowMeta): Promise<BuyerSaleRow> {
  const resolved = entry.status !== 'reserved'
  return {
    id: await buyerSaleRowId(meta.partner_id, entry),
    partner_id: meta.partner_id,
    organization_id: meta.organization_id,
    lead_key: entry.lead_key,
    population: entry.population,
    kind: entry.kind,
    status: entry.status,
    payout_cents: entry.payout_cents,
    debt: meta.debt,
    multiplier: meta.multiplier,
    et_day: entry.et_day,
    hour_bucket: new Date(entry.hour_bucket * 3_600_000).toISOString(),
    workflow_id: meta.workflow_id,
    // The column is a uuid; a test run's placeholder id must not break the row.
    execution_id: UUID_RE.test(entry.execution_id) ? entry.execution_id : null,
    trace_id: meta.trace_id,
    http_status: entry.outcome?.http_status ?? null,
    result_code: entry.outcome?.result_code ?? null,
    buyer_reference: entry.outcome?.buyer_reference ?? null,
    live_percent_in_force: meta.live_percent_in_force,
    caps_in_force: meta.caps_in_force,
    resolution_source: !resolved ? null : entry.kind === 'rehearsal' ? 'rehearsal' : 'buyer',
    resolved_by: null,
  }
}

export interface MirrorDeps {
  markMirrored: (key: EntryKey) => Promise<void>
}

export async function mirrorBuyerSale(supabase: SupabaseClient, row: BuyerSaleRow, entry: LedgerEntry, deps: MirrorDeps): Promise<void> {
  const { data, error } = (await supabase.rpc('record_buyer_sale', { p_row: row })) as { data: unknown; error: { message: string } | null }
  if (error) throw new Error(`record_buyer_sale failed for ${row.id}: ${error.message}`)
  const stored = data as { id?: unknown } | null
  if (!stored || stored.id !== row.id) {
    throw new Error(`record_buyer_sale returned a different row for ${row.id}: ${JSON.stringify(stored?.id ?? null)}`)
  }
  await deps.markMirrored({ lead_key: entry.lead_key, population: entry.population, kind: entry.kind })
}
