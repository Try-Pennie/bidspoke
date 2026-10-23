/**
 * Buyer profile routes (#1412, Phase 5), mounted under /partners beside the
 * partner routes:
 *
 *   GET  /partners/:id/buyer-profile          the document, the partner's accept rules, other sellers,
 *                                             and the other buyers sold on the offer (#2324)
 *   GET  /partners/:id/buyer-usage            the ledger's counts for the current Eastern hour and day,
 *                                             or a click sold buyer's clicks today on the Pacific day
 *
 * Every query filters organization_id explicitly: the Worker is service_role and
 * bypasses RLS. Any allowlisted member of the org may call these, the same as the
 * partner routes (the escalated decision on #1407).
 *
 * The profile is saved with the partner record by PUT /partners/:id/page
 * (#2133, partners.ts); the checks that save shares with the profile are
 * exported from here.
 */
import { Hono, type Context } from 'hono'
import {
  WIRED_POPULATIONS,
  easternDayStartUtc,
  PACIFIC,
  CLICK_URL_NO_PROSPECT_ID_MESSAGE,
  clickUrlCarriesProspectId,
  registryPathOf,
  type BuyerProfile,
  type ProfileErrorCode,
  type Signal,
} from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { dbError, dbErrorUnlessNotFound } from '../../lib/api-error'
import { fetchUpTo } from '../../lib/paginate'
import { CONFIG_LIST_BOUNDS } from '../../lib/config-list-bounds'
import { readBuyerSale, readBuyerSoldOn } from '../../lib/buyer-profile-loader'
import { BuyerLedgerClient, ClickCounterClient } from '../../lib/buyer-object-clients'
import { workflowsUsingPartner } from '../../lib/partner-workflow-finder'
import { readOrgWorkflows } from '../../lib/org-workflows'
import { inputGapsForProfileSave } from '../../lib/buyer-input-coverage'

const buyerProfiles = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

interface PartnerForProfile {
  id: string
  slug: string
  is_active: boolean
  accept_signals: unknown
  /** Read for the enabling refusals (#1416): a buyer sells nowhere without them. */
  click_url: string | null
  external_routing_code: number | null
}

/** The partner in this org, or the response that ends the request. */
async function loadPartner(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  id: string,
  orgId: string
): Promise<{ partner: PartnerForProfile } | { response: Response }> {
  const { data, error } = await supabase
    .from('partner_configs')
    .select('id, slug, is_active, accept_signals, click_url, external_routing_code')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  const blocked = dbErrorUnlessNotFound(c, error)
  if (blocked) return { response: blocked }
  if (!data) return { response: c.json({ error: 'Partner not found' }, 404) }
  return { partner: data as unknown as PartnerForProfile }
}

const acceptSignalsOf = (partner: PartnerForProfile): Signal[] => (Array.isArray(partner.accept_signals) ? (partner.accept_signals as Signal[]) : [])

// ── Read ──────────────────────────────────────────────────────────────────────

/** Another buyer sold on the offer, as the Priority section names it (#2324, PM-21). */
interface OfferBuyer {
  id: string
  name: string
  priority: number | null
}

/**
 * The org's OTHER buyers that buyer selection can offer a lead to today: an
 * enabled profile sold on the offer whose partner is switched on (buyer_select
 * skips an inactive partner). The Priority section says where this buyer stands
 * among them ("Today Tripoint is the only buyer sold on the offer"), so a failed
 * read throws rather than answering an empty list, which would say exactly that.
 */
async function readOtherOfferBuyers(supabase: ReturnType<typeof createSupabaseClient>, orgId: string, partnerId: string): Promise<OfferBuyer[]> {
  // Read whole or refused (#1437): where this buyer stands among a cut list is wrong.
  const rows = await fetchUpTo<{ partner_id: string; priority: number | null; partner_configs: { name: string; is_active: boolean } | null }>((limit) => supabase
    .from('buyer_profiles')
    .select('partner_id, priority, partner_configs!inner(name, is_active)')
    .eq('organization_id', orgId)
    .eq('sold_on', 'offer')
    .eq('is_enabled', true)
    .limit(limit), CONFIG_LIST_BOUNDS.buyerProfiles, 'other offer buyers')
  return rows
    .filter((r) => r.partner_id !== partnerId && r.partner_configs?.is_active === true)
    .map((r) => ({ id: r.partner_id, name: r.partner_configs?.name ?? r.partner_id, priority: r.priority }))
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.name.localeCompare(b.name))
}

buyerProfiles.get('/:id/buyer-profile', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const loaded = await loadPartner(c, supabase, id, orgId)
  if ('response' in loaded) return loaded.response

  const { data: document, error: docError } = await supabase.rpc('buyer_profile_document', { p_partner: id })
  if (docError) return dbError(c, docError)

  // Other sellers: live workflows whose bid_group or partner_bid nodes name this
  // partner. Buyer selection itself is not an OTHER seller, so buyer_select nodes
  // are left out; the caps panel names these because their wins are not counted (L582).
  // The click nodes are left out too (#1543): a click buyer's clicks through
  // buyer_click_send are exactly what its cap counts, and buyer_click_check only
  // offers, so neither is a seller whose wins the cap leaves uncounted. A
  // latency_gate is left out as well (#2251): it times a confirmation and sells nothing.
  let workflows
  try {
    workflows = await readOrgWorkflows(supabase, orgId)
  } catch (err) {
    return dbError(c, err)
  }
  const finder = workflowsUsingPartner(
    workflows,
    new Map(),
    { includeBuyerSelect: false, includeClickNodes: false, includeLatencyGates: false, liveOnly: true }
  )

  let offerBuyers: OfferBuyer[]
  try {
    offerBuyers = await readOtherOfferBuyers(supabase, orgId, id)
  } catch (err) {
    return dbError(c, err)
  }

  return c.json({
    profile: document ?? null,
    accept_signals: acceptSignalsOf(loaded.partner),
    other_sellers: finder(id),
    offer_buyers: offerBuyers,
  })
})

/**
 * A click buyer switched to the offer while a LIVE workflow names it on a
 * buyer_click_check or buyer_click_send node is refused, naming each workflow
 * (#1557): the check would stop offering it and the send would stop judging its
 * cap, with nothing on the page saying why. Only the switch AWAY from the click
 * is refused. Switching to the click is how a click node that names an offer
 * buyer gets fixed, and a bid_group or partner_bid sells the partner whichever
 * way its profile is sold. The stored kind is read first, and the workflows only
 * when the kind is actually leaving the click, so an ordinary save pays one read.
 */
export async function refuseSwitchAwayFromClick(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  partnerId: string,
  nextSoldOn: string | null
): Promise<Response | null> {
  if (nextSoldOn === 'click') return null
  let stored
  try {
    stored = await readBuyerSoldOn(supabase, orgId, partnerId)
  } catch (err) {
    console.error(`[buyer-profile] stored sold_on unreadable for partner ${partnerId}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'sold_on_unavailable', message: 'Whether this buyer is sold on the offer or on the click now could not be read, so nothing was saved. Try again.' }, 503)
  }
  if (stored !== 'click') return null

  let workflows
  try {
    workflows = await readOrgWorkflows(supabase, orgId)
  } catch (err) {
    return dbError(c, err)
  }
  const using = workflowsUsingPartner(
    workflows,
    new Map(),
    { includeBuyerSelect: false, includeClickNodes: true, includeLatencyGates: false, clickNodesOnly: true, liveOnly: true }
  )(partnerId)
  if (using.length === 0) return null
  const names = using.map((w) => w.name).join(', ')
  return c.json({
    error: 'sold_on_in_use',
    message: `This buyer is sold on the click in live workflows: ${names}. Nothing was saved. Take it off their click nodes, or switch those workflows off, before selling it on the offer.`,
    workflows: using,
  }, 409)
}

/**
 * An enabled profile carrying a rule a LIVE workflow's buyer step has no
 * template to read is refused (#2149), naming the workflow, the step and the
 * missing template, on the profile field whose rule it is: saved, it would
 * refuse every lead that step judges as missing_lead_field, which is what
 * Tripoint's 2,000 minimum did to the Engine live share for 45 hours from
 * 2026-10-13. The workflows are read only for an enabled profile, because a
 * switched off one is judged by nothing; the switch on is a save, and is
 * checked then. A failed read refuses the save rather than letting it through
 * as if no workflow were live (L42). The same finder refuses the workflow side
 * (routes/api/workflows.ts), so neither side can reach this state alone.
 */
export async function refuseUnreadRules(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  partnerId: string,
  profile: BuyerProfile
): Promise<Response | null> {
  if (!profile.isEnabled) return null
  let workflows
  try {
    workflows = await readOrgWorkflows(supabase, orgId, { activeOnly: true })
  } catch (err) {
    return dbError(c, err)
  }
  const errors = inputGapsForProfileSave(workflows, { partnerId, name: partnerId, profile })
  if (errors.length === 0) return null
  return c.json({
    error: 'rule_unread_by_live_workflow',
    message: errors[0].message,
    errors: errors.map((e) => ({ ...e, field: registryPathOf(e.path) })),
  }, 422)
}

// ── Usage ─────────────────────────────────────────────────────────────────────

buyerProfiles.get('/:id/buyer-usage', async (c) => {
  const { orgId } = c.get('user')
  const id = c.req.param('id')
  const supabase = createSupabaseClient(c.env)

  const loaded = await loadPartner(c, supabase, id, orgId)
  if ('response' in loaded) return loaded.response

  // A click sold buyer (#1541) never reserves in the ledger, so its counts here
  // would read as zero sales against a cap that counts clicks: it answers with
  // today's clicks instead (#1543). An unreadable kind is its own refusal, never
  // the numbers of a buyer that may be sold on the click.
  const clickAnswer = await clickCountIfClickSold(c, supabase, orgId, id)
  if (clickAnswer) return clickAnswer

  // The ledger is the authority the caps refuse from, so the panel reads the
  // same counted() the refusal uses (L16). A ledger that does not answer is a
  // 503, never a zero (L633).
  const ledger = new BuyerLedgerClient(c.env.BUYER_LEDGER, id)
  let summary
  let counts
  try {
    ;[summary, counts] = await Promise.all([ledger.summary('live'), ledger.peek('live')])
  } catch (err) {
    console.error(`[buyer-usage] ledger unavailable for partner ${id}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'usage_unavailable', message: 'The buyer ledger did not answer, so the counts cannot be shown.' }, 503)
  }

  // Wins recorded for this buyer today by anything other than buyer selection:
  // Main Flow's Bid Group, for one. Those are not counted against these caps,
  // and the panel says so with the number (L582, L287). Bounded on the partition
  // key (attempted_at_utc) to the Eastern day.
  const unmeasured: string[] = []
  let outsideWins: number | null = null
  const dayStart = easternDayStartUtc(summary.et_day)
  const nextDayStart = easternDayStartUtc(nextIsoDate(summary.et_day))
  const { count, error: countError } = await supabase
    .from('lead_sighting_bids')
    .select('id', { count: 'exact', head: true })
    .eq('partner_slug', loaded.partner.slug)
    .eq('is_winner', true)
    .neq('resolver_type', 'buyer_select')
    .gte('attempted_at_utc', new Date(dayStart).toISOString())
    .lt('attempted_at_utc', new Date(nextDayStart).toISOString())
  if (countError || typeof count !== 'number') {
    console.error(`[buyer-usage] outside wins count failed for ${loaded.partner.slug}: ${countError?.message ?? 'no count returned'}`)
    unmeasured.push('outside_wins_today')
  } else {
    outsideWins = count
  }

  return c.json({
    sold_on: 'offer',
    et_day: summary.et_day,
    hour_bucket: counts.hour_bucket,
    hour: { leads: counts.hour_leads, spend_cents: counts.hour_spend_cents },
    day: { leads: counts.day_leads, spend_cents: counts.day_spend_cents, by_status: summary.by_status },
    counted_populations: [...WIRED_POPULATIONS],
    outside_wins_today: outsideWins,
    unmeasured,
  })
})

/**
 * The answer a ledger or daily cap count route gives for a buyer sold on the
 * click (#1541, #1543), or null for any other partner. Shared by the usage route
 * here and the partner cap-count route, so both answer the same way: today's
 * distinct clicks from the click counter, keyed on the partner id, on the
 * PACIFIC day the counter resets on (the day CapsGrid names), read with the
 * plain count call that never adds a member. This is the counter itself, the
 * true count. buyer_click_check judges the cap against its saved copy instead
 * (#1632), which can trail the counter by a click or two for up to a minute,
 * so on a busy moment the panel can read one or two higher than the count the
 * last offer was judged on; the panel is the one to believe. A counter that
 * does not answer is a 503, never a zero (L633).
 */
export async function clickCountIfClickSold(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  partnerId: string
): Promise<Response | null> {
  let soldOn
  try {
    soldOn = await readBuyerSoldOn(supabase, orgId, partnerId)
  } catch (err) {
    console.error(`[buyer-kind] could not read how partner ${partnerId} is sold: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'sold_on_unavailable', message: 'Whether this buyer is sold on the offer or on the click could not be read, so no count is shown.' }, 503)
  }
  if (soldOn !== 'click') return null
  try {
    const counter = new ClickCounterClient(c.env.DAILY_CAP, c.env.WORKFLOW_CACHE, partnerId, Date.now())
    const count = await counter.memberCount()
    return c.json({ sold_on: 'click', count, date: counter.date, day_zone: PACIFIC })
  } catch (err) {
    console.error(`[click-count] could not read today's clicks for partner ${partnerId}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    return c.json({ error: 'click_count_unavailable', message: 'The click counter did not answer, so the clicks today cannot be shown.' }, 503)
  }
}

/**
 * The partner save's refusal of a click URL an enabled click buyer cannot be
 * offered on (#1561), or null to let the save through. The URL lives on the
 * partner record, so validateProfile refusing to ENABLE such a buyer (#1546)
 * never saw a later edit that broke it; this is the same rule at that edit, with
 * the same code, sentence and field path, so the partner form puts it on its
 * Click URL field. Only a change to the URL is judged, and the profile is read
 * only when the new value lacks the placeholder, so an ordinary save pays
 * nothing. An unreadable profile refuses that one change with a 503 rather than
 * letting it through (L42); a save that leaves the URL alone never reads it.
 */
export async function refuseClickUrlWithoutProspectId(
  c: Context<{ Bindings: Env; Variables: AuthVariables }>,
  supabase: ReturnType<typeof createSupabaseClient>,
  orgId: string,
  partnerId: string,
  storedClickUrl: string | null,
  nextClickUrl: string | null | undefined
): Promise<Response | null> {
  if (nextClickUrl === undefined || nextClickUrl === storedClickUrl) return null
  if (clickUrlCarriesProspectId(nextClickUrl)) return null
  let sale
  try {
    sale = await readBuyerSale(supabase, orgId, partnerId)
  } catch (err) {
    console.error(`[partner-save] buyer profile unreadable for partner ${partnerId}: ${err instanceof Error ? err.message : 'non Error thrown'}`)
    const message = 'Whether this buyer is sold on the click could not be read, so the new click URL was not saved and nothing else was either. Try again.'
    return c.json({ error: 'click_url_unverifiable', message, errors: [{ code: 'click_url_unverifiable', path: 'clickUrl', field: 'click_url', message }] }, 503)
  }
  if (sale?.soldOn !== 'click' || !sale.isEnabled) return null
  const code = 'click_url_has_no_prospect_id' satisfies ProfileErrorCode
  return c.json({ error: code, message: CLICK_URL_NO_PROSPECT_ID_MESSAGE, errors: [{ code, path: 'clickUrl', field: 'click_url', message: CLICK_URL_NO_PROSPECT_ID_MESSAGE }] }, 422)
}

function nextIsoDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export default buyerProfiles
