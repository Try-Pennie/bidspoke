/**
 * Held click routes (#1552): the clicks buyer_click_send left held, and a
 * person's release of each.
 *
 *   GET  /held-clicks?partner_id=               one buyer's held clicks, each with its claim's live state
 *   POST /held-clicks/:id/mark-sent  { generation, buyer_lead_id? }  the buyer has the lead (the id is optional, PM-7)
 *   POST /held-clicks/:id/free       { generation }                  the buyer does not have it
 *   POST /held-clicks/:id/clear                                      remove an entry whose claim is no longer held
 *   POST /held-clicks/:id/salesforce                                 write a marked sent click's Salesforce updates again
 *   POST /held-clicks/:id/lead-id    { generation, buyer_lead_id }   add or correct a marked sent sale's lead id (#2139)
 *
 * Who may call: any signed in person of the organization (the JWT middleware on
 * /api). Whose rows: only held_click_claims and audit_log rows of the caller's
 * organization, filtered by organization_id on every read and write here,
 * because the Worker is service_role and RLS does not apply.
 *
 * The claim in the LeadSaleObject is the authority; held_click_claims only says
 * which claims to ask about, because an object cannot be listed. So every read
 * asks the object, and every release is a compare and set on the generation the
 * page read (L157): a stale page is refused by name, never acted on. The route
 * reads the claim first so it can refuse a send still inside its window, which
 * the object's own free would allow (the node frees its own refused sends).
 *
 * Mark sent heals the claim to sold with the lead id the person confirmed in the
 * buyer's system, or with none when they have none (PM-7, #2139), then adds the prospect to the click count of the Pacific day
 * the click was HELD, which is the day the buyer received it, so a late release
 * never takes an offer from today's cap. The count is a set, so a click the node
 * already counted is not counted twice, and an add that got no answer is asked
 * once more (#1766). A count that still fails is reported on a sale that stands
 * (L33), as not_added only when the counter refused it, and as unknown otherwise.
 *
 * Mark sent then writes the click's Salesforce updates (#1659): the Prospect,
 * Submission and Lead bodies a live `sent` click writes, through
 * lib/held-click-sale-writes.ts. The mark stands whatever Salesforce answers,
 * because the buyer does have the lead; each write's outcome is returned and
 * audited, and an entry whose writes did not all land stays on the list so the
 * person can retry them (POST /:id/salesforce, with the lead id the CLAIM holds,
 * never one sent in the request), and so does a sale with no lead id after its
 * writes all land, so the id can be added (see settled()). The updates are the same bodies every time,
 * so a retry, or two at once, is safe. Free writes nothing to Salesforce.
 *
 * A LEAD ID ADDED OR CORRECTED LATER (#2139, decision 3, L1008). A sale marked
 * without a lead id stays on the list after its Salesforce updates land, so the
 * person can add the id once the buyer shows it, or remove the entry. POST
 * /:id/lead-id amends the claim's buyer reference (a compare and set on the
 * generation the page read, every other outcome field unchanged), then writes
 * the Salesforce updates with it. The claim changes first because it is the
 * authority Salesforce is written from: if the run stops between the two, the
 * list reads the claim's id against the id the last updates carried and reports
 * lead_id_not_written, and Retry Salesforce writes the claim's id. Only a sale a
 * person marked sent (result code marked_sent) is amended; a reference the
 * buyer's own answer gave is the buyer's.
 *
 * The list entry is deleted only while its last_execution_id is still the one
 * this route read, so a hold recorded while the person acted is not deleted with
 * the old one. Every release is audited with the claim's old and new state (L529).
 */
import { Hono, type Context } from 'hono'
import { buyerLeadIdOf, salesforceStandingOf, withDeadline, type SalesforceStanding, type SalesforceWritesView } from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { recordAuditLog, writeAuditLog } from '../../lib/audit'
import { isNoRowMatchedError, requireRowsAffected } from '../../lib/db-retry'
import { addAskingOnceMore, addKnownRefused, ClickCounterClient, CLICK_CLAIM_KIND, isPartnerId, LeadSaleClient, OBJECT_CALL_DEADLINE_MS } from '../../lib/buyer-object-clients'
import { GenerationMovedError, WrongStateError } from '../../lib/buyer-sale-attempt'
import type { SaleState } from '../../durable-objects/lead-sale'
import { notAttempted, writeHeldClickSale, type SaleWrites } from '../../lib/held-click-sale-writes'

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

/** The result code a sale a person marked sent carries; only such a sale's lead id is amended here. */
const MARKED_SENT = 'marked_sent'

const LEAD_ID_INVALID = { error: 'buyer_lead_id_invalid', message: 'Enter the lead id the buyer shows for this prospect, with no spaces.' } as const

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
  const claims = await Promise.all(rows.map(async (row): Promise<HeldClaimView> => {
    try {
      return viewOf(await saleClient(c.env, row).read(), now)
    } catch (err) {
      return { status: 'unreadable', message: `The claim did not answer: ${messageOf(err)}` }
    }
  }))
  // A sold entry is on the list only when its Salesforce writes did not all land, when it has no lead id yet (so one can be added), or when its removal did not land, so the page shows the last outcome.
  const soldIds = rows.filter((_, i) => claims[i].status === 'sold').map((r) => r.id)
  const salesforce = await lastSalesforceWrites(c, orgId, soldIds)
  const entries = rows.map((row, i) => {
    const claim = claims[i]
    const writes = claim.status === 'sold' ? salesforce(row.id) : null
    // Where a sold entry stands in Salesforce, read once here for the page (L342): every state but written offers Retry Salesforce.
    const standing: SalesforceStanding | null = claim.status === 'sold' && writes ? salesforceStandingOf(writes, claim.partner_lead_id) : null
    return {
      id: row.id, prospect_id: row.prospect_id, reason: row.reason, detail: row.detail, partner_lead_id: row.partner_lead_id,
      workflow_id: row.workflow_id, execution_id: row.execution_id, held_at: row.held_at, last_seen_at: row.last_seen_at, claim,
      salesforce: writes, salesforce_standing: standing,
    }
  })
  return c.json({ entries, total: count ?? rows.length })
})

function isSaleWrites(v: unknown): v is SaleWrites {
  return v !== null && typeof v === 'object' && Array.isArray((v as SaleWrites).writes) && typeof (v as SaleWrites).complete === 'boolean'
}

/** One entry's latest audited Salesforce writes. */
async function latestSalesforceWrites(c: Ctx, orgId: string, id: string): Promise<SalesforceWritesView> {
  const supabase = createSupabaseClient(c.env)
  // Its OWN newest row that carries salesforce_writes, so other audit rows (this
  // entry's or another's) can never push it out of the read and make it read as none.
  const { data, error } = await supabase
    .from('audit_log')
    .select('changed_at, changes')
    .eq('organization_id', orgId)
    .eq('entity_type', 'held_click')
    .eq('entity_id', id)
    .not('changes->salesforce_writes', 'is', null)
    .order('changed_at', { ascending: false })
    .limit(1)
  if (error) return { status: 'unreadable', message: `The last Salesforce update could not be read: ${error.message}` }
  const r = ((data ?? []) as Array<{ changed_at: string; changes: unknown }>)[0]
  if (!r) return { status: 'none' }
  const changes = r.changes as { salesforce_writes?: { new?: unknown }; buyer_lead_id?: { new?: unknown } } | null
  const writes = changes?.salesforce_writes?.new
  if (!isSaleWrites(writes)) return { status: 'unreadable', message: 'The last Salesforce update was recorded in a shape this page cannot read.' }
  // Writes recorded before #2139 do not carry their lead id; a Mark sent row carries it beside them.
  const besideId = changes?.buyer_lead_id?.new
  const withId = writes.buyer_lead_id === undefined && (typeof besideId === 'string' || besideId === null) ? { ...writes, buyer_lead_id: besideId } : writes
  return { status: 'recorded', at: r.changed_at, writes: withId }
}

/** The latest audited Salesforce writes of each sold entry, one bounded read per entry (at most HELD_CLICKS_LIMIT). */
async function lastSalesforceWrites(c: Ctx, orgId: string, ids: string[]): Promise<(id: string) => SalesforceWritesView> {
  const views = await Promise.all(ids.map((id) => latestSalesforceWrites(c, orgId, id)))
  const byId = new Map(ids.map((id, i) => [id, views[i]]))
  return (id) => byId.get(id) ?? { status: 'none' }
}

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

/** Who acted, carried on every held click audit row as the partner page's own rows carry it (#2139). */
function actorOf(c: Ctx): { name: string | null; email: string } {
  const { name, email } = c.get('user')
  return { name, email }
}

/** The click's Salesforce updates; an unexpected throw is reported on every record rather than lost (L11). */
async function writeSale(c: Ctx, orgId: string, userId: string, row: HeldRow, buyerLeadId: string | null): Promise<SaleWrites> {
  try {
    return await writeHeldClickSale(c.env, createSupabaseClient(c.env), { orgId, userId, row, buyerLeadId })
  } catch (err) {
    const message = messageOf(err)
    console.error(`[held-clicks] Salesforce writes for ${row.id} threw: ${message}`)
    return { ...notAttempted(`the Salesforce updates stopped before they started: ${message}`), buyer_lead_id: buyerLeadId }
  }
}

/**
 * Whether the entry may leave the list once its Salesforce updates are written.
 * A sale with no lead id stays, because the list is the one place its id can be
 * added (L1008); Remove from the list takes it off when no id will come.
 */
function settled(salesforce: SaleWrites, leadId: string | null): boolean {
  return salesforce.complete && leadId !== null
}

/** The recorded outcome a new Salesforce write replaces, for the audit entry's old value (L529). */
async function previousWrites(c: Ctx, orgId: string, id: string): Promise<SaleWrites | { unreadable: string } | null> {
  const before = (await lastSalesforceWrites(c, orgId, [id]))(id)
  return before.status === 'recorded' ? before.writes : before.status === 'unreadable' ? { unreadable: before.message } : null
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
  // Optional (PM-7): nothing typed is no lead id, and the sale is still counted and Completed in Salesforce.
  const parsed = buyerLeadIdOf(body.buyer_lead_id)
  if (!parsed.ok) return c.json(LEAD_ID_INVALID, 400)
  const leadId = parsed.id

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

  // The day the click was held is the day the buyer received it. An add with no answer is
  // asked once more by the same rule buyer_click_send follows (#1766), because it may have
  // landed and the count is a set; the page is told whether the count refused it or whether
  // that is not known, so it never says the click was not added when nobody measured that.
  let count: { added: boolean; count: number; date: string } | null = null
  let countError: string | null = null
  let countFailure: 'not_added' | 'unknown' = 'unknown'
  const counter = new ClickCounterClient(c.env.DAILY_CAP, c.env.WORKFLOW_CACHE, row.partner_id, Date.parse(row.held_at))
  const added = await addAskingOnceMore(() => withDeadline(counter.addMember(row.prospect_id), OBJECT_CALL_DEADLINE_MS, 'click counter add'))
  if (added.result) {
    count = { ...added.result, date: counter.date }
  } else {
    countError = added.failed.map((f) => f.message).join('; asked again: ')
    countFailure = addKnownRefused(added) ? 'not_added' : 'unknown'
    console.error(`[held-clicks] count after mark sent failed for ${row.id} (${countFailure}): ${countError}`)
  }

  // The sale stands whatever Salesforce answers: the buyer has the lead.
  const salesforce = await writeSale(c, orgId, userId, row, leadId)

  const supabase = createSupabaseClient(c.env)
  // The audit entry is the only record of the Salesforce outcome, so whether it landed is part of the answer (L11).
  const auditRecorded = await recordAuditLog(supabase, orgId, 'held_click', row.id, 'updated', userId, {
    claim_state: { old: checked.state.state, new: 'sold' },
    claim_generation: { old: generation, new: next },
    buyer_lead_id: { old: null, new: leadId },
    salesforce_writes: { old: null, new: salesforce },
    subject: subjectOf(row),
    _actor: actorOf(c),
  })
  // An entry whose writes did not all land stays listed, so its retry is on the page; so does one with no lead id, so it can be added.
  const listCleared = settled(salesforce, leadId) ? await clearEntry(c.env, row, orgId) : false
  return c.json(count
    ? { outcome: 'sent', generation: next, count, salesforce, audit_recorded: auditRecorded, list_cleared: listCleared }
    : { outcome: 'sent', generation: next, count: null, count_failure: countFailure, count_error: countError, count_date: counter.date, salesforce, audit_recorded: auditRecorded, list_cleared: listCleared })
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
    _actor: actorOf(c),
  })
  const listCleared = await clearEntry(c.env, row, orgId)
  return c.json({ outcome: 'freed', generation: next, list_cleared: listCleared })
})

heldClicks.post('/:id/salesforce', async (c) => {
  const { orgId, userId } = c.get('user')
  const loaded = await loadRow(c, c.req.param('id'), orgId)
  if ('response' in loaded) return loaded.response
  const { row } = loaded

  let state: SaleState
  try {
    state = await saleClient(c.env, row).read()
  } catch (err) {
    console.error(`[held-clicks] claim read failed for ${row.id}: ${messageOf(err)}`)
    return c.json({ error: 'claim_unavailable', message: 'The claim did not answer, so nothing was written. Try again in a minute.' }, 503)
  }
  if (state.state !== 'sold') {
    return c.json({ error: 'not_sold', message: 'This click is not marked sent, so there is no sale to write to Salesforce. Nothing was written.' }, 409)
  }
  // The lead id the claim was sold with is the authority, none included (PM-7); the request carries none.
  const leadId = state.outcome.buyer_reference || null

  // The outcome this retry replaces, read before writing, so the audit entry carries old and new (L529).
  const previous = await previousWrites(c, orgId, row.id)

  const salesforce = await writeSale(c, orgId, userId, row, leadId)
  const supabase = createSupabaseClient(c.env)
  const auditRecorded = await recordAuditLog(supabase, orgId, 'held_click', row.id, 'updated', userId, {
    salesforce_writes: { old: previous, new: salesforce },
    subject: subjectOf(row),
    _actor: actorOf(c),
  })
  const listCleared = settled(salesforce, leadId) ? await clearEntry(c.env, row, orgId) : false
  return c.json({ outcome: salesforce.complete ? 'written' : 'incomplete', salesforce, audit_recorded: auditRecorded, list_cleared: listCleared })
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
      _actor: actorOf(c),
    })
  }
  return c.json({ outcome: 'cleared', claim: view.status, list_cleared: listCleared })
})

heldClicks.post('/:id/lead-id', async (c) => {
  const { orgId, userId } = c.get('user')
  const body = await bodyOf(c)
  const generation = generationOf(body)
  if (generation === null) return c.json({ error: 'generation_invalid', message: 'generation is the whole number the page read.' }, 400)
  const parsed = buyerLeadIdOf(body.buyer_lead_id)
  if (!parsed.ok) return c.json(LEAD_ID_INVALID, 400)
  if (parsed.id === null) return c.json({ error: 'buyer_lead_id_required', message: 'Enter the lead id the buyer shows for this prospect.' }, 400)
  const leadId = parsed.id

  const loaded = await loadRow(c, c.req.param('id'), orgId)
  if ('response' in loaded) return loaded.response
  const { row } = loaded

  let state: SaleState
  try {
    state = await saleClient(c.env, row).read()
  } catch (err) {
    console.error(`[held-clicks] claim read failed for ${row.id}: ${messageOf(err)}`)
    return c.json({ error: 'claim_unavailable', message: 'The claim did not answer, so nothing was changed. Try again in a minute.' }, 503)
  }
  if (state.generation !== generation) return c.json({ error: 'claim_changed', message: CHANGED_MESSAGE }, 409)
  if (state.state !== 'sold') {
    return c.json({ error: 'not_sold', message: 'This click is not marked sent, so it has no sale whose lead id could change. Nothing was changed.' }, 409)
  }
  if (state.outcome.result_code !== MARKED_SENT) {
    return c.json({ error: 'not_marked_sent', message: "The buyer confirmed this sale itself, so its lead id is the buyer's own and is not changed here. Nothing was changed." }, 409)
  }
  const oldId = state.outcome.buyer_reference || null
  if (oldId === leadId) return c.json({ error: 'lead_id_unchanged', message: `This sale already has the lead id ${leadId}. Nothing was changed.` }, 409)

  // Read before the claim moves, so the audit entry carries what the new writes replace (L529).
  const previous = await previousWrites(c, orgId, row.id)

  // The claim first: it is the authority Salesforce is written from, and a run that stops
  // after this leaves the list reporting lead_id_not_written until Salesforce has the id.
  let next: number
  try {
    next = await saleClient(c.env, row).amend(generation, leadId)
  } catch (err) {
    return refusalOf(c, row, err)
  }

  const salesforce = await writeSale(c, orgId, userId, row, leadId)
  const supabase = createSupabaseClient(c.env)
  const auditRecorded = await recordAuditLog(supabase, orgId, 'held_click', row.id, 'updated', userId, {
    buyer_lead_id: { old: oldId, new: leadId },
    claim_generation: { old: generation, new: next },
    salesforce_writes: { old: previous, new: salesforce },
    subject: subjectOf(row),
    _actor: actorOf(c),
  })
  const listCleared = settled(salesforce, leadId) ? await clearEntry(c.env, row, orgId) : false
  return c.json({ outcome: 'amended', generation: next, salesforce, audit_recorded: auditRecorded, list_cleared: listCleared })
})

export default heldClicks
