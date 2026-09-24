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
import type { AlertClaims } from './alert-claim'
import { formatErr } from './format-error'
import { etTime, sendBuyerClickAlert, type BuyerClickAlertMessage } from './slack'

/** One page per buyer per reason per quarter hour. */
export const CLICK_PAGE_COOLDOWN_SECONDS = 15 * 60
/** Longer than any day, so the per date key cannot post twice inside one. */
export const CLICK_OVER_CAP_TTL_SECONDS = 26 * 60 * 60

export const CLICK_PAGE_REASONS = ['claim_in_doubt', 'outcome_unknown', 'sold_mark_failed', 'count_failed', 'free_failed', 'cap_unreadable'] as const
export type ClickPageReason = (typeof CLICK_PAGE_REASONS)[number]

export type ClickAlert =
  | {
      kind: 'page'
      reason: ClickPageReason
      /** The partner_configs id: the cooldown key, so a slug rename neither repeats nor lifts it (#1553). */
      partner_id: string
      /** For the words only. */
      partner_slug: string
      prospect_id: string
      detail: string
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

/** What each page says happened and what it left behind. Complete over the reasons at compile time (L113). */
const PAGE_WORDING: Record<ClickPageReason, { header: string; held: string }> = {
  outcome_unknown: {
    header: 'sent a click with no readable answer',
    held: 'Whether the buyer created the record is not known. The claim on this prospect is held, so no later click on it sends until a person checks with the buyer and releases it.',
  },
  claim_in_doubt: {
    header: 'has a click claim in doubt',
    held: 'An earlier send on this prospect never recorded its outcome. The claim is held, so this click was not sent; a person has to check with the buyer and release it.',
  },
  sold_mark_failed: {
    header: 'created a record but the claim could not be marked sold',
    held: 'The buyer confirmed the record. The claim is still held in flight, so a later click on this prospect will not send; the count below says whether the click was counted.',
  },
  count_failed: {
    header: 'sent a click that could not be counted',
    held: "The buyer confirmed the record, but today's click count did not take it, so the count reads low by this click until it is added.",
  },
  free_failed: {
    header: 'refused a click, and the claim could not be released',
    held: 'The buyer refused this prospect. The claim is still held, so a later click on it will not retry until a person releases it.',
  },
  cap_unreadable: {
    header: "click buyer has no readable daily cap",
    held: "The click was handled, but the over cap notice cannot be judged, so it will not post for this buyer until its buyer profile can be read and holds clicks per day.",
  },
}

export function clickAlertMessage(alert: ClickAlert, appUrl: string): BuyerClickAlertMessage {
  if (alert.kind === 'page') {
    const w = PAGE_WORDING[alert.reason]
    return {
      header: `${alert.partner_slug} ${w.header}`,
      body: [
        `Prospect \`${alert.prospect_id}\`: ${alert.detail}.`,
        w.held,
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
