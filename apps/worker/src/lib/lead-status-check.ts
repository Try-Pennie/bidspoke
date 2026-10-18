/**
 * Does each sale's Salesforce Lead carry the Completed its Submission carries,
 * per partner? Daily (#1524, widened to every partner for #1525).
 *
 * WHY. On 2026-07-08 Salesforce stopped copying `External_Exchange_Status__c =
 * Completed` from a `Submission__c` to its `Lead` (#1521, #1525), for every
 * partner. `Lead.ExternalRevenue__c` books 0 unless the Lead reads Completed, so
 * anything built on the Lead under counts. Pennie's reporting reads the
 * Submission, which stayed right, so this is two records disagreeing rather
 * than money missing. It went unseen for eleven weeks, and then hid a second
 * time behind a Tripoint only check: a Tripoint fix made Tripoint's number
 * healthy while AmOne and Engine stayed broken.
 *
 * WHAT IT MEASURES, PER PARTNER. For the UTC day before the run: of the
 * submissions created that day that read Completed, and whose Lead names the
 * same partner, how many have a Lead reading Completed. The same partner
 * condition matters: a consumer who came back and was sold elsewhere has a
 * Lead naming that later partner, and their newer sale is judged under it. It
 * also counts every such sale since the break whose Lead still disagrees,
 * which is what tells anyone a backfill has finished. Both counts go into the
 * alert, so the reader sees the divergence rather than a verdict (L11).
 *
 * A RETURNING CUSTOMER IS NOT BACKLOG. A Lead follows its customer's newest
 * Submission (`Lead.Submission_Object_ID__c`), so when a customer sold on
 * 08-18 comes back on 09-20 the Lead now carries the 09-20 visit's status and
 * no backfill of the 08-18 sale can change it. On 2026-09-29, 53 of Tripoint's
 * 56 backlog sales were that. SOQL cannot compare one field with another, so
 * the backlog is read as rows and split here: a sale whose Lead names it (or
 * names nothing) is left behind, one whose Lead names another Submission is
 * counted apart and never raises the alert on its own. Which visit's revenue
 * such a Lead should carry is a Salesforce decision (#1525).
 *
 * JUDGED ONLY WHERE A HEALTHY SHARE IS ON RECORD. In the week before the break
 * the share was 100.0% for Tripoint and 97.0% for AmOne, so both are judged
 * against LEAD_COMPLETED_MIN_SHARE. Engine was 21.9%, so there is no healthy
 * share to judge it by until someone establishes what an Engine Lead should
 * read; its counts are reported every run and a count that could not be read
 * is still a finding, but its share raises nothing.
 *
 * A PARTNER IT DOES NOT COVER IS A FINDING. The list below names Salesforce's
 * own partner values, which no Bidspoke table holds, so it cannot be derived;
 * instead every run asks Salesforce which partners had Completed sales that day
 * and names any the list lacks. A fixed list that nobody extends is how this
 * defect hid behind Tripoint (L96, L217).
 *
 * A COUNT THAT COULD NOT BE READ IS ITS OWN FINDING, never a zero, and a
 * judged partner with no Completed sale at all is reported rather than read as
 * agreement (L98, L215).
 *
 * BUT NOT WHEN A CLICK BUYER WAS SENT NOTHING TO SELL (#1767, #2395). A buyer
 * sold on the click sells when a consumer clicks, so its zero is judged against
 * the clicks Bidspoke delivered to it: the non test buyer_click_send steps that
 * answered sent for its partner id. None delivered and none in Salesforce is
 * agreement and reports nothing; any delivered beside a zero is reported with
 * the delivered count. Its buyer profile's operating hours are NOT the test any
 * more (#1767 used them): they gate the offer, not the click (decided
 * 2026-09-24), so a click lands outside them, and the UTC day judged spans two
 * Eastern dates. On 2026-10-18 that paged on Oct 17 UTC, which opens at 8 PM
 * Friday Eastern inside Liberty1's hours, while Bidspoke had delivered no
 * Liberty1 click that day either.
 *
 * WHICH DAY THE CLICKS ARE COUNTED OVER. The click's own UTC day (the step's
 * started_at, which is also the partition key, so the read touches one day's
 * partition), not the day its Submission was created, which Salesforce is
 * keyed on and execution_steps does not hold. Nearly every click follows its
 * Submission by about a minute, so the two days agree: Oct 12 to 17 they were
 * 41 and 41, 43 and 44, 14 and 14, 24 and 24, 16 and 17, and 0 and 0
 * (Salesforce first). The gap is a click landing on a later day than its
 * Submission, as one did on Oct 16 for a Submission created Oct 1. Such a click
 * counts on the day it landed, so on a day with no Submission of its own it
 * raises the zero line; that errs toward reporting (L42). The other way round,
 * a Submission clicked only on a later day whose sale Salesforce then failed
 * to record reads here as agreement (none on either side for its day); the
 * click reconcile (click-path-checks.ts) matches every counted click to a
 * Completed record by the click's own stamp, so it is found there. Comparing
 * a nonzero Completed count with the delivered count is that reconcile's job,
 * record by record, so it is not repeated here.
 *
 * A buyer sold on offers keeps the old rule, because the older Tripoint ping
 * sells it without reading its profile; so does a partner with no enabled
 * profile. The profile maps to the Salesforce partner by partner_configs.name,
 * the value Salesforce records as the partner, and its partner id is the one
 * the clicks are counted for. Profiles that cannot be read, two profiles with
 * one name, or a delivered count that cannot be read are each their own
 * finding, never a pass or a zero (L98). The profiles are read, and the clicks
 * counted, only when a judged partner had no sales.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { judgeCopyAge } from './stored-copy-age'
import { CLICK_CHECK_LAST_GOOD_MAX_AGE_MS } from '@bidspoke/buyer-profile'
import { describeReadError, formatErr } from './format-error'
import { notifyExportFailure, type TitledRemedy } from './export-alerts'
import { loadBuyerProfiles, type BuyerProfilesSnapshot } from './buyer-profile-loader'
import { resolveSalesforceCredentialOrg } from './salesforce-creds'
import { salesforceCount, salesforceGet, salesforceRows } from './salesforce-read'
import { leadNamesAnotherSubmission } from './returning-customer'
import type { Env } from '../index'

export const LEAD_STATUS_JOB = 'lead-status'

/** Below this share of Completed sales with a Completed Lead, a judged partner's day is reported. */
export const LEAD_COMPLETED_MIN_SHARE = 0.9

/**
 * Fewer Completed sales than this and the share is not judged: a handful of
 * consumers still mid click through reads as a collapse. A judged partner with
 * none at all is still reported, as its own line (L716).
 */
export const MIN_SUBMISSIONS_TO_JUDGE = 20

/**
 * The most backlog rows one partner's read will page through. The largest real
 * backlog was about 25,000 (Tripoint, Jul 8 to Sep 24); past this the backlog is
 * refused rather than split on part of it.
 */
export const BACKLOG_MAX_ROWS = 50_000

/**
 * A sale touched this recently is left to the next run (#2019). The Lead write
 * follows the Submission write: on 2026-10-13 Sub-003007872's Submission read
 * Completed at 13:01:20 UTC, its Lead at 13:01:21, and the check reading it at
 * 13:01:21 counted it as left behind. That one second is the only gap on record:
 * a Lead keeps no field history, and its last modified time is a person's later
 * edit on 1,492 of 1,500 recent Tripoint sales (measured 2026-10-13), so the gap
 * cannot be read off the Lead. Fifteen minutes is far wider than one second on
 * purpose: a sale held back is counted by the next day's run, so too wide only
 * delays a line, while too narrow sends a phantom (L648).
 */
export const BACKLOG_GRACE_MS = 15 * 60_000

/** The most waiting sale ids one partner's log line names, so a large backlog cannot flood the log. */
export const LOGGED_IDS_MAX = 20

/** The day the Submission to Lead copy stopped, where the backlog count starts. */
export const SYNC_BROKE_ON = '2026-07-08'

/**
 * Every partner a Lead is sold to, by the value both `External_Partner_Name__c`
 * on the Submission and `ExternalPartnerName__c` on the Lead carry. `before`
 * is the healthy share, measured 2026-06-30 to 07-06 for the partners sold to
 * before the break, quoted in the alert as what normally happens.
 */
export const LEAD_STATUS_PARTNERS: ReadonlyArray<{ partner: string; judged: boolean; before: string; buyerAnswers?: boolean }> = [
  // Tripoint's answer to each sale is on the Submission (#1837), so its waiting
  // sales are told apart by it. No other partner's is.
  { partner: 'Tripoint', judged: true, before: '100%', buyerAnswers: true },
  { partner: 'AmOne', judged: true, before: '97%' },
  { partner: 'Engine', judged: false, before: '22%' },
  // Went live 2026-09-30, after the break, so its healthy share is the one
  // measured at launch: 43 of 43 that day.
  { partner: 'Liberty1', judged: true, before: '100%' },
]

/**
 * The alert, in plain sentences (Dan, 2026-10-01). Three titles, because each
 * case needs a different thing done: older sales whose Lead was left behind are
 * checked one by one, a day whose new sales did not sync needs the Salesforce
 * copy fixed, and a count the check could not take says nothing either way.
 */
const LEAD_STATUS_CONTEXT = 'Until a Lead says Completed, its External Revenue shows $0 for that sale.'

export const LEAD_STATUS_BACKLOG_REMEDY: TitledRemedy = {
  title: "Some sales aren't showing on their Salesforce Lead",
  context: LEAD_STATUS_CONTEXT,
  fixHint:
    "Check whether each one is a real sale. If it is, set the Lead's External Exchange Status to Completed " +
    "in Salesforce. If it isn't, set the Submission back.",
}

/**
 * The backlog fix when every waiting line says what the buyer answered (#1837).
 * Only then: an AmOne or Liberty1 line carries no answer, so this hint beside it
 * would point at something the reader cannot see.
 */
export const LEAD_STATUS_ANSWERED_BACKLOG_REMEDY: TitledRemedy = {
  title: LEAD_STATUS_BACKLOG_REMEDY.title,
  context: LEAD_STATUS_CONTEXT,
  fixHint:
    "Set the Lead's External Exchange Status to Completed in Salesforce only for a sale the buyer accepted. " +
    'Set the Submission back for one the buyer refused. Where no answer is on record, check the sale with the buyer first.',
}

export const LEAD_STATUS_BROKEN_REMEDY: TitledRemedy = {
  title: "New sales aren't reaching their Salesforce Lead",
  context: LEAD_STATUS_CONTEXT,
  fixHint:
    'Salesforce has stopped copying Completed from the Submission to the Lead for this partner. That copy needs ' +
    'fixing in Salesforce, and then the older sales need a backfill.',
}

export const LEAD_STATUS_UNCHECKED_REMEDY: TitledRemedy = {
  title: "The Lead status check couldn't check everything",
}

type FindingKind = 'backlog' | 'broken' | 'unchecked'
interface Finding {
  kind: FindingKind
  text: string
  /**
   * What the finding is about, for the alerter to tell a reminder from a new
   * problem (#1768): the partner and what is wrong, never the day judged or a
   * count, which move every run. A backlog also names the days of the sales it
   * lists, so a different set of waiting sales is a new problem while the same
   * span being worked through is not.
   */
  key: string
  /** Set on a judged partner's no sales line, which stands unless the partner is a click buyer Bidspoke delivered no click to that day. */
  zeroFor?: string
  /** Set on a backlog line that says what the buyer answered for each sale (#1837). */
  answered?: boolean
  /** The Salesforce partner a broken or backlog line is about, so the fix can name it (#835). */
  partner?: string
}

const andList = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * The broken page's fix, naming each partner with its own fix (#835). A broken
 * day can share a page with another partner's backlog, and "this partner ...
 * the older sales need a backfill" then read as the fix for both.
 */
function brokenFix(findings: Finding[]): string {
  const broken = [...new Set(findings.filter((f) => f.kind === 'broken' && f.partner).map((f) => f.partner as string))]
  const parts = [
    `Salesforce has stopped copying Completed from the Submission to the Lead for ${andList(broken)}. That copy needs fixing in ` +
      `Salesforce, and then the older ${andList(broken)} sales need a backfill.`,
  ]
  for (const f of findings) {
    if (f.kind !== 'backlog' || !f.partner) continue
    const fix = (f.answered ? LEAD_STATUS_ANSWERED_BACKLOG_REMEDY : LEAD_STATUS_BACKLOG_REMEDY).fixHint ?? ''
    parts.push(`For ${f.partner}: ${fix}`)
  }
  return parts.join(' ')
}

/** The broken title outranks the backlog one, which outranks a check that could not run. */
function remedyFor(findings: Finding[]): TitledRemedy {
  if (findings.some((f) => f.kind === 'broken')) return { ...LEAD_STATUS_BROKEN_REMEDY, fixHint: brokenFix(findings) }
  const backlogs = findings.filter((f) => f.kind === 'backlog')
  if (backlogs.length) return backlogs.every((f) => f.answered) ? LEAD_STATUS_ANSWERED_BACKLOG_REMEDY : LEAD_STATUS_BACKLOG_REMEDY
  return LEAD_STATUS_UNCHECKED_REMEDY
}

/** A day as the alert says it, "Sep 24", from a UTC instant or a YYYY-MM-DD day. */
function shortDay(isoOrDay: string): string | null {
  const d = new Date(isoOrDay.length === 10 ? `${isoOrDay}T00:00:00Z` : isoOrDay.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d)
}

/**
 * The two COUNT() queries and the backlog row query for one partner and the UTC
 * day starting at `dayStart`. The backlog leaves out a sale touched within
 * BACKLOG_GRACE_MS of `now`, whose Lead write may still be on its way (#2019).
 */
export function leadStatusQueries(partner: string, dayStart: Date, now: Date): { submissions: string; leads: string; backlog: string } {
  const sale =
    `External_Partner_Name__c = '${partner}' AND External_Exchange_Status__c = 'Completed' ` +
    `AND Lead__r.ExternalPartnerName__c = '${partner}'`
  const from = isoSecond(dayStart)
  const to = isoSecond(new Date(dayStart.getTime() + 86_400_000))
  const day = `CreatedDate >= ${from} AND CreatedDate < ${to}`
  return {
    submissions: `SELECT COUNT() FROM Submission__c WHERE ${sale} AND ${day}`,
    leads: `SELECT COUNT() FROM Submission__c WHERE ${sale} AND Lead__r.External_Exchange_Status__c = 'Completed' AND ${day}`,
    backlog:
      `SELECT Id, CreatedDate, Tripoint_Response__c, Tripoint_Submit_Response__c, Lead__r.Submission_Object_ID__c, ` +
      `Lead__r.External_Exchange_Status__c FROM Submission__c WHERE ${sale} ` +
      `AND Lead__r.External_Exchange_Status__c != 'Completed' AND CreatedDate >= ${SYNC_BROKE_ON}T00:00:00Z ` +
      `AND LastModifiedDate < ${isoSecond(new Date(now.getTime() - BACKLOG_GRACE_MS))}`,
  }
}

/** SOQL datetime literals take no fractional seconds. */
function isoSecond(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface LeadStatusDeps {
  /** Runs one COUNT() query. Injected so the check runs without Salesforce (L196). */
  count?: (soql: string) => Promise<number>
  /** Runs one row query, every page. Injected likewise. */
  rows?: (soql: string) => Promise<Array<Record<string, unknown>>>
  /** Every partner value with Completed sales created in the UTC day starting at `dayStart`. Injected likewise. */
  listPartners?: (dayStart: Date) => Promise<Array<{ partner: string | null; n: number }>>
  /** The enabled buyer profiles of the org whose Salesforce this reads. Injected likewise. */
  loadProfiles?: () => Promise<BuyerProfilesSnapshot>
  /**
   * How many clicks Bidspoke delivered to the buyer with this partner id in the
   * UTC day starting at `dayStart` (#2395). Injected likewise. Throws when it
   * cannot count, which is never read as none.
   */
  countDeliveredClicks?: (partnerId: string, dayStart: Date) => Promise<number>
  now?: () => Date
}

export interface PartnerLeadStatus {
  partner: string
  judged: boolean
  /** Null when the count could not be read. */
  submissions_completed: number | null
  leads_completed: number | null
  /** Completed sales since SYNC_BROKE_ON whose Lead does not read Completed and still names that sale; null when unread. */
  backlog: number | null
  /** The same, where the Lead has moved on to a later Submission, so no backfill can change it; null when unread. */
  backlog_returning: number | null
  /** The first LOGGED_IDS_MAX of the waiting sales' ids, logged so a counted sale can be looked up afterwards (#2019). */
  waiting_ids: string[]
  /** True when it is sold on the click, had no Completed sales, and Bidspoke delivered it no click that day, so the zero was not reported. */
  no_clicks_delivered: boolean
}

export interface LeadStatusResult {
  /** The UTC day judged, YYYY-MM-DD. */
  day: string
  partners: PartnerLeadStatus[]
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
export async function checkLeadStatus(env: Env, supabase: SupabaseClient, deps: LeadStatusDeps = {}): Promise<LeadStatusResult> {
  const now = (deps.now ?? (() => new Date()))()
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  const day = dayStart.toISOString().slice(0, 10)
  const count = deps.count ?? ((soql: string) => salesforceCount(env, supabase, soql, 'the Lead status check'))
  const rows = deps.rows ?? ((soql: string) => salesforceRows(env, supabase, soql, 'the Lead status check', BACKLOG_MAX_ROWS))
  const listPartners = deps.listPartners ?? salesforcePartnerLister(env, supabase)
  const loadProfiles = deps.loadProfiles ?? salesforceOrgBuyerProfiles(env, supabase)
  const countDeliveredClicks = deps.countDeliveredClicks ?? deliveredClickCounter(supabase)

  let partners: PartnerLeadStatus[] = []
  let found: Finding[]
  try {
    const measured = await Promise.all(LEAD_STATUS_PARTNERS.map((p) => measure(count, rows, p, dayStart, day, now)))
    partners = measured.map((m) => m.status)
    const judged = await judgeZeroDays(measured.flatMap((m) => m.findings), partners, loadProfiles, countDeliveredClicks, dayStart, now)
    found = [...judged, ...(await uncoveredPartners(listPartners, dayStart, day))]
  } catch (err) {
    found = [{ kind: 'unchecked', text: `The check itself failed: ${formatErr(err)}`, key: 'check-failed' }]
  }
  const findings = found.map((f) => f.text)

  // AN EMPTY LIST IS STILL SENT: the alerter reads no findings as the recovery
  // signal and clears its standing alert with it.
  try {
    await notifyExportFailure(supabase, LEAD_STATUS_JOB, findings, env.IDEMPOTENCY, remedyFor(found), undefined, { keys: found.map((f) => f.key) })
  } catch (err) {
    console.error('[lead-status] could not send its alert:', formatErr(err))
  }
  // Logged on every run, Engine included, so a working check and the unjudged
  // partner's numbers are visible rather than only heard from on a complaint.
  const unread = (n: number | null) => (n === null ? 'unread' : String(n))
  const notReported = partners
    .filter((p) => p.no_clicks_delivered)
    .map((p) => ` not reported: ${p.partner} had no Completed sales and Bidspoke delivered no ${p.partner} clicks that day.`)
    .join('')
  console.log(
    `[lead-status] day=${day} ` +
      partners
        .map(
          (p) =>
            `${p.partner}=${unread(p.leads_completed)}/${unread(p.submissions_completed)} backlog=${unread(p.backlog)} returning=${unread(p.backlog_returning)}` +
            (p.waiting_ids.length ? ` ${p.partner} waiting=${p.waiting_ids.join(',')}` : ''),
        )
        .join(' ') +
      ` findings=${findings.length}${notReported}`,
  )
  return { day, partners, findings, alerted: findings.length > 0 }
}

/** A Salesforce id, 15 or 18 characters; the first 15 are the record. */
const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/

export interface BacklogSplit {
  own: number
  returning: number
  /** The earliest and latest CreatedDate among the sales left behind, when Salesforce sent them. */
  ownFirst?: string
  ownLast?: string
  /** What the left behind sales' Leads say instead, in first seen order. */
  ownLeadStatuses: string[]
  /** The left behind sales' ids, the first LOGGED_IDS_MAX of them. */
  ownIds: string[]
  /** The left behind sales by what the buyer answered on the Submission (#1837). */
  ownAnswers: { accepted: number; refused: number; none: number }
}

/**
 * What Tripoint answered for a sale, from its Submission (#1837). Measured on the
 * 30,978 Completed Tripoint sales of the 30 days to 2026-10-13: the submit
 * response is 200 or 208, or absent; the response is Success, Duplicate, Fail, or
 * absent. A refusal on either field wins over an accepted code on the other, so
 * revenue is never booked on a refused lead. Neither field set is NOT "never
 * submitted": 1,195 such sales were real, most with a Completed Lead, sold by a
 * route that does not record Tripoint's answer. So it is "no answer on record".
 */
export function buyerAnswer(row: Record<string, unknown>): 'accepted' | 'refused' | 'none' {
  const response = typeof row.Tripoint_Response__c === 'string' ? row.Tripoint_Response__c.trim() : ''
  const submit = typeof row.Tripoint_Submit_Response__c === 'string' ? row.Tripoint_Submit_Response__c.trim() : ''
  const submitAccepted = submit === '200' || submit === '208'
  if (response === 'Duplicate' || response === 'Fail' || (submit !== '' && !submitAccepted)) return 'refused'
  if (submitAccepted || response === 'Success') return 'accepted'
  return 'none'
}

/**
 * Splits backlog rows into sales whose Lead still names them (left behind) and
 * sales whose Lead names a later Submission (a returning customer). A Lead
 * naming nothing counts as left behind: nothing shows it moved on. Throws on a
 * row with no readable id, so a changed answer is a refusal, never a smaller
 * backlog (L90).
 */
export function splitBacklog(records: Array<Record<string, unknown>>): BacklogSplit {
  let own = 0
  let returning = 0
  let ownFirst: string | undefined
  let ownLast: string | undefined
  const statuses: string[] = []
  const ids: string[] = []
  const answers = { accepted: 0, refused: 0, none: 0 }
  for (const r of records) {
    if (typeof r.Id !== 'string' || !SALESFORCE_ID.test(r.Id)) {
      throw new Error(`Salesforce returned a backlog row with no readable Id: ${JSON.stringify(r).slice(0, 200)}`)
    }
    const lead = r.Lead__r
    const current = lead !== null && typeof lead === 'object' ? (lead as Record<string, unknown>).Submission_Object_ID__c : null
    if (!leadNamesAnotherSubmission(current, r.Id)) {
      own++
      if (ids.length < LOGGED_IDS_MAX) ids.push(r.Id)
      answers[buyerAnswer(r)]++
      const created = r.CreatedDate
      if (typeof created === 'string' && !Number.isNaN(Date.parse(created.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')))) {
        if (ownFirst === undefined || created < ownFirst) ownFirst = created
        if (ownLast === undefined || created > ownLast) ownLast = created
      }
      const said = lead !== null && typeof lead === 'object' ? (lead as Record<string, unknown>).External_Exchange_Status__c : null
      if (typeof said === 'string' && said !== '' && !statuses.includes(said)) statuses.push(said)
    } else returning++
  }
  return { own, returning, ownFirst, ownLast, ownLeadStatuses: statuses, ownIds: ids, ownAnswers: answers }
}

async function tryBacklog(
  rows: (soql: string) => Promise<Array<Record<string, unknown>>>,
  soql: string,
): Promise<BacklogSplit | { err: string }> {
  try {
    return splitBacklog(await rows(soql))
  } catch (err) {
    return { err: formatErr(err) }
  }
}

async function measure(
  count: (soql: string) => Promise<number>,
  rows: (soql: string) => Promise<Array<Record<string, unknown>>>,
  rule: { partner: string; judged: boolean; before: string; buyerAnswers?: boolean },
  dayStart: Date,
  day: string,
  now: Date,
): Promise<{ status: PartnerLeadStatus; findings: Finding[] }> {
  const { partner, judged, before } = rule
  const q = leadStatusQueries(partner, dayStart, now)
  const [subs, leads, backlog] = await Promise.all([tryCount(count, q.submissions), tryCount(count, q.leads), tryBacklog(rows, q.backlog)])
  const findings: Finding[] = []
  const on = shortDay(day) ?? day

  const status: PartnerLeadStatus = {
    partner,
    judged,
    submissions_completed: 'n' in subs ? subs.n : null,
    leads_completed: 'n' in leads ? leads.n : null,
    backlog: 'err' in backlog ? null : backlog.own,
    backlog_returning: 'err' in backlog ? null : backlog.returning,
    waiting_ids: 'err' in backlog ? [] : backlog.ownIds,
    no_clicks_delivered: false,
  }

  // A count that could not be read is a refusal for every partner, judged or
  // not: the check did not measure what it reports.
  if ('err' in subs || 'err' in leads) {
    const why = 'err' in subs ? subs.err : (leads as { err: string }).err
    findings.push({ kind: 'unchecked', text: `The check couldn't count ${partner} sales in Salesforce: ${why}`, key: `uncounted:${partner}` })
  } else if (judged && subs.n === 0) {
    // judgeZeroDays decides whether this stands, from the buyer profile and the clicks Bidspoke delivered that day.
    findings.push({ kind: 'unchecked', text: `${noSales(partner, on)}, so there was nothing to compare.`, zeroFor: partner, key: `zero:${partner}` })
  } else if (judged && subs.n >= MIN_SUBMISSIONS_TO_JUDGE && leads.n / subs.n < LEAD_COMPLETED_MIN_SHARE) {
    const older = status.backlog ? ` ${fmt(status.backlog)} older ${partner} sales are also waiting.` : ''
    findings.push({
      kind: 'broken',
      text:
        `Only ${fmt(leads.n)} of ${fmt(subs.n)} ${partner} sales on ${on} reached their Lead ` +
        `(${Math.round((leads.n / subs.n) * 100)}%). Normally ${before} do, so new sales aren't syncing.${older}`,
      key: `broken:${partner}`,
      partner,
    })
  }

  if ('err' in backlog) {
    findings.push({ kind: 'unchecked', text: `The check couldn't count older ${partner} sales waiting on their Lead: ${backlog.err}`, key: `backlog-uncounted:${partner}` })
  } else if (judged && backlog.own > 0 && !findings.some((f) => f.kind === 'broken')) {
    const answered = rule.buyerAnswers === true
    findings.push({ kind: 'backlog', text: describeBacklog(partner, backlog, answered), key: backlogKey(partner, backlog), answered, partner })
  }

  return { status, findings }
}

const noSales = (partner: string, on: string) => `Salesforce has no Completed ${partner} sales from ${on}`

type ProfileRead = { snapshot: BuyerProfilesSnapshot } | { err: string }

/**
 * Keeps a judged partner's no sales line only where it means something
 * (#1767, #2395): it is dropped for a click buyer Bidspoke delivered no click
 * that day, marking that partner no_clicks_delivered, and names the delivered
 * count when there were some. The profiles are read once, and only when there
 * is a line to decide. Every other finding passes through in its place.
 */
async function judgeZeroDays(
  findings: Finding[],
  partners: PartnerLeadStatus[],
  loadProfiles: () => Promise<BuyerProfilesSnapshot>,
  countDeliveredClicks: (partnerId: string, dayStart: Date) => Promise<number>,
  dayStart: Date,
  now: Date,
): Promise<Finding[]> {
  if (!findings.some((f) => f.zeroFor)) return findings
  const read = await readProfiles(loadProfiles, now)
  const on = shortDay(dayStart.toISOString().slice(0, 10)) ?? dayStart.toISOString().slice(0, 10)
  const kept: Finding[] = []
  for (const f of findings) {
    if (!f.zeroFor) {
      kept.push(f)
      continue
    }
    // Its own failure boundary (L73): a profile that cannot be judged names
    // that partner, and every other partner's findings still go out, rather
    // than the whole run collapsing into one "check itself failed" line.
    let verdict: Finding | 'none_delivered' | null
    try {
      verdict = await zeroDayVerdict(f, read, countDeliveredClicks, dayStart, on)
    } catch (err) {
      verdict = {
        kind: 'unchecked',
        text: `${noSales(f.zeroFor, on)}, and the check couldn't judge ${f.zeroFor}'s buyer profile: ${formatErr(err)}`,
        key: `zero-profile-unjudged:${f.zeroFor}`,
      }
    }
    if (verdict === 'none_delivered') {
      const status = partners.find((p) => p.partner === f.zeroFor)
      if (status) status.no_clicks_delivered = true
    } else kept.push(verdict ?? f)
  }
  return kept
}

/** The profiles, or why they cannot be trusted: a failed read, or a last good copy older than the click check would offer from. */
async function readProfiles(loadProfiles: () => Promise<BuyerProfilesSnapshot>, now: Date): Promise<ProfileRead> {
  let snapshot: BuyerProfilesSnapshot
  try {
    snapshot = await loadProfiles()
  } catch (err) {
    return { err: formatErr(err) }
  }
  if (snapshot.served_from === 'last_good') {
    const verdict = judgeCopyAge(snapshot.loaded_at, now.getTime(), CLICK_CHECK_LAST_GOOD_MAX_AGE_MS)
    if (!verdict.usable) {
      const age = verdict.reason === 'copy_too_old' && verdict.ageMs !== null ? `${Math.round(verdict.ageMs / 60_000)} minutes old` : `of unknown age (${snapshot.loaded_at})`
      return { err: `the database read failed and the saved copy is ${age}.` }
    }
  }
  return { snapshot }
}

/**
 * For one judged partner's no sales line: 'none_delivered' when it is a click
 * buyer Bidspoke delivered no click that day, null when the plain line stands
 * (no enabled profile, or sold on offers), or the finding that replaces it:
 * the line with the delivered count, or why the check could not tell.
 */
async function zeroDayVerdict(
  line: Finding,
  read: ProfileRead,
  countDeliveredClicks: (partnerId: string, dayStart: Date) => Promise<number>,
  dayStart: Date,
  on: string,
): Promise<Finding | 'none_delivered' | null> {
  const partner = line.zeroFor as string
  const lead = noSales(partner, on)
  if ('err' in read) {
    return {
      kind: 'unchecked',
      text: `${lead}, and the check couldn't read the buyer profiles to tell whether ${partner} is sold on the click: ${read.err}`,
      key: `zero-profiles-unread:${partner}`,
    }
  }
  // partner_configs.name is the value Salesforce records as the partner.
  const named = read.snapshot.buyers.filter((b) => b.partner.name === partner)
  if (named.length > 1) {
    return {
      kind: 'unchecked',
      text: `${lead}, and ${named.length} buyer profiles are named ${partner}, so the check couldn't tell whose clicks to count.`,
      key: `zero-profiles-ambiguous:${partner}`,
    }
  }
  // No enabled profile, or one sold on offers that the older Tripoint ping also
  // sells without reading it: nothing here says whether this partner was sent
  // anything to sell, so the plain line stands.
  if (named.length === 0 || named[0].profile.soldOn !== 'click') return null
  let delivered: number
  try {
    delivered = await countDeliveredClicks(named[0].partner.id, dayStart)
  } catch (err) {
    return {
      kind: 'unchecked',
      text: `${lead}, and the check couldn't count the ${partner} clicks Bidspoke delivered that day: ${formatErr(err)}`,
      key: `zero-delivered-uncounted:${partner}`,
    }
  }
  if (delivered === 0) return 'none_delivered'
  const clicks = delivered === 1 ? `1 ${partner} click` : `${fmt(delivered)} ${partner} clicks`
  // The same key as the plain line: it is the same problem, now with its count.
  return { ...line, text: `${lead}, but Bidspoke delivered ${clicks} that day, so there was nothing to compare.` }
}

/**
 * The real profile reader: the enabled buyer profiles through the one loader the
 * click check uses, for the organization that holds the Salesforce credentials,
 * which is the one whose Salesforce this check reads.
 */
export function salesforceOrgBuyerProfiles(env: Env, supabase: SupabaseClient): () => Promise<BuyerProfilesSnapshot> {
  return async () => {
    const { orgId, error } = await resolveSalesforceCredentialOrg(supabase)
    if (!orgId) throw new Error(error ?? 'no_org_holds_salesforce_credentials')
    return loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase)
  }
}

/**
 * "3 Tripoint sales from Sep 21 to Sep 28 are marked Completed on their
 * Submission, but their Lead still says Pending or Fail." Returning customers
 * are left out: no backfill changes them, so the number is nothing to act on.
 */
function describeBacklog(partner: string, b: BacklogSplit, withAnswers: boolean): string {
  const one = b.own === 1
  const first = b.ownFirst ? shortDay(b.ownFirst) : null
  const last = b.ownLast ? shortDay(b.ownLast) : null
  const when = first && last ? (first === last ? ` from ${first}` : ` from ${first} to ${last}`) : ''
  const says = b.ownLeadStatuses.length ? b.ownLeadStatuses.join(' or ') : 'something else'
  const line = one
    ? `1 ${partner} sale${when} is marked Completed on its Submission, but its Lead still says ${says}.`
    : `${fmt(b.own)} ${partner} sales${when} are marked Completed on their Submission, but their Lead still says ${says}.`
  return withAnswers ? `${line} ${describeAnswers(partner, b)}` : line
}

/** Which waiting sales the buyer accepted, refused, or has no answer on record for (#1837). */
function describeAnswers(partner: string, b: BacklogSplit): string {
  const { accepted, refused, none } = b.ownAnswers
  const all = b.own === 1 ? 'it' : b.own === 2 ? 'both' : `all ${fmt(b.own)}`
  if (accepted === b.own) return `${partner} accepted ${all}.`
  if (refused === b.own) return `${partner} refused ${all}.`
  if (none === b.own) return `${partner} has no answer on record for ${b.own === 1 ? 'it' : 'any of them'}.`
  const parts = [
    accepted ? `accepted ${fmt(accepted)}` : null,
    refused ? `refused ${fmt(refused)}` : null,
    none ? `has no answer on record for ${fmt(none)}` : null,
  ].filter((p): p is string => p !== null)
  return `${partner} ${new Intl.ListFormat('en', { type: 'conjunction' }).format(parts)}.`
}

/** A backlog's key: its partner and the days of the first and last waiting sale, the same days its line names. */
function backlogKey(partner: string, b: BacklogSplit): string {
  const first = b.ownFirst ? shortDay(b.ownFirst) : null
  const last = b.ownLast ? shortDay(b.ownLast) : null
  return `backlog:${partner}:${first ?? 'unknown'}..${last ?? 'unknown'}`
}

/**
 * A line for every partner Salesforce sold to that day which this check does
 * not cover. A sale with no partner is skipped: its Lead has no partner to
 * compare, so there is nothing this check could judge.
 */
async function uncoveredPartners(
  listPartners: (dayStart: Date) => Promise<Array<{ partner: string | null; n: number }>>,
  dayStart: Date,
  day: string,
): Promise<Finding[]> {
  const on = shortDay(day) ?? day
  let sold: Array<{ partner: string | null; n: number }>
  try {
    sold = await listPartners(dayStart)
  } catch (err) {
    return [{
      kind: 'unchecked',
      text: `The check couldn't list which partners had sales on ${on}, so a new partner would go unnoticed: ${formatErr(err)}`,
      key: 'partners-unlisted',
    }]
  }
  const covered = new Set(LEAD_STATUS_PARTNERS.map((p) => p.partner))
  return sold
    .filter((s): s is { partner: string; n: number } => s.partner !== null && s.partner !== '' && !covered.has(s.partner))
    .map((s) => ({
      kind: 'unchecked' as const,
      text: `Salesforce had ${fmt(s.n)} ${s.partner} sales on ${on}, but this check doesn't cover ${s.partner} yet, so their Leads weren't checked.`,
      key: `uncovered:${s.partner}`,
    }))
}

/** The real lister: one aggregate query over the day, through the shared Salesforce read. */
export function salesforcePartnerLister(
  env: Env,
  supabase: SupabaseClient,
): (dayStart: Date) => Promise<Array<{ partner: string | null; n: number }>> {
  return async (dayStart) => {
    const from = isoSecond(dayStart)
    const to = isoSecond(new Date(dayStart.getTime() + 86_400_000))
    const soql =
      `SELECT External_Partner_Name__c, COUNT(Id) n FROM Submission__c WHERE External_Exchange_Status__c = 'Completed' ` +
      `AND Lead__c != null AND CreatedDate >= ${from} AND CreatedDate < ${to} GROUP BY External_Partner_Name__c`
    const body = await salesforceGet<{ records?: Array<{ External_Partner_Name__c?: unknown; n?: unknown }> }>(
      env,
      supabase,
      `query?q=${encodeURIComponent(soql)}`,
      'the Lead status check',
    )
    if (!Array.isArray(body.records)) throw new Error('Salesforce answered the partner listing with no records array')
    return body.records.map((r) => ({
      partner: typeof r.External_Partner_Name__c === 'string' ? r.External_Partner_Name__c : null,
      n: typeof r.n === 'number' ? r.n : 0,
    }))
  }
}

/**
 * The real delivered click reader (#2395): a count, never rows, of the non test
 * buyer_click_send steps that answered sent for this buyer and started inside
 * the UTC day. started_at is execution_steps' partition key, so the read
 * touches that one day's partition. No index leads with step_type for these
 * rows, so it scans that partition: 4.7 s for Oct 16's 1.1 million rows,
 * measured 2026-10-18, against the 30 s statement limit, and it runs only on a
 * day a click buyer had no sales. It is not narrowed to the workflows a
 * definition names today, because a workflow edited or switched off since
 * would hide clicks it delivered that day. A HEAD count carries no error body,
 * so the status is named, and an answer with no count is refused (L90).
 */
export function deliveredClickCounter(supabase: SupabaseClient): (partnerId: string, dayStart: Date) => Promise<number> {
  return async (partnerId, dayStart) => {
    const { count, error, status, statusText } = (await supabase
      .from('execution_steps')
      .select('id', { count: 'exact', head: true })
      .eq('step_type', 'buyer_click_send')
      .eq('is_test', false)
      .eq('output->>reason', 'sent')
      .eq('output->>partner_id', partnerId)
      .gte('started_at', dayStart.toISOString())
      .lt('started_at', new Date(dayStart.getTime() + 86_400_000).toISOString())) as unknown as {
      count: number | null
      error: unknown
      status?: number
      statusText?: string
    }
    if (error) throw new Error(`execution_steps count failed: ${describeReadError(error, status, statusText)}`)
    if (typeof count !== 'number') throw new Error('execution_steps answered the delivered click count with no count')
    return count
  }
}
