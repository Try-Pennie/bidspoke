/**
 * Buyer sales routes (#1412, Phase 5):
 *
 *   GET  /buyer-sales?status=unresolved&page=&limit=&partner_id=   the queue, from the mirror, paged, one buyer when asked
 *   POST /buyer-sales/:id/settle  { outcome }          settle one sale as accepted or released
 *   POST /buyer-sales/:id/recopy                       copy one sale again from the ledger (#2422)
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
  // One buyer's queue (#1457): the partner page used to read the whole queue and
  // keep this buyer's rows, so rows past the first page were never shown while
  // the total still read as complete. The filter and the count now come from the
  // same query (L16). An empty value is refused rather than matched, because
  // eq('partner_id', '') answers with an empty queue that looks like nothing
  // waiting (L100).
  const partnerId = c.req.query('partner_id')
  if (partnerId !== undefined && partnerId.trim() === '') {
    return c.json({ error: 'partner_id_invalid', message: 'partner_id, when given, is a partner id' }, 400)
  }
  const from = (page - 1) * limit
  let query = supabase
    .from('buyer_sales')
    .select('*, partner_configs(slug, name)', { count: 'exact' })
    .eq('organization_id', orgId)
    .eq('status', status)
  if (partnerId !== undefined) query = query.eq('partner_id', partnerId)
  const { data, error, count } = await query
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

// ── Re-copy ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `error` name in a ledger refusal's body, or null when it has none or does not parse. */
function ledgerErrorName(body: string): string | null {
  try {
    return (JSON.parse(body) as { error?: string }).error ?? null
  } catch {
    return null
  }
}

/**
 * POST /buyer-sales/:id/recopy, no body (#2422).
 *
 * Who may call it: any signed in member of an organization (the JWT middleware on
 * /api), as with settle. Whose data it touches: one buyer_sales row of the
 * caller's own organization, found by id AND organization, and that sale's
 * ledger entry; another organization's id is 404 and its ledger is never asked.
 *
 * It clears the ledger's copied mark for the sale, so the minute drain copies
 * the ledger's own state over the row through record_buyer_sale. It never
 * changes the entry's status, outcome, payout or resolution, so no cap or spend
 * moves; the copy itself is written by the drain, never here. The repair for a
 * copy a mark froze before the mark checked the state it read.
 */
buyerSales.post('/:id/recopy', async (c) => {
  const { orgId, userId } = c.get('user')
  const id = c.req.param('id')
  if (!UUID_RE.test(id)) return c.json({ error: 'Sale not found' }, 404)
  const supabase = createSupabaseClient(c.env)

  const { data, error } = await supabase
    .from('buyer_sales')
    .select('id, partner_id, lead_key, population, kind, status')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return blocked
  if (!data) return c.json({ error: 'Sale not found' }, 404)
  const row = data as unknown as Pick<SaleRowForSettle, 'id' | 'partner_id' | 'lead_key' | 'population' | 'kind' | 'status'>
  const key: EntryKey = { lead_key: row.lead_key, population: row.population as Population, kind: row.kind as LedgerKind }

  const ledger = new BuyerLedgerClient(c.env.BUYER_LEDGER, row.partner_id)
  let result
  try {
    result = await ledger.clearMirrored(key)
  } catch (err) {
    if (err instanceof ObjectCallError && err.status === 404) {
      return c.json({ error: 'Sale not found in the ledger', detail: ledgerErrorName(err.body) }, 404)
    }
    console.error(`[buyer-sales] recopy failed for ${id}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'ledger_unavailable', message: 'The buyer ledger did not answer, so nothing was re-queued.' }, 503)
  }

  await writeAuditLog(supabase, orgId, 'buyer_sale', id, 'buyer_sale_recopy_requested', userId, {
    copy_status: row.status,
    ledger_status: result.entry.status,
    requeued: result.cleared,
  })

  return c.json({ requeued: result.cleared, entry: result.entry })
})

export default buyerSales
