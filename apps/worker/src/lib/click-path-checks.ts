/**
 * The click buyer path checks, every 15 minutes (#1546, milestone "Click sold
 * buyers"). A click sold buyer (Liberty1 first, EvaFi later) fails SILENTLY by
 * construction: buyer_click_check routes a read that fails or overruns to
 * not_eligible and only logs, so a broken counter reads like a quiet day; a
 * broken proxy repoint means no click execution at all; and each refused send
 * is handled correctly on its own. So these watch the path from outside it.
 * The buyer is a SETTING: every buyer named on a live buyer_click_check or
 * buyer_click_send node is a subject, and no buyer literal lives here.
 *
 *   CHECK ERRORS  the SHARE of the last hour's buyer_click_check runs that
 *                 could not complete (cap_check_error, which is also how an
 *                 unreadable profile routes, and profile_copy_stale), never a
 *                 count, so a busy hour does not page on the same handful a
 *                 quiet hour would. The share needs CHECK_ERROR_MIN_RUNS runs;
 *                 below that an hour in which EVERY run errored, at least
 *                 CHECK_ERROR_SATURATION_MIN_RUNS of them, pages anyway (L139),
 *                 and otherwise the hour is QUIET, a state distinct from normal.
 *
 *   QUIET         two absences, each judged only for a buyer whose profile is
 *                 enabled (read through the one profile loader), because an off
 *                 switch explains both:
 *                   no eligible  none of the leads that reached the check
 *                                inside the buyer's selling hours (its
 *                                operating windows and blackout dates) in up
 *                                to six hours, never before the profile last
 *                                changed, was eligible, and at the eligible
 *                                rate the buyer has had since that change so
 *                                many with none happens less than once in
 *                                1,000 (#2104). No rate is trusted from fewer
 *                                than QUIET_RATE_MIN_RUNS leads or with none
 *                                eligible, so a profile switched on or edited
 *                                minutes ago is never judged on those minutes.
 *                                But when NO lead has passed the buyer's rules
 *                                since a change, the leads since it are judged
 *                                against the share eligible in the 72 hours
 *                                before it instead, so an edit that leaves no
 *                                lead eligible pages rather than resetting the
 *                                check to a rate of zero it never trusts
 *                                (#2426); an edit that leaves some eligible
 *                                re-baselines as above.
 *                                Runs the disabled profile answered are not
 *                                counted, and a run at the day's cap stands
 *                                the check down, because then not eligible is
 *                                the cap working.
 *                   no click     at least NO_CLICK_MIN_OFFERS offers were made
 *                                in the last three hours and no execution of a
 *                                workflow sending this buyer's clicks ran, or
 *                                no live workflow sends them at all.
 *                 The offers are the lead_sighting_bids rows the Engine run
 *                 wrote for the buyer (resolver_type click, #1544), kept only
 *                 where that execution's own check run routed eligible, so the
 *                 count is this organization's and a row nothing here decided
 *                 is not one. Those rows are purged a day after export, far
 *                 outside three hours.
 *
 *   REFUSALS      a burst of buyer_click_send refusals for one buyer in the
 *                 last hour: at least REFUSAL_MIN_COUNT refused AND at least
 *                 REFUSAL_MIN_SHARE of the sends the buyer answered (sent,
 *                 refused, unknown). A refusal is final (Dan, 2026-09-24), so a
 *                 burst is somebody's intake rules or our body changing.
 *
 *   RECONCILE     once per Pacific day, after the day has settled an hour: the
 *                 prospects the click counter holds for the day against the
 *                 Salesforce prospects with the buyer's routing code and
 *                 exchange status Completed whose ExternalTimestamp__c (the
 *                 click write's own stamp) falls in the day. The Salesforce
 *                 read is padded by RECONCILE_PAD_MS both sides, and a Completed
 *                 prospect is looked for in the day before and after too,
 *                 because the count is taken a moment before the write and the
 *                 two can straddle midnight. A Liberty1 click from a
 *                 Submission with no Prospect (2026-09-29) is counted by the
 *                 submission's id and written to the submission alone, so the
 *                 Completed submissions with the routing code and no Prospect
 *                 are read beside the prospects, over the same padded day. A
 *                 mismatch pages naming the records. The Salesforce read follows buyer-sales-checks'
 *                 independent record read: the org's credentials, the cached
 *                 token, SOQL through nextRecordsUrl, bounded.
 *
 * NONE of this reuses the predicate of the gate it watches (L721): the check's
 * own verdicts are read as the rows it wrote, and the absence is judged against
 * the profile's windows as stored, not against what the check decided.
 *
 * Thresholds are NOT MEASURED: no click buyer has run through Bidspoke yet
 * (2026-09-24, Liberty1's profile ships disabled and Salesforce holds one
 * Completed routing code 4 prospect in 14 days). Each is conservative and is
 * to be re-measured in launch week; see the constants.
 *
 * Pages go through the shared export alerter under one job name per family, so
 * the same KV keys mute them and a standing page backs off; a buyer flagged
 * for the first time while another buyer's page stands is let out past that
 * backoff (L707). The run records itself in job_runs (L557) and both heartbeat
 * stamps are written by the cron wiring (L514).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CLICK_CHECK_BUDGET_MS, CLICK_CHECK_LAST_GOOD_MAX_AGE_MS, PACIFIC, isOpen, isPartnerId, zonedDayStartUtc, zonedParts, type OutReason } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
import { RETENTION_DAYS } from '../archive/candidate-days'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { CLICK_RESOLVER_TYPE } from '../engine/bid-log'
import { clearCondition, readCondition, type BackoffKv } from './alert-backoff'
import { ClickCounterClient } from './buyer-object-clients'
import { loadBuyerProfiles, type LoadedBuyer } from './buyer-profile-loader'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { parseJson } from './json'
import { fetchAllPaged } from './paginate'
import { resolveSalesforceCredsFor } from './salesforce-creds'

// ── Names ─────────────────────────────────────────────────────────────────────

/** The heartbeat and job_runs name. */
export const CLICK_PATH_CHECKS_JOB = 'click-path-checks'
/** The alerter job names, one per family, so each can be muted on its own. */
export const CLICK_CHECK_ERRORS_JOB = 'click-check-errors'
export const CLICK_PATH_QUIET_JOB = 'click-path-quiet'
export const CLICK_SEND_REFUSALS_JOB = 'click-send-refusals'
export const CLICK_RECONCILE_JOB = 'click-reconcile'
export const CLICK_ALERT_JOBS = [CLICK_CHECK_ERRORS_JOB, CLICK_PATH_QUIET_JOB, CLICK_SEND_REFUSALS_JOB, CLICK_RECONCILE_JOB] as const
export type ClickAlertJob = (typeof CLICK_ALERT_JOBS)[number]

// ── Thresholds (NOT MEASURED; re-measure in launch week) ──────────────────────

const MIN = 60_000
const HOUR = 60 * MIN

/** The window the two rate checks judge. */
export const RATE_WINDOW_MS = HOUR
/** The check's outcomes that mean it could not answer. cap_check_error is also how an unreadable profile or a blown budget routes. */
export const CHECK_ERROR_REASONS = ['cap_check_error', 'profile_copy_stale'] as const satisfies readonly OutReason[]
/**
 * Runs an hour must hold before the error share is judged. The check sees
 * about 60 to 100 Tripoint noes an hour in Engine's business hours (1,395 noes
 * in the 24 hours to 2026-09-24 23:00 UTC), so 20 is reached in a quarter of an
 * hour on a normal day and a thin evening hour is not judged on a few runs.
 */
export const CHECK_ERROR_MIN_RUNS = 20
/**
 * The share that pages. The #1557 review measured the object call p99 at 1,492
 * ms against the check's budget (CLICK_CHECK_BUDGET_MS), so a cold counter will cost SOME runs every day;
 * a fifth is well past a cold start and well short of an outage. The real share
 * on the first live day is what to set this from.
 */
export const CHECK_ERROR_MIN_SHARE = 0.2
/** Below the minimum, an hour in which every run errored and there were at least this many pages anyway (L139). */
export const CHECK_ERROR_SATURATION_MIN_RUNS = 5

/**
 * The no eligible window (#2104): up to six hours, and never further back than
 * the profile's last change, of which only the leads that arrived inside the
 * buyer's selling hours count. Six, not three, because a buyer whose rules let
 * few leads through needs that long to see enough of them: Liberty1 at 4
 * percent eligible after its collections cap (#2111) sees about 47 judged leads
 * an hour, and needs about 170 before none is unusual. The no click half keeps
 * its own three hours (NO_CLICK_WINDOW_MS).
 */
export const QUIET_WINDOW_MS = 6 * HOUR
/** Leads below which zero eligible is never judged, whatever the rate says. */
export const QUIET_MIN_RUNS = 10
/**
 * How far back the buyer's eligible rate is measured, never past the profile's
 * last change, because a change of rules (a cap, a floor, a state) changes the
 * rate, and a rate from before it set the bar the 2026-10-14 false page tripped.
 */
export const QUIET_RATE_WINDOW_MS = 24 * HOUR
/** Leads in the rate window, inside selling hours, before the rate is trusted at all. */
export const QUIET_RATE_MIN_RUNS = 100
/**
 * Zero eligible pages only when, at the measured rate, that many leads with none
 * eligible would happen less often than this. At one in 1,000 a run every 15
 * minutes through a 12 hour selling day pages by chance about once a month.
 */
export const QUIET_MAX_CHANCE = 0.001
/**
 * The edit to zero comparison (#2426). Judging against the rate since the
 * profile last changed has one blind spot: an edit that leaves NO lead eligible
 * gives a rate of zero, which is never trusted, so the check stood down at the
 * moment the buyer stopped being offered (the click twin of #2149). So when no
 * lead has been eligible since the edit, the leads since it are judged against
 * the eligible share in this window before it instead, by the same one in 1,000
 * bar. An edit that leaves ANY lead eligible re-baselines as before.
 *
 * Sized from Liberty1's recorded volumes, not a fresh query: about 47 judged
 * leads an hour inside its selling hours (272 from 12:16 to 6 PM ET on
 * 2026-10-16, PR #2298) and about 670 a day (4,673 in the 7 days to
 * 2026-10-14, #2104). One weekday's selling hours before an edit therefore hold
 * several hundred leads, far past QUIET_RATE_MIN_RUNS, but an edit on a Monday
 * morning has a weekend behind it, and a buyer closed at weekends last sold on
 * Friday, up to about 63 hours earlier. 72 hours reaches that Friday from any
 * edit, and stays well inside the 7 days execution steps are kept, so the
 * leads before the edit are still there to read.
 */
export const EDIT_PRE_WINDOW_MS = 72 * HOUR
/**
 * Leads this soon after an edit are not counted on either side of it, because
 * the check may still have judged them on the copy from before the edit: the
 * buyer profiles copy reaches bidding within 3 minutes on a healthy day
 * (BIDDING_PICKUP, measured 2026-10-15), and when the database read fails the
 * check offers from a last good copy up to CLICK_CHECK_LAST_GOOD_MAX_AGE_MS old,
 * plus a minute for KV to reach every location. Without it, a few leads judged
 * on the old rules right after the edit would read as eligible since it and
 * stand the comparison down.
 */
export const EDIT_PICKUP_GRACE_MS = CLICK_CHECK_LAST_GOOD_MAX_AGE_MS + MIN
/** An edit older than the kept execution steps has no leads before it left to compare, so it is not looked for. */
export const EDIT_LOOKBACK_MAX_MS = RETENTION_DAYS * 24 * HOUR
/** How finely selling time is checked against the operating windows. Windows are whole minutes; five is finer than any window anyone sets. */
export const QUIET_OPEN_SAMPLE_MS = 5 * MIN
/**
 * Offers in three hours with no click execution before that pages. No click
 * through rate exists yet: at 10 percent, 30 offers with no click happens about
 * 4 times in 100 by chance; at 5 percent, about 21. So this is a floor for a
 * rate we expect to be well above that, and is the first number to re-measure.
 */
export const NO_CLICK_MIN_OFFERS = 30
/** The no click window: offers made and no click execution in this long. */
export const NO_CLICK_WINDOW_MS = 3 * HOUR
/** The step row's started_at trails the sighting's attempted_at, so eligible runs are read this much further back than the offers. */
const OFFER_MATCH_SLACK_MS = 5 * MIN

/** Refused sends in the hour that make a burst. */
export const REFUSAL_MIN_COUNT = 5
/** And the share of the buyer's answers they must be. */
export const REFUSAL_MIN_SHARE = 0.5
const ANSWERED_SEND_ROUTES: ReadonlySet<string> = new Set(['sent', 'refused', 'unknown'])

/** Minutes into the Pacific day before the previous day is reconciled, so clicks counted at 23:59 have been written. */
export const RECONCILE_SETTLE_MINUTES = 60
/** How far past each end of the day the Salesforce read reaches. */
export const RECONCILE_PAD_MS = 15 * MIN
/** A day holds about a cap's worth (50); more than this and the read is refused as unbounded rather than reconciled on part of it. */
export const RECONCILE_MAX_RECORDS = 2000
const RECONCILE_DONE_TTL_SECONDS = 3 * 24 * 3600
/** At most this many prospect ids per side in a page; the count is always whole. */
const RECONCILE_NAMED_MAX = 20

export const reconcileDoneKey = (partnerId: string, date: string) => `click-reconcile-done:${partnerId}:${date}`
const flaggedKey = (job: ClickAlertJob, partnerId: string) => `click-path-flagged:${job}:${partnerId}`

// ── Remedies ──────────────────────────────────────────────────────────────────

export const CLICK_CHECK_ERRORS_REMEDY: AlertRemedy = {
  consequence:
    'A click sold buyer is not being offered on many of the Engine leads that reached its check, because the check could not read ' +
    "the buyer's profile or today's click count in time. Each of those leads was rejected as if the buyer had said no, and nothing " +
    'else pages for it. Each line names the buyer and the share:',
  fixHint:
    'Open a recent Engine Bidding execution and read the Buyer Click Check step: cap_check_error with a timeout means the click counter ' +
    `answered past the ${CLICK_CHECK_BUDGET_MS} ms budget, with a read failure means the profile could not be loaded; profile_copy_stale means the ` +
    'database was unreadable for more than 15 minutes. Check Supabase and the Durable Object health before changing the budget.',
  headlineVerb: 'shows a click buyer check that cannot answer',
  itemNoun: { one: 'buyer', many: 'buyers' },
}

export const CLICK_PATH_QUIET_REMEDY: AlertRemedy = {
  consequence:
    'A click sold buyer has gone quiet inside its selling hours: either leads kept reaching its check and none could be offered, or ' +
    'offers were made and no click reached Bidspoke. Each line says which:',
  fixHint:
    'No eligible: the reasons on the line say why every lead was out; a missing lead field or a debt below the minimum on every lead ' +
    'usually means a template on the Buyer Click Check node reads a path the payload no longer carries. A line naming a profile ' +
    "change: open the buyer's History on the Partners page at that time and undo or correct the edit. No click: check that the " +
    "buyer's click proxy still forwards a POST to the Bidspoke custom endpoint, that the endpoint's workflow is switched on, and " +
    "that the portal's click link still works.",
  headlineVerb: 'shows a click buyer path gone quiet',
  itemNoun: { one: 'finding', many: 'findings' },
}

export const CLICK_SEND_REFUSALS_REMEDY: AlertRemedy = {
  // A refusal frees the claim (buyer_click_send's `refused` route), so it is not
  // final for the prospect: a later click on it is sent again (#835).
  consequence:
    'A click sold buyer refused most of the clicks sent to it in the last hour. A refused prospect is marked Fail in ' +
    'Salesforce and its claim is freed, so a later click on it is sent again. Each line names the buyer and the share:',
  fixHint:
    "Open the newest refused Buyer Click Send step and read the buyer's own error. The same error on every refusal usually means " +
    'our request body or the buyer\'s intake rules changed; ask the buyer before the next click is refused.',
  headlineVerb: 'shows a click buyer refusing clicks',
  itemNoun: { one: 'buyer', many: 'buyers' },
}

export const CLICK_RECONCILE_REMEDY: AlertRemedy = {
  consequence:
    "A click sold buyer's count of clicks for a Pacific day does not agree with Salesforce. The count decides when offers stop at the " +
    "cap, and Salesforce is what is billed. Each line names the day and the prospects on each side:",
  fixHint:
    'Counted but not Completed: the buyer took the prospect and the Salesforce write after it failed; read that click execution and ' +
    'write the prospect by hand. Completed but never counted: the prospect was sold outside this workflow (another flow, or by hand), ' +
    "or its add to the count was refused or never landed, so the day's count read low by that many. " +
    'A click paged as possibly not counted is listed here only when its add never landed.',
  headlineVerb: 'found a click count that disagrees with Salesforce',
  itemNoun: { one: 'disagreement', many: 'disagreements' },
}

/**
 * A family whose lines are only reads that failed (#835): nothing was judged for
 * what they name, so none of the finding wording above is true of them.
 */
const UNREAD_FIX =
  'Where a read failed, check that the system the error names (Supabase, Salesforce or the click counter) is answering and ' +
  'that its credentials are valid; the check judges again on its next run.'

export const CLICK_PATH_UNREAD_REMEDY: AlertRemedy = {
  consequence:
    'A click buyer check could not read what it judges, so it measured nothing for what each line names. Each line names the ' +
    'read that failed and its error:',
  fixHint: UNREAD_FIX,
  headlineVerb: 'could not read what it judges',
}

const FINDING_REMEDY: Record<ClickAlertJob, AlertRemedy> = {
  [CLICK_CHECK_ERRORS_JOB]: CLICK_CHECK_ERRORS_REMEDY,
  [CLICK_PATH_QUIET_JOB]: CLICK_PATH_QUIET_REMEDY,
  [CLICK_SEND_REFUSALS_JOB]: CLICK_SEND_REFUSALS_REMEDY,
  [CLICK_RECONCILE_JOB]: CLICK_RECONCILE_REMEDY,
}

/** A family's page for how many of its lines are findings and how many are reads that failed (#835). */
export function clickRemedyFor(job: ClickAlertJob, findings: number, unread: number): AlertRemedy {
  const finding = FINDING_REMEDY[job]
  if (unread === 0) return finding
  if (findings === 0) return CLICK_PATH_UNREAD_REMEDY
  return {
    ...finding,
    consequence: `${finding.consequence.replace(/:$/, '.')} A line saying a read failed measured nothing for what it names:`,
    fixHint: `${finding.fixHint} ${UNREAD_FIX}`,
  }
}

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface ClickSubject {
  organization_id: string
  partner_id: string
  /** Live workflows with a buyer_click_check naming this buyer, and those nodes' namespaces. */
  check: { workflow_ids: string[]; namespaces: string[] }
  /** Live workflows with a buyer_click_send naming this buyer, and those nodes' namespaces. */
  send: { workflow_ids: string[]; namespaces: string[] }
}

export interface CheckRun {
  execution_id: string
  started_at: string
  route: string | null
  reason: string | null
}

export interface SendRun {
  started_at: string
  route: string | null
}

export interface CompletedProspect {
  id: string
  /** ExternalTimestamp__c, the click write's own stamp. */
  at: string
}

export interface PartnerFacts {
  slug: string
  external_routing_code: number | null
}

export interface ClickPathDeps {
  listSubjects(): Promise<ClickSubject[]>
  /** The partner row's words and routing code; null when the org holds no such partner. */
  readPartner(orgId: string, partnerId: string): Promise<PartnerFacts | null>
  /** The buyer's enabled profile through the one loader; null when none is enabled. Throws when unreadable. */
  loadBuyer(orgId: string, partnerId: string): Promise<LoadedBuyer | null>
  /** Non test buyer_click_check step rows for this buyer, started in [fromMs, toMs). */
  readCheckRuns(subject: ClickSubject, fromMs: number, toMs: number): Promise<CheckRun[]>
  /** Non test buyer_click_send step rows for this buyer, started in [fromMs, toMs). */
  readSendRuns(subject: ClickSubject, fromMs: number, toMs: number): Promise<SendRun[]>
  /** Non test executions of the workflows sending this buyer's clicks, started in [fromMs, toMs). */
  countClickExecutions(subject: ClickSubject, fromMs: number, toMs: number): Promise<number>
  /** execution_id of every non test click offer bid row for the slug, attempted in [fromMs, toMs). */
  readOfferExecutionIds(slug: string, fromMs: number, toMs: number): Promise<string[]>
  /** The prospects the click counter holds for the buyer on a Pacific date. */
  counterMembers(partnerId: string, date: string): Promise<string[]>
  /** Salesforce prospects with this routing code, exchange status Completed, and ExternalTimestamp__c in [fromMs, toMs). */
  readCompletedProspects(orgId: string, routingCode: number, fromMs: number, toMs: number): Promise<CompletedProspect[]>
  /** Salesforce submissions with NO Prospect, this routing code, exchange status Completed, and External_Timestamp__c in [fromMs, toMs). */
  readCompletedSubmissionsWithoutProspect(orgId: string, routingCode: number, fromMs: number, toMs: number): Promise<CompletedProspect[]>
  kv: BackoffKv
  /** The remedy follows the lines (#835): findings, reads that failed, or both. */
  notify: Record<ClickAlertJob, (lines: string[], remedy: AlertRemedy) => Promise<void>>
  now(): number
  localDev: boolean
  appUrl: string
  log(line: string): void
}

export type Judged<Good extends string> =
  | { verdict: Good | 'quiet'; detail?: string }
  | { verdict: 'elevated'; detail: string }
  | { verdict: 'unmeasured'; reason: string }

export type QuietVerdict =
  | { verdict: 'normal' | 'not_open' | 'not_enabled' | 'too_few'; detail?: string }
  | { verdict: 'quiet'; lines: string[] }
  | { verdict: 'unmeasured'; reason: string }

export type ReconcileVerdict =
  | { verdict: 'not_due' | 'already_done' | 'match'; date?: string; detail?: string }
  | { verdict: 'mismatch'; date: string; detail: string }
  | { verdict: 'unmeasured'; date: string; reason: string }

export interface SubjectSummary {
  partner_id: string
  slug: string | null
  check_errors: Judged<'normal'>
  quiet: QuietVerdict
  refusals: Judged<'normal'>
  reconcile: ReconcileVerdict
}

export interface ClickPathSummary {
  skipped?: 'local_dev'
  unmeasured?: string
  subjects: SubjectSummary[]
  paged: Record<ClickAlertJob, number>
}

// ── Pure judges ───────────────────────────────────────────────────────────────

const percent = (n: number): string => `${Math.round(n * 100)}%`
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'non Error thrown')
const inWindow = (iso: string, fromMs: number, toMs: number): boolean => {
  const t = Date.parse(iso)
  return Number.isFinite(t) && t >= fromMs && t < toMs
}

function tally(values: Array<string | null>): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v ?? 'unknown', (counts.get(v ?? 'unknown') ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(', ')
}

/** The last hour's check runs: the share that could not answer, judged only on enough runs, saturation below that. */
export function judgeCheckErrors(runs: readonly CheckRun[], nowMs: number): Judged<'normal'> {
  const hour = runs.filter((r) => r.reason !== null && inWindow(r.started_at, nowMs - RATE_WINDOW_MS, nowMs + 1))
  const errors = hour.filter((r) => (CHECK_ERROR_REASONS as readonly string[]).includes(r.reason as string))
  const total = hour.length
  const what = `of the ${total} leads that reached the check in the last hour could not be judged (${tally(errors.map((e) => e.reason))})`
  if (total >= CHECK_ERROR_SATURATION_MIN_RUNS && errors.length === total) return { verdict: 'elevated', detail: `all ${errors.length} ${what}` }
  if (total < CHECK_ERROR_MIN_RUNS) return { verdict: 'quiet', detail: `${total} runs in the last hour, fewer than the ${CHECK_ERROR_MIN_RUNS} a share needs, and not every one errored` }
  const share = errors.length / total
  if (errors.length > 0 && share >= CHECK_ERROR_MIN_SHARE) return { verdict: 'elevated', detail: `${errors.length} of ${total} leads that reached the check in the last hour could not be judged, ${percent(share)} (${tally(errors.map((e) => e.reason))})` }
  return { verdict: 'normal', detail: `${errors.length} of ${total} runs errored, ${percent(share)}` }
}

/** The last hour's sends: a burst of refusals among the answered sends. */
export function judgeRefusals(runs: readonly SendRun[], nowMs: number): Judged<'normal'> {
  const answered = runs.filter((r) => r.route !== null && ANSWERED_SEND_ROUTES.has(r.route) && inWindow(r.started_at, nowMs - RATE_WINDOW_MS, nowMs + 1))
  const refused = answered.filter((r) => r.route === 'refused').length
  if (refused < REFUSAL_MIN_COUNT) return { verdict: 'quiet', detail: `${refused} refused in the last hour, fewer than the ${REFUSAL_MIN_COUNT} a burst needs` }
  const share = refused / answered.length
  if (share >= REFUSAL_MIN_SHARE) return { verdict: 'elevated', detail: `${refused} of ${answered.length} clicks the buyer answered in the last hour were refused, ${percent(share)}` }
  return { verdict: 'normal', detail: `${refused} of ${answered.length} refused, ${percent(share)}` }
}

/** Minutes of [fromMs, toMs) the buyer was open for sale, sampled every QUIET_OPEN_SAMPLE_MS. */
export function openMinutes(buyer: LoadedBuyer, fromMs: number, toMs: number): number {
  let open = 0
  for (let t = fromMs; t < toMs; t += QUIET_OPEN_SAMPLE_MS) {
    if (isOpen(buyer.profile.windows, buyer.profile.blackoutDates, t)) open += 1
  }
  return (open * QUIET_OPEN_SAMPLE_MS) / MIN
}

/**
 * Leads needed with none eligible before that is less likely than QUIET_MAX_CHANCE
 * at eligible rate p: the smallest n with (1 - p)^n below it, never under QUIET_MIN_RUNS.
 */
export function quietRunsNeeded(p: number): number {
  return Math.max(QUIET_MIN_RUNS, Math.ceil(Math.log(QUIET_MAX_CHANCE) / Math.log(1 - p)))
}

/** A rate for a person: one decimal, no trailing zero. */
const rateWords = (p: number): string => `${Math.round(p * 1000) / 10}%`

// ── The run ───────────────────────────────────────────────────────────────────

export async function runClickPathChecks(deps: ClickPathDeps): Promise<ClickPathSummary> {
  const now = deps.now()
  const paged = Object.fromEntries(CLICK_ALERT_JOBS.map((j) => [j, 0])) as Record<ClickAlertJob, number>
  if (deps.localDev) {
    deps.log(`[${CLICK_PATH_CHECKS_JOB}] skipped: local dev`)
    return { skipped: 'local_dev', subjects: [], paged }
  }

  let subjects: ClickSubject[]
  try {
    subjects = await deps.listSubjects()
  } catch (err) {
    const reason = `the workflows naming click buyers could not be read, so no click buyer was checked: ${messageOf(err)}`
    await deps.notify[CLICK_CHECK_ERRORS_JOB]([reason], CLICK_PATH_UNREAD_REMEDY)
    paged[CLICK_CHECK_ERRORS_JOB] = 1
    return { unmeasured: reason, subjects: [], paged }
  }

  const lines: Record<ClickAlertJob, string[]> = { [CLICK_CHECK_ERRORS_JOB]: [], [CLICK_PATH_QUIET_JOB]: [], [CLICK_SEND_REFUSALS_JOB]: [], [CLICK_RECONCILE_JOB]: [] }
  const flagged: Record<ClickAlertJob, Set<string>> = { [CLICK_CHECK_ERRORS_JOB]: new Set(), [CLICK_PATH_QUIET_JOB]: new Set(), [CLICK_SEND_REFUSALS_JOB]: new Set(), [CLICK_RECONCILE_JOB]: new Set() }
  /** Per family, how many of its lines are reads that failed rather than findings. */
  const unread: Record<ClickAlertJob, number> = { [CLICK_CHECK_ERRORS_JOB]: 0, [CLICK_PATH_QUIET_JOB]: 0, [CLICK_SEND_REFUSALS_JOB]: 0, [CLICK_RECONCILE_JOB]: 0 }
  let reconcileRan = false
  const summaries: SubjectSummary[] = []

  for (const subject of subjects) {
    const s = await checkSubject(deps, subject, now)
    summaries.push(s)
    const name = s.slug ?? subject.partner_id
    const page = `${deps.appUrl}/partners?selected=${encodeURIComponent(name)}`
    if (s.check_errors.verdict === 'elevated') { lines[CLICK_CHECK_ERRORS_JOB].push(`${name}: ${s.check_errors.detail}. Partner page: ${page}`); flagged[CLICK_CHECK_ERRORS_JOB].add(subject.partner_id) }
    if (s.check_errors.verdict === 'unmeasured') { lines[CLICK_CHECK_ERRORS_JOB].push(`${name}: the check runs could not be read, so whether the check is answering is not known: ${s.check_errors.reason}`); unread[CLICK_CHECK_ERRORS_JOB] += 1 }
    if (s.quiet.verdict === 'quiet') { lines[CLICK_PATH_QUIET_JOB].push(...s.quiet.lines.map((l) => `${name}: ${l}`)); flagged[CLICK_PATH_QUIET_JOB].add(subject.partner_id) }
    // An unread check says so rather than passing as a clean run (L98), like check_errors and reconcile below.
    if (s.quiet.verdict === 'unmeasured') { lines[CLICK_PATH_QUIET_JOB].push(`${name}: whether the path is quiet is not known, because what it reads could not be read: ${s.quiet.reason}`); unread[CLICK_PATH_QUIET_JOB] += 1 }
    if (s.refusals.verdict === 'elevated') { lines[CLICK_SEND_REFUSALS_JOB].push(`${name}: ${s.refusals.detail}. Partner page: ${page}`); flagged[CLICK_SEND_REFUSALS_JOB].add(subject.partner_id) }
    if (s.refusals.verdict === 'unmeasured') { lines[CLICK_SEND_REFUSALS_JOB].push(`${name}: the sends could not be read, so whether the buyer is refusing is not known: ${s.refusals.reason}`); unread[CLICK_SEND_REFUSALS_JOB] += 1 }
    if (s.reconcile.verdict === 'mismatch' || s.reconcile.verdict === 'unmeasured' || s.reconcile.verdict === 'match') reconcileRan = true
    if (s.reconcile.verdict === 'mismatch') { lines[CLICK_RECONCILE_JOB].push(`${name} on ${s.reconcile.date} (Pacific day): ${s.reconcile.detail}`); flagged[CLICK_RECONCILE_JOB].add(subject.partner_id) }
    if (s.reconcile.verdict === 'unmeasured') { lines[CLICK_RECONCILE_JOB].push(`${name} on ${s.reconcile.date} (Pacific day) could not be reconciled, and is tried again on the next run: ${s.reconcile.reason}`); unread[CLICK_RECONCILE_JOB] += 1 }
  }

  for (const job of CLICK_ALERT_JOBS) {
    // The reconcile runs once a day; a run that did not reconcile says nothing, so it neither pages nor clears a standing page.
    if (job === CLICK_RECONCILE_JOB && !reconcileRan) continue
    await letNewSubjectsOut(deps.kv, job, subjects, flagged[job])
    // The words follow the lines (#835); which lines page is decided above and unchanged.
    await deps.notify[job](lines[job], clickRemedyFor(job, lines[job].length - unread[job], unread[job]))
    paged[job] = lines[job].length
  }
  return { subjects: summaries, paged }
}

/**
 * One alert family covers every click buyer, so a standing page for one would
 * hold back the first page for another (L707). A buyer flagged now and not on
 * the previous run lifts the family's backoff, but only when this job set it:
 * a cooldown standing on its own is a person's mute and stays (L523).
 */
async function letNewSubjectsOut(kv: BackoffKv, job: ClickAlertJob, subjects: readonly ClickSubject[], flaggedNow: ReadonlySet<string>): Promise<void> {
  let newlyFlagged = false
  for (const s of subjects) {
    const key = flaggedKey(job, s.partner_id)
    if (flaggedNow.has(s.partner_id)) {
      if ((await kv.get(key)) === null) newlyFlagged = true
      await kv.put(key, '1', { expirationTtl: 2 * 24 * 3600 })
    } else {
      await kv.delete(key)
    }
  }
  if (newlyFlagged) {
    const family = `export-alert:${job}`
    if ((await readCondition(kv, family)) !== null) await clearCondition(kv, family)
  }
}

async function checkSubject(deps: ClickPathDeps, subject: ClickSubject, now: number): Promise<SubjectSummary> {
  let partner: PartnerFacts | null = null
  let partnerError: string | null = null
  try {
    partner = await deps.readPartner(subject.organization_id, subject.partner_id)
  } catch (err) {
    partnerError = messageOf(err)
  }
  const slug = partner?.slug ?? null

  // The rate window and a little, once: the error check uses the last hour of
  // it, the no eligible half its six hours, the eligible rate all of it (#2104),
  // and the offer match the slack before the no click window.
  const readFrom = now - Math.max(QUIET_RATE_WINDOW_MS, QUIET_WINDOW_MS, NO_CLICK_WINDOW_MS + OFFER_MATCH_SLACK_MS)
  let checks: CheckRun[] | null = null
  let checksError = ''
  try {
    checks = subject.check.workflow_ids.length === 0 ? [] : await deps.readCheckRuns(subject, readFrom, now + 1)
  } catch (err) {
    checksError = messageOf(err)
  }
  const check_errors: Judged<'normal'> = checks === null ? { verdict: 'unmeasured', reason: `buyer_click_check steps: ${checksError}` } : judgeCheckErrors(checks, now)

  let refusals: Judged<'normal'>
  try {
    const sends = subject.send.workflow_ids.length === 0 ? [] : await deps.readSendRuns(subject, now - RATE_WINDOW_MS, now + 1)
    refusals = judgeRefusals(sends, now)
  } catch (err) {
    refusals = { verdict: 'unmeasured', reason: `buyer_click_send steps: ${messageOf(err)}` }
  }

  let buyer: LoadedBuyer | null = null
  let buyerError: string | null = null
  try {
    buyer = await deps.loadBuyer(subject.organization_id, subject.partner_id)
  } catch (err) {
    buyerError = messageOf(err)
  }

  const quiet = await judgeQuiet(deps, subject, { buyer, buyerError, checks, checksError, readFrom, slug, partnerError }, now)
  const reconcile = await reconcileDay(deps, subject, partner, partnerError, now)
  return { partner_id: subject.partner_id, slug, check_errors, quiet, refusals, reconcile }
}

async function judgeQuiet(
  deps: ClickPathDeps,
  subject: ClickSubject,
  read: { buyer: LoadedBuyer | null; buyerError: string | null; checks: CheckRun[] | null; checksError: string; readFrom: number; slug: string | null; partnerError: string | null },
  now: number,
): Promise<QuietVerdict> {
  if (read.buyerError !== null) return { verdict: 'unmeasured', reason: `the buyer profile could not be read: ${read.buyerError}` }
  if (read.buyer === null) return { verdict: 'not_enabled' }
  if (read.buyer.profile.soldOn !== 'click') return { verdict: 'not_enabled', detail: 'the profile is sold on the offer' }
  if (read.checks === null) return { verdict: 'unmeasured', reason: `buyer_click_check steps: ${read.checksError}` }
  const buyer = read.buyer
  const found: string[] = []

  // No eligible (#2104). Judged on the leads that arrived inside the buyer's
  // selling hours, read from its stored windows rather than from what the check
  // decided (L721), since the profile last changed, against the eligible rate
  // the buyer has had since then. A profile switched on or edited a few minutes
  // ago has no rate yet and a window of minutes, so it is never judged on them.
  const changedAt = Date.parse(buyer.updated_at)
  // An unreadable change time is never read as no change (L50): the window would
  // then reach past it, so the check is not judged at all.
  const changeKnown = Number.isFinite(changedAt)
  const since = (windowMs: number) => (changeKnown ? Math.max(now - windowMs, changedAt) : now)
  const counts = (r: CheckRun, fromMs: number) =>
    r.reason !== null && r.reason !== 'profile_disabled' && inWindow(r.started_at, fromMs, now + 1) &&
    isOpen(buyer.profile.windows, buyer.profile.blackoutDates, Date.parse(r.started_at))
  const judgedFrom = since(QUIET_WINDOW_MS)
  const counted = read.checks.filter((r) => counts(r, judgedFrom))
  const eligible = counted.filter((r) => r.route === 'eligible').length
  const minutes = openMinutes(buyer, judgedFrom, now)
  const rateRuns = read.checks.filter((r) => counts(r, since(QUIET_RATE_WINDOW_MS)))
  const rateEligible = rateRuns.filter((r) => r.route === 'eligible').length
  const atCap = counted.some((r) => r.reason === 'daily_click_cap')
  const seen = `${counted.length} leads in ${minutes} minutes of selling time`
  let notJudged: string | null = null
  if (!changeKnown) {
    notJudged = `its profile's last change time cannot be read (${JSON.stringify(buyer.updated_at)}), so the leads since it cannot be told from those before`
  } else if (minutes === 0) {
    notJudged = 'not_open'
  } else if (rateRuns.length < QUIET_RATE_MIN_RUNS) {
    notJudged = `${seen}; its eligible rate is not known yet: ${rateRuns.length} leads since the profile last changed, fewer than ${QUIET_RATE_MIN_RUNS}`
  } else if (rateEligible === 0) {
    notJudged = `${seen}; its eligible rate is not known: none of ${rateRuns.length} leads since the profile last changed was eligible`
  }
  const rate = rateRuns.length === 0 ? 0 : rateEligible / rateRuns.length
  let needed = notJudged === null ? quietRunsNeeded(rate) : Infinity

  // An edit that left no lead eligible (#2426) is judged against the share
  // before it, which the rate since the edit (zero, never trusted) cannot be.
  // Not looked for outside selling time, as the rest of this half is not.
  const edit: EditJudgement = changeKnown && minutes > 0 && subject.check.workflow_ids.length > 0
    ? await judgeEditToZero(deps, subject, buyer, read.checks, read.readFrom, changedAt, now)
    : { kind: 'none' }
  if (edit.kind === 'page') found.push(edit.line)
  if (edit.kind === 'too_few') notJudged = edit.detail
  if (edit.kind !== 'none') needed = Infinity

  if (!atCap && eligible === 0 && counted.length >= needed) {
    found.push(
      `${counted.length} leads reached the Buyer Click Check in ${minutes} minutes of its selling hours and none was eligible. ` +
      `${rateWords(rate)} of leads have been eligible since its profile last changed, so this many with none happens less than once in ${Math.round(1 / QUIET_MAX_CHANCE).toLocaleString('en-US')} (${tally(counted.map((r) => r.reason))})`,
    )
  }

  // No click: offers made by this org's own eligible check runs, and no click execution.
  // A half that cannot be read never discards what the other half found (L530): it is
  // reported beside it, and only a run that found nothing says unmeasured.
  const noClick = await judgeNoClick(deps, subject, read.slug, read.partnerError, read.checks, now - NO_CLICK_WINDOW_MS, now)
  if (noClick.line) found.push(noClick.line)
  if (noClick.unread && found.length > 0) found.push(`whether the offers turned into clicks is not known: ${noClick.unread}`)
  if (edit.kind === 'unread' && found.length > 0) found.push(`whether the profile change left any lead eligible is not known: ${edit.reason}`)
  const offers = noClick.offers

  if (found.length > 0) return { verdict: 'quiet', lines: found }
  const unread = [edit.kind === 'unread' ? edit.reason : null, noClick.unread ?? null].filter((r): r is string => r !== null)
  if (unread.length > 0) return { verdict: 'unmeasured', reason: unread.join('; ') }
  if (notJudged === 'not_open') return { verdict: 'not_open', detail: `no selling time in the ${Math.round((now - judgedFrom) / MIN)} minutes judged, ${offers} offers` }
  if (notJudged !== null) return { verdict: 'too_few', detail: notJudged }
  if (counted.length < needed) return { verdict: 'too_few', detail: `${seen}, ${needed} needed at ${rateWords(rate)} eligible` }
  return { verdict: 'normal', detail: `${seen}, ${eligible} eligible, ${offers} offers` }
}

/**
 * The edit to zero comparison (#2426): `none` hands the judgement back to the
 * rate since the change, which is right whenever any lead has passed the
 * buyer's rules since it, and whenever there is no trusted share before it.
 */
type EditJudgement =
  | { kind: 'none' }
  | { kind: 'page'; line: string }
  | { kind: 'too_few'; detail: string }
  | { kind: 'unread'; reason: string }

const ET_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
/** An instant for a person, in Eastern time; ICU's narrow space before AM or PM is made a plain one. */
const etClock = (ms: number): string => `${ET_CLOCK.format(new Date(ms)).replace(/\u202f/g, ' ')} ET`

/**
 * A lead that passed the buyer's rules: eligible, or out only on the day's
 * click cap, which buyer_click_check judges after the rules (its step 3).
 */
const passedRules = (r: CheckRun): boolean => r.route === 'eligible' || r.reason === 'daily_click_cap'

async function judgeEditToZero(
  deps: ClickPathDeps,
  subject: ClickSubject,
  buyer: LoadedBuyer,
  checks: readonly CheckRun[],
  readFrom: number,
  changedAt: number,
  now: number,
): Promise<EditJudgement> {
  if (changedAt < now - EDIT_LOOKBACK_MAX_MS || changedAt > now) return { kind: 'none' }
  const settledFrom = changedAt + EDIT_PICKUP_GRACE_MS
  // Nothing after the grace yet: the edit is minutes old and judged on nothing (#2104).
  if (settledFrom >= now) return { kind: 'none' }
  const counts = (r: CheckRun, fromMs: number, toMs: number) =>
    r.reason !== null && r.reason !== 'profile_disabled' && inWindow(r.started_at, fromMs, toMs) &&
    isOpen(buyer.profile.windows, buyer.profile.blackoutDates, Date.parse(r.started_at))
  // The runs already read answer the usual case, a lead passing since the edit, with no further read.
  if (checks.some((r) => passedRules(r) && counts(r, settledFrom, now + 1))) return { kind: 'none' }

  const preFrom = changedAt - EDIT_PRE_WINDOW_MS
  let runs: readonly CheckRun[] = checks
  if (preFrom < readFrom) {
    try {
      runs = [...(await deps.readCheckRuns(subject, preFrom, readFrom)), ...checks]
    } catch (err) {
      return { kind: 'unread', reason: `the leads before the profile change at ${etClock(changedAt)} could not be read: ${messageOf(err)}` }
    }
  }
  const sinceEdit = runs.filter((r) => counts(r, settledFrom, now + 1))
  if (sinceEdit.some(passedRules)) return { kind: 'none' }
  const beforeEdit = runs.filter((r) => counts(r, preFrom, changedAt))
  const beforeEligible = beforeEdit.filter((r) => r.route === 'eligible').length
  if (beforeEdit.length < QUIET_RATE_MIN_RUNS || beforeEligible === 0) return { kind: 'none' }

  const before = beforeEligible / beforeEdit.length
  const needed = quietRunsNeeded(before)
  const hours = Math.round(EDIT_PRE_WINDOW_MS / HOUR)
  if (sinceEdit.length < needed) {
    return {
      kind: 'too_few',
      detail: `${sinceEdit.length} leads in selling hours since the profile changed at ${etClock(changedAt)}, none eligible; ${needed} needed at the ${rateWords(before)} eligible in the ${hours} hours before it`,
    }
  }
  return {
    kind: 'page',
    line:
      `${sinceEdit.length} leads reached the Buyer Click Check in its selling hours since its profile was changed at ${etClock(changedAt)}, and none was eligible. ` +
      `${rateWords(before)} of leads were eligible (${beforeEligible} of ${beforeEdit.length}) in the ${hours} hours before that change, so this many with none ` +
      `happens less than once in ${Math.round(1 / QUIET_MAX_CHANCE).toLocaleString('en-US')} at that share, and the change may have left no lead the buyer can be offered ` +
      `(${tally(sinceEdit.map((r) => r.reason))})`,
  }
}

/** The offers-but-no-clicks half of the quiet check: a finding, or the reason it could not be read. */
async function judgeNoClick(
  deps: ClickPathDeps,
  subject: ClickSubject,
  slug: string | null,
  partnerError: string | null,
  checks: CheckRun[],
  from: number,
  now: number,
): Promise<{ line?: string; unread?: string; offers: number | null }> {
  if (slug === null) return { unread: `the partner could not be read, so its offers could not be counted${partnerError ? `: ${partnerError}` : ''}`, offers: null }
  let offers: number
  try {
    const eligibleIds = new Set(checks.filter((r) => r.route === 'eligible').map((r) => r.execution_id))
    offers = (await deps.readOfferExecutionIds(slug, from, now + 1)).filter((id) => eligibleIds.has(id)).length
  } catch (err) {
    return { unread: `the offers could not be read: ${messageOf(err)}`, offers: null }
  }
  if (offers < NO_CLICK_MIN_OFFERS) return { offers }
  if (subject.send.workflow_ids.length === 0) {
    return { line: `${offers} offers made in the last 3 hours and no live workflow sends this buyer's clicks, so no click can be sold`, offers }
  }
  let clicks: number
  try {
    clicks = await deps.countClickExecutions(subject, from, now + 1)
  } catch (err) {
    return { unread: `the click executions could not be counted: ${messageOf(err)}`, offers }
  }
  return clicks === 0 ? { line: `${offers} offers made in the last 3 hours and no click execution ran in the workflow that sends them`, offers } : { offers }
}

const previousPacificDate = (date: string): string => zonedParts(zonedDayStartUtc(date, PACIFIC) - 1, PACIFIC).date
const nextPacificDate = (date: string): string => zonedParts(zonedDayStartUtc(date, PACIFIC) + 36 * HOUR, PACIFIC).date

async function reconcileDay(deps: ClickPathDeps, subject: ClickSubject, partner: PartnerFacts | null, partnerError: string | null, now: number): Promise<ReconcileVerdict> {
  const today = zonedParts(now, PACIFIC)
  if (today.minuteOfDay < RECONCILE_SETTLE_MINUTES) return { verdict: 'not_due' }
  const date = previousPacificDate(today.date)
  const doneKey = reconcileDoneKey(subject.partner_id, date)
  if ((await deps.kv.get(doneKey)) !== null) return { verdict: 'already_done', date }

  const unmeasured = (reason: string): ReconcileVerdict => ({ verdict: 'unmeasured', date, reason })
  if (partner === null) return unmeasured(partnerError ? `the partner could not be read: ${partnerError}` : 'the organization holds no such partner')

  let counted: string[]
  let around: Set<string>
  try {
    counted = await deps.counterMembers(subject.partner_id, date)
    const neighbours = await Promise.all([deps.counterMembers(subject.partner_id, previousPacificDate(date)), deps.counterMembers(subject.partner_id, nextPacificDate(date))])
    around = new Set([...counted, ...neighbours.flat()])
  } catch (err) {
    return unmeasured(`the click count could not be read: ${messageOf(err)}`)
  }

  const code = partner.external_routing_code
  if (code === null) {
    if (counted.length === 0) return markDone(deps, doneKey, { verdict: 'match', date, detail: 'no clicks counted and no routing code to read Salesforce by' })
    return unmeasured(`${counted.length} clicks were counted but the partner has no Salesforce routing code to find their prospects by`)
  }

  const start = zonedDayStartUtc(date, PACIFIC)
  const end = zonedDayStartUtc(nextPacificDate(date), PACIFIC)
  let completed: CompletedProspect[]
  try {
    const [prospects, submissions] = await Promise.all([
      deps.readCompletedProspects(subject.organization_id, code, start - RECONCILE_PAD_MS, end + RECONCILE_PAD_MS),
      deps.readCompletedSubmissionsWithoutProspect(subject.organization_id, code, start - RECONCILE_PAD_MS, end + RECONCILE_PAD_MS),
    ])
    completed = [...prospects, ...submissions]
  } catch (err) {
    return unmeasured(`Salesforce could not be read: ${messageOf(err)}`)
  }

  const inSalesforce = new Set(completed.map((p) => p.id))
  const countedOnly = counted.filter((id) => !inSalesforce.has(id))
  const salesforceOnly = completed.filter((p) => inWindow(p.at, start, end) && !around.has(p.id)).map((p) => p.id)
  if (countedOnly.length === 0 && salesforceOnly.length === 0) {
    return markDone(deps, doneKey, { verdict: 'match', date, detail: `${counted.length} counted, all Completed in Salesforce` })
  }
  const named = (ids: string[]) => `${ids.slice(0, RECONCILE_NAMED_MAX).join(', ')}${ids.length > RECONCILE_NAMED_MAX ? `, and ${ids.length - RECONCILE_NAMED_MAX} more` : ''}`
  const parts: string[] = []
  if (countedOnly.length) parts.push(`${countedOnly.length} counted as clicks with no Completed prospect or submission in Salesforce: ${named(countedOnly)}`)
  if (salesforceOnly.length) parts.push(`${salesforceOnly.length} Completed in Salesforce with routing code ${code} and never counted: ${named(salesforceOnly)}`)
  return markDone(deps, doneKey, { verdict: 'mismatch', date, detail: parts.join('; ') })
}

async function markDone(deps: ClickPathDeps, key: string, verdict: ReconcileVerdict): Promise<ReconcileVerdict> {
  await deps.kv.put(key, new Date(deps.now()).toISOString(), { expirationTtl: RECONCILE_DONE_TTL_SECONDS })
  return verdict
}

/** What the run records about itself: ok only when every check on every buyer measured and agreed. */
export function endingOf(summary: ClickPathSummary): JobRunEnding {
  if (summary.skipped) return { outcome: 'skipped', detail: summary.skipped }
  if (summary.unmeasured) return { outcome: 'unmeasured', detail: summary.unmeasured }
  const findings = Object.values(summary.paged).some((n) => n > 0) && summary.subjects.some((s) =>
    s.check_errors.verdict === 'elevated' || s.quiet.verdict === 'quiet' || s.refusals.verdict === 'elevated' || s.reconcile.verdict === 'mismatch')
  const unmeasured = summary.subjects.some((s) =>
    s.check_errors.verdict === 'unmeasured' || s.quiet.verdict === 'unmeasured' || s.refusals.verdict === 'unmeasured' || s.reconcile.verdict === 'unmeasured')
  return {
    outcome: findings ? 'findings' : unmeasured ? 'unmeasured' : 'ok',
    summary: {
      subjects: summary.subjects.map((s) => ({
        partner_id: s.partner_id, slug: s.slug, check_errors: s.check_errors.verdict, quiet: s.quiet.verdict, refusals: s.refusals.verdict,
        reconcile: s.reconcile.verdict, reconcile_date: 'date' in s.reconcile ? s.reconcile.date ?? null : null,
      })),
      paged: summary.paged,
    },
  }
}

// ── Production wiring ─────────────────────────────────────────────────────────

interface WorkflowRow {
  id: string
  organization_id: string
  is_active: boolean | null
  definition: { nodes?: Array<{ type?: unknown; namespace?: unknown; config?: { partner_id?: unknown } | null }> } | null
}

/** Every buyer named on a buyer_click_check or buyer_click_send node of a live workflow, grouped per organization and buyer. */
export function subjectsFromWorkflows(rows: readonly WorkflowRow[]): ClickSubject[] {
  const byKey = new Map<string, ClickSubject>()
  const add = (list: { workflow_ids: string[]; namespaces: string[] }, workflowId: string, namespace: string) => {
    if (!list.workflow_ids.includes(workflowId)) list.workflow_ids.push(workflowId)
    if (!list.namespaces.includes(namespace)) list.namespaces.push(namespace)
  }
  for (const w of rows) {
    if (w.is_active !== true) continue
    for (const n of w.definition?.nodes ?? []) {
      if (n?.type !== 'buyer_click_check' && n?.type !== 'buyer_click_send') continue
      const partnerId = typeof n.config?.partner_id === 'string' ? n.config.partner_id.trim() : ''
      if (!isPartnerId(partnerId) || typeof n.namespace !== 'string') continue
      const key = `${w.organization_id}:${partnerId}`
      const subject = byKey.get(key) ?? { organization_id: w.organization_id, partner_id: partnerId, check: { workflow_ids: [], namespaces: [] }, send: { workflow_ids: [], namespaces: [] } }
      add(n.type === 'buyer_click_check' ? subject.check : subject.send, w.id, n.namespace)
      byKey.set(key, subject)
    }
  }
  return [...byKey.values()]
}

const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/
const SOQL_INSTANT = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * One bounded SOQL read of Completed records for the reconcile: the org's
 * credentials, the cached token, every page through nextRecordsUrl. LIMIT is one
 * past the bound, so a day beyond it is refused rather than reconciled on part.
 */
async function readCompletedRecords(env: Env, supabase: SupabaseClient, orgId: string, kind: 'prospect' | 'submission', stampField: string, soql: string): Promise<CompletedProspect[]> {
  const { creds, missing } = await resolveSalesforceCredsFor(env, supabase, orgId)
  if (!creds) throw new Error(`Salesforce credentials missing: ${missing.join(', ')}`)
  const token = await getSalesforceToken(env, orgId, creds.instanceUrl, creds.clientId, creds.clientSecret)
  const out: CompletedProspect[] = []
  let next: string | undefined = `${creds.instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`
  while (next) {
    const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`Salesforce query failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
    const body = await parseJson<{ records: Array<Record<string, unknown>>; done: boolean; nextRecordsUrl?: string }>(res)
    for (const rec of body.records) {
      const at = rec[stampField]
      if (typeof rec.Id !== 'string' || !SALESFORCE_ID.test(rec.Id) || typeof at !== 'string') {
        throw new Error(`Salesforce returned an unreadable ${kind}: ${JSON.stringify(rec).slice(0, 200)}`)
      }
      out.push({ id: rec.Id, at })
    }
    if (out.length > RECONCILE_MAX_RECORDS) throw new Error(`more than ${RECONCILE_MAX_RECORDS} Completed ${kind}s in the day, so the day was not reconciled on part of them`)
    next = body.done ? undefined : body.nextRecordsUrl ? `${creds.instanceUrl}${body.nextRecordsUrl}` : undefined
  }
  return out
}

export function productionClickPathDeps(supabase: SupabaseClient, env: Env): ClickPathDeps {
  const stepRows = <T>(subject: ClickSubject, which: 'check' | 'send', select: string, fromMs: number, toMs: number) =>
    fetchAllPaged<T>(
      (from, to) => supabase
        .from('execution_steps')
        .select(select)
        .in('workflow_id', subject[which].workflow_ids)
        // The namespace leads the (workflow_id, step_namespace, started_at) index;
        // started_at prunes the monthly partitions.
        .in('step_namespace', subject[which].namespaces)
        .eq('step_type', which === 'check' ? 'buyer_click_check' : 'buyer_click_send')
        .eq('is_test', false)
        .eq('output->>partner_id', subject.partner_id)
        .gte('started_at', new Date(fromMs).toISOString())
        .lt('started_at', new Date(toMs).toISOString())
        .order('started_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
      `execution_steps ${which}`,
    )

  return {
    listSubjects: async () => {
      // The workflows table is small (about a dozen rows), so the definitions are read whole, as the parity refresh does.
      const { data, error } = await supabase
        .from('workflows')
        .select('id, organization_id, is_active, definition')
        .is('deleted_at', null)
        .limit(200)
      if (error) throw new Error(`workflows: ${error.message}`)
      return subjectsFromWorkflows((data ?? []) as unknown as WorkflowRow[])
    },
    readPartner: async (orgId, partnerId) => {
      const { data, error } = await supabase
        .from('partner_configs')
        .select('slug, external_routing_code')
        .eq('organization_id', orgId)
        .eq('id', partnerId)
        .maybeSingle()
      if (error) throw new Error(`partner_configs: ${error.message}`)
      if (!data) return null
      const row = data as { slug: string; external_routing_code: number | null }
      return { slug: row.slug, external_routing_code: typeof row.external_routing_code === 'number' ? row.external_routing_code : null }
    },
    loadBuyer: async (orgId, partnerId) => {
      const snapshot = await loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase)
      return snapshot.buyers.find((b) => b.partner.id === partnerId) ?? null
    },
    readCheckRuns: async (subject, fromMs, toMs) => {
      const rows = await stepRows<{ execution_id: string; started_at: string; route: string | null; reason: string | null }>(
        subject, 'check', 'id, execution_id, started_at, route:output->>_route, reason:output->>reason', fromMs, toMs)
      return rows.map((r) => ({ execution_id: r.execution_id, started_at: r.started_at, route: r.route, reason: r.reason }))
    },
    readSendRuns: async (subject, fromMs, toMs) => {
      const rows = await stepRows<{ started_at: string; route: string | null }>(subject, 'send', 'id, started_at, route:output->>_route', fromMs, toMs)
      return rows.map((r) => ({ started_at: r.started_at, route: r.route }))
    },
    countClickExecutions: async (subject, fromMs, toMs) => {
      const { count, error } = await supabase
        .from('workflow_executions')
        .select('id', { count: 'exact', head: true })
        .in('workflow_id', subject.send.workflow_ids)
        .eq('is_test', false)
        .gte('started_at', new Date(fromMs).toISOString())
        .lt('started_at', new Date(toMs).toISOString())
      if (error) throw new Error(`workflow_executions count: ${error.message}`)
      // A null count is an unanswered question, never zero executions (L215).
      if (typeof count !== 'number') throw new Error('workflow_executions count: no count returned')
      return count
    },
    readOfferExecutionIds: async (slug, fromMs, toMs) => {
      const rows = await fetchAllPaged<{ execution_id: string }>(
        (from, to) => supabase
          .from('lead_sighting_bids')
          .select('id, execution_id')
          .eq('partner_slug', slug)
          .eq('resolver_type', CLICK_RESOLVER_TYPE)
          .eq('is_test', false)
          // The partition key, so the read prunes to the current month.
          .gte('attempted_at_utc', new Date(fromMs).toISOString())
          .lt('attempted_at_utc', new Date(toMs).toISOString())
          .order('attempted_at_utc', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
        'lead_sighting_bids click offers',
      )
      return rows.map((r) => r.execution_id)
    },
    counterMembers: async (partnerId, date) => {
      // The counter is named by the Pacific date of an instant; noon of that date names it.
      const counter = new ClickCounterClient(env.DAILY_CAP, env.WORKFLOW_CACHE, partnerId, zonedDayStartUtc(date, PACIFIC) + 12 * HOUR)
      if (counter.date !== date) throw new Error(`click counter for ${date} resolved to ${counter.date}`)
      const r = await counter.members()
      if (!r || !Array.isArray(r.members)) throw new Error(`click counter members answered an unreadable body: ${JSON.stringify(r)}`)
      return r.members.map((m) => m.member)
    },
    readCompletedProspects: async (orgId, routingCode, fromMs, toMs) => {
      if (!Number.isInteger(routingCode)) throw new Error(`routing code ${String(routingCode)} is not a whole number`)
      return readCompletedRecords(env, supabase, orgId, 'prospect', 'ExternalTimestamp__c',
        `SELECT Id, ExternalTimestamp__c FROM Prospect__c WHERE ExternalRoutingCode__c = ${routingCode} AND ExternalExchangeStatus__c = 'Completed' ` +
        `AND ExternalTimestamp__c >= ${SOQL_INSTANT(fromMs)} AND ExternalTimestamp__c < ${SOQL_INSTANT(toMs)} ORDER BY ExternalTimestamp__c LIMIT ${RECONCILE_MAX_RECORDS + 1}`)
    },
    readCompletedSubmissionsWithoutProspect: async (orgId, routingCode, fromMs, toMs) => {
      if (!Number.isInteger(routingCode)) throw new Error(`routing code ${String(routingCode)} is not a whole number`)
      // The routing code is a Text field on the Submission, a Number on the Prospect.
      // SystemModstamp is indexed and the click's own write moves it, so it bounds
      // the scan without losing a record: unfiltered this read took 80s on the org
      // on 2026-09-29, with it 11s, and Salesforce stops a query at 120s.
      return readCompletedRecords(env, supabase, orgId, 'submission', 'External_Timestamp__c',
        `SELECT Id, External_Timestamp__c FROM Submission__c WHERE SystemModstamp >= ${SOQL_INSTANT(fromMs)} ` +
        `AND External_Routing_Code__c = '${routingCode}' AND External_Exchange_Status__c = 'Completed' ` +
        `AND Prospect__c = null AND External_Timestamp__c >= ${SOQL_INSTANT(fromMs)} AND External_Timestamp__c < ${SOQL_INSTANT(toMs)} ` +
        `ORDER BY External_Timestamp__c LIMIT ${RECONCILE_MAX_RECORDS + 1}`)
    },
    kv: env.IDEMPOTENCY,
    notify: {
      [CLICK_CHECK_ERRORS_JOB]: (lines, remedy) => notifyExportFailure(supabase, CLICK_CHECK_ERRORS_JOB, lines, env.IDEMPOTENCY, remedy),
      [CLICK_PATH_QUIET_JOB]: (lines, remedy) => notifyExportFailure(supabase, CLICK_PATH_QUIET_JOB, lines, env.IDEMPOTENCY, remedy),
      [CLICK_SEND_REFUSALS_JOB]: (lines, remedy) => notifyExportFailure(supabase, CLICK_SEND_REFUSALS_JOB, lines, env.IDEMPOTENCY, remedy),
      [CLICK_RECONCILE_JOB]: (lines, remedy) => notifyExportFailure(supabase, CLICK_RECONCILE_JOB, lines, env.IDEMPOTENCY, remedy),
    },
    now: () => Date.now(),
    localDev: Boolean(env.LOCAL_DEV),
    appUrl: env.APP_URL,
    log: (line) => console.log(line),
  }
}

/** What the scheduled handler calls: the checks under a job run record (L557). */
export function runClickPathChecksForEnv(supabase: SupabaseClient, env: Env): Promise<ClickPathSummary> {
  return withJobRun(supabase, CLICK_PATH_CHECKS_JOB, () => runClickPathChecks(productionClickPathDeps(supabase, env)), endingOf)
}
