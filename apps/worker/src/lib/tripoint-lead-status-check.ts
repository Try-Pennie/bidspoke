/**
 * Does a Tripoint sale's Salesforce Lead carry the Completed its Submission
 * carries? Daily (#1524).
 *
 * WHY. On 2026-07-08 Salesforce stopped copying `External_Exchange_Status__c =
 * Completed` from a `Submission__c` to its `Lead` (#1521, #1525).
 * `Lead.ExternalRevenue__c` books 0 unless the Lead reads Completed, so the
 * Lead's revenue for Main Flow Tripoint sales fell from about 11,000 a month to
 * a few hundred, and nothing noticed for eleven weeks. Pennie's reporting reads
 * the Submission, which stayed right, so this is two records disagreeing rather
 * than money missing; but anything built on the Lead is wrong while it lasts.
 *
 * WHAT IT MEASURES. For the UTC day before the run: of the Main Flow Tripoint
 * submissions (`Tripoint_Response__c = Success`) created that day that read
 * Completed, how many have a Lead that reads Completed. Before July 8 that was
 * 96 to 99 percent; on 2026-09-23 it was 2 of 409. Both counts go into the
 * alert, so the reader sees the divergence rather than a verdict (L11). It also
 * counts every Completed submission since July 8 whose Lead still disagrees,
 * which is what tells anyone the backfill in #1525 has finished.
 *
 * A COUNT THAT COULD NOT BE READ IS ITS OWN FINDING, never a zero, and a day
 * with no Completed submission at all is reported rather than read as
 * agreement: Main Flow sells a few hundred a day to Tripoint (L98, L215).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { salesforceCount } from './salesforce-read'
import type { Env } from '../index'

export const TRIPOINT_LEAD_STATUS_JOB = 'tripoint-lead-status'

/** Below this share of Completed submissions with a Completed Lead, the day is reported. */
export const LEAD_COMPLETED_MIN_SHARE = 0.9

/**
 * Fewer Completed submissions than this and the share is not judged: a handful
 * of consumers still mid click through reads as a collapse. A day with none at
 * all is still reported, as its own line (L716).
 */
export const MIN_SUBMISSIONS_TO_JUDGE = 20

/** The day the Submission to Lead copy stopped, where the backlog count starts. */
export const SYNC_BROKE_ON = '2026-07-08'

export const TRIPOINT_LEAD_STATUS_REMEDY: AlertRemedy = {
  consequence:
    'Main Flow Tripoint sales read Completed on their Salesforce Submission__c but not on their Lead, so ' +
    'Lead.ExternalRevenue__c books $0 on them and anything built on the Lead under counts Tripoint revenue. ' +
    'Reporting that reads Submission__c is unaffected. The lines below give the counts:',
  fixHint:
    'This is fixed in Salesforce, not Bidspoke: either the Submission to Lead copy in Apex or the Tripoint ' +
    'submission workflow in Pipedream that marks the sale Completed (see GitHub issue #1525), then a backfill ' +
    'of the Leads left behind. A count that could not be read: check the Worker\'s Salesforce credentials. ' +
    'Run POST /api/admin/tripoint-lead-status-check for the current answer.',
  headlineVerb: 'has findings',
  itemNoun: { one: 'finding', many: 'findings' },
}

const TRIPOINT_SALE =
  "External_Partner_Name__c = 'Tripoint' AND Tripoint_Response__c = 'Success' AND External_Exchange_Status__c = 'Completed'"

/** The three COUNT() queries for the UTC day starting at `dayStart`. */
export function leadStatusQueries(dayStart: Date): { submissions: string; leads: string; backlog: string } {
  const from = isoSecond(dayStart)
  const to = isoSecond(new Date(dayStart.getTime() + 86_400_000))
  const day = `CreatedDate >= ${from} AND CreatedDate < ${to}`
  return {
    submissions: `SELECT COUNT() FROM Submission__c WHERE ${TRIPOINT_SALE} AND ${day}`,
    leads: `SELECT COUNT() FROM Submission__c WHERE ${TRIPOINT_SALE} AND Lead__r.External_Exchange_Status__c = 'Completed' AND ${day}`,
    backlog:
      `SELECT COUNT() FROM Submission__c WHERE ${TRIPOINT_SALE} ` +
      `AND Lead__r.External_Exchange_Status__c != 'Completed' AND CreatedDate >= ${SYNC_BROKE_ON}T00:00:00Z`,
  }
}

/** SOQL datetime literals take no fractional seconds. */
function isoSecond(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface LeadStatusDeps {
  /** Runs one COUNT() query. Injected so the check runs without Salesforce (L196). */
  count?: (soql: string) => Promise<number>
  now?: () => Date
}

export interface LeadStatusResult {
  /** The UTC day judged, YYYY-MM-DD. */
  day: string
  /** Null when the count could not be read. */
  submissions_completed: number | null
  leads_completed: number | null
  /** Completed submissions since SYNC_BROKE_ON whose Lead does not read Completed; null when unread. */
  backlog: number | null
  findings: string[]
  alerted: boolean
}

const fmt = (n: number) => n.toLocaleString('en-US')

async function tryCount(count: (soql: string) => Promise<number>, soql: string): Promise<{ n: number } | { err: string }> {
  try {
    return { n: await count(soql) }
  } catch (err) {
    return { err: formatErr(err) }
  }
}

/** NEVER THROWS: its caller is a `waitUntil`, where a rejection reaches nobody (L71). */
export async function checkTripointLeadStatus(
  env: Env,
  supabase: SupabaseClient,
  deps: LeadStatusDeps = {},
): Promise<LeadStatusResult> {
  const now = (deps.now ?? (() => new Date()))()
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  const day = dayStart.toISOString().slice(0, 10)
  const count = deps.count ?? ((soql: string) => salesforceCount(env, supabase, soql, 'the Tripoint Lead status check'))

  let result: Omit<LeadStatusResult, 'alerted'>
  try {
    result = await measure(count, dayStart, day)
  } catch (err) {
    const detail = `the Tripoint Lead status check itself failed: ${formatErr(err)}`
    result = { day, submissions_completed: null, leads_completed: null, backlog: null, findings: [detail] }
  }

  // AN EMPTY LIST IS STILL SENT: the alerter reads no findings as the recovery
  // signal and clears its standing alert with it.
  try {
    await notifyExportFailure(supabase, TRIPOINT_LEAD_STATUS_JOB, result.findings, env.IDEMPOTENCY, TRIPOINT_LEAD_STATUS_REMEDY)
  } catch (err) {
    console.error('[tripoint-lead-status] could not send its alert:', formatErr(err))
  }
  // Logged on every run, so a working check is visible rather than only heard
  // from when it complains.
  console.log(
    `[tripoint-lead-status] day=${day} submissions=${result.submissions_completed ?? 'unread'} ` +
      `leads=${result.leads_completed ?? 'unread'} backlog=${result.backlog ?? 'unread'} findings=${result.findings.length}`,
  )
  return { ...result, alerted: result.findings.length > 0 }
}

async function measure(
  count: (soql: string) => Promise<number>,
  dayStart: Date,
  day: string,
): Promise<Omit<LeadStatusResult, 'alerted'>> {
  const q = leadStatusQueries(dayStart)
  const [subs, leads, backlog] = await Promise.all([tryCount(count, q.submissions), tryCount(count, q.leads), tryCount(count, q.backlog)])
  const findings: string[] = []

  const submissions_completed = 'n' in subs ? subs.n : null
  const leads_completed = 'n' in leads ? leads.n : null
  const backlogN = 'n' in backlog ? backlog.n : null

  if ('err' in subs || 'err' in leads) {
    const why = 'err' in subs ? subs.err : (leads as { err: string }).err
    findings.push(`the Tripoint sales created on ${day} could not be counted in Salesforce, so the Leads were NOT compared: ${why}`)
  } else if (subs.n === 0) {
    findings.push(
      `no Tripoint submission created on ${day} reads Completed in Salesforce, so there was nothing to compare; ` +
        'Main Flow normally sells a few hundred a day to Tripoint',
    )
  } else if (subs.n >= MIN_SUBMISSIONS_TO_JUDGE && leads.n / subs.n < LEAD_COMPLETED_MIN_SHARE) {
    findings.push(
      `${fmt(leads.n)} of ${fmt(subs.n)} Tripoint sales created on ${day} have a Lead reading Completed ` +
        `(${Math.round((leads.n / subs.n) * 100)}%); before ${SYNC_BROKE_ON} this was 96 to 99%.` +
        (backlogN !== null ? ` ${fmt(backlogN)} Completed sales since ${SYNC_BROKE_ON} still have a Lead that does not.` : ''),
    )
  }

  if ('err' in backlog) {
    findings.push(`the backlog of Leads not reading Completed since ${SYNC_BROKE_ON} could not be counted: ${backlog.err}`)
  } else if (backlog.n > 0 && findings.length === 0) {
    // Only claim new sales carry over when the day was large enough to judge.
    const judged = submissions_completed !== null && submissions_completed >= MIN_SUBMISSIONS_TO_JUDGE
    findings.push(
      `${fmt(backlog.n)} Completed Tripoint sales since ${SYNC_BROKE_ON} still have a Lead that does not read Completed` +
        (judged ? `; sales created on ${day} are carrying over, so this is the backfill still to do` : ''),
    )
  }

  return { day, submissions_completed, leads_completed, backlog: backlogN, findings }
}
