/**
 * Buyer sales routes (#1412, Phase 5):
 *
 *   GET  /buyer-sales?status=unresolved&page=&limit=   the queue, from the mirror, paged
 *   POST /buyer-sales/:id/settle  { outcome }          settle one sale as accepted or released
 *
 * Settle is a LEDGER operation first (L83, the violation recorded on #1412). The
 * ledger is the one home of the fact the caps count from, so the route reads the
 * sale's key from its buyer_sales row, settles the ledger with the caller as the
 * actor, and only then mirrors the settled entry to buyer_sales through
 * record_buyer_sale, inline. A mirror that fails leaves the entry unmirrored for
 * the drain and is reported in the answer; it never fails the settlement (L33).
 * The direct settle_buyer_sale function is gone: a settlement written to the
 * mirror alone would keep holding a slot and dollars in the ledger.
 */
import { Hono } from 'hono'
import { SALE_STATUSES, type SaleStatus } from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { writeAuditLog } from '../../lib/audit'
import { BuyerLedgerClient, ObjectCallError } from '../../lib/buyer-object-clients'
import { buildBuyerSaleRow, mirrorBuyerSale } from '../../lib/buyer-sale-mirror'
import type { CapLimits, EntryKey, SaleOutcomeRecord } from '../../durable-objects/buyer-ledger'
import type { LedgerKind, Population } from '@bidspoke/buyer-profile'

const buyerSales = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

// ── The queue ─────────────────────────────────────────────────────────────────

buyerSales.get('/', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const status = c.req.query('status') ?? 'unresolved'
  if (!(SALE_STATUSES as readonly string[]).includes(status)) {
    return c.json({ error: 'status_invalid', message: `status must be one of ${SALE_STATUSES.join(', ')}` }, 400)
  }
  const page = Number(c.req.query('page') ?? '1')
  const limit = Number(c.req.query('limit') ?? String(DEFAULT_LIMIT))
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return c.json({ error: 'page_invalid', message: `page is 1 or more and limit is 1 to ${MAX_LIMIT}` }, 400)
  }
  const from = (page - 1) * limit
  const { data, error, count } = await supabase
    .from('buyer_sales')
    .select('*, partner_configs(slug, name)', { count: 'exact' })
    .eq('organization_id', orgId)
    .eq('status', status)
    .order('reserved_at', { ascending: true })
    .range(from, from + limit - 1)
  if (error) return dbError(c, error)
  return c.json({ entries: data ?? [], total: count ?? 0, page, limit })
})

// ── Settle ────────────────────────────────────────────────────────────────────

interface SettleRequest {
  outcome?: unknown
}

interface SaleRowForSettle {
  id: string
  partner_id: string
  organization_id: string
  lead_key: string
  population: string
  kind: string
  status: string
  payout_cents: number
  debt: number | string | null
  multiplier: number | string | null
  workflow_id: string | null
  trace_id: string | null
  http_status: number | null
  buyer_reference: string | null
  live_percent_in_force: number | null
  caps_in_force: unknown
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v))

buyerSales.post('/:id/settle', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const body = await c.req.json<SettleRequest>()
  if (body.outcome !== 'accepted' && body.outcome !== 'released') {
    return c.json({ error: 'outcome_invalid', message: 'A settlement is accepted (it counts as sold) or released (it frees the slot).' }, 400)
  }
  const outcome: 'accepted' | 'released' = body.outcome

  const { data, error } = await supabase
    .from('buyer_sales')
    .select('*, partner_configs(slug, name)')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'Sale not found' }, 404)
  const row = data as unknown as SaleRowForSettle

  const key: EntryKey = { lead_key: row.lead_key, population: row.population as Population, kind: row.kind as LedgerKind }
  const record: SaleOutcomeRecord | undefined = outcome === 'accepted'
    ? { buyer_reference: row.buyer_reference ?? null, result_code: 'settled', http_status: row.http_status ?? null, payout_cents: row.payout_cents }
    : undefined

  const ledger = new BuyerLedgerClient(c.env.BUYER_LEDGER, row.partner_id)
  let entry
  try {
    entry = await ledger.settle(key, outcome, record, userId)
  } catch (err) {
    if (err instanceof ObjectCallError) {
      let parsed: { error?: string; status?: string } = {}
      try {
        parsed = JSON.parse(err.body) as { error?: string; status?: string }
      } catch {
        parsed = {}
      }
      if (err.status === 409) return c.json({ error: 'not_unresolved', status: parsed.status ?? 'unknown' }, 409)
      if (err.status === 404) return c.json({ error: 'Sale not found in the ledger', detail: parsed.error ?? null }, 404)
    }
    console.error(`[buyer-sales] settle failed for ${id}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'ledger_unavailable', message: 'The buyer ledger did not answer, so nothing was settled.' }, 503)
  }

  // Inline mirror, the same path the node uses after a sale. Its failure is
  // reported and left for the drain; the settlement itself already happened.
  let mirrored = true
  let mirrorError: string | null = null
  try {
    const mirrorRow = await buildBuyerSaleRow(entry, {
      partner_id: row.partner_id,
      organization_id: orgId,
      workflow_id: row.workflow_id,
      trace_id: row.trace_id,
      debt: num(row.debt),
      multiplier: num(row.multiplier),
      live_percent_in_force: row.live_percent_in_force,
      caps_in_force: (row.caps_in_force as CapLimits | null) ?? null,
    })
    await mirrorBuyerSale(supabase, mirrorRow, entry, { markMirrored: (k) => ledger.markMirrored([k]).then(() => undefined) })
  } catch (err) {
    mirrored = false
    mirrorError = err instanceof Error ? err.message : 'non Error thrown'
    console.error(`[buyer-sales] mirror after settle failed for ${id}, the drain will deliver it: ${mirrorError}`)
  }

  await writeAuditLog(supabase, orgId, 'buyer_sale', id, 'updated', userId, { status: { old: row.status as SaleStatus, new: outcome } })

  return c.json(mirrored ? { entry, mirrored } : { entry, mirrored, mirror_error: mirrorError })
})

export default buyerSales
