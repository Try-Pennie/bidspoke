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
 *   2. POST the url and body a preceding code node built, with a 20 s timeout.
 *   3. CLASSIFY the answer three ways:
 *        confirmed  a 2xx whose body is exactly the buyer's success line, the
 *                   partner's own `success_pattern` with an `id` group, matched
 *                   anchored. Mark the claim sold (payout 0, the partner lead id),
 *                   then add the prospect to today's distinct count. A mark or an
 *                   add that fails pages; the route is still `sent`.
 *        refused    a 4xx carrying the buyer's own error (not an HTML page, not
 *                   empty, not 408 or 429): free the claim so a later click retries.
 *        unknown    everything else: a timeout, a network error, a 5xx, an HTML
 *                   page, a 2xx that is not the success line. The claim is kept
 *                   held, the node pages, and only a person releases it.
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
 * The partner is a SETTING (EvaFi follows Liberty1): the partner and the success
 * pattern are config, and no buyer's literal lives in this file. The daily cap
 * the over cap notice is judged against is the buyer PROFILE's (#1543, L83),
 * the same number buyer_click_check stops offering at, read through the one
 * profile reader after the click is counted. A profile that cannot be read, or
 * an enabled one holding no cap, pages cap_unreadable; no enabled profile at all
 * (switched off while offers were still out) is recorded and pages nothing.
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
import { alertOverPercentOf, canonicalBodySha256, isCap, partnerIdOf, withDeadline, type SoldOn, type Timers } from '@bidspoke/buyer-profile'
import type { Env } from '../../index'
import type { ExecutionContext, NodeDefinition } from '../../types'
import type { ClaimBody, ClaimResult } from '../../durable-objects/lead-sale'
import type { SaleOutcomeRecord } from '../../durable-objects/sale-outcome'
import type { AddMemberResult } from '../../durable-objects/daily-cap'
import { ClickCounterClient, LeadSaleClient, OBJECT_CALL_DEADLINE_MS, type ClickClaimKey } from '../../lib/buyer-object-clients'
import { loadBuyerProfiles } from '../../lib/buyer-profile-loader'
import { loadPartnerConstants } from '../../lib/partner-constants-loader'
import { postToPartner, type PartnerCallResult } from '../../lib/post-to-partner'
import { productionClickAlert, type ClickAlert, type ClickAlertOutcome, type ClickPageReason } from '../../lib/buyer-click-alert'
import { log as structuredLog } from '../../lib/logger'
import { resolveValue } from '../context'
import { isShadowDryRun } from '../shadow'

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
 * each, plus 10 s of margin. A deadline shorter than that would let a second
 * click find the claim in doubt while the first is still legitimately
 * finishing. Replace the reasoning with the measured p99 from the first week of
 * live clicks (the step rows carry duration_ms).
 */
export const CLICK_CLAIM_DEADLINE_MS = CLICK_POST_TIMEOUT_MS + 2 * OBJECT_CALL_DEADLINE_MS + 10_000

/** The node's own bound on the post, a second past the post's timeout, so a fetch that ignores its abort still ends. */
export const CLICK_POST_DEADLINE_MS = CLICK_POST_TIMEOUT_MS + 1_000

/** How long the node waits on one Slack alert before recording it as failed. */
export const CLICK_ALERT_DEADLINE_MS = 5_000

/** How long the node waits on the profile's cap after the click is counted; past it the notice is cap_unreadable. */
export const CLICK_CAP_READ_DEADLINE_MS = 5_000


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
  | 'success_pattern_invalid'
  | 'alert_over_percent_invalid'
  | 'prospect_id_empty'
  | 'request_url_invalid'
  | 'request_body_invalid'
  | 'claim_unavailable'
  | 'buyer_click_send_handle_unwired'

/** Whether the over cap notice went out on this click. */
export type OverCapState = ClickAlertOutcome | 'not_due' | 'cap_unreadable' | 'no_enabled_profile' | 'not_counted'

// ── Config and output ─────────────────────────────────────────────────────────

export interface BuyerClickSendConfig {
  /** The buyer's partner_configs id (#1553). Names the claim and the counter; the slug is looked up from it. */
  partner_id: string
  /** Template resolving to the prospect id, the claim and count key. */
  prospect_id: string
  /** Template resolving to the https URL the preceding code node picked. */
  request_url: string
  /** Template resolving to the body object the preceding code node built. */
  request_body: string
  /**
   * The buyer's success line as a regular expression with a named `id` group,
   * matched against the WHOLE trimmed body. Per partner; no default (L72).
   */
  success_pattern: string
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
  /** The distinct count after this click, null when it was not counted. */
  count: number | null
  /** True when this click added the prospect to the count, false when it was already there or the add failed. */
  counted: boolean
  count_date: string | null
  over_cap: OverCapState | null
  /** The profile's daily cap the notice was judged against, null when it was not read or there was none. */
  daily_lead_cap: number | null
  /** A cap still stored on the node, shown because it is not the one in force. */
  daily_lead_cap_ignored?: unknown
  claim_freed?: boolean
  pages: Array<{ reason: ClickPageReason; outcome: ClickAlertOutcome }>
  would_send_body_sha256?: string
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

export interface ClickSaleApi {
  claim(body: ClaimBody): Promise<ClaimResult>
  sold(generation: number, outcome: SaleOutcomeRecord): Promise<number>
  free(generation: number): Promise<number>
}

export interface ClickCounterApi {
  readonly date: string
  addMember(member: string): Promise<AddMemberResult>
}

/** The enabled profile's cap and how the buyer is sold, so an offer buyer's leads cap is never judged against clicks (#1557). */
export type ProfileCap = { found: false } | { found: true; cap: number | null; soldOn: SoldOn | null }

export interface BuyerClickSendDeps {
  /** The buyer's enabled profile's daily cap, through the one profile reader; found false when no enabled profile. Throws when it cannot be read. */
  profileCap: (partnerId: string) => Promise<ProfileCap>
  /** The org's partner by id, for its slug; null when the org holds no such partner. Throws when it cannot be read. */
  resolvePartner: (partnerId: string) => Promise<{ slug: string } | null>
  saleClient: (key: ClickClaimKey) => ClickSaleApi
  counter: (partnerId: string, nowMs: number) => ClickCounterApi
  post: (target: { slug: string; url: string }, body: unknown, opts: { traceId: string; timeoutMs: number }) => Promise<PartnerCallResult>
  alert: (alert: ClickAlert) => Promise<ClickAlertOutcome>
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
    profileCap: async (partnerId) => {
      const snapshot = await loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase, { background })
      const buyer = snapshot.buyers.find((b) => b.partner.id === partnerId)
      return buyer ? { found: true, cap: buyer.profile.dailyLeadCap, soldOn: buyer.profile.soldOn } : { found: false }
    },
    // The org scoped, cached partner read the Constants node already uses (memory, KV, then a
    // last good copy), so a click does not pay a cold database read and survives a Supabase wobble.
    resolvePartner: async (partnerId) => {
      const constants = await loadPartnerConstants(orgId, env.WORKFLOW_CACHE, supabase)
      if (!constants.slugsById) throw new Error('the partner list was served from a last good copy written before partner ids were recorded, because the database read failed')
      const slug = constants.slugsById[partnerId]
      return slug ? { slug } : null
    },
    saleClient: (key) => new LeadSaleClient(env.LEAD_SALE, key),
    counter: (partnerId, nowMs) => new ClickCounterClient(env.DAILY_CAP, partnerId, nowMs),
    // The one outbound POST (L613): the URL is the node's, and a click buyer carries no stored credential.
    post: (target, body, opts) => postToPartner({ slug: target.slug, api_endpoint: target.url, cf_secret_key: null }, body, env, opts),
    // The one production alert, shared with buyer_click_check (#1557).
    alert: productionClickAlert(orgId, env, supabase),
    clock: () => Date.now(),
    log: (fields) => structuredLog({ ...fields, trace_id: ctx.trigger.trace_id, workflow_id: ctx.trigger.workflow_id, execution_id: ctx.trigger.execution_id } as Parameters<typeof structuredLog>[0]),
    localDev: Boolean(env.LOCAL_DEV),
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

interface Validated {
  partnerId: string
  slug: string
  pattern: RegExp
  percent: number
  prospectId: string
  url: string
  body: Record<string, unknown>
}

class Run {
  readonly startedAt: number
  private readonly config: BuyerClickSendConfig
  private readonly out: BuyerClickSendOutput

  constructor(private readonly node: NodeDefinition, private readonly ctx: ExecutionContext, private readonly deps: BuyerClickSendDeps) {
    this.startedAt = deps.clock()
    this.config = node.config as unknown as BuyerClickSendConfig
    const reportOnly = Boolean(ctx.isTest) || isShadowDryRun(ctx) || deps.localDev
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
    if (!('pattern' in checked)) return checked
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
    const v: Validated = { ...checked, slug: partner.slug }

    if (this.out.mode_effective === 'report_only') {
      this.out.would_send_body_sha256 = await canonicalBodySha256(v.body)
      return this.done('not_sent', 'report_only', 'a test, shadow or local run claims, sends and counts nothing')
    }

    // 1. claim
    const sale = this.deps.saleClient({ kind: 'click', partner_id: v.partnerId, prospect_id: v.prospectId })
    const executionId = this.ctx.trigger.execution_id ?? this.ctx.trigger.trace_id
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
        await this.page(v, 'claim_in_doubt', detail)
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
      await this.page(v, 'outcome_unknown', detail)
      return this.done('unknown', 'outcome_unknown', detail)
    }
    this.out.status = res.status

    // 3. classify
    const verdict = classifyClickAnswer(res, v.pattern)
    if (verdict.kind === 'unknown') {
      await this.page(v, 'outcome_unknown', verdict.detail)
      return this.done('unknown', 'outcome_unknown', verdict.detail)
    }
    if (verdict.kind === 'refused') {
      try {
        await sale.free(generation)
        this.out.claim_freed = true
      } catch (err) {
        this.out.claim_freed = false
        await this.page(v, 'free_failed', `the buyer refused it (${verdict.detail}) and the claim could not be released: ${messageOf(err)}`)
      }
      return this.done('refused', 'refused_by_buyer', verdict.detail)
    }

    this.out.partner_lead_id = verdict.partnerLeadId
    try {
      await sale.sold(generation, { buyer_reference: verdict.partnerLeadId, result_code: 'created', http_status: res.status, payout_cents: 0 })
    } catch (err) {
      await this.page(v, 'sold_mark_failed', `the buyer created ${verdict.partnerLeadId}, and marking the claim sold failed: ${messageOf(err)}`)
    }
    await this.count(v)
    return this.done('sent', 'sent', `the buyer created ${verdict.partnerLeadId}`)
  }

  /** Adds the prospect to today's distinct count, then judges the over cap notice. */
  private async count(v: Validated): Promise<void> {
    const now = this.deps.clock()
    let counter: ClickCounterApi
    let added: AddMemberResult
    try {
      counter = this.deps.counter(v.partnerId, now)
      this.out.count_date = counter.date
      added = await counter.addMember(v.prospectId)
    } catch (err) {
      this.out.over_cap = 'not_counted'
      await this.page(v, 'count_failed', `the buyer created ${this.out.partner_lead_id}, and adding it to the day's count failed: ${messageOf(err)}`)
      return
    }
    this.out.count = added.count
    this.out.counted = added.added

    let profile: ProfileCap
    try {
      profile = await withDeadline(this.deps.profileCap(v.partnerId), CLICK_CAP_READ_DEADLINE_MS, 'buyer profile cap', this.deps.timers)
    } catch (err) {
      this.out.over_cap = 'cap_unreadable'
      await this.page(v, 'cap_unreadable', `the buyer profile could not be read for its daily cap: ${messageOf(err)}`)
      return
    }
    if (!profile.found) {
      // Switched off while offers were out: nothing more is offered, so there is no overshoot to warn about.
      this.out.over_cap = 'no_enabled_profile'
      this.deps.log({ event: 'buyer_click_send_no_enabled_profile', step_namespace: this.node.namespace, partner_id: v.partnerId, partner_slug: v.slug })
      return
    }
    // An offer buyer's daily cap counts leads sold through buyer_select, so it is
    // no cap on clicks: judging clicks against it would be a wrong notice (#1557).
    if (profile.soldOn !== 'click') {
      this.out.over_cap = 'cap_unreadable'
      await this.page(v, 'cap_unreadable', `the enabled buyer profile is sold on the ${String(profile.soldOn)}, not the click, so its daily cap counts leads rather than clicks`)
      return
    }
    const cap = profile.cap
    // The one cap rule (isCap), shared with save validation and buyer_click_check.
    if (!isCap(cap)) {
      this.out.over_cap = 'cap_unreadable'
      await this.page(v, 'cap_unreadable', `the enabled buyer profile holds daily cap ${JSON.stringify(cap)}, not a whole number above zero`)
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

  private async page(v: Validated, reason: ClickPageReason, detail: string): Promise<void> {
    const outcome = await this.alert({
      kind: 'page', reason, partner_id: v.partnerId, partner_slug: v.slug, prospect_id: v.prospectId, detail,
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

  private validate(): Omit<Validated, 'slug'> | BuyerClickSendResult {
    const c = this.config
    // The one partner id rule, shared with save validation (#1543).
    const partnerRule = partnerIdOf(c.partner_id)
    if (!partnerRule.ok) return this.fail('partner_id_invalid', 'permanent', partnerRule.reason)
    const partnerId = partnerRule.id

    let pattern: RegExp
    try {
      if (typeof c.success_pattern !== 'string' || c.success_pattern.trim() === '') throw new Error('it is unset, and there is no default')
      pattern = new RegExp(`^(?:${c.success_pattern})$`)
      if (!/\(\?<id>/.test(c.success_pattern)) throw new Error('it has no (?<id>...) group to capture the partner lead id')
    } catch (err) {
      return this.fail('success_pattern_invalid', 'permanent', `success_pattern: ${messageOf(err)}`)
    }

    const percentRule = alertOverPercentOf(c.alert_over_percent)
    if (!percentRule.ok) return this.fail('alert_over_percent_invalid', 'permanent', percentRule.reason)
    const percent = percentRule.percent

    const prospect = this.resolve(c.prospect_id)
    const prospectId = typeof prospect === 'string' ? prospect.trim() : typeof prospect === 'number' ? String(prospect) : ''
    if (prospectId === '' || prospectId.length > 200) return this.fail('prospect_id_empty', 'permanent', `prospect_id ${JSON.stringify(c.prospect_id ?? null)} resolved to nothing usable`)

    const url = this.resolve(c.request_url)
    let parsed: URL | null
    try {
      parsed = typeof url === 'string' ? new URL(url) : null
    } catch {
      parsed = null
    }
    if (!parsed || parsed.protocol !== 'https:') return this.fail('request_url_invalid', 'permanent', `request_url ${JSON.stringify(c.request_url ?? null)} did not resolve to an https URL`)

    const body = this.resolve(c.request_body)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return this.fail('request_body_invalid', 'permanent', `request_body ${JSON.stringify(c.request_body ?? null)} resolved to ${body === null ? 'null' : Array.isArray(body) ? 'an array' : typeof body}, not an object`)
    }
    return { partnerId, pattern, percent, prospectId, url: parsed.toString(), body: body as Record<string, unknown> }
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
