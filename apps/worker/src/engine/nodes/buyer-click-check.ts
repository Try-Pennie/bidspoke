/**
 * buyer_click_check (#1543, milestone "Click sold buyers"): on Engine's
 * response path, whether a click sold buyer may be offered this lead.
 *
 *   1. Load the buyer profiles through the one reader (lib/buyer-profile-loader,
 *      which a web guard keeps the only one) and find the partner by its
 *      partner_configs id. No enabled profile for it is `profile_disabled`: the
 *      profile's enabled flag is the on and off switch, and it ships off. A
 *      profile sold on the offer routes not_eligible as partner_not_click and
 *      pages a person (#1557), because buyer_select sells that buyer and this
 *      node would offer it a second way. It never fails the step: a failed
 *      walker step fails Engine's whole execution, its reject response included.
 *      A last good copy of the profiles older than
 *      CLICK_CHECK_LAST_GOOD_MAX_AGE_MS routes profile_copy_stale.
 *   2. The partner's own active flag, then the buyer's box through the shared
 *      evaluateClickEligibility (states, blackout days, hours, debt, loan
 *      amount), judged at the instant the node RUNS, not when the lead arrived
 *      (Dan, 2026-09-24).
 *   3. Today's distinct click count from the click counter (the Pacific day,
 *      keyed on the partner id), compared with the profile's daily cap: eligible
 *      only while count < cap, else daily_click_cap. A slight overshoot is
 *      accepted, because clicks arrive after offers and the send side counts
 *      exactly. A profile with no cap routes no_daily_cap.
 *
 * One budget (CLICK_CHECK_BUDGET_MS) covers the profile load and the count
 * together, with injected timers (L524, and one timer for the whole path rather
 * than one per step). A read that fails or overruns, or a stored cap isCap
 * refuses, routes not_eligible with cap_check_error, so the node fails toward
 * under sending (Dan: cap unreadable is no offer). The decision is computed as a value and
 * written to the output only after the budget answered, so a read landing late
 * cannot rewrite what the walker already routed.
 *
 * The output carries the partner's id, slug, name, click URL and Salesforce
 * routing code, so the scripts that build the offer hold no partner literal
 * (EvaFi follows Liberty1), plus the count and the cap it judged (L11).
 *
 * Walker only (NODE_TRAITS): engine/index.ts runs it once, never through
 * executeNode's retry loop, so the budget is the only bound on it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CLICK_CHECK_BUDGET_MS, CLICK_CHECK_LAST_GOOD_MAX_AGE_MS, CLICK_URL_PROSPECT_PLACEHOLDER, clickUrlCarriesProspectId, evaluateClickEligibility, isCap, partnerIdOf, POPULATIONS, withDeadline, type OutReason, type Population, type Timers } from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition } from '../../types'
import { loadBuyerProfiles, type BuyerProfilesSnapshot, type LoadedBuyer } from '../../lib/buyer-profile-loader'
import { ClickCounterClient } from '../../lib/buyer-object-clients'
import { productionClickAlert, type ClickAlert, type ClickPageReason } from '../../lib/buyer-click-alert'
import { log as structuredLog } from '../../lib/logger'
import { resolveValue } from '../context'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The whole check, profile load and count read together (#1543), from the
 * package so the node form states the same number. A cold object or a cold
 * profile read past it is an under send, never a late answer.
 */
export { CLICK_CHECK_BUDGET_MS }

/** The fixed outgoing handles, in the order the canvas shows them. */
export const BUYER_CLICK_CHECK_ROUTES = ['eligible', 'not_eligible'] as const
export type BuyerClickCheckRoute = (typeof BUYER_CLICK_CHECK_ROUTES)[number]

export type BuyerClickCheckFailureReason =
  | 'partner_id_invalid'
  | 'population_invalid'
  | 'buyer_click_check_handle_unwired'

// ── Config and output ─────────────────────────────────────────────────────────

export interface BuyerClickCheckConfig {
  /** The buyer's partner_configs id; never its slug (#1553, L15). */
  partner_id: string
  /** Templates resolving to the lead's state, debt and loan amount. */
  state: string
  debt: string
  loan_amount: string
  /** Which lead source this check runs on, recorded on every output. */
  population: Population
}

export interface BuyerClickCheckOutput {
  _route: BuyerClickCheckRoute
  /** `eligible`, or the first reason it is out, from the package vocabulary. */
  reason: 'eligible' | OutReason
  detail?: string
  population: string | null
  partner_id: string | null
  partner_slug: string | null
  partner_name: string | null
  click_url: string | null
  external_routing_code: number | null
  /** Today's distinct clicks when the counter was read, else null. */
  count: number | null
  /** The profile's daily cap the count was judged against, null when there was none or no profile. */
  daily_lead_cap: number | null
  /** The Pacific date the count is for, null when the counter was not opened. */
  count_date: string | null
  profile_served_from: BuyerProfilesSnapshot['served_from'] | null
  duration_ms: number
}

export interface BuyerClickCheckFailure {
  message: string
  errorType: 'transient' | 'permanent'
  reason: BuyerClickCheckFailureReason
}

export interface BuyerClickCheckResult {
  output: BuyerClickCheckOutput
  failure?: BuyerClickCheckFailure
}

// ── Injectable dependencies ───────────────────────────────────────────────────

export interface ClickCountApi {
  readonly date: string
  memberCount(): Promise<number>
}

export interface BuyerClickCheckDeps {
  loadProfiles: () => Promise<BuyerProfilesSnapshot>
  counter: (partnerId: string, nowMs: number) => ClickCountApi
  clock: () => number
  timers?: Timers
  /**
   * Pages a person, fire and forget: the node is on Engine's response path and
   * never waits on Slack. The click alert claim is the cooldown, so a burst of
   * leads is one page per buyer per reason per quarter hour.
   */
  alert: (alert: ClickAlert) => void
  log: (fields: { event: string } & Record<string, unknown>) => void
}

export function productionDeps(ctx: ExecutionContext, env: Env, supabase: SupabaseClient): BuyerClickCheckDeps {
  const orgId = ctx.trigger.org_id
  // Fire and forget, as buyer_select does: the walk is still inside the request, and the rebuild never rejects.
  const background = (work: Promise<unknown>) => { void work }
  return {
    // The one reader (#1492): an ageing cached copy is rebuilt in the background, so the read this lead pays stays a cache hit.
    loadProfiles: () => loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase, { background }),
    counter: (partnerId, nowMs) => new ClickCounterClient(env.DAILY_CAP, partnerId, nowMs, { deadlineMs: CLICK_CHECK_BUDGET_MS }),
    clock: () => Date.now(),
    alert: (alert) => background(productionClickAlert(orgId, env, supabase)(alert)),
    log: (fields) => structuredLog({ ...fields, trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, execution_id: ctx.trigger.execution_id } as Parameters<typeof structuredLog>[0]),
  }
}

// ── The executor ──────────────────────────────────────────────────────────────

type PartnerFacts = Pick<BuyerClickCheckOutput, 'partner_slug' | 'partner_name' | 'click_url' | 'external_routing_code'>

/** What the budgeted part decided, as a value, so nothing it does after the budget ends can reach the output. */
type Decision =
  | { kind: 'route'; route: BuyerClickCheckRoute; reason: 'eligible' | OutReason; detail?: string; facts?: PartnerFacts; cap?: number | null; count?: number; countDate?: string; servedFrom?: BuyerProfilesSnapshot['served_from']; page?: ClickPageReason }

export async function executeBuyerClickCheckNode(node: NodeDefinition, ctx: ExecutionContext, deps: BuyerClickCheckDeps): Promise<BuyerClickCheckResult> {
  const startedAt = deps.clock()
  const config = node.config as unknown as Partial<BuyerClickCheckConfig>
  const output: BuyerClickCheckOutput = {
    _route: 'not_eligible',
    reason: 'cap_check_error',
    population: typeof config.population === 'string' ? config.population : null,
    partner_id: typeof config.partner_id === 'string' ? config.partner_id : null,
    partner_slug: null,
    partner_name: null,
    click_url: null,
    external_routing_code: null,
    count: null,
    daily_lead_cap: null,
    count_date: null,
    profile_served_from: null,
    duration_ms: 0,
  }
  const finish = (): void => { output.duration_ms = deps.clock() - startedAt }
  const fail = (reason: BuyerClickCheckFailureReason, detail: string): BuyerClickCheckResult => {
    output.detail = detail
    finish()
    deps.log({ event: 'buyer_click_check_failed', step_namespace: node.namespace, partner_id: output.partner_id, reason, detail })
    return { output, failure: { message: `buyer_click_check ${reason}: ${detail}`, errorType: 'permanent', reason } }
  }

  const partnerId = partnerIdOf(config.partner_id)
  if (!partnerId.ok) return fail('partner_id_invalid', partnerId.reason)
  output.partner_id = partnerId.id
  if (!(POPULATIONS as readonly unknown[]).includes(config.population)) {
    return fail('population_invalid', `population ${JSON.stringify(config.population ?? null)} is not one of ${POPULATIONS.join(', ')}`)
  }

  const lead = { state: resolve(config.state, ctx), debt: resolve(config.debt, ctx), loanAmount: resolve(config.loan_amount, ctx) }
  let decision: Decision
  try {
    decision = await withDeadline(decide(partnerId.id, lead, startedAt, deps), CLICK_CHECK_BUDGET_MS, 'buyer click check', deps.timers)
  } catch (err) {
    decision = { kind: 'route', route: 'not_eligible', reason: 'cap_check_error', detail: `the check did not complete, so the buyer is not offered: ${messageOf(err)}` }
  }

  output._route = decision.route
  output.reason = decision.reason
  if (decision.detail !== undefined) output.detail = decision.detail
  if (decision.facts) Object.assign(output, decision.facts)
  if (decision.cap !== undefined) output.daily_lead_cap = decision.cap
  if (decision.count !== undefined) output.count = decision.count
  if (decision.countDate !== undefined) output.count_date = decision.countDate
  if (decision.servedFrom !== undefined) output.profile_served_from = decision.servedFrom
  finish()
  if (decision.page) page(node, ctx, deps, output, decision.page)
  deps.log({ event: 'buyer_click_check_reason', step_namespace: node.namespace, partner_id: output.partner_id, partner_slug: output.partner_slug, route: output._route, reason: output.reason, count: output.count, daily_lead_cap: output.daily_lead_cap, detail: output.detail })
  return { output }
}

/**
 * The budgeted part. Every read failure below is caught into cap_check_error
 * here, except the budget itself, which the caller turns into the same reason.
 * Once the profile has been read, a failure keeps the partner facts it found.
 */
async function decide(partnerId: string, lead: { state: unknown; debt: unknown; loanAmount: unknown }, instantMs: number, deps: BuyerClickCheckDeps): Promise<Decision> {
  let snapshot: BuyerProfilesSnapshot
  try {
    snapshot = await deps.loadProfiles()
  } catch (err) {
    return { kind: 'route', route: 'not_eligible', reason: 'cap_check_error', detail: `the buyer profiles could not be read, so the buyer is not offered: ${messageOf(err)}` }
  }
  const servedFrom = snapshot.served_from
  // A last good copy is served only when the database read failed. Past the
  // bound it may still offer a buyer switched off, or a cap lowered, since.
  if (servedFrom === 'last_good') {
    const ageMs = instantMs - Date.parse(snapshot.loaded_at)
    if (!(ageMs <= CLICK_CHECK_LAST_GOOD_MAX_AGE_MS)) {
      return { kind: 'route', route: 'not_eligible', reason: 'profile_copy_stale', detail: `the database read failed and the last good copy of the buyer profiles was loaded at ${snapshot.loaded_at}, older than ${CLICK_CHECK_LAST_GOOD_MAX_AGE_MS / 60_000} minutes`, servedFrom }
    }
  }
  const buyer = snapshot.buyers.find((b) => b.partner.id === partnerId)
  if (!buyer) {
    return { kind: 'route', route: 'not_eligible', reason: 'profile_disabled', detail: `partner ${partnerId} has no enabled buyer profile in this organization`, servedFrom }
  }
  const facts = factsOf(buyer)
  if (buyer.profile.soldOn !== 'click') {
    return { kind: 'route', route: 'not_eligible', reason: 'partner_not_click', detail: `${buyer.partner.slug} is sold on the ${String(buyer.profile.soldOn)}, not the click, so buyer_select sells it and this check never offers it`, facts, servedFrom, page: 'partner_not_click' }
  }
  const cap = buyer.profile.dailyLeadCap
  const base = { kind: 'route' as const, facts, servedFrom, cap }
  if (!buyer.partner.is_active) return { ...base, route: 'not_eligible', reason: 'inactive' }
  // #1546: the offer lands on the click URL with the placeholder replaced by the
  // created prospect's id, and build_response_body refuses a URL without it. A
  // buyer switched on with such a URL (saved before validateProfile refused it,
  // or edited on the partner since) would pass here on every lead and then fail
  // to be offered one step later with nothing paging, so it is refused by name,
  // before the box and the count, and a person is paged.
  if (!clickUrlCarriesProspectId(buyer.partner.click_url)) {
    const shown = buyer.partner.click_url === null || buyer.partner.click_url.trim() === '' ? 'no click URL' : `the click URL ${JSON.stringify(buyer.partner.click_url)}`
    return { ...base, route: 'not_eligible', reason: 'click_url_has_no_prospect_id', detail: `${buyer.partner.slug} has ${shown}, which carries no ${CLICK_URL_PROSPECT_PLACEHOLDER} placeholder, so no offer can be made to it`, page: 'click_url_has_no_prospect_id' }
  }

  const verdict = evaluateClickEligibility(buyer.profile, lead, instantMs)
  if (!verdict.eligible) return { ...base, route: 'not_eligible', reason: verdict.reason }

  if (cap === null) {
    return { ...base, route: 'not_eligible', reason: 'no_daily_cap', detail: 'the profile holds no clicks per day, so the buyer is not offered' }
  }
  // The one cap rule (isCap), shared with save validation and buyer_click_send.
  if (!isCap(cap)) {
    return { ...base, cap: null, route: 'not_eligible', reason: 'cap_check_error', detail: `the profile holds clicks per day ${JSON.stringify(cap)}, not a whole number above zero, so the buyer is not offered` }
  }
  let counter: ClickCountApi
  let count: number
  try {
    counter = deps.counter(partnerId, instantMs)
    count = await counter.memberCount()
  } catch (err) {
    return { ...base, route: 'not_eligible', reason: 'cap_check_error', detail: `today's click count could not be read, so the buyer is not offered: ${messageOf(err)}` }
  }
  const counted = { ...base, count, countDate: counter.date }
  if (count >= cap) return { ...counted, route: 'not_eligible', reason: 'daily_click_cap', detail: `${count} clicks on ${counter.date} (Pacific) of a cap of ${cap}` }
  return { ...counted, route: 'eligible', reason: 'eligible' }
}

/**
 * A buyer picked on the node but sold on the offer, and a click buyer whose
 * click URL has no {prospect_id} placeholder (#1546), are configuration faults a
 * person must fix. Each routes not eligible rather than failing the step, because
 * a failed walker step fails Engine's whole execution, its reject response
 * included; the page is how somebody hears. Caught, because the answer has
 * already been decided.
 */
function page(node: NodeDefinition, ctx: ExecutionContext, deps: BuyerClickCheckDeps, output: BuyerClickCheckOutput, reason: ClickPageReason): void {
  try {
    deps.alert({
      kind: 'page', reason, partner_id: output.partner_id ?? '', partner_slug: output.partner_slug ?? output.partner_id ?? '',
      prospect_id: null, detail: output.detail ?? output.reason, hold_recorded: null, workflow_id: ctx.trigger.workflow_id, trace_id: ctx.trigger.trace_id, at: deps.clock(),
    })
  } catch (err) {
    deps.log({ event: 'buyer_click_check_alert_failed', step_namespace: node.namespace, partner_id: output.partner_id, error_message: messageOf(err) })
  }
}

function factsOf(buyer: LoadedBuyer): PartnerFacts {
  return {
    partner_slug: buyer.partner.slug,
    partner_name: buyer.partner.name,
    click_url: buyer.partner.click_url,
    external_routing_code: buyer.partner.external_routing_code,
  }
}

function resolve(template: unknown, ctx: ExecutionContext): unknown {
  if (typeof template !== 'string' || template === '') return undefined
  try {
    return resolveValue(template, ctx)
  } catch {
    return undefined
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'non Error thrown'
}
