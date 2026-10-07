/**
 * buyer_click_send (#1542, milestone "Click sold buyers"): send one clicked
 * prospect to a click sold buyer, exactly once, and count it exactly once.
 *
 * One node does the three things that must not come apart:
 *   1. CLAIM the prospect for this buyer in a LeadSaleObject under the `click`
 *      kind (`sale:click:{partner_id}:{prospect_id}`), with a deadline that outlives
 *      the post (CLICK_CLAIM_DEADLINE_MS).
 *        sold       already_sent   an earlier click was confirmed; nothing sent
 *        in_flight  in_progress    another execution is sending it right now
 *        in_doubt   needs_review   an earlier send never recorded its outcome; pages
 *   2. POST the body a preceding code node built to the buyer profile's route
 *      for the lead's state, with a 20 s timeout.
 *   3. CLASSIFY the answer three ways:
 *        confirmed  a 2xx whose body is exactly the buyer's success line, the
 *                   buyer profile's success reply with an `id` group, matched
 *                   anchored. Mark the claim sold (payout 0, the partner lead id),
 *                   then add the prospect to today's distinct count. An add with
 *                   no answer is asked once more inside CLICK_RUN_BUDGET_MS
 *                   (#1766). A mark or an add that fails pages, the add saying
 *                   only what the counter answered; the route is still `sent`.
 *        refused    a 4xx carrying the buyer's own error (not an HTML page, not
 *                   empty, not 408 or 429): free the claim so a later click retries.
 *        unknown    everything else: a timeout, a network error, a 5xx, an HTML
 *                   page, a 2xx that is not the success line. The claim is kept
 *                   held, the node pages, and only a person releases it.
 *
 * A claim left held, or found held, is also RECORDED (#1552) through
 * record_held_click, because a claim object cannot be listed and the step rows
 * are purged after 7 days while the claim stays held. The partner page lists
 * the held clicks from that record and a person releases each one there. A
 * record that fails is logged and reported on the step; the page still goes out.
 *
 * Every route carries a named reason (L11). Config problems and a claim that
 * cannot be read fail the step by name before anything is sent.
 *
 * Walker only (NODE_TRAITS): engine/index.ts runs it once, never through
 * executeNode's retry loop, because a retried send is a duplicate. It refuses a
 * resumed or replayed execution, because resume re-runs every node from the
 * entry and would post the click a second time. A Test Runner run, a shadow run
 * and local dev evaluate the config and touch nothing (report_only, L719).
 *
 * The partner is a SETTING (EvaFi follows Liberty1): the partner is config, and
 * no buyer's literal lives in this file. The daily cap the over cap notice is
 * judged against is the buyer PROFILE's (#1543, L83), the same number
 * buyer_click_check stops offering at. An enabled profile holding no cap pages
 * cap_unreadable.
 *
 * WHERE the click goes and WHICH reply counts as sold are the buyer profile's
 * click delivery (#1639): the route whose states list the lead's state (the
 * node's `state` template), else the one catch-all route, and the profile's
 * success line. Both come from the same profile read as the cap, made once
 * before anything is claimed. Since #1671 the profile is the ONLY source: the
 * node's own request_url and success_pattern are gone, and a canvas saved
 * before then that still carries them is ignored. So every way of having no
 * delivery is refused by name before the claim, never guessed at (L75): a
 * profile that cannot be read (profile_unreadable, transient, Dan's decision of
 * 2026-09-30), no profile at all (no_profile), a profile sold on the offer
 * (not_sold_on_click), and a click profile whose Click delivery is empty
 * (click_delivery_unset).
 *
 * Switching a click buyer's profile OFF stops new offers only (Dan, 2026-09-30):
 * a click on an offer already shown is still sent through that profile's click
 * delivery, read from the switched off profiles the same snapshot carries
 * (readClickProfile, #1849), and recorded as no_enabled_profile for the over
 * cap notice, which pages nothing because nothing more is offered.
 *
 * The partner is stored by its partner_configs id (#1553, L15), and the claim,
 * the counter and the alert cooldowns are all keyed on that id, so renaming a
 * buyer's slug keeps its held claims and the day's count. The slug is resolved
 * from the id on every run, through the org's cached partner constants, and is
 * used only for words: logs, alerts, the post's error messages and the output.
 * A partner the org does not hold, or a read that fails, fails the step by name
 * before anything is claimed or sent.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DeadlineError, alertOverPercentOf, canonicalBodySha256, isCap, isHttpsUrl, partnerIdOf, pickClickRoute, successPatternOf, withDeadline, type ClickDelivery, type HeldClickReason, type PickedClickRoute, type SoldOn, type Timers } from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { ClaimBody, ClaimResult } from '../../durable-objects/lead-sale'
import type { SaleOutcomeRecord } from '../../durable-objects/sale-outcome'
import type { AddMemberResult } from '../../durable-objects/daily-cap'
import { addAskingOnceMore, addKnownRefused, ClickCounterClient, LeadSaleClient, OBJECT_CALL_DEADLINE_MS, type AddFailure, type ClickClaimKey } from '../../lib/buyer-object-clients'
import { loadBuyerProfiles, switchedOffProfile, type BuyerProfilesSnapshot } from '../../lib/buyer-profile-loader'
import { loadPartnerConstants } from '../../lib/partner-constants-loader'
import { postToPartner, type PartnerCallResult } from '../../lib/post-to-partner'
import { productionClickAlert, type ClickAlert, type ClickAlertOutcome, type ClickPageReason, type HoldRecorded } from '../../lib/buyer-click-alert'
import { log as structuredLog } from '../../lib/logger'
import { resolveValue } from '../context'
import { nodeReportsOnly, runRealityOf } from '../run-reality'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The whole post, connect to last byte. The buyer is a Salesforce Sites URL; the
 * same budget buyer_select gives a buyer call (BUYER_CALL_TIMEOUT_MS).
 */
export const CLICK_POST_TIMEOUT_MS = 20_000

/**
 * How long the claim stays in flight before another click finds it in doubt.
 *
 * NOT MEASURED: no Liberty1 post has run through Bidspoke yet, and the Pipedream
 * flow it replaces records no latency we can read. So this is the STRUCTURAL
 * worst case of one node run instead: the post can take at most
 * CLICK_POST_TIMEOUT_MS (the node ends it there itself), and after it come two
 * object calls (mark sold, then add to the count) at OBJECT_CALL_DEADLINE_MS
 * each, plus CLICK_CLAIM_MARGIN_MS. A deadline shorter than that would let a
 * second click find the claim in doubt while the first is still legitimately
 * finishing. The count's one retry (#1766) does not lengthen it: the retry is
 * asked only inside CLICK_RUN_BUDGET_MS, which stops short of the margin.
 * Replace the reasoning with the measured p99 from the first week of live
 * clicks (the step rows carry duration_ms).
 */
export const CLICK_CLAIM_MARGIN_MS = 10_000
export const CLICK_CLAIM_DEADLINE_MS = CLICK_POST_TIMEOUT_MS + 2 * OBJECT_CALL_DEADLINE_MS + CLICK_CLAIM_MARGIN_MS

/** The node's own bound on the post, a second past the post's timeout, so a fetch that ignores its abort still ends. */
export const CLICK_POST_DEADLINE_MS = CLICK_POST_TIMEOUT_MS + 1_000

/** How long the node waits on one Slack alert before recording it as failed. */
export const CLICK_ALERT_DEADLINE_MS = 5_000

/**
 * The node's whole run, measured on its own clock from just before the claim
 * (#1766): the claim deadline less its margin, so nothing this budget decides
 * can still be running when a later click is entitled to find the claim in
 * doubt. One call is decided by it: the count's retry, which is asked only when
 * CLICK_COUNT_RETRY_COST_MS still fits, and then with its full deadline, never
 * with what is left, so a retry is a real second ask or none at all.
 */
export const CLICK_RUN_BUDGET_MS = CLICK_CLAIM_DEADLINE_MS - CLICK_CLAIM_MARGIN_MS

/**
 * What asking the count again can take: the add at its full deadline, then the
 * page that follows when it still gives no answer. Nothing comes after the
 * page, so a retry that fits ends the run inside CLICK_RUN_BUDGET_MS.
 */
export const CLICK_COUNT_RETRY_COST_MS = OBJECT_CALL_DEADLINE_MS + CLICK_ALERT_DEADLINE_MS

/**
 * How long the node waits on the buyer profile, read once before anything is
 * claimed, for the click delivery and the cap (#1639). Past it the step fails
 * profile_unreadable and nothing is sent. The read is the cached snapshot, a KV
 * hit on the warm path.
 */
export const CLICK_PROFILE_READ_DEADLINE_MS = 5_000

/** How long the node waits on the held click record before reporting it as not recorded. */
export const CLICK_HOLD_RECORD_DEADLINE_MS = 5_000


/** The fixed outgoing handles, in the order the canvas shows them. */
export const BUYER_CLICK_SEND_ROUTES = ['sent', 'refused', 'unknown', 'already_sent', 'in_progress', 'needs_review', 'not_sent'] as const
export type BuyerClickSendRoute = (typeof BUYER_CLICK_SEND_ROUTES)[number]

export type BuyerClickSendReason =
  | 'sent'
  | 'refused_by_buyer'
  | 'outcome_unknown'
  | 'already_sent'
  | 'claim_in_progress'
  | 'claim_in_doubt'
  | 'report_only'

export type BuyerClickSendFailureReason =
  | 'recovery_run_refused'
  | 'partner_id_invalid'
  | 'partner_not_found'
  | 'partner_unreadable'
  | 'alert_over_percent_invalid'
  | 'prospect_id_empty'
  | 'request_body_invalid'
  | 'claim_unavailable'
  | 'buyer_click_send_handle_unwired'
  | 'profile_unreadable'
  | 'no_profile'
  | 'not_sold_on_click'
  | 'click_delivery_unset'
  | 'click_delivery_invalid'
  | 'state_template_unset'

/** Whether the over cap notice went out on this click. */
export type OverCapState = ClickAlertOutcome | 'not_due' | 'cap_unreadable' | 'no_enabled_profile' | 'not_counted'

// ── Config and output ─────────────────────────────────────────────────────────

export interface BuyerClickSendConfig {
  /** The buyer's partner_configs id (#1553). Names the claim and the counter; the slug is looked up from it. */
  partner_id: string
  /** Template resolving to the prospect id, the claim and count key. */
  prospect_id: string
  /** Template resolving to the body object the preceding code node built. */
  request_body: string
  /**
   * Template resolving to the lead's state (#1639), which picks the buyer
   * profile's route. Required when the profile routes by state.
   */
  state?: string
  /*
   * No request_url or success_pattern (#1671): where the click goes and which
   * reply counts as sold are the buyer profile's click delivery. A definition
   * saved before #1671 may still carry both; they are never read.
   */
  /**
   * Ignored and reported (#1543): the cap lives on the buyer profile, where
   * buyer_click_check reads it too, so there is one home for it (L83).
   */
  daily_lead_cap?: unknown
  alert_over_percent?: number
  /** Ignored and reported: the node runs once whatever the definition says. */
  retries?: number
}

export interface BuyerClickSendOutput {
  _route: BuyerClickSendRoute
  reason: BuyerClickSendReason
  detail?: string
  mode_effective: 'live' | 'report_only'
  /** The configured partner id, as stored (null when the config holds none). */
  partner_id: string | null
  /** The partner's current slug, resolved from the id; null until resolved or when it could not be. */
  partner_slug: string | null
  prospect_id: string | null
  /** The buyer's HTTP status under the canonical key (status-key-contract), null when no answer arrived. */
  status: number | null
  partner_lead_id: string | null
  /** The distinct count after this click, null when the counter's answer did not give one. */
  count: number | null
  /**
   * True when the counter answered that this ask added the prospect; false when
   * it answered the prospect was already there, or gave no count. After a retry
   * (count_retried), false can also mean the first ask landed late, because the
   * count takes each prospect once.
   */
  counted: boolean
  /** Present only when the add was asked a second time (#1766): why the first ask gave no answer. */
  count_retried?: string
  /** Present only when no count was read: the same detail the count page carries. */
  count_error?: string
  count_date: string | null
  over_cap: OverCapState | null
  /** The profile's daily cap the notice was judged against, null when it was not read or there was none. */
  daily_lead_cap: number | null
  /** A cap still stored on the node, shown because it is not the one in force. */
  daily_lead_cap_ignored?: unknown
  claim_freed?: boolean
  pages: Array<{ reason: ClickPageReason; outcome: ClickAlertOutcome }>
  /**
   * Present only when the claim is held: whether the partner page's record of it
   * was written (#1552), or outcome_unknown when the write ran out of time and
   * may have landed (#1849).
   */
  hold_recorded?: HoldRecorded
  /** Why the record failed or did not answer, when hold_recorded is not true: the page sends the person here for it. */
  hold_record_error?: string
  would_send_body_sha256?: string
  /** The profile route posted to (#1639); null until a route was chosen. */
  route_name: string | null
  /** Why that route: it lists the lead's state, the state is in no route (catch_all), or the lead had no readable state. */
  route_matched?: PickedClickRoute['matched']
  /** The lead's state as the route choice read it. */
  route_state?: string | null
  /**
   * Where the address and the success line came from: always the buyer profile's
   * click delivery since #1671, null until it was read. Kept so step rows from
   * before (#1639, which could read 'node') and after read in one vocabulary.
   */
  url_source: 'profile' | null
  pattern_source: 'profile' | null
  retries_ignored?: number
  duration_ms: number
}

export interface BuyerClickSendFailure {
  message: string
  errorType: 'transient' | 'permanent'
  reason: BuyerClickSendFailureReason
}

export interface BuyerClickSendResult {
  output: BuyerClickSendOutput
  failure?: BuyerClickSendFailure
}

// ── Injectable dependencies ───────────────────────────────────────────────────

/** One held claim, as the partner page lists it (#1552). The org comes from the execution. */
export interface HeldClickRecord {
  partner_id: string
  prospect_id: string
  reason: HeldClickReason
  detail: string
  /** The id the buyer answered with when it confirmed receipt; null when it is not known. */
  partner_lead_id: string | null
  workflow_id: string
  execution_id: string
  trace_id: string
}

export interface ClickSaleApi {
  claim(body: ClaimBody): Promise<ClaimResult>
  sold(generation: number, outcome: SaleOutcomeRecord): Promise<number>
  free(generation: number): Promise<number>
}

export interface ClickCounterApi {
  readonly date: string
  addMember(member: string): Promise<AddMemberResult>
}

/**
 * The buyer's profile as the node reads it: how the buyer is sold, so an offer
 * buyer is never sent a click (#1557), its click delivery, null when it holds
 * none (#1639), and whether it is in the enabled snapshot with the cap that
 * snapshot holds. A profile switched off after its offers went out is found with
 * enabled false and no cap: its clicks are still sent (Dan, 2026-09-30).
 */
export type ProfileRead =
  | { found: false }
  | { found: true; enabled: boolean; cap: number | null; soldOn: SoldOn | null; clickDelivery: ClickDelivery | null }

/** The snapshot as readClickProfile needs it: the shape loadBuyerProfiles answers. */
interface EnabledBuyersLike extends Pick<BuyerProfilesSnapshot, 'switched_off'> {
  buyers: ReadonlyArray<{ partner: { id: string }; profile: { dailyLeadCap: number | null; soldOn: SoldOn | null; clickDelivery?: ClickDelivery | null } }>
}

/**
 * The profile for one click: the enabled profile from the one cached snapshot
 * that buyer_select and buyer_click_check read, and only when the buyer is not
 * in it, the switched off profile the same snapshot carries, for a profile
 * switched off after its offers went out. That used to be a read of the buyer's
 * own row with no copy behind it, so in a database outage every such click was
 * refused; now both come from the snapshot's cache or its last-good copy
 * (#1849). A snapshot that cannot be read, or cannot answer for this buyer,
 * throws, so the click is refused as profile_unreadable.
 */
export async function readClickProfile(
  partnerId: string,
  enabledSnapshot: () => Promise<EnabledBuyersLike>,
): Promise<ProfileRead> {
  const snapshot = await enabledSnapshot()
  const buyer = snapshot.buyers.find((b) => b.partner.id === partnerId)
  // A snapshot cached before #1639 carries no clickDelivery: read as none, which refuses the click by name.
  if (buyer) return { found: true, enabled: true, cap: buyer.profile.dailyLeadCap, soldOn: buyer.profile.soldOn, clickDelivery: buyer.profile.clickDelivery ?? null }
  const row = switchedOffProfile(snapshot, partnerId)
  // Not in the enabled snapshot: switched off (or enabled since the snapshot was cached),
  // so there is no cap in force to judge an overshoot against.
  return row ? { found: true, enabled: false, cap: null, soldOn: row.soldOn, clickDelivery: row.clickDelivery } : { found: false }
}

export interface BuyerClickSendDeps {
  /** The buyer's profile (readClickProfile); found false when the buyer has no profile at all. Throws when it cannot be read. */
  readProfile: (partnerId: string) => Promise<ProfileRead>
  /** The org's partner by id, for its slug; null when the org holds no such partner. Throws when it cannot be read. */
  resolvePartner: (partnerId: string) => Promise<{ slug: string } | null>
  saleClient: (key: ClickClaimKey) => ClickSaleApi
  counter: (partnerId: string, nowMs: number) => ClickCounterApi
  post: (target: { slug: string; url: string }, body: unknown, opts: { traceId: string; timeoutMs: number }) => Promise<PartnerCallResult>
  alert: (alert: ClickAlert) => Promise<ClickAlertOutcome>
  /** Writes the held click record the partner page lists (#1552). Throws when it did not land. */
  recordHold: (hold: HeldClickRecord) => Promise<void>
  clock: () => number
  timers?: Timers
  log: (fields: { event: string } & Record<string, unknown>) => void
  localDev: boolean
}

export function productionDeps(ctx: ExecutionContext, env: Env, supabase: SupabaseClient): BuyerClickSendDeps {
  const orgId = ctx.trigger.org_id
  // Fire and forget, as buyer_select does: the walk is still inside the request, and the rebuild never rejects.
  const background = (work: Promise<unknown>) => { void work }
  return {
    readProfile: (partnerId) => readClickProfile(partnerId, () => loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase, { background })),
    // The org scoped, cached partner read the Constants node already uses (memory, KV, then a
    // last good copy), so a click does not pay a cold database read and survives a Supabase wobble.
    resolvePartner: async (partnerId) => {
      const constants = await loadPartnerConstants(orgId, env.WORKFLOW_CACHE, supabase)
      if (!constants.slugsById) throw new Error('the partner list was served from a last good copy written before partner ids were recorded, because the database read failed')
      const slug = constants.slugsById[partnerId]
      return slug ? { slug } : null
    },
    saleClient: (key) => new LeadSaleClient(env.LEAD_SALE, key),
    counter: (partnerId, nowMs) => new ClickCounterClient(env.DAILY_CAP, env.WORKFLOW_CACHE, partnerId, nowMs),
    // The one outbound POST (L613): the URL is the profile route's, and a click buyer carries no stored credential.
    post: (target, body, opts) => postToPartner({ slug: target.slug, api_endpoint: target.url, cf_secret_key: null }, body, env, opts),
    // The one production alert, shared with buyer_click_check (#1557).
    alert: productionClickAlert(orgId, env, supabase),
    recordHold: async (hold) => {
      const { error } = await supabase.rpc('record_held_click', {
        p_org: orgId,
        p_partner: hold.partner_id,
        p_prospect: hold.prospect_id,
        p_reason: hold.reason,
        p_detail: hold.detail,
        p_partner_lead_id: hold.partner_lead_id,
        p_workflow: hold.workflow_id,
        p_execution: hold.execution_id,
        p_trace: hold.trace_id,
      })
      if (error) throw new Error(`record_held_click: ${error.message}`)
    },
    clock: () => Date.now(),
    log: (fields) => structuredLog({ ...fields, trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, execution_id: ctx.trigger.execution_id } as Parameters<typeof structuredLog>[0]),
    localDev: runRealityOf(ctx, env).localDev,
  }
}

// ── Answer classification ─────────────────────────────────────────────────────

export type ClickAnswer =
  | { kind: 'confirmed'; partnerLeadId: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'unknown'; detail: string }

/** Statuses in the 4xx range that say nothing about the lead: the request was never judged. */
const UNJUDGED_4XX = new Set([408, 429])

/**
 * A buyer's success line as the node runs it: matched against the WHOLE answer.
 * The one compile lives in the shared package (#1639), where the profile form and
 * save validation read it too; re-exported so a test of one buyer's line
 * compiles it exactly this way.
 */
export { compileSuccessPattern } from '@bidspoke/buyer-profile'

/**
 * The buyer's answer, three ways. `pattern` is the partner's success line,
 * already anchored. A body Salesforce returns as a JSON string is read as that
 * string, because an Apex REST method returning a String is serialised quoted.
 */
export function classifyClickAnswer(res: PartnerCallResult, pattern: RegExp): ClickAnswer {
  if (res.isHtml) return { kind: 'unknown', detail: `http ${res.status} with an HTML page, so something in front of the buyer answered` }
  const text = (typeof res.json === 'string' ? res.json : res.text).trim()
  if (res.status >= 200 && res.status < 300) {
    const m = pattern.exec(text)
    const id = m?.groups?.id
    if (id) return { kind: 'confirmed', partnerLeadId: id }
    return { kind: 'unknown', detail: `http ${res.status}, but the body is not the configured success shape: ${excerpt(text)}` }
  }
  if (res.status >= 400 && res.status < 500 && !UNJUDGED_4XX.has(res.status)) {
    if (text === '') return { kind: 'unknown', detail: `http ${res.status} with an empty body, so whose refusal it is was not measured` }
    return { kind: 'refused', detail: `http ${res.status}: ${excerpt(text)}` }
  }
  return { kind: 'unknown', detail: `http ${res.status}: ${excerpt(text)}` }
}

/** A short piece of the buyer's answer for the step row, never the whole body (L222). */
function excerpt(text: string): string {
  if (text === '') return '(empty body)'
  return text.length > 200 ? `${text.slice(0, 200)}...` : text
}

// ── The executor ──────────────────────────────────────────────────────────────

export async function executeBuyerClickSendNode(node: NodeDefinition, ctx: ExecutionContext, deps: BuyerClickSendDeps): Promise<BuyerClickSendResult> {
  const run = new Run(node, ctx, deps)
  const result = await run.execute()
  result.output.duration_ms = deps.clock() - run.startedAt
  return result
}

interface Checked {
  partnerId: string
  percent: number
  prospectId: string
  body: Record<string, unknown>
}

interface Target {
  pattern: RegExp
  url: string
}

interface Validated extends Checked, Target {
  slug: string
  /** False for a profile switched off after its offers went out: its click is sent, and no cap is in force. */
  enabled: boolean
  /** The enabled click profile's daily cap, from the one read made before the claim. */
  cap: number | null
}

class Run {
  readonly startedAt: number
  private readonly config: BuyerClickSendConfig
  private readonly out: BuyerClickSendOutput

  constructor(private readonly node: NodeDefinition, private readonly ctx: ExecutionContext, private readonly deps: BuyerClickSendDeps) {
    this.startedAt = deps.clock()
    this.config = node.config as unknown as BuyerClickSendConfig
    const reportOnly = nodeReportsOnly('buyer_click_send', runRealityOf(ctx, { LOCAL_DEV: deps.localDev }))
    this.out = {
      _route: 'not_sent',
      reason: 'report_only',
      mode_effective: reportOnly ? 'report_only' : 'live',
      partner_id: typeof this.config.partner_id === 'string' ? this.config.partner_id : null,
      partner_slug: null,
      prospect_id: null,
      status: null,
      partner_lead_id: null,
      count: null,
      counted: false,
      count_date: null,
      over_cap: null,
      daily_lead_cap: null,
      pages: [],
      route_name: null,
      url_source: null,
      pattern_source: null,
      duration_ms: 0,
    }
    if (typeof this.config.retries === 'number') this.out.retries_ignored = this.config.retries
    if (this.config.daily_lead_cap !== undefined) this.out.daily_lead_cap_ignored = this.config.daily_lead_cap
  }

  private done(route: BuyerClickSendRoute, reason: BuyerClickSendReason, detail?: string): BuyerClickSendResult {
    this.out._route = route
    this.out.reason = reason
    if (detail !== undefined) this.out.detail = detail
    this.deps.log({ event: 'buyer_click_send_reason', step_namespace: this.node.namespace, partner_id: this.out.partner_id, partner_slug: this.out.partner_slug, route, reason, detail })
    return { output: this.out }
  }

  private fail(reason: BuyerClickSendFailureReason, errorType: 'transient' | 'permanent', detail: string): BuyerClickSendResult {
    this.out.detail = detail
    this.deps.log({ event: 'buyer_click_send_failed', step_namespace: this.node.namespace, partner_id: this.out.partner_id, partner_slug: this.out.partner_slug, reason, detail })
    return { output: this.out, failure: { message: `buyer_click_send ${reason}: ${detail}`, errorType, reason } }
  }

  async execute(): Promise<BuyerClickSendResult> {
    // A recovery run would post the click again: resume re-runs every node from the entry.
    if (this.ctx.recovery) {
      return this.fail('recovery_run_refused', 'permanent', `this is a ${this.ctx.recovery} of an earlier execution, and a click is never re-sent by one; a new click starts a new execution`)
    }
    const checked = this.validate()
    if (!('prospectId' in checked)) return checked
    this.out.prospect_id = checked.prospectId

    // The slug, for words only. Resolved before a report only run returns, so a
    // Test Runner run shows a partner the org does not hold before launch.
    let partner: { slug: string } | null
    try {
      partner = await this.deps.resolvePartner(checked.partnerId)
    } catch (err) {
      return this.fail('partner_unreadable', 'transient', `partner ${checked.partnerId} could not be read, so nothing was sent: ${messageOf(err)}`)
    }
    if (!partner) return this.fail('partner_not_found', 'permanent', `no partner with id ${checked.partnerId} in this organization, so nothing was sent; pick the buyer again on the node`)
    this.out.partner_slug = partner.slug

    // The profile, once, before anything is claimed (#1639): it may say where the
    // click goes, and its cap judges the over cap notice after the count.
    let profile: ProfileRead
    try {
      profile = await withDeadline(this.deps.readProfile(checked.partnerId), CLICK_PROFILE_READ_DEADLINE_MS, 'buyer profile', this.deps.timers)
    } catch (err) {
      return this.fail('profile_unreadable', 'transient', `the buyer profile could not be read, so where this click goes is not known and nothing was sent: ${messageOf(err)}`)
    }
    // The profile is the only place a click can go (#1671): every way of it holding
    // no delivery is refused here, by name, before anything is claimed.
    if (!profile.found) {
      return this.fail('no_profile', 'permanent', `there is no buyer profile for ${partner.slug}, so there is no Click delivery to send to and nothing was sent; give the buyer a profile sold on the click, with its Click delivery filled, on the partner page`)
    }
    if (profile.soldOn !== 'click') {
      return this.fail('not_sold_on_click', 'permanent', `the buyer profile for ${partner.slug} is sold on the ${String(profile.soldOn)}, not the click, so it holds no Click delivery and nothing was sent; set the profile to be sold on the click and fill its Click delivery, or take this node off the workflow`)
    }
    if (!profile.clickDelivery) {
      return this.fail('click_delivery_unset', 'permanent', `the buyer profile for ${partner.slug} holds no Click delivery, so where this click goes is not known and nothing was sent; fill the buyer profile's Click delivery (routes and success reply) on the partner page`)
    }
    const target = this.fromProfile(profile.clickDelivery)
    if ('output' in target) return target
    const v: Validated = { ...checked, ...target, slug: partner.slug, enabled: profile.enabled, cap: profile.cap }

    if (this.out.mode_effective === 'report_only') {
      this.out.would_send_body_sha256 = await canonicalBodySha256(v.body)
      return this.done('not_sent', 'report_only', 'a test, shadow or local run claims, sends and counts nothing')
    }

    // 1. claim
    const sale = this.deps.saleClient({ kind: 'click', partner_id: v.partnerId, prospect_id: v.prospectId })
    const executionId = this.executionId()
    // CLICK_RUN_BUDGET_MS runs from here, a moment before the object starts the claim's deadline.
    const claimStartedAt = this.deps.clock()
    let claim: ClaimResult
    try {
      claim = await sale.claim({ partner_id: v.partnerId, execution_id: executionId, deadline_ms: CLICK_CLAIM_DEADLINE_MS })
    } catch (err) {
      return this.fail('claim_unavailable', 'transient', `nothing was sent: ${messageOf(err)}`)
    }
    switch (claim.state) {
      case 'sold':
        this.out.partner_lead_id = claim.outcome.buyer_reference
        this.out.status = claim.outcome.http_status
        return this.done('already_sent', 'already_sent', `an earlier click sent this prospect to ${v.slug}`)
      case 'in_flight':
        return this.done('in_progress', 'claim_in_progress', `execution ${claim.holder_execution_id} has been sending it since ${new Date(claim.since).toISOString()}`)
      case 'in_doubt': {
        const detail = 'an earlier send never recorded its outcome, so this click was not sent'
        await this.holdAndPage(v, 'claim_in_doubt', detail, null)
        return this.done('needs_review', 'claim_in_doubt', detail)
      }
      case 'claimed':
        break
    }
    const generation = claim.generation

    // 2. post
    let res: PartnerCallResult
    try {
      res = await withDeadline(this.deps.post({ slug: v.slug, url: v.url }, v.body, { traceId: this.ctx.trigger.trace_id, timeoutMs: CLICK_POST_TIMEOUT_MS }), CLICK_POST_DEADLINE_MS, 'click post', this.deps.timers)
    } catch (err) {
      const detail = `no answer from the buyer: ${messageOf(err)}`
      await this.holdAndPage(v, 'outcome_unknown', detail, null)
      return this.done('unknown', 'outcome_unknown', detail)
    }
    this.out.status = res.status

    // 3. classify
    const verdict = classifyClickAnswer(res, v.pattern)
    if (verdict.kind === 'unknown') {
      await this.holdAndPage(v, 'outcome_unknown', verdict.detail, null)
      return this.done('unknown', 'outcome_unknown', verdict.detail)
    }
    if (verdict.kind === 'refused') {
      try {
        await sale.free(generation)
        this.out.claim_freed = true
      } catch (err) {
        this.out.claim_freed = false
        const detail = `the buyer refused it (${verdict.detail}) and the claim could not be released: ${messageOf(err)}`
        await this.holdAndPage(v, 'free_failed', detail, null)
      }
      return this.done('refused', 'refused_by_buyer', verdict.detail)
    }

    this.out.partner_lead_id = verdict.partnerLeadId
    try {
      await sale.sold(generation, { buyer_reference: verdict.partnerLeadId, result_code: 'created', http_status: res.status, payout_cents: 0 })
    } catch (err) {
      const detail = `the buyer confirmed receipt with id ${verdict.partnerLeadId}, and marking the claim sold failed: ${messageOf(err)}`
      await this.holdAndPage(v, 'sold_mark_failed', detail, verdict.partnerLeadId)
    }
    await this.count(v, claimStartedAt)
    return this.done('sent', 'sent', `the buyer confirmed receipt with id ${verdict.partnerLeadId}`)
  }

  /**
   * Adds the prospect to today's distinct count, then judges the over cap notice.
   *
   * An ask with no answer may still have landed (#1766: on 2026-10-05 one landed
   * 48 ms after the caller gave up), and the count is a set, so it is asked once
   * more when the run budget still holds the retry and its page. Which failures
   * are asked again is the shared rule (addAskingOnceMore), the same one the held
   * click Mark sent route follows. The page then says only what was answered:
   * count_failed for a refusal, count_unknown when nothing says whether it took it.
   */
  private async count(v: Validated, claimStartedAt: number): Promise<void> {
    const now = this.deps.clock()
    let counter: ClickCounterApi
    try {
      counter = this.deps.counter(v.partnerId, now)
    } catch (err) {
      await this.countFailed(v, [{ kind: 'not_asked', message: messageOf(err) }], false, true)
      return
    }
    this.out.count_date = counter.date
    let elapsed = 0
    // Each ask is bounded by the node itself, so the run budget does not rest on the client's own deadline.
    const outcome = await addAskingOnceMore(
      () => withDeadline(counter.addMember(v.prospectId), OBJECT_CALL_DEADLINE_MS, 'click counter add', this.deps.timers),
      () => {
        elapsed = this.deps.clock() - claimStartedAt
        return elapsed + CLICK_COUNT_RETRY_COST_MS <= CLICK_RUN_BUDGET_MS
      },
    )
    const first = outcome.failed[0]
    if (first?.kind === 'no_answer') {
      const retried = !outcome.retryDeclined
      this.deps.log({ event: 'buyer_click_count_no_answer', step_namespace: this.node.namespace, partner_id: v.partnerId, partner_slug: v.slug, retried, elapsed_since_claim_ms: elapsed, error_message: first.message })
      if (retried) this.out.count_retried = first.message
    }
    if (!outcome.result) {
      await this.countFailed(v, outcome.failed, outcome.retryDeclined, addKnownRefused(outcome))
      return
    }
    const added = outcome.result
    this.out.count = added.count
    this.out.counted = added.added

    // The same read the address came from (#1639), so the route and the cap are one
    // snapshot. It is a click profile: anything else was refused before the claim.
    if (!v.enabled) {
      // Switched off while offers were out (Dan, 2026-09-30): the click is sent, and
      // nothing more is offered, so there is no overshoot to warn about.
      this.out.over_cap = 'no_enabled_profile'
      this.deps.log({ event: 'buyer_click_send_no_enabled_profile', step_namespace: this.node.namespace, partner_id: v.partnerId, partner_slug: v.slug })
      return
    }
    const cap = v.cap
    // The one cap rule (isCap), shared with save validation and buyer_click_check.
    if (!isCap(cap)) {
      this.out.over_cap = 'cap_unreadable'
      await this.page(v, 'cap_unreadable', `the enabled buyer profile holds daily cap ${JSON.stringify(cap)}, not a whole number above zero`, null)
      return
    }
    this.out.daily_lead_cap = cap
    const threshold = Math.ceil((cap * v.percent) / 100)
    if (added.count < threshold) {
      this.out.over_cap = 'not_due'
      return
    }
    this.out.over_cap = await this.alert({
      kind: 'over_cap', partner_id: v.partnerId, partner_slug: v.slug, date: counter.date, count: added.count, daily_lead_cap: cap,
      alert_over_percent: v.percent, threshold, workflow_id: this.ctx.trigger.workflow_id, at: now,
    })
  }

  /**
   * The count page, saying what the counter answered and nothing more (L11). The
   * click is known not to be counted only when the one ask was refused or never
   * made (`known`); an ask with no answer may have landed, so any run holding one
   * pages count_unknown, whatever a retry then answered.
   */
  private async countFailed(v: Validated, asks: CountFailure[], notRetried: boolean, known: boolean): Promise<void> {
    this.out.over_cap = 'not_counted'
    let detail = `the buyer confirmed receipt with id ${this.out.partner_lead_id}, and the day's count ${describeAsk(asks[0])}`
    if (asks[1]) detail += `; asked again, it ${describeAsk(asks[1])}`
    if (notRetried) detail += ". It was not asked again, because too little of this click's time was left"
    this.out.count_error = detail
    await this.page(v, known ? 'count_failed' : 'count_unknown', detail, null)
  }

  /** A held claim: record it for the partner page, then page with whether that record landed. */
  private async holdAndPage(v: Validated, reason: HeldClickReason, detail: string, partnerLeadId: string | null): Promise<void> {
    const recorded = await this.recordHold(v, reason, detail, partnerLeadId)
    await this.page(v, reason, detail, recorded)
  }

  /**
   * Bounded and caught like an alert: the click it records already happened, so a
   * failure is reported, never thrown. Answers whether the record landed, which the
   * page for this hold carries, so it points at the Held clicks list only when the
   * list has the click. A record that ran out of time may still land (the rpc is
   * an idempotent upsert), so it answers outcome_unknown, never false (#1849).
   */
  private async recordHold(v: Validated, reason: HeldClickReason, detail: string, partnerLeadId: string | null): Promise<HoldRecorded> {
    try {
      await withDeadline(
        this.deps.recordHold({
          partner_id: v.partnerId, prospect_id: v.prospectId, reason, detail, partner_lead_id: partnerLeadId,
          workflow_id: this.ctx.trigger.workflow_id, execution_id: this.executionId(), trace_id: this.ctx.trigger.trace_id,
        }),
        CLICK_HOLD_RECORD_DEADLINE_MS, 'held click record', this.deps.timers,
      )
      this.out.hold_recorded = true
      return true
    } catch (err) {
      const recorded: HoldRecorded = err instanceof DeadlineError ? 'outcome_unknown' : false
      this.out.hold_recorded = recorded
      this.out.hold_record_error = messageOf(err)
      this.deps.log({ event: 'buyer_click_hold_record_failed', step_namespace: this.node.namespace, partner_id: v.partnerId, partner_slug: v.slug, reason, hold_outcome: recorded === false ? 'not_recorded' : recorded, error_message: messageOf(err) })
      return recorded
    }
  }

  private executionId(): string {
    return this.ctx.trigger.execution_id ?? this.ctx.trigger.trace_id
  }

  /** holdRecorded: what recordHold answered for this page's hold, null for a page that holds no claim. */
  private async page(v: Validated, reason: ClickPageReason, detail: string, holdRecorded: HoldRecorded | null): Promise<void> {
    const outcome = await this.alert({
      kind: 'page', reason, partner_id: v.partnerId, partner_slug: v.slug, prospect_id: v.prospectId, detail, hold_recorded: holdRecorded,
      workflow_id: this.ctx.trigger.workflow_id, trace_id: this.ctx.trigger.trace_id, at: this.deps.clock(),
    })
    this.out.pages.push({ reason, outcome })
  }

  /** Every alert is bounded and caught: the click it reports on already happened (never fails the node). */
  private async alert(alert: ClickAlert): Promise<ClickAlertOutcome> {
    try {
      return await withDeadline(this.deps.alert(alert), CLICK_ALERT_DEADLINE_MS, 'buyer click alert', this.deps.timers)
    } catch (err) {
      this.deps.log({ event: 'buyer_click_alert_failed', step_namespace: this.node.namespace, partner_id: alert.partner_id, partner_slug: alert.partner_slug, alert_kind: alert.kind, error_message: messageOf(err) })
      return 'post_failed'
    }
  }

  private validate(): Checked | BuyerClickSendResult {
    const c = this.config
    // The one partner id rule, shared with save validation (#1543).
    const partnerRule = partnerIdOf(c.partner_id)
    if (!partnerRule.ok) return this.fail('partner_id_invalid', 'permanent', partnerRule.reason)
    const partnerId = partnerRule.id

    const percentRule = alertOverPercentOf(c.alert_over_percent)
    if (!percentRule.ok) return this.fail('alert_over_percent_invalid', 'permanent', percentRule.reason)
    const percent = percentRule.percent

    const prospect = this.resolve(c.prospect_id)
    const prospectId = typeof prospect === 'string' ? prospect.trim() : typeof prospect === 'number' ? String(prospect) : ''
    if (prospectId === '' || prospectId.length > 200) return this.fail('prospect_id_empty', 'permanent', `prospect_id ${JSON.stringify(c.prospect_id ?? null)} resolved to nothing usable`)

    const body = this.resolve(c.request_body)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return this.fail('request_body_invalid', 'permanent', `request_body ${JSON.stringify(c.request_body ?? null)} resolved to ${body === null ? 'null' : Array.isArray(body) ? 'an array' : typeof body}, not an object`)
    }
    return { partnerId, percent, prospectId, body: body as Record<string, unknown> }
  }

  /**
   * The profile's click delivery (#1639): the route for the lead's state and the
   * profile's success line. Re-checked with the shared rules, which save
   * validation already applied, so a delivery the save would refuse fails by
   * name here rather than posting somewhere.
   */
  private fromProfile(delivery: ClickDelivery): Target | BuyerClickSendResult {
    const rule = successPatternOf(delivery.successPattern)
    if (!rule.ok) return this.fail('click_delivery_invalid', 'permanent', `the buyer profile's success line: ${rule.reason}`)
    // With a route per state, a node that names no state would send every lead to
    // the catch-all, which for a buyer licensed state by state is the wrong buyer
    // product, so it is refused by name until the canvas gains the template.
    const stateTemplate = typeof this.config.state === 'string' ? this.config.state.trim() : ''
    if (stateTemplate === '' && delivery.routes.some((r) => r.states.length > 0)) {
      return this.fail('state_template_unset', 'permanent', "the buyer profile routes clicks by state, and this node has no state template, so the route cannot be chosen; set the node's state")
    }
    const picked = pickClickRoute(delivery, stateTemplate === '' ? undefined : this.resolve(stateTemplate))
    if (!picked) return this.fail('click_delivery_invalid', 'permanent', "the buyer profile's click delivery has no route with no states to take every other state")
    if (!isHttpsUrl(picked.route.url)) return this.fail('click_delivery_invalid', 'permanent', `the buyer profile's route ${picked.route.name} has no https address`)
    this.out.route_name = picked.route.name
    this.out.route_matched = picked.matched
    this.out.route_state = picked.state
    this.out.url_source = 'profile'
    this.out.pattern_source = 'profile'
    return { pattern: rule.pattern, url: new URL(picked.route.url).toString() }
  }

  private resolve(template: unknown): unknown {
    if (typeof template !== 'string' || template === '') return undefined
    try {
      return resolveValue(template, this.ctx)
    } catch {
      return undefined
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'non Error thrown'
}

/**
 * A failed ask of the click counter (#1766): what the shared rule names
 * (AddFailure in buyer-object-clients), plus the node's own not_asked, a
 * counter that could not even be opened, so nothing was asked.
 */
type CountFailure = AddFailure | { kind: 'not_asked'; message: string }

function describeAsk(ask: CountFailure): string {
  switch (ask.kind) {
    case 'no_answer': return `did not answer: ${ask.message}`
    case 'refused': return `refused to add it: ${ask.message}`
    case 'error_status': return `answered with an error that does not say whether it took it: ${ask.message}`
    case 'unreadable': return `answered, but its answer could not be read: ${ask.message}`
    case 'not_asked': return `could not be asked: ${ask.message}`
    case 'unclassified': return `failed in a way this node does not classify: ${ask.message}`
  }
}
