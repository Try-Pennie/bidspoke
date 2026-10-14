/**
 * The buyer_click_send node's two Slack messages (#1542).
 *
 *   page       a click that needs a person: a send with no readable answer, a
 *              claim found in doubt, a sale or a count that could not be
 *              recorded, a claim that could not be freed, or a cap the over cap
 *              notice cannot read. Keyed by buyer and reason, with a cooldown,
 *              so a burst of one fault is one page; the execution list holds
 *              every occurrence.
 *   over_cap   the day's distinct clicks passed the alert threshold (60 at a
 *              cap of 50). Keyed by buyer and PACIFIC date, so it posts once a
 *              day per buyer.
 *
 * The buyer in both keys is its partner id, never its slug (#1553), so a slug
 * renamed mid day neither repeats the over cap notice nor lifts a cooldown.
 *
 * Both are decided by the alert claim object (AlertClaimObject, #1298), whose
 * TTL IS the cooldown: strongly consistent, so two clicks that page together
 * post once. The claim fails open when the object cannot be asked, so the
 * worst case is a duplicate, never a missing page.
 *
 * This never throws. The node calls it after the send it reports on, and a
 * Slack failure must never turn a sent click into a failed step: it is logged,
 * the claim is released so the next occurrence can try again, and the caller
 * records the outcome on the step.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { HELD_CLICK_REASONS } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
import { makeAlertClaims, type AlertClaims } from './alert-claim'
import { formatErr } from './format-error'
import { resolveSlackForBlockAlert } from './partner-block-alert'
import { etTime, readSlackConnectionForLead, sendBuyerClickAlert, type BuyerClickAlertMessage } from './slack'
import { readLastGoodSlackConnections } from './volume-cliff'
import { secretKeys } from './secret-crypto'

/**
 * Whether a held click record landed (#1552): true, false when the write was
 * refused, or outcome_unknown when it ran out of time and may have (#1849).
 */
export type HoldRecorded = boolean | 'outcome_unknown'

/** One page per buyer per reason per quarter hour. */
export const CLICK_PAGE_COOLDOWN_SECONDS = 15 * 60
/** Longer than any day, so the per date key cannot post twice inside one. */
export const CLICK_OVER_CAP_TTL_SECONDS = 26 * 60 * 60

/**
 * The send side's seven, plus two from buyer_click_check: partner_not_click
 * (#1557), a buyer picked on the offer side check whose profile is sold on the
 * offer, and click_url_has_no_prospect_id (#1546). The check routes not
 * eligible rather than failing Engine's execution, so these pages are how a
 * person hears about it.
 *
 * The count has two (#1766), split by what the counter answered: count_failed
 * when it refused the add, so the click is known not to be counted, and
 * count_unknown when nothing it answered says whether it took the click (no
 * answer even after the one retry, an error status, an answer that cannot be
 * read, or an error the node does not classify), because an add that timed out
 * can still land.
 */
export const CLICK_PAGE_REASONS = ['claim_in_doubt', 'outcome_unknown', 'sold_mark_failed', 'count_failed', 'count_unknown', 'free_failed', 'cap_unreadable', 'partner_not_click', 'click_url_has_no_prospect_id'] as const
export type ClickPageReason = (typeof CLICK_PAGE_REASONS)[number]

export type ClickAlert =
  | {
      kind: 'page'
      reason: ClickPageReason
      /** The partner_configs id: the cooldown key, so a slug rename neither repeats nor lifts it (#1553). */
      partner_id: string
      /** For the words only. */
      partner_slug: string
      /** The click's prospect; null for a page from the offer side, which judges a lead before any prospect clicked. */
      prospect_id: string | null
      detail: string
      /**
       * Whether the held click record landed (#1552): true when the partner page's
       * Held clicks list has it, false when the record failed, null for a page
       * that holds no claim. The page points at that list only on true, because
       * the reason alone cannot say whether the list has the click.
       * outcome_unknown when the record ran out of time, since a write that
       * timed out may still have landed (#1849).
       */
      hold_recorded: HoldRecorded | null
      /**
       * True when the call this page is about (the sold mark, the release) got
       * NO answer, a deadline or a call lost in transit, so it may have landed
       * (#835). The page then says so rather than that the claim is still held.
       */
      unanswered?: boolean
      workflow_id: string
      trace_id: string
      at: number
    }
  | {
      kind: 'over_cap'
      partner_id: string
      partner_slug: string
      /** The Pacific date the counter counts. */
      date: string
      count: number
      daily_lead_cap: number
      alert_over_percent: number
      threshold: number
      workflow_id: string
      at: number
    }

export type ClickAlertOutcome = 'posted' | 'claimed_elsewhere' | 'no_slack' | 'post_failed'

type SlackTarget = { bot_token: string; default_channel: string }

export interface ClickAlertDeps {
  claims: AlertClaims | undefined
  resolveSlack: () => Promise<SlackTarget | null>
  send?: typeof sendBuyerClickAlert
  appUrl: string
  log?: (line: string) => void
}

export function clickAlertKey(alert: ClickAlert): { key: string; ttlSeconds: number } {
  return alert.kind === 'page'
    ? { key: `buyer-click-page:${alert.partner_id}:${alert.reason}`, ttlSeconds: CLICK_PAGE_COOLDOWN_SECONDS }
    : { key: `buyer-click-over-cap:${alert.partner_id}:${alert.date}`, ttlSeconds: CLICK_OVER_CAP_TTL_SECONDS }
}

/**
 * What each page says happened and what it left behind. Complete over the
 * reasons at compile time (L113). `heldUnanswered` replaces `held` when the
 * call the page is about got no answer and so may have landed (#835).
 */
const PAGE_WORDING: Record<ClickPageReason, { header: string; held: string; heldUnanswered?: string }> = {
  outcome_unknown: {
    header: 'sent a click with no readable answer',
    held: 'Whether the buyer received the lead is not known. The claim on this prospect is held, so no later click on it sends until a person checks with the buyer and releases it.',
  },
  claim_in_doubt: {
    header: 'has a click claim in doubt',
    held: 'An earlier send on this prospect never recorded its outcome. The claim is held, so this click was not sent; a person has to check with the buyer and release it.',
  },
  sold_mark_failed: {
    header: 'confirmed receipt of a click but the claim could not be marked sold',
    held: 'The buyer confirmed receipt of the lead. The claim is still held in flight, so a later click on this prospect will not send.',
    heldUnanswered:
      'The buyer confirmed receipt of the lead. Marking the claim sold got no answer in time, so it may have landed; if it did not, the claim is held in flight and a later click on this prospect will not send.',
  },
  count_failed: {
    header: 'sent a click that could not be counted',
    held: "The buyer confirmed receipt of the lead, but today's click count did not take it, so the count reads low by this click until it is added.",
  },
  count_unknown: {
    header: 'sent a click that may not have been counted',
    held: "The buyer confirmed receipt of the lead. Today's click count did not say whether it took this click, so the click may not have been counted.",
  },
  free_failed: {
    header: 'refused a click, and the claim could not be released',
    held: 'The buyer refused this prospect. The claim is still held, so a later click on it will not retry until a person releases it.',
    heldUnanswered:
      'The buyer refused this prospect. Releasing the claim got no answer in time, so it may have landed; if it did not, the claim is held and a later click on it will not retry until a person releases it.',
  },
  cap_unreadable: {
    header: 'click buyer has no valid daily cap',
    // The profile was read; the cap it holds is the problem (#835), and the line above names it.
    held: "The click was handled, but the over cap notice cannot be judged without a daily cap, so it will not post for this buyer until the profile's daily cap is set to a whole number above zero.",
  },
  partner_not_click: {
    header: 'is named on a Buyer Click Check but is not sold on the click',
    held: 'No lead is offered to it through this check. Either set its buyer profile to be sold on the click, or pick a buyer sold on the click on the node.',
  },
  click_url_has_no_prospect_id: {
    header: 'click URL has no place for the prospect id',
    held: 'No lead is offered to this buyer until the click URL on its partner page carries {prospect_id} where the prospect\'s id goes, because the offer replaces that placeholder and refuses a URL without it.',
  },
}

/**
 * Where the person releases a held claim (#1552), decided by whether the record
 * the partner page lists actually landed, never by the reason alone. Only a
 * recorded hold is on the Held clicks list; for one that is not, the page says
 * so, and says it appears there when a later click on the prospect finds the
 * claim, which records it again (buyer_click_send records claim_in_doubt).
 */
function releaseLine(alert: Extract<ClickAlert, { kind: 'page' }>, appUrl: string): string {
  const partnerPage = `${appUrl}/partners?selected=${encodeURIComponent(alert.partner_slug)}`
  if (alert.hold_recorded === true) return `Release it under Held clicks on the ${alert.partner_slug} partner page: ${partnerPage}`
  const claim = alert.prospect_id === null ? `the claim for ${alert.partner_slug}` : `the claim on prospect \`${alert.prospect_id}\` for ${alert.partner_slug}`
  if (alert.hold_recorded === 'outcome_unknown') {
    return [
      `The record of this click did not answer in time, so it may or may not be on the Held clicks list on the ${alert.partner_slug} partner page: ${partnerPage}`,
      `If it is there, release it there. If not, ${claim} is held with nothing there to release it, and the next click on this prospect after the claim's send window finds it and records it there.`,
      'Why the record did not answer is on the execution linked below.',
    ].join(' ')
  }
  return [
    `This click could not be added to the Held clicks list on the ${alert.partner_slug} partner page, so ${claim} is held with nothing there to release it.`,
    'The next click on this prospect after the claim\'s send window finds it and records it there, and it can be released then.',
    'Why the record failed is on the execution linked below.',
  ].join(' ')
}

export function clickAlertMessage(alert: ClickAlert, appUrl: string): BuyerClickAlertMessage {
  if (alert.kind === 'page') {
    const w = PAGE_WORDING[alert.reason]
    const release = (HELD_CLICK_REASONS as readonly string[]).includes(alert.reason) ? [releaseLine(alert, appUrl)] : []
    return {
      header: `${alert.partner_slug} ${w.header}`,
      body: [
        alert.prospect_id === null ? `${alert.detail}.` : `Prospect \`${alert.prospect_id}\`: ${alert.detail}.`,
        alert.unanswered === true && w.heldUnanswered !== undefined ? w.heldUnanswered : w.held,
        ...release,
        `Further ${alert.reason} pages for ${alert.partner_slug} are held for ${CLICK_PAGE_COOLDOWN_SECONDS / 60} minutes; the executions list shows every occurrence. Seen at ${etTime(alert.at)}.`,
      ].join('\n\n'),
      link: `${appUrl}/workflows/${alert.workflow_id}/executions?trace=${encodeURIComponent(alert.trace_id)}`,
    }
  }
  return {
    header: `${alert.partner_slug} clicks reached ${alert.count} today`,
    body: [
      `${alert.count} distinct prospects were sent to ${alert.partner_slug} on ${alert.date} (Pacific day), at or past ${alert.alert_over_percent} percent of the daily cap of ${alert.daily_lead_cap} (${alert.threshold}).`,
      'Offers stop at the cap; clicks on offers already made still send, which is how the count passes it. This notice posts once per Pacific day.',
    ].join('\n\n'),
    link: `${appUrl}/workflows/${alert.workflow_id}/executions`,
  }
}

/**
 * The production alert both click nodes post through (#1557): the alert claim
 * object for the cooldown, and the org's Slack connection from the database
 * first (one bounded read, #1849) and the last good copy second, so a page still goes out while Supabase
 * wobbles (L682).
 */
export function productionClickAlert(orgId: string, env: Env, supabase: SupabaseClient): (alert: ClickAlert) => Promise<ClickAlertOutcome> {
  return (alert) =>
    postClickAlert(
      {
        claims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
        resolveSlack: () =>
          resolveSlackForBlockAlert(
            orgId,
            () => readSlackConnectionForLead(supabase, orgId),
            () => readLastGoodSlackConnections(env.IDEMPOTENCY, secretKeys(env)),
          ),
        appUrl: env.APP_URL,
      },
      alert,
    )
}

export async function postClickAlert(deps: ClickAlertDeps, alert: ClickAlert): Promise<ClickAlertOutcome> {
  const log = deps.log ?? ((line: string) => console.error(line))
  const send = deps.send ?? sendBuyerClickAlert
  const { key, ttlSeconds } = clickAlertKey(alert)
  const release = async () => {
    if (deps.claims) await deps.claims.release(key)
  }
  try {
    if (deps.claims && !(await deps.claims.claim(key, ttlSeconds))) return 'claimed_elsewhere'
    const slack = await deps.resolveSlack()
    if (!slack) {
      log(`[buyer-click-alert] no Slack connection, so ${key} was logged but not posted`)
      await release()
      return 'no_slack'
    }
    const ts = await send(slack, slack.default_channel, clickAlertMessage(alert, deps.appUrl))
    if (ts === null) {
      log(`[buyer-click-alert] Slack post failed for ${key}; released so the next occurrence can try`)
      await release()
      return 'post_failed'
    }
    return 'posted'
  } catch (err) {
    log(`[buyer-click-alert] post failed for ${key}: ${formatErr(err)}`)
    await release().catch(() => undefined)
    return 'post_failed'
  }
}
