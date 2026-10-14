/**
 * Alert when a source starts sending damaged email addresses in bulk (#744).
 *
 * When Salesforce rejects a lead's email, the Salesforce node blanks the field
 * and retries, so the run SUCCEEDS. That is the right outcome for the lead: a
 * cosmetically broken address must not cost us someone we can still phone (#723).
 * But it also means no Slack alert and no dashboard signal, so making the failure
 * self-recovering deleted the only thing that counted it.
 *
 * An error deliberately classified as expected still needs a RATE behind it
 * (LESSONS L77). The code waving it through has no notion of volume, so one
 * benign instance and a systemic upstream problem arrive on the same path and are
 * indistinguishable, which leaves the second invisible for as long as it lasts.
 * The point of naming the SOURCE is that the actionable question is which partner
 * is sending damage.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSlackConnection, postMessage } from './slack'
import { formatErr } from './format-error'

export interface SourceDropStats {
  source_name: string | null
  total: number
  dropped: number
}

export interface DropOffender {
  source: string
  total: number
  dropped: number
  rate: number
}

export interface DropAlertDecision {
  alert: boolean
  /** no_executions | below_min_volume | within_threshold | over_threshold */
  reason: string
  offenders: DropOffender[]
  /** Sources whose row could not be read as numbers, reported rather than skipped. */
  unusable: string[]
}

export interface DropAlertOptions {
  /** Below this many leads in the window a source is not judged at all. */
  minVolume: number
  /** Fraction of leads with a dropped email at or above which we alert. */
  rateThreshold: number
}

/**
 * A source is judged on ITS OWN volume, never on a pooled total. A rate computed
 * across every source together hides exactly the case this exists to catch: one
 * broken feed beside a large clean one is paid for out of the clean one's headroom
 * and never surfaces (LESSONS L117).
 *
 * Counts are validated as usable non-negative integers before any comparison,
 * because a value that arrives as NaN compares false against every threshold and
 * would silently land on the healthy side (LESSONS L50).
 *
 * Finding nothing is its own outcome, not success (LESSONS L98). Zero executions
 * in the window means either a dead feed or a broken query, and both deserve to
 * be distinguishable from "the drop rate is fine".
 */
export function decideEmailDropAlert(
  rows: SourceDropStats[],
  opts: DropAlertOptions,
): DropAlertDecision {
  const unusable: string[] = []
  const usable: Array<{ source: string; total: number; dropped: number }> = []

  const isCount = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0

  for (const r of rows) {
    const source = r.source_name ?? '(no source)'
    // dropped > total is a bad aggregation, not a rate above 100 percent. Flag it
    // rather than rendering a nonsense figure into an alert.
    if (!isCount(r.total) || !isCount(r.dropped) || r.dropped > r.total) {
      unusable.push(source)
      continue
    }
    usable.push({ source, total: r.total, dropped: r.dropped })
  }

  const totalLeads = usable.reduce((sum, r) => sum + r.total, 0)
  if (totalLeads === 0) {
    return { alert: false, reason: 'no_executions', offenders: [], unusable }
  }

  const judged = usable.filter((r) => r.total >= opts.minVolume)
  if (judged.length === 0) {
    return { alert: false, reason: 'below_min_volume', offenders: [], unusable }
  }

  const offenders = judged
    .map((r) => ({ ...r, rate: r.dropped / r.total }))
    .filter((r) => r.rate >= opts.rateThreshold)
    .sort((a, b) => b.rate - a.rate)

  return {
    alert: offenders.length > 0,
    reason: offenders.length > 0 ? 'over_threshold' : 'within_threshold',
    offenders,
    unusable,
  }
}

// ── The scheduled check ───────────────────────────────────────────────────────

const WINDOW_HOURS = 24
const MIN_VOLUME = 20
const RATE_THRESHOLD = 0.05
/** One alert per source per day: a partner problem lasts days, and repeating it
 *  hourly would train everyone to ignore it (LESSONS L36). */
const COOLDOWN_SECONDS = 24 * 60 * 60

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/**
 * Called from the Worker scheduled handler on the daily cron.
 *
 * Each organization is checked inside its OWN failure boundary. Independent steps
 * sharing one handler each need one, or an unguarded throw on the first org
 * silently cancels every org after it, and the ones lost are unrelated to the one
 * that broke (LESSONS L73).
 */
export async function runEmailDropRateCheck(supabase: SupabaseClient, kv: KvLike): Promise<void> {
  // Only orgs with Slack connected: there is nowhere to deliver the alert
  // otherwise, and the query is not free.
  // paginate-ok: one row per organization with a Slack connection, single digits
  const { data: conns, error: connErr } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')

  if (connErr) {
    console.error(`[email-drop-rate] event=email_drop_orgs_query_failed error=${connErr.message}`)
    return
  }

  const orgIds = [...new Set((conns ?? []).map((c) => c.organization_id as string))]
  if (orgIds.length === 0) {
    // Distinct from "checked and found nothing wrong" (LESSONS L98).
    console.log('[email-drop-rate] event=email_drop_no_slack_orgs')
    return
  }

  for (const orgId of orgIds) {
    try {
      await checkOrg(supabase, kv, orgId)
    } catch (e) {
      console.error(`[email-drop-rate] event=email_drop_org_failed org=${orgId} error=${formatErr(e)}`)
    }
  }
}

async function checkOrg(
  supabase: SupabaseClient,
  kv: KvLike,
  orgId: string,
): Promise<void> {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase.rpc('email_drop_counts_by_source', {
    p_org_id: orgId,
    p_since: since,
  })

  // A failed lookup is not a clean window. Report it rather than returning
  // quietly, or the check becomes indistinguishable from one that found nothing
  // wrong (LESSONS L98, L11).
  if (error) {
    console.error(`[email-drop-rate] event=email_drop_query_failed error=${error.message}`)
    return
  }

  const rows = (data ?? []) as SourceDropStats[]
  const decision = decideEmailDropAlert(rows, { minVolume: MIN_VOLUME, rateThreshold: RATE_THRESHOLD })

  console.log(
    `[email-drop-rate] event=email_drop_checked window_h=${WINDOW_HOURS} sources=${rows.length} reason=${decision.reason} offenders=${decision.offenders.length} unusable=${decision.unusable.length}`,
  )

  if (decision.unusable.length > 0) {
    // Not folded into the alert: a malformed row is a bug here, not a partner
    // problem, and conflating them would misdirect whoever reads the alert.
    console.error(
      `[email-drop-rate] event=email_drop_unusable_rows sources=${decision.unusable.join(',')}`,
    )
  }

  if (!decision.alert) return

  const slack = await getSlackConnection(supabase, orgId)
  // Reuses the volume-alerts toggle rather than adding a switch nobody knows
  // about: this is the same class of signal (a rate moved, go look at a source).
  if (!slack || !slack.volume_alerts_enabled) return

  for (const o of decision.offenders) {
    const key = `email-drop-alert:${orgId}:${o.source}`
    if (await kv.get(key)) continue

    const pct = (o.rate * 100).toFixed(1)
    const text = [
      `*${o.source}*`,
      '',
      `${o.dropped} of ${o.total} leads (${pct}%) from this source in the last ${WINDOW_HOURS} hours had their email rejected by Salesforce as invalid.`,
      '',
      'Those leads were still created, deliberately: the address is dropped and the record saved without it, so a reachable phone number is not lost. The point of this alert is the rate, not the individual lead.',
      '',
      // A fixed rate, not a change against a baseline, so not "a sudden rise" (#835).
      `That is at or above the ${(RATE_THRESHOLD * 100).toFixed(0)}% this alert allows, which usually means the source captures or encodes the address in a way Salesforce rejects. Worth asking them.`,
    ].join('\n')

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'Leads arriving with an unusable email address' } },
      { type: 'section', text: { type: 'mrkdwn', text } },
    ]

    try {
      const sent = await postMessage(slack.bot_token, slack.default_channel, blocks, `Email drop rate: ${o.source}`)
      // The cooldown is set only on a CONFIRMED send. Setting it optimistically
      // would swallow the one notification whenever Slack was briefly unavailable
      // and then stay quiet for a day (LESSONS L12).
      if (sent) await kv.put(key, '1', { expirationTtl: COOLDOWN_SECONDS })
      else console.error(`[email-drop-rate] event=email_drop_alert_not_sent source=${o.source}`)
    } catch (e) {
      console.error(`[email-drop-rate] event=email_drop_alert_send_failed source=${o.source} error=${formatErr(e)}`)
    }
  }
}
