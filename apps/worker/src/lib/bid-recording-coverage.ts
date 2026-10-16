/**
 * Alert when a bidding workflow stops recording bids at all (#1157).
 *
 * Lead Economy wrote 41,747 runs' worth of sightings and never one row to
 * lead_sighting_bids, with a null winning_partner_slug on every sighting. Every
 * run SUCCEEDED, so there was no failed execution, no alert and no dashboard
 * signal: the failure exists only as data that is not there, and it was found
 * while scoping an unrelated issue weeks later.
 *
 * Nothing in the system could have reported it, because nothing compared what a
 * workflow wrote as sightings against what it wrote as bids. The neighbouring
 * detectors sit either side of that gap: field-presence watches fields inside a
 * step's output, and the volume checks watch run counts. A derivation between
 * the two that produces nothing is invisible to both.
 *
 * WHY EACH WORKFLOW IS JUDGED AGAINST ITS PEERS, not against a threshold of its
 * own. Bid rows are purged well before their sightings are: measured on prod
 * 2026-09-04, the 16:00 and 17:00 hours of the previous day held 2,315 and 6,382
 * sightings with ZERO bid rows, the 18:00 hour was partial, and the ratio was
 * normal from 19:00 on. So "this workflow recorded no bids" is a true statement
 * about a drained window as often as about a broken workflow, and nothing in the
 * numbers separates the two. What does separate them is whether ANY sister
 * workflow recorded a bid in the same window: if one did, the window is retained
 * and the silence belongs to the workflow.
 *
 * That also makes a total engine outage report as itself rather than as five
 * simultaneous accusations.
 *
 * SINCE #1167 the purge holds a bid row until its sighting is purged, so once that
 * is deployed the drained-window case above no longer arises: a sighting present
 * in Supabase has its bids present. The peer proof is kept on purpose. It is also
 * what makes an outage report once and an empty window read as unmeasured.
 *
 * The pair was measured to line up on 2026-10-09 (the oldest sighting and the
 * oldest bid row were one second apart, about 26 hours back), so the ratio check
 * now reads a full day of its own (#1929). The silence check keeps six hours.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSlackConnection, postMessage } from './slack'
import { formatErr } from './format-error'
import { slackOrgIds } from './alert-fanout'
import { BID_PURGE_HORIZON_MS } from './sightings-export'
import {
  decideRatioCollapse,
  appendReading,
  COLLAPSE_FACTOR,
  MIN_RATIO_SIGHTINGS,
  type RatioHistory,
} from './bid-ratio-collapse'

export interface BidCoverageRow {
  workflow_id: string
  workflow_name: string
  is_active: boolean
  sightings: number
  bid_rows: number
  /** Bid rows whose skip_reason is distinct from `skipped`: the real attempts (#1413). */
  attempt_rows: number
  winners: number
}

export interface SilentWorkflow {
  workflow_id: string
  workflow_name: string
  is_active: boolean
  sightings: number
  winners: number
}

export interface BidRecordingDecision {
  alert: boolean
  /** no_sightings | window_not_retained | silent_workflows | recording */
  reason: string
  silent: SilentWorkflow[]
  /** Below the floor, so not judged at all. Named so the blind spot is visible. */
  unjudged: string[]
  /** Counts that could not be read as counts, reported rather than skipped. */
  unusable: string[]
}

export interface BidRecordingOptions {
  /** Below this many sightings in the window a workflow is not judged. */
  minSightings: number
}

export function decideBidRecordingAlert(
  rows: BidCoverageRow[],
  opts: BidRecordingOptions,
): BidRecordingDecision {
  const isCount = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0

  const unusable: string[] = []
  const usable: BidCoverageRow[] = []

  for (const r of rows) {
    // winners counts sightings, so it can never exceed them. A row that says
    // otherwise is a bad aggregation in bid_recording_coverage_v2, not a workflow
    // problem, and rendering it into an alert would misdirect the reader.
    if (!isCount(r.sightings) || !isCount(r.bid_rows) || !isCount(r.winners) || r.winners > r.sightings) {
      unusable.push(r.workflow_name)
      continue
    }
    usable.push(r)
  }

  const withSightings = usable.filter((r) => r.sightings > 0)
  if (withSightings.length === 0) {
    // Measured nothing, which is not the same as measured and healthy
    // (LESSONS L98). An empty window is either a quiet period, a purge that
    // reached further than expected, or a broken query.
    return { alert: false, reason: 'no_sightings', silent: [], unjudged: [], unusable }
  }

  // The retention proof. Only a usable row can supply it: if the single row
  // carrying bid rows is one we refused to read, then nothing we can trust
  // recorded a bid, and the window is unproven.
  const anyRecorded = withSightings.some((r) => r.bid_rows > 0)
  if (!anyRecorded) {
    return { alert: false, reason: 'window_not_retained', silent: [], unjudged: [], unusable }
  }

  const judged = withSightings.filter((r) => r.sightings >= opts.minSightings)
  const unjudged = withSightings
    .filter((r) => r.sightings < opts.minSightings)
    .map((r) => r.workflow_name)

  const silent = judged
    .filter((r) => r.bid_rows === 0)
    .sort((a, b) => b.sightings - a.sightings)
    .map((r) => ({
      workflow_id: r.workflow_id,
      workflow_name: r.workflow_name,
      is_active: r.is_active,
      sightings: r.sightings,
      winners: r.winners,
    }))

  return {
    alert: silent.length > 0,
    reason: silent.length > 0 ? 'silent_workflows' : 'recording',
    silent,
    unjudged,
    unusable,
  }
}

// ── The scheduled check ───────────────────────────────────────────────────────

/**
 * Six hours, not twenty four, and the reason is retention rather than taste.
 * Bid rows drain about 25 hours back (see the header), so a 24 hour window
 * always contains a stretch where zero is the correct answer, which dilutes
 * every count in it. Six hours sits well inside the retained zone even after a
 * missed purge cycle, and still carried roughly 13,600 sightings across five
 * workflows during the QUIETEST six hours of 2026-09-04.
 *
 * The peer check above is what makes this safe rather than load-bearing: if the
 * window is ever drained anyway, the outcome is window_not_retained, not a false
 * accusation.
 */
export const WINDOW_HOURS = 6

/**
 * Fifty sightings in the window. Every workflow that records bids writes a row
 * for a large fraction of its sightings, the sparsest measured on 2026-09-04
 * being Main Flow at 1,414 rows for 4,045 sightings (35%), so fifty sightings
 * with nothing at all cannot be a quiet stretch. It is also far below the
 * smallest live bidding workflow, which ran 4,045 sightings in 24 hours.
 *
 * DELIBERATE BLIND SPOT: a workflow under fifty sightings in the window is not
 * judged, and nothing else covers it. The decision names those workflows in
 * `unjudged` and the log line counts them, so the gap is visible rather than
 * implied.
 */
export const MIN_SIGHTINGS = 50

/** One alert per workflow per day: this condition lasts until someone fixes the
 *  derivation, and repeating it hourly is how a guard gets ignored (LESSONS L36). */
const COOLDOWN_SECONDS = 24 * 60 * 60

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/**
 * Called from the Worker scheduled handler on the daily cron.
 *
 * Each organization is checked inside its own failure boundary, or an unguarded
 * throw on the first one silently cancels every organization after it
 * (LESSONS L73).
 */
export async function runBidRecordingCoverageCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl?: string,
): Promise<void> {
  // The coverage reads below need the database, so an org list answered from the
  // saved copy (the database did not answer) is a failed lookup here too (#1303).
  const orgs = await slackOrgIds(supabase, 'bid-recording')
  if (orgs.kind !== 'live') {
    console.error(`[bid-recording] event=bid_recording_orgs_query_failed reason=${orgs.kind === 'stored' ? 'database_not_answering' : orgs.reason}`)
    return
  }
  const orgIds = orgs.orgIds
  if (orgIds.length === 0) {
    console.log('[bid-recording] event=bid_recording_no_slack_orgs')
    return
  }

  for (const orgId of orgIds) {
    try {
      await checkOrg(supabase, kv, orgId, appUrl)
    } catch (e) {
      console.error(`[bid-recording] event=bid_recording_org_failed org=${orgId} error=${formatErr(e)}`)
    }
    // Its OWN failure boundary (L73). The two answer different questions over
    // different windows, and this half touches KV while the other does not, so a
    // failure in either must not swallow the other.
    try {
      await checkOrgRatios(supabase, kv, orgId, appUrl)
    } catch (e) {
      console.error(`[bid-recording] event=bid_ratio_check_failed org=${orgId} error=${formatErr(e)}`)
    }
  }
}

async function checkOrg(
  supabase: SupabaseClient,
  kv: KvLike,
  orgId: string,
  appUrl?: string,
): Promise<void> {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString()

  // Typed at the boundary rather than destructured from `any` and cast further
  // down: the shape is asserted either way, and this keeps the assertion where
  // the untyped value actually arrives.
  // v2 carries attempt_rows beside bid_rows (#1413); the silent workflow rule
  // below still reads bid_rows, the ratio judge reads attempts.
  const { data, error } = (await supabase.rpc('bid_recording_coverage_v2', {
    p_org_id: orgId,
    p_since: since,
  })) as { data: BidCoverageRow[] | null; error: { message: string } | null }

  // A failed lookup is not a clean window (LESSONS L98, L11).
  if (error) {
    console.error(`[bid-recording] event=bid_recording_query_failed org=${orgId} error=${error.message}`)
    return
  }

  const rows = data ?? []
  const decision = decideBidRecordingAlert(rows, { minSightings: MIN_SIGHTINGS })

  console.log(
    `[bid-recording] event=bid_recording_checked window_h=${WINDOW_HOURS} workflows=${rows.length} reason=${decision.reason} silent=${decision.silent.length} unjudged=${decision.unjudged.length} unusable=${decision.unusable.length}`,
  )

  if (decision.unusable.length > 0) {
    console.error(
      `[bid-recording] event=bid_recording_unusable_rows workflows=${decision.unusable.join(',')}`,
    )
  }

  if (decision.reason === 'window_not_retained') {
    // Deliberately not a Slack alert: the commonest cause is the purge reaching
    // into the window, which nobody needs paging about, and the other cause (an
    // engine wide outage) is already covered by the volume cliff check on a
    // one minute cadence. Logged loudly so it can be told from a healthy run.
    console.error(
      `[bid-recording] event=bid_recording_window_unproven org=${orgId} window_h=${WINDOW_HOURS} workflows=${rows.length}`,
    )
    return
  }

  if (!decision.alert) return

  const slack = await getSlackConnection(supabase, orgId)
  // Reuses the volume-alerts toggle rather than adding a switch nobody knows
  // about: this is the same class of signal (go and look at a workflow).
  if (!slack || !slack.volume_alerts_enabled) return

  for (const s of decision.silent) {
    const key = `bid-recording-alert:${orgId}:${s.workflow_id}`
    if (await kv.get(key)) continue

    const link = appUrl ? `\n\n<${appUrl}/workflows/${s.workflow_id}|Open the workflow>` : ''
    const inactive = s.is_active ? '' : ' It is currently disabled.'
    const text = [
      `*${s.workflow_name}*`,
      '',
      `This workflow recorded ${s.sightings} leads in the last ${WINDOW_HOURS} hours and not one bid, while other bidding workflows in the same window recorded theirs normally.${inactive}`,
      // Only when there were winners: "a winner on 0 of those leads" said
      // nothing (#835).
      ...(s.winners > 0
        ? ['', `It also named a winner on ${s.winners} of those leads, so there is no record of what was bid, whether we won, or at what price.`]
        : []),
      '',
      // Not "the runs are succeeding": this check reads sightings and bid rows,
      // never run outcomes (#835). A bid that is not recorded fails no run.
      'A bid that is not recorded does not fail the run, so no failure alert reports this. The usual cause is that the workflow produces its bid in a shape the recording does not recognise.',
    ].join('\n')

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'A bidding workflow is recording no bids' } },
      { type: 'section', text: { type: 'mrkdwn', text: text + link } },
    ]

    try {
      const sent = await postMessage(
        slack.bot_token,
        slack.default_channel,
        blocks,
        `No bids recorded: ${s.workflow_name}`,
      )
      // Only a CONFIRMED send sets the cooldown, or a brief Slack outage
      // swallows the one notification and then stays quiet for a day
      // (LESSONS L12).
      if (sent) await kv.put(key, '1', { expirationTtl: COOLDOWN_SECONDS })
      else console.error(`[bid-recording] event=bid_recording_alert_not_sent workflow=${s.workflow_name}`)
    } catch (e) {
      console.error(
        `[bid-recording] event=bid_recording_alert_send_failed workflow=${s.workflow_name} error=${formatErr(e)}`,
      )
    }
  }
}

// ── Far too few, not only none (#1168) ────────────────────────────────────────

/**
 * How far short of now the ratio window stops (#1929).
 *
 * A sighting is written when its run starts and its bid rows when the attempt
 * is logged, a few seconds later, so the newest leads always read as no attempt
 * yet (L696). On 2026-10-09 one of the six leads judged had its bid row written
 * two seconds after the check read. Ten minutes is far longer than any bidding
 * run, so nothing still in flight is inside the window.
 */
export const RATIO_IN_FLIGHT_MARGIN_MS = 10 * 60 * 1000

/**
 * The ratio check's window: from the purge horizon to the in-flight margin, so
 * about a day (#1929).
 *
 * It used to share the silence check's six hours, which on the 13:00 UTC cron
 * are the six overnight hours. A workflow that takes leads only in the working
 * day (RML GigFi, 13:00 to 23:00 UTC) then had nothing in its window but its
 * first minute, and was judged on six leads. A day holds every workflow's whole
 * cycle.
 *
 * It starts at BID_PURGE_HORIZON_MS rather than a number of its own: a row is
 * purged no sooner than that long after its attempt, so everything from there on
 * is still held, and a shorter purge shortens this window with it (L174).
 */
const RATIO_WINDOW_HOURS = Math.round(BID_PURGE_HORIZON_MS / 3_600_000)

/** Read the ratio window, prove it retained, then judge it (#1929). */
async function checkOrgRatios(
  supabase: SupabaseClient,
  kv: KvLike,
  orgId: string,
  appUrl?: string,
): Promise<void> {
  const now = Date.now()
  const since = new Date(now - BID_PURGE_HORIZON_MS).toISOString()
  const until = new Date(now - RATIO_IN_FLIGHT_MARGIN_MS).toISOString()

  const { data, error } = (await supabase.rpc('bid_recording_coverage_v3', {
    p_org_id: orgId,
    p_since: since,
    p_until: until,
  })) as { data: BidCoverageRow[] | null; error: { message: string } | null }

  // A failed lookup is not a clean window (L98, L11).
  if (error) {
    console.error(`[bid-recording] event=bid_ratio_query_failed org=${orgId} error=${error.message}`)
    return
  }

  const rows = data ?? []
  // The same peer proof the silence check uses, over this window: if nothing
  // recorded a bid, the window is drained or the engine was down, and judging
  // ratios there would accuse every workflow at once.
  // Only its no_sightings and window_not_retained answers are read, neither of
  // which depends on the floor; the ratio's own floor is passed so this function
  // reads one constant, not both.
  const proof = decideBidRecordingAlert(rows, { minSightings: MIN_RATIO_SIGHTINGS })
  if (proof.reason === 'no_sightings' || proof.reason === 'window_not_retained') {
    console.error(
      `[bid-recording] event=bid_ratio_window_unproven org=${orgId} reason=${proof.reason} window_h=${RATIO_WINDOW_HOURS} workflows=${rows.length}`,
    )
    return
  }

  await checkRatios(supabase, kv, orgId, rows, appUrl)
}

/**
 * One KV entry per organization, holding every workflow's recent ratios. The
 * suffix is bumped whenever what a reading measures changes (L683): v2 when the
 * ratio moved from rows to attempts (#1413), v3 when the window moved from six
 * overnight hours to a day and readings under fifty leads stopped being stored
 * (#1929). A reading of one kind compared against a median of the other would
 * page falsely or hide a real collapse. The old key is simply never read again;
 * the monitor is unbaselined for MIN_BASELINE_SAMPLES runs per workflow and says so.
 */
const historyKey = (orgId: string) => `bid-ratio-history-v3:${orgId}`

/** No expiry: the history IS the baseline, and losing it makes the check inert
 *  for MIN_BASELINE_SAMPLES runs with nothing saying why. */
async function readHistories(kv: KvLike, orgId: string): Promise<Record<string, RatioHistory>> {
  const raw = await kv.get(historyKey(orgId))
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    // Every reading is re-validated on the way out of storage. A value that is
    // not a finite number would make the median NaN, and NaN compares false
    // against every threshold, so the check would read as working while being
    // unable to fire (L50). Non-numbers are dropped, which shortens the history
    // and leaves the workflow unbaselined rather than judged against nonsense.
    const out: Record<string, RatioHistory> = {}
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const ratios = (entry as { ratios?: unknown } | null)?.ratios
      if (!Array.isArray(ratios)) continue
      const clean = ratios.filter((r): r is number => typeof r === 'number' && Number.isFinite(r))
      if (clean.length !== ratios.length) {
        console.error(
          `[bid-recording] event=bid_ratio_history_dropped_readings org=${orgId} workflow=${id} dropped=${ratios.length - clean.length}`,
        )
      }
      out[id] = { ratios: clean }
    }
    return out
  } catch {
    // A corrupt entry must not take the check down. It rebuilds from the next
    // run, and the loss is loud rather than silent.
    console.error(`[bid-recording] event=bid_ratio_history_unreadable org=${orgId}`)
    return {}
  }
}

/**
 * Judge each workflow's attempts-per-sighting ratio against its own history.
 *
 * Runs on rows the caller has already proven retained, which is what makes the
 * ratio trustworthy: a drained window would understate every workflow at once.
 */
async function checkRatios(
  supabase: SupabaseClient,
  kv: KvLike,
  orgId: string,
  rows: BidCoverageRow[],
  appUrl?: string,
): Promise<void> {
  const histories = await readHistories(kv, orgId)
  const decision = decideRatioCollapse(rows, histories, { minSightings: MIN_RATIO_SIGHTINGS })

  console.log(
    `[bid-recording] event=bid_ratio_checked org=${orgId} window_h=${RATIO_WINDOW_HOURS} workflows=${rows.length} collapsed=${decision.collapsed.length} unbaselined=${decision.unbaselined.length} unjudged=${decision.unjudged.length}`,
  )
  if (decision.unjudged.length > 0) {
    // The deliberate blind spot, named rather than implied.
    console.log(`[bid-recording] event=bid_ratio_unjudged org=${orgId} min_leads=${MIN_RATIO_SIGHTINGS} workflows=${decision.unjudged.join(',')}`)
  }

  // Store this run's readings before alerting, so a Slack failure cannot cost
  // the baseline as well as the notification.
  const next: Record<string, RatioHistory> = { ...histories }
  for (const r of decision.readings) next[r.workflow_id] = appendReading(next[r.workflow_id], r.ratio)
  try {
    await kv.put(historyKey(orgId), JSON.stringify(next))
  } catch (e) {
    console.error(`[bid-recording] event=bid_ratio_history_write_failed org=${orgId} error=${formatErr(e)}`)
  }

  if (decision.collapsed.length === 0) return

  const slack = await getSlackConnection(supabase, orgId)
  if (!slack || !slack.volume_alerts_enabled) return

  for (const c of decision.collapsed) {
    const key = `bid-ratio-alert:${orgId}:${c.workflow_id}`
    if (await kv.get(key)) continue

    const pct = (n: number) => `${Math.round(n * 100)}%`
    const link = appUrl ? `\n\n<${appUrl}/workflows/${c.workflow_id}|Open the workflow>` : ''
    const text = [
      `*${c.workflow_name}*`,
      '',
      `This workflow recorded ${c.attempt_rows} bid attempts across ${c.sightings} leads in the last ${RATIO_WINDOW_HOURS} hours, which is ${pct(c.ratio)} of its leads. It normally records ${pct(c.baseline)}, so about ${c.expected_rows} attempts were expected. Rows the workflow wrote for leads it skipped without asking anyone are not counted.`,
      '',
      // Derived from the ratio (#835). It fires below half the baseline, so the
      // old "most of the bid history is still there" was false by construction.
      `That is ${pct(c.ratio / c.baseline)} of what it normally records. A bid that is not recorded does not fail the run, so no failure alert reports this. The usual cause is one partner or one branch dropping out of the recording while the rest carries on.`,
    ].join('\n')

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: 'A bidding workflow is recording far fewer bids than usual' } },
      { type: 'section', text: { type: 'mrkdwn', text: text + link } },
    ]

    try {
      const sent = await postMessage(
        slack.bot_token,
        slack.default_channel,
        blocks,
        `Bid attempts down to ${pct(c.ratio)}: ${c.workflow_name}`,
      )
      if (sent) await kv.put(key, '1', { expirationTtl: COOLDOWN_SECONDS })
      else console.error(`[bid-recording] event=bid_ratio_alert_not_sent workflow=${c.workflow_name}`)
    } catch (e) {
      console.error(
        `[bid-recording] event=bid_ratio_alert_send_failed workflow=${c.workflow_name} error=${formatErr(e)}`,
      )
    }
  }
}

export { COLLAPSE_FACTOR }
