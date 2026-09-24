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
 *                   no eligible  the last three hours were ALL inside the
 *                                buyer's selling hours (its operating windows
 *                                and blackout dates), at least QUIET_MIN_RUNS
 *                                leads reached the check, and none was
 *                                eligible. Runs the disabled profile answered
 *                                are not counted, and a run at the day's cap
 *                                stands the check down, because then not
 *                                eligible is the cap working.
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
 *                 two can straddle midnight. A mismatch pages naming the
 *                 prospects. The Salesforce read follows buyer-sales-checks'
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
import { PACIFIC, isOpen, isPartnerId, zonedDayStartUtc, zonedParts, type OutReason } from '@bidspoke/buyer-profile'
import type { Env } from '../index'
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
 * ms against a 300 ms budget, so a cold counter will cost SOME runs every day;
 * a fifth is well past a cold start and well short of an outage. The real share
 * on the first live day is what to set this from.
 */
export const CHECK_ERROR_MIN_SHARE = 0.2
/** Below the minimum, an hour in which every run errored and there were at least this many pages anyway (L139). */
export const CHECK_ERROR_SATURATION_MIN_RUNS = 5

/** The absence window the issue names. */
export const QUIET_WINDOW_MS = 3 * HOUR
/** Leads that must have reached the check in the three hours before zero eligible means anything. */
export const QUIET_MIN_RUNS = 10
/** How finely the three hours are checked against the operating windows. Windows are whole minutes; five is finer than any window anyone sets. */
export const QUIET_OPEN_SAMPLE_MS = 5 * MIN
/**
 * Offers in three hours with no click execution before that pages. No click
 * through rate exists yet: at 10 percent, 30 offers with no click happens about
 * 4 times in 100 by chance; at 5 percent, about 21. So this is a floor for a
 * rate we expect to be well above that, and is the first number to re-measure.
 */
export const NO_CLICK_MIN_OFFERS = 30
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
    'answered past the 300 ms budget, with a read failure means the profile could not be loaded; profile_copy_stale means the ' +
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
    'usually means a template on the Buyer Click Check node reads a path the payload no longer carries. No click: check that the ' +
    "buyer's click proxy still forwards a POST to the Bidspoke custom endpoint, that the endpoint's workflow is switched on, and " +
    "that the portal's click link still works.",
  headlineVerb: 'shows a click buyer path gone quiet',
  itemNoun: { one: 'finding', many: 'findings' },
}

export const CLICK_SEND_REFUSALS_REMEDY: AlertRemedy = {
  consequence:
    'A click sold buyer refused most of the clicks sent to it in the last hour. A refusal is final: the prospect is marked Fail in ' +
    'Salesforce and later clicks on it are not sent. Each line names the buyer and the share:',
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
    "or the count failed; the day's count read low by that many.",
  headlineVerb: 'found a click count that disagrees with Salesforce',
  itemNoun: { one: 'disagreement', many: 'disagreements' },
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
  kv: BackoffKv
  notify: Record<ClickAlertJob, (lines: string[]) => Promise<void>>
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

/** Whether the buyer was open for sale at every sample across [fromMs, toMs], both ends included. */
export function openThroughout(buyer: LoadedBuyer, fromMs: number, toMs: number): boolean {
  for (let t = fromMs; t < toMs; t += QUIET_OPEN_SAMPLE_MS) {
    if (!isOpen(buyer.profile.windows, buyer.profile.blackoutDates, t)) return false
  }
  return isOpen(buyer.profile.windows, buyer.profile.blackoutDates, toMs)
}

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
    await deps.notify[CLICK_CHECK_ERRORS_JOB]([reason])
    paged[CLICK_CHECK_ERRORS_JOB] = 1
    return { unmeasured: reason, subjects: [], paged }
  }

  const lines: Record<ClickAlertJob, string[]> = { [CLICK_CHECK_ERRORS_JOB]: [], [CLICK_PATH_QUIET_JOB]: [], [CLICK_SEND_REFUSALS_JOB]: [], [CLICK_RECONCILE_JOB]: [] }
  const flagged: Record<ClickAlertJob, Set<string>> = { [CLICK_CHECK_ERRORS_JOB]: new Set(), [CLICK_PATH_QUIET_JOB]: new Set(), [CLICK_SEND_REFUSALS_JOB]: new Set(), [CLICK_RECONCILE_JOB]: new Set() }
  let reconcileRan = false
  const summaries: SubjectSummary[] = []

  for (const subject of subjects) {
    const s = await checkSubject(deps, subject, now)
    summaries.push(s)
    const name = s.slug ?? subject.partner_id
    const page = `${deps.appUrl}/partners?selected=${encodeURIComponent(name)}`
    if (s.check_errors.verdict === 'elevated') { lines[CLICK_CHECK_ERRORS_JOB].push(`${name}: ${s.check_errors.detail}. Partner page: ${page}`); flagged[CLICK_CHECK_ERRORS_JOB].add(subject.partner_id) }
    if (s.check_errors.verdict === 'unmeasured') lines[CLICK_CHECK_ERRORS_JOB].push(`${name}: the check runs could not be read, so whether the check is answering is not known: ${s.check_errors.reason}`)
    if (s.quiet.verdict === 'quiet') { lines[CLICK_PATH_QUIET_JOB].push(...s.quiet.lines.map((l) => `${name}: ${l}`)); flagged[CLICK_PATH_QUIET_JOB].add(subject.partner_id) }
    if (s.refusals.verdict === 'elevated') { lines[CLICK_SEND_REFUSALS_JOB].push(`${name}: ${s.refusals.detail}. Partner page: ${page}`); flagged[CLICK_SEND_REFUSALS_JOB].add(subject.partner_id) }
    if (s.reconcile.verdict === 'mismatch' || s.reconcile.verdict === 'unmeasured' || s.reconcile.verdict === 'match') reconcileRan = true
    if (s.reconcile.verdict === 'mismatch') { lines[CLICK_RECONCILE_JOB].push(`${name} on ${s.reconcile.date} (Pacific day): ${s.reconcile.detail}`); flagged[CLICK_RECONCILE_JOB].add(subject.partner_id) }
    if (s.reconcile.verdict === 'unmeasured') lines[CLICK_RECONCILE_JOB].push(`${name} on ${s.reconcile.date} (Pacific day) could not be reconciled, and is tried again on the next run: ${s.reconcile.reason}`)
  }

  for (const job of CLICK_ALERT_JOBS) {
    // The reconcile runs once a day; a run that did not reconcile says nothing, so it neither pages nor clears a standing page.
    if (job === CLICK_RECONCILE_JOB && !reconcileRan) continue
    await letNewSubjectsOut(deps.kv, job, subjects, flagged[job])
    await deps.notify[job](lines[job])
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

  // Three hours and a little, once: the rate check uses the last hour of it,
  // the quiet check all of it, and the offer match the slack before it.
  const quietFrom = now - QUIET_WINDOW_MS
  let checks: CheckRun[] | null = null
  let checksError = ''
  try {
    checks = subject.check.workflow_ids.length === 0 ? [] : await deps.readCheckRuns(subject, quietFrom - OFFER_MATCH_SLACK_MS, now + 1)
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

  const quiet = await judgeQuiet(deps, subject, { buyer, buyerError, checks, checksError, slug, partnerError }, now)
  const reconcile = await reconcileDay(deps, subject, partner, partnerError, now)
  return { partner_id: subject.partner_id, slug, check_errors, quiet, refusals, reconcile }
}

async function judgeQuiet(
  deps: ClickPathDeps,
  subject: ClickSubject,
  read: { buyer: LoadedBuyer | null; buyerError: string | null; checks: CheckRun[] | null; checksError: string; slug: string | null; partnerError: string | null },
  now: number,
): Promise<QuietVerdict> {
  if (read.buyerError !== null) return { verdict: 'unmeasured', reason: `the buyer profile could not be read: ${read.buyerError}` }
  if (read.buyer === null) return { verdict: 'not_enabled' }
  if (read.buyer.profile.soldOn !== 'click') return { verdict: 'not_enabled', detail: 'the profile is sold on the offer' }
  if (read.checks === null) return { verdict: 'unmeasured', reason: `buyer_click_check steps: ${read.checksError}` }
  const from = now - QUIET_WINDOW_MS
  const found: string[] = []
  const window = read.checks.filter((r) => r.reason !== null && inWindow(r.started_at, from, now + 1))

  // No eligible, judged only when every moment of the three hours was open for sale.
  const open = openThroughout(read.buyer, from, now)
  const counted = window.filter((r) => r.reason !== 'profile_disabled')
  const eligible = counted.filter((r) => r.route === 'eligible').length
  const atCap = counted.some((r) => r.reason === 'daily_click_cap')
  if (open && !atCap && eligible === 0 && counted.length >= QUIET_MIN_RUNS) {
    found.push(`${counted.length} leads reached the Buyer Click Check in the last 3 hours, all inside its selling hours, and none was eligible (${tally(counted.map((r) => r.reason))})`)
  }

  // No click: offers made by this org's own eligible check runs, and no click execution.
  if (read.slug === null) {
    return { verdict: 'unmeasured', reason: `the partner could not be read, so its offers could not be counted${read.partnerError ? `: ${read.partnerError}` : ''}` }
  }
  let offers: number
  try {
    const eligibleIds = new Set(read.checks.filter((r) => r.route === 'eligible').map((r) => r.execution_id))
    offers = (await deps.readOfferExecutionIds(read.slug, from, now + 1)).filter((id) => eligibleIds.has(id)).length
  } catch (err) {
    return { verdict: 'unmeasured', reason: `the offers could not be read: ${messageOf(err)}` }
  }
  if (offers >= NO_CLICK_MIN_OFFERS) {
    if (subject.send.workflow_ids.length === 0) {
      found.push(`${offers} offers made in the last 3 hours and no live workflow sends this buyer's clicks, so no click can be sold`)
    } else {
      let clicks: number
      try {
        clicks = await deps.countClickExecutions(subject, from, now + 1)
      } catch (err) {
        return { verdict: 'unmeasured', reason: `the click executions could not be counted: ${messageOf(err)}` }
      }
      if (clicks === 0) found.push(`${offers} offers made in the last 3 hours and no click execution ran in the workflow that sends them`)
    }
  }

  if (found.length > 0) return { verdict: 'quiet', lines: found }
  if (!open) return { verdict: 'not_open', detail: `${counted.length} runs, ${eligible} eligible, ${offers} offers` }
  if (counted.length < QUIET_MIN_RUNS) return { verdict: 'too_few', detail: `${counted.length} runs, ${offers} offers` }
  return { verdict: 'normal', detail: `${counted.length} runs, ${eligible} eligible, ${offers} offers` }
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
    completed = await deps.readCompletedProspects(subject.organization_id, code, start - RECONCILE_PAD_MS, end + RECONCILE_PAD_MS)
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
  if (countedOnly.length) parts.push(`${countedOnly.length} counted as clicks with no Completed prospect in Salesforce: ${named(countedOnly)}`)
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
      const counter = new ClickCounterClient(env.DAILY_CAP, partnerId, zonedDayStartUtc(date, PACIFIC) + 12 * HOUR)
      if (counter.date !== date) throw new Error(`click counter for ${date} resolved to ${counter.date}`)
      const r = await counter.members()
      if (!r || !Array.isArray(r.members)) throw new Error(`click counter members answered an unreadable body: ${JSON.stringify(r)}`)
      return r.members.map((m) => m.member)
    },
    readCompletedProspects: async (orgId, routingCode, fromMs, toMs) => {
      if (!Number.isInteger(routingCode)) throw new Error(`routing code ${String(routingCode)} is not a whole number`)
      const { creds, missing } = await resolveSalesforceCredsFor(env, supabase, orgId)
      if (!creds) throw new Error(`Salesforce credentials missing: ${missing.join(', ')}`)
      const token = await getSalesforceToken(env, orgId, creds.instanceUrl, creds.clientId, creds.clientSecret)
      // One bounded query: a day is about a cap's worth of prospects. LIMIT one
      // past the bound, so a day beyond it is refused rather than reconciled on part.
      const soql = `SELECT Id, ExternalTimestamp__c FROM Prospect__c WHERE ExternalRoutingCode__c = ${routingCode} AND ExternalExchangeStatus__c = 'Completed' ` +
        `AND ExternalTimestamp__c >= ${SOQL_INSTANT(fromMs)} AND ExternalTimestamp__c < ${SOQL_INSTANT(toMs)} ORDER BY ExternalTimestamp__c LIMIT ${RECONCILE_MAX_RECORDS + 1}`
      const out: CompletedProspect[] = []
      let next: string | undefined = `${creds.instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`
      while (next) {
        const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) throw new Error(`Salesforce query failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
        const body = await parseJson<{ records: Array<{ Id?: unknown; ExternalTimestamp__c?: unknown }>; done: boolean; nextRecordsUrl?: string }>(res)
        for (const rec of body.records) {
          if (typeof rec.Id !== 'string' || !SALESFORCE_ID.test(rec.Id) || typeof rec.ExternalTimestamp__c !== 'string') {
            throw new Error(`Salesforce returned an unreadable prospect: ${JSON.stringify(rec).slice(0, 200)}`)
          }
          out.push({ id: rec.Id, at: rec.ExternalTimestamp__c })
        }
        if (out.length > RECONCILE_MAX_RECORDS) throw new Error(`more than ${RECONCILE_MAX_RECORDS} Completed prospects in the day, so the day was not reconciled on part of them`)
        next = body.done ? undefined : body.nextRecordsUrl ? `${creds.instanceUrl}${body.nextRecordsUrl}` : undefined
      }
      return out
    },
    kv: env.IDEMPOTENCY,
    notify: {
      [CLICK_CHECK_ERRORS_JOB]: (lines) => notifyExportFailure(supabase, CLICK_CHECK_ERRORS_JOB, lines, env.IDEMPOTENCY, CLICK_CHECK_ERRORS_REMEDY),
      [CLICK_PATH_QUIET_JOB]: (lines) => notifyExportFailure(supabase, CLICK_PATH_QUIET_JOB, lines, env.IDEMPOTENCY, CLICK_PATH_QUIET_REMEDY),
      [CLICK_SEND_REFUSALS_JOB]: (lines) => notifyExportFailure(supabase, CLICK_SEND_REFUSALS_JOB, lines, env.IDEMPOTENCY, CLICK_SEND_REFUSALS_REMEDY),
      [CLICK_RECONCILE_JOB]: (lines) => notifyExportFailure(supabase, CLICK_RECONCILE_JOB, lines, env.IDEMPOTENCY, CLICK_RECONCILE_REMEDY),
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
