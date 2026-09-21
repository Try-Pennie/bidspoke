/**
 * The normalised outcome of a buyer sale, as both objects store it (#1410): the
 * ledger on commit and settle, the claim on sold and heal. One parser, so the
 * two cannot accept different shapes (L370).
 */
export interface SaleOutcomeRecord {
  buyer_reference: string | null
  result_code: string | null
  http_status: number | null
  payout_cents: number
}

export function parseOutcome(value: unknown): SaleOutcomeRecord | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const payout = v.payout_cents
  if (typeof payout !== 'number' || !Number.isInteger(payout) || payout < 0) return null
  const str = (x: unknown): string | null | undefined => (x === null || x === undefined ? null : typeof x === 'string' ? x : undefined)
  const buyer_reference = str(v.buyer_reference)
  const result_code = str(v.result_code)
  const http_status = v.http_status === null || v.http_status === undefined ? null : typeof v.http_status === 'number' ? v.http_status : undefined
  if (buyer_reference === undefined || result_code === undefined || http_status === undefined) return null
  return { buyer_reference, result_code, http_status, payout_cents: payout }
}
