/**
 * Held click routes (#1552): the clicks buyer_click_send left held, and a
 * person's release of each.
 *
 *   GET  /held-clicks?partner_id=               one buyer's held clicks, each with its claim's live state
 *   POST /held-clicks/:id/mark-sent  { generation, buyer_lead_id }   the buyer has the lead
 *   POST /held-clicks/:id/free       { generation }                  the buyer does not have it
 *   POST /held-clicks/:id/clear                                      remove an entry whose claim is no longer held
 *
 * The claim in the LeadSaleObject is the authority; held_click_claims only says
 * which claims to ask about, because an object cannot be listed. So every read
 * asks the object, and every release is a compare and set on the generation the
 * page read (L157): a stale page is refused by name, never acted on. The route
 * reads the claim first so it can refuse a send still inside its window, which
 * the object's own free would allow (the node frees its own refused sends).
 *
 * Mark sent heals the claim to sold with the lead id the person confirmed in the
 * buyer's system, then adds the prospect to the click count of the Pacific day
 * the click was HELD, which is the day the buyer received it, so a late release
 * never takes an offer from today's cap. The count is a set, so a click the node
 * already counted is not counted twice. A count that fails is reported on a sale
 * that stands (L33).
 *
 * The list entry is deleted only while its last_execution_id is still the one
 * this route read, so a hold recorded while the person acted is not deleted with
 * the old one. Every release is audited with the claim's old and new state (L529).
 */
import { Hono, type Context } from 'hono'
import { withDeadline } from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { writeAuditLog } from '../../lib/audit'
import { isNoRowMatchedError, requireRowsAffected } from '../../lib/db-retry'
import { ClickCounterClient, CLICK_CLAIM_KIND, isPartnerId, LeadSaleClient, OBJECT_CALL_DEADLINE_MS } from '../../lib/buyer-object-clients'
import { GenerationMovedError, WrongStateError } from '../../lib/buyer-sale-attempt'
import type { SaleState } from '../../durable-objects/lead-sale'

type HeldClicksEnv = { Bindings: Env; Variables: AuthVariables }
type Ctx = Context<HeldClicksEnv>

const heldClicks = new Hono<HeldClicksEnv>()

/** The most held clicks one read returns. A held click is an exception a person clears, so more than this is its own alarm. */
export const HELD_CLICKS_LIMIT = 100

/** What the page is told about one claim. */
export type HeldClaimView =
  | { status: 'held'; generation: number }
  | { status: 'sending'; generation: number; releasable_at: string }
  | { status: 'free'; generation: number }
  | { status: 'sold'; generation: number; partner_lead_id: string | null }
  | { status: 'unreadable'; message: string }

interface HeldRow {
  id: string
  organization_id: string
  partner_id: string
  prospect_id: string
  reason: string
  detail: string
  partner_lead_id: string | null
  workflow_id: string | null
  execution_id: string
  held_at: string
  last_execution_id: string
  last_seen_at: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A buyer's lead id as a person pastes it: trimmed, no spaces inside, bounded. */
const LEAD_ID_SHAPE = /^\S{1,200}$/

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'non Error thrown'
}

function saleClient(env: Env, row: Pick<HeldRow, 'partner_id' | 'prospect_id'>): LeadSaleClient {
  return new LeadSaleClient(env.LEAD_SALE, { kind: CLICK_CLAIM_KIND, partner_id: row.partner_id, prospect_id: row.prospect_id }, { deadlineMs: OBJECT_CALL_DEADLINE_MS })
}

/** The one reading of a claim's state for a person, shared by the list and the releases (L342). */
export function viewOf(state: SaleState, nowMs: number): Exclude<HeldClaimView, { status: 'unreadable' }> {
  switch (state.state) {
    case 'in_doubt':
      return { status: 'held', generation: state.generation }
    case 'in_flight': {
      const until = state.since + state.deadline_ms
      return until <= nowMs
        ? { status: 'held', generation: state.generation }
        : { status: 'sending', generation: state.generation, releasable_at: new Date(until).toISOString() }
    }
    case 'free':
      return { status: 'free', generation: state.generation }
    case 'sold':
      return { status: 'sold', generation: state.generation, partner_lead_id: state.outcome.buyer_reference }
  }
}

// ── The list ──────────────────────────────────────────────────────────────────

heldClicks.get('/', async (c) => {
  const { orgId } = c.get('user')
  const partnerId = c.req.query('partner_id')
  // Required: an absent or malformed id would list nothing, which reads as nothing held (L100).
  if (!isPartnerId(partnerId)) return c.json({ error: 'partner_id_invalid', message: 'partner_id is a partner id.' }, 400)

  const supabase = createSupabaseClient(c.env)
  const { data, error, count } = await supabase
    .from('held_click_claims')
    .select('*', { count: 'exact' })
    .eq('organization_id', orgId)
    .eq('partner_id', partnerId)
    .order('held_at', { ascending: true })
    .range(0, HELD_CLICKS_LIMIT - 1)
  if (error) return dbError(c, error)
  const rows = (data ?? []) as HeldRow[]

  const now = Date.now()
  const entries = await Promise.all(rows.map(async (row) => {
    let claim: HeldClaimView
    try {
      claim = viewOf(await saleClient(c.env, row).read(), now)
    } catch (err) {
      claim = { status: 'unreadable', message: `The claim did not answer: ${messageOf(err)}` }
    }
    return {
      id: row.id, prospect_id: row.prospect_id, reason: row.reason, detail: row.detail, partner_lead_id: row.partner_lead_id,
      workflow_id: row.workflow_id, execution_id: row.execution_id, held_at: row.held_at, last_seen_at: row.last_seen_at, claim,
    }
  }))
  return c.json({ entries, total: count ?? rows.length })
})

// ── Releases ──────────────────────────────────────────────────────────────────

type Loaded = { row: HeldRow } | { response: Response }

async function loadRow(c: Ctx, id: string, orgId: string): Promise<Loaded> {
  // A malformed id is simply not found; sent to the uuid column it would be a database error.
  if (!UUID.test(id)) return { response: c.json({ error: 'not_found', message: 'That held click does not exist.' }, 404) }
  const supabase = createSupabaseClient(c.env)
  const { data, error } = await supabase.from('held_click_claims').select('*').eq('id', id).eq('organization_id', orgId).single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return { response: blocked }
  if (!data) return { response: c.json({ error: 'not_found', message: 'That held click does not exist.' }, 404) }
  return { row: data }
}

const CHANGED_MESSAGE = 'This click changed since the page was read, so nothing was done. Reload to see where it stands.'

function notHeldMessage(view: HeldClaimView): string {
  if (view.status === 'free') return 'This click is no longer held: its claim is free, so the next click on this prospect sends. Nothing was changed.'
  if (view.status === 'sold') return `This click is no longer held: it is already marked sent${view.partner_lead_id ? ` as ${view.partner_lead_id}` : ''}. Nothing was changed.`
  return 'This click is no longer held. Nothing was changed.'
}

/**
 * Reads the claim and decides whether a release may go ahead at the generation
 * the page read. Returns the state it read, or the refusal to answer with.
 */
async function precheck(c: Ctx, row: HeldRow, generation: number): Promise<{ state: SaleState } | { response: Response }> {
  let state: SaleState
  try {
    state = await saleClient(c.env, row).read()
  } catch (err) {
    console.error(`[held-clicks] claim read failed for ${row.id}: ${messageOf(err)}`)
    return { response: c.json({ error: 'claim_unavailable', message: 'The claim did not answer, so nothing was done. Try again in a minute.' }, 503) }
  }
  if (state.generation !== generation) return { response: c.json({ error: 'claim_changed', message: CHANGED_MESSAGE }, 409) }
  const view = viewOf(state, Date.now())
  if (view.status === 'sending') {
    return { response: c.json({ error: 'still_sending', releasable_at: view.releasable_at, message: `A send on this prospect is still inside its window, so nothing was done. It can be released after ${view.releasable_at}.` }, 409) }
  }
  if (view.status === 'free' || view.status === 'sold') return { response: c.json({ error: 'not_held', claim: view.status, message: notHeldMessage(view) }, 409) }
  return { state }
}

/** Maps the object's refusals of the compare and set; anything else is the object not answering. */
function refusalOf(c: Ctx, row: HeldRow, err: unknown): Response {
  if (err instanceof GenerationMovedError) return c.json({ error: 'claim_changed', message: CHANGED_MESSAGE }, 409)
  if (err instanceof WrongStateError) {
    const view = viewOf(err.current, Date.now())
    if (view.status === 'free' || view.status === 'sold') return c.json({ error: 'not_held', claim: view.status, message: notHeldMessage(view) }, 409)
    return c.json({ error: 'claim_changed', message: CHANGED_MESSAGE }, 409)
  }
  console.error(`[held-clicks] claim release failed for ${row.id}: ${messageOf(err)}`)
  return c.json({ error: 'claim_unavailable', message: 'The claim did not answer, so nothing was done. Try again in a minute.' }, 503)
}

/** Deletes the entry only while it is still the hold this route read. True when it was deleted. */
async function clearEntry(env: Env, row: HeldRow, orgId: string): Promise<boolean> {
  const supabase = createSupabaseClient(env)
  // Zero rows is an answer, not a failure: a newer hold replaced the entry, and it stays.
  const { rows, error } = await requireRowsAffected('held_click_claims', () =>
    supabase
      .from('held_click_claims')
      .delete()
      .eq('id', row.id)
      .eq('organization_id', orgId)
      .eq('last_execution_id', row.last_execution_id)
      .select('id'),
  )
  if (error && !isNoRowMatchedError(error)) {
    console.error(`[held-clicks] clearing ${row.id} failed: ${error.message}`)
    return false
  }
  return rows.length === 1
}

function subjectOf(row: HeldRow) {
  return { partner_id: row.partner_id, prospect_id: row.prospect_id, reason: row.reason, held_at: row.held_at }
}

function generationOf(body: Record<string, unknown>): number | null {
  const g = body.generation
  return typeof g === 'number' && Number.isInteger(g) && g >= 0 ? g : null
}

async function bodyOf(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json<unknown>()
    return b !== null && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

heldClicks.post('/:id/mark-sent', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await bodyOf(c)
  const generation = generationOf(body)
  if (generation === null) return c.json({ error: 'generation_invalid', message: 'generation is the whole number the page read.' }, 400)
  const leadId = typeof body.buyer_lead_id === 'string' ? body.buyer_lead_id.trim() : ''
  if (!LEAD_ID_SHAPE.test(leadId)) return c.json({ error: 'buyer_lead_id_invalid', message: 'Enter the lead id the buyer shows for this prospect, with no spaces.' }, 400)

  const loaded = await loadRow(c, c.req.param('id'), orgId)
  if ('response' in loaded) return loaded.response
  const { row } = loaded
  const checked = await precheck(c, row, generation)
  if ('response' in checked) return checked.response

  let next: number
  try {
    next = await saleClient(c.env, row).heal(generation, { buyer_reference: leadId, result_code: 'marked_sent', http_status: null, payout_cents: 0 })
  } catch (err) {
    return refusalOf(c, row, err)
  }

  // The day the click was held is the day the buyer received it.
  let count: { added: boolean; count: number; date: string } | null = null
  let countError: string | null = null
  const counter = new ClickCounterClient(c.env.DAILY_CAP, c.env.WORKFLOW_CACHE, row.partner_id, Date.parse(row.held_at))
  try {
    const added = await withDeadline(counter.addMember(row.prospect_id), OBJECT_CALL_DEADLINE_MS, 'click counter add')
    count = { ...added, date: counter.date }
  } catch (err) {
    countError = messageOf(err)
    console.error(`[held-clicks] count after mark sent failed for ${row.id}: ${countError}`)
  }

  const supabase = createSupabaseClient(c.env)
  await writeAuditLog(supabase, orgId, 'held_click', row.id, 'updated', userId, {
    claim_state: { old: checked.state.state, new: 'sold' },
    claim_generation: { old: generation, new: next },
    buyer_lead_id: { old: null, new: leadId },
    subject: subjectOf(row),
  })
  const listCleared = await clearEntry(c.env, row, orgId)
  return c.json(count
    ? { outcome: 'sent', generation: next, count, list_cleared: listCleared }
    : { outcome: 'sent', generation: next, count: null, count_error: countError, count_date: counter.date, list_cleared: listCleared })
})

heldClicks.post('/:id/free', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await bodyOf(c)
  const generation = generationOf(body)
  if (generation === null) return c.json({ error: 'generation_invalid', message: 'generation is the whole number the page read.' }, 400)

  const loaded = await loadRow(c, c.req.param('id'), orgId)
  if ('response' in loaded) return loaded.response
  const { row } = loaded
  const checked = await precheck(c, row, generation)
  if ('response' in checked) return checked.response

  let next: number
  try {
    next = await saleClient(c.env, row).free(generation)
  } catch (err) {
    return refusalOf(c, row, err)
  }

  const supabase = createSupabaseClient(c.env)
  await writeAuditLog(supabase, orgId, 'held_click', row.id, 'updated', userId, {
    claim_state: { old: checked.state.state, new: 'free' },
    claim_generation: { old: generation, new: next },
    subject: subjectOf(row),
  })
  const listCleared = await clearEntry(c.env, row, orgId)
  return c.json({ outcome: 'freed', generation: next, list_cleared: listCleared })
})

heldClicks.post('/:id/clear', async (c) => {
  const { orgId, userId } = c.get('user')
  const loaded = await loadRow(c, c.req.param('id'), orgId)
  if ('response' in loaded) return loaded.response
  const { row } = loaded

  let view: HeldClaimView
  try {
    view = viewOf(await saleClient(c.env, row).read(), Date.now())
  } catch (err) {
    console.error(`[held-clicks] claim read failed for ${row.id}: ${messageOf(err)}`)
    return c.json({ error: 'claim_unavailable', message: 'The claim did not answer, so nothing was removed. Try again in a minute.' }, 503)
  }
  // Only an entry whose claim is no longer held may go: a held click is never hidden.
  if (view.status !== 'free' && view.status !== 'sold') {
    return c.json({ error: 'still_held', message: 'This click is still held, so it stays on the list. Mark it sent or free it.' }, 409)
  }
  const listCleared = await clearEntry(c.env, row, orgId)
  if (listCleared) {
    const supabase = createSupabaseClient(c.env)
    await writeAuditLog(supabase, orgId, 'held_click', row.id, 'deleted', userId, {
      held_click: { old: subjectOf(row), new: null },
      claim_state: { old: view.status, new: view.status },
    })
  }
  return c.json({ outcome: 'cleared', claim: view.status, list_cleared: listCleared })
})

export default heldClicks
