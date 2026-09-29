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
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { salesforceCount, salesforceGet, salesforceRows } from './salesforce-read'
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

/** The day the Submission to Lead copy stopped, where the backlog count starts. */
export const SYNC_BROKE_ON = '2026-07-08'

/**
 * Every partner a Lead is sold to, by the value both `External_Partner_Name__c`
 * on the Submission and `ExternalPartnerName__c` on the Lead carry. `before`
 * is the share measured 2026-06-30 to 07-06, quoted in the alert.
 */
export const LEAD_STATUS_PARTNERS: ReadonlyArray<{ partner: string; judged: boolean; before: string }> = [
  { partner: 'Tripoint', judged: true, before: '100%' },
  { partner: 'AmOne', judged: true, before: '97%' },
  { partner: 'Engine', judged: false, before: '22%' },
]

export const LEAD_STATUS_REMEDY: AlertRemedy = {
  consequence:
    'Sales read Completed on their Salesforce Submission__c but not on their Lead, so Lead.ExternalRevenue__c ' +
    'books $0 on them and anything built on the Lead under counts that partner. Reporting that reads ' +
    'Submission__c is unaffected. Each line names the partner and gives the counts:',
  fixHint:
    'This is fixed in Salesforce, not Bidspoke: the Submission to Lead copy in Apex, which since 2026-07-08 ' +
    'syncs the Lead only when Completed_Submission_SO__c first turns Yes (see GitHub issue #1525), then a ' +
    'backfill of the Leads left behind. A count that could not be read: check the Worker\'s Salesforce ' +
    'credentials. Run POST /api/admin/lead-status-check for the current answer.',
  headlineVerb: 'has findings',
  itemNoun: { one: 'finding', many: 'findings' },
}

/** The two COUNT() queries and the backlog row query for one partner and the UTC day starting at `dayStart`. */
export function leadStatusQueries(partner: string, dayStart: Date): { submissions: string; leads: string; backlog: string } {
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
      `SELECT Id, Lead__r.Submission_Object_ID__c FROM Submission__c WHERE ${sale} ` +
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
  /** Runs one row query, every page. Injected likewise. */
  rows?: (soql: string) => Promise<Array<Record<string, unknown>>>
  /** Every partner value with Completed sales created in the UTC day starting at `dayStart`. Injected likewise. */
  listPartners?: (dayStart: Date) => Promise<Array<{ partner: string | null; n: number }>>
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

  let partners: PartnerLeadStatus[] = []
  let findings: string[]
  try {
    const measured = await Promise.all(LEAD_STATUS_PARTNERS.map((p) => measure(count, rows, p, dayStart, day)))
    partners = measured.map((m) => m.status)
    findings = [...measured.flatMap((m) => m.findings), ...(await uncoveredPartners(listPartners, dayStart, day))]
  } catch (err) {
    findings = [`the Lead status check itself failed: ${formatErr(err)}`]
  }

  // AN EMPTY LIST IS STILL SENT: the alerter reads no findings as the recovery
  // signal and clears its standing alert with it.
  try {
    await notifyExportFailure(supabase, LEAD_STATUS_JOB, findings, env.IDEMPOTENCY, LEAD_STATUS_REMEDY)
  } catch (err) {
    console.error('[lead-status] could not send its alert:', formatErr(err))
  }
  // Logged on every run, Engine included, so a working check and the unjudged
  // partner's numbers are visible rather than only heard from on a complaint.
  const unread = (n: number | null) => (n === null ? 'unread' : String(n))
  console.log(
    `[lead-status] day=${day} ` +
      partners
        .map((p) => `${p.partner}=${unread(p.leads_completed)}/${unread(p.submissions_completed)} backlog=${unread(p.backlog)} returning=${unread(p.backlog_returning)}`)
        .join(' ') +
      ` findings=${findings.length}`,
  )
  return { day, partners, findings, alerted: findings.length > 0 }
}

/** A Salesforce id, 15 or 18 characters; the first 15 are the record. */
const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/

/**
 * Splits backlog rows into sales whose Lead still names them (left behind) and
 * sales whose Lead names a later Submission (a returning customer). A Lead
 * naming nothing counts as left behind: nothing shows it moved on. Throws on a
 * row with no readable id, so a changed answer is a refusal, never a smaller
 * backlog (L90).
 */
export function splitBacklog(records: Array<Record<string, unknown>>): { own: number; returning: number } {
  let own = 0
  let returning = 0
  for (const r of records) {
    if (typeof r.Id !== 'string' || !SALESFORCE_ID.test(r.Id)) {
      throw new Error(`Salesforce returned a backlog row with no readable Id: ${JSON.stringify(r).slice(0, 200)}`)
    }
    const lead = r.Lead__r
    const current = lead !== null && typeof lead === 'object' ? (lead as Record<string, unknown>).Submission_Object_ID__c : null
    if (typeof current !== 'string' || current === '' || current.slice(0, 15) === r.Id.slice(0, 15)) own++
    else returning++
  }
  return { own, returning }
}

async function tryBacklog(
  rows: (soql: string) => Promise<Array<Record<string, unknown>>>,
  soql: string,
): Promise<{ own: number; returning: number } | { err: string }> {
  try {
    return splitBacklog(await rows(soql))
  } catch (err) {
    return { err: formatErr(err) }
  }
}

async function measure(
  count: (soql: string) => Promise<number>,
  rows: (soql: string) => Promise<Array<Record<string, unknown>>>,
  rule: { partner: string; judged: boolean; before: string },
  dayStart: Date,
  day: string,
): Promise<{ status: PartnerLeadStatus; findings: string[] }> {
  const { partner, judged, before } = rule
  const q = leadStatusQueries(partner, dayStart)
  const [subs, leads, backlog] = await Promise.all([tryCount(count, q.submissions), tryCount(count, q.leads), tryBacklog(rows, q.backlog)])
  const findings: string[] = []
  const say = (text: string) => findings.push(`${partner}: ${text}`)

  const status: PartnerLeadStatus = {
    partner,
    judged,
    submissions_completed: 'n' in subs ? subs.n : null,
    leads_completed: 'n' in leads ? leads.n : null,
    backlog: 'err' in backlog ? null : backlog.own,
    backlog_returning: 'err' in backlog ? null : backlog.returning,
  }
  const returningNote =
    status.backlog_returning ? ` ${fmt(status.backlog_returning)} more have a Lead that has moved on to a later Submission by the same customer, which no backfill changes (#1525).` : ''

  // A count that could not be read is a refusal for every partner, judged or
  // not: the check did not measure what it reports.
  if ('err' in subs || 'err' in leads) {
    const why = 'err' in subs ? subs.err : (leads as { err: string }).err
    say(`the sales created on ${day} could not be counted in Salesforce, so the Leads were NOT compared: ${why}`)
  } else if (judged && subs.n === 0) {
    say(`no sale created on ${day} reads Completed in Salesforce, so there was nothing to compare`)
  } else if (judged && subs.n >= MIN_SUBMISSIONS_TO_JUDGE && leads.n / subs.n < LEAD_COMPLETED_MIN_SHARE) {
    say(
      `${fmt(leads.n)} of ${fmt(subs.n)} sales created on ${day} have a Lead reading Completed ` +
        `(${Math.round((leads.n / subs.n) * 100)}%); before ${SYNC_BROKE_ON} this was ${before}. ` +
        'So new sales are not reaching the Lead: the ongoing copy is broken, and a backfill alone will not keep up.' +
        (status.backlog !== null ? ` ${fmt(status.backlog)} Completed sales since ${SYNC_BROKE_ON} still have a Lead that does not.` : '') +
        returningNote,
    )
  }

  if ('err' in backlog) {
    say(`the backlog of Leads not reading Completed since ${SYNC_BROKE_ON} could not be counted: ${backlog.err}`)
  } else if (judged && backlog.own > 0 && findings.length === 0) {
    // Reached only when the day raised nothing, so the day's sales did sync:
    // what is left is older sales for a backfill. Say the day's count only
    // when it was large enough to judge.
    const dayJudged = status.submissions_completed !== null && status.submissions_completed >= MIN_SUBMISSIONS_TO_JUDGE
    say(
      `${fmt(backlog.own)} Completed sales since ${SYNC_BROKE_ON} still have a Lead that does not read Completed` +
        (dayJudged
          ? `, while ${fmt(status.leads_completed ?? 0)} of ${fmt(status.submissions_completed ?? 0)} sales created on ${day} did reach the Lead, so these are older sales for a backfill.`
          : ', so these are sales for a backfill.') +
        returningNote,
    )
  }

  return { status, findings }
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
): Promise<string[]> {
  let sold: Array<{ partner: string | null; n: number }>
  try {
    sold = await listPartners(dayStart)
  } catch (err) {
    return [`the partners with Completed sales created on ${day} could not be listed, so a partner this check does not cover would go unseen: ${formatErr(err)}`]
  }
  const covered = new Set(LEAD_STATUS_PARTNERS.map((p) => p.partner))
  return sold
    .filter((s): s is { partner: string; n: number } => s.partner !== null && s.partner !== '' && !covered.has(s.partner))
    .map(
      (s) =>
        `${s.partner}: ${fmt(s.n)} sales created on ${day} read Completed, and this check does not cover that partner, ` +
        'so its Leads were not compared. Add it to LEAD_STATUS_PARTNERS in apps/worker/src/lib/lead-status-check.ts',
    )
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
