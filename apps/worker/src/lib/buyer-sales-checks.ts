/**
 * The buyer sales checks, every 15 minutes (#1413, Phase 6). Three checks per
 * buyer, each named for what it proves, and one page for what is waiting on a
 * person.
 *
 * COMPLETENESS: the ledger's entries for the day against the buyer_sales copy,
 * by status. buyer_sales is a copy the ledger wrote, so agreement proves the
 * copy is complete and nothing more (L58). While the outbox is not empty the
 * copy is known to lag, so the check is unmeasured with the oldest age rather
 * than a mismatch that the next drain tick will erase (L324).
 *
 * CONSISTENCY: accepted live entries against the bid logger's winner rows in
 * lead_sighting_bids, per Eastern hour. The node wrote both in the same
 * attempt, so this catches a lost logger write and NOTHING about a double sale
 * or an accept the buyer never recorded, and it is named consistency for that
 * reason (L58). Bid rows are purged after export, so an hour at or beyond the
 * purge horizon is unmeasured with the reason `beyond_bid_purge_horizon`, never
 * compared against rows that may be gone (L592). The horizon is imported from
 * the purge itself, never copied.
 *
 * INDEPENDENT: accepted live entries' buyer references against a record a
 * DIFFERENT node wrote: the Salesforce write back of the buyer's lead id. A
 * buyer with no such record is unmeasured, never clean (L11).
 *
 * UNRESOLVED: one page per buyer counting every unresolved entry, the oldest
 * age, and the slots and dollars they hold against today's caps, with a link
 * to the list. The dedup stamp is the count, so the page repeats when the count
 * grows (L707, L641), and never names a lead key. Only LIVE entries can be
 * unresolved: a rehearsal reservation nothing settled is released by the
 * ledger's own alarm (#1515), and the count of those over the days read is
 * recorded per buyer as `rehearsals_expired`, a leak measure that pages nobody
 * because there is nothing for a person to do about one (L112).
 *
 * OUTCOME RATE: a decline and a buyer error are each an expected answer, so a
 * run carrying one succeeds and the outage aggregation, which reads failed
 * runs, cannot see a buyer answering that way to everything (L77). Per buyer,
 * the live attempts of the last hour: the share that failed before the buyer
 * processed the lead (released, or held as unresolved) and the share the buyer
 * declined, each against the same share over the prior 14 days of buyer_sales.
 * A share is elevated when it is more than double the baseline AND at least 25
 * points above it, so a tiny baseline doubled by one flaky call does not page.
 * The rate needs 10 attempts; below that an hour in which EVERY attempt failed,
 * three or more, is elevated anyway (saturation, L139), and otherwise the hour
 * is QUIET, a third state distinct from normal (L11). A baseline thinner than
 * 100 attempts, or one that could not be read, leaves the rate unmeasured.
 * One line per buyer; a buyer that starts failing while another is already
 * paged gets out past the reminder backoff (L707).
 *
 * A mismatch pages only once it has persisted across two runs; a single run's
 * disagreement is usually the copy catching up. Pages go through the shared
 * export alerter so the same KV keys mute them. The run records its own outcome
 * through job_runs, so a lifetime of zero passes reads as broken (L557).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { easternDayStartUtc, easternParts, hourBucket, type SaleStatus } from '@bidspoke/buyer-profile'
import type { CapLimits, LedgerEntry, UnmirroredResult } from '../durable-objects/buyer-ledger'
import type { Env } from '../index'
import { getSalesforceToken } from '../engine/nodes/salesforce'
import { clearCondition, readCondition, type BackoffKv } from './alert-backoff'
import { BuyerLedgerClient } from './buyer-object-clients'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { withJobRun, type JobRunEnding } from './job-run-record'
import { parseJson } from './json'
import { fetchAllPaged } from './paginate'
import { resolveSalesforceCredsFor } from './salesforce-creds'
import { BID_PURGE_HORIZON_MS } from './sightings-export'
import { describeDuration } from './incident-span'

export { BID_PURGE_HORIZON_MS }

/** The heartbeat and job_runs name. */
export const BUYER_SALES_CHECKS_JOB = 'buyer-sales-checks'
/** The alerter job name for a persisted completeness, consistency or independent mismatch. */
export const BUYER_SALES_MISMATCH_JOB = 'buyer-sales-mismatch'
/** The alerter job name for the unresolved page. */
export const BUYER_SALES_UNRESOLVED_JOB = 'buyer-sales-unresolved'
/** The alerter job name for a buyer refusing or failing far more of its leads than usual. */
export const BUYER_OUTCOME_RATE_JOB = 'buyer-outcome-rate'

/** The baseline window, in Eastern days before today. */
export const OUTCOME_BASELINE_DAYS = 14
/** Attempts the baseline must hold before an hour is judged against it. */
export const OUTCOME_BASELINE_MIN_ATTEMPTS = 100
/** Attempts an hour must hold before its shares are judged against the baseline. */
export const OUTCOME_RATE_MIN_ATTEMPTS = 10
/** Attempts an hour must hold for every one of them failing to be a finding on its own (L139). */
export const OUTCOME_SATURATION_MIN_ATTEMPTS = 3
/** Elevated means more than this multiple of the baseline share AND at least this many points above it. */
const OUTCOME_RATE_MULTIPLE = 2
const OUTCOME_RATE_MIN_RISE = 0.25

/**
 * The buyers whose accepted sales another node writes back to Salesforce, by
 * slug. Tripoint's lead id is patched onto the prospect by the Engine workflow's
 * patch step (docs/engine-cutover-scope.md), which is a record the buyer_select
 * node did not write. A buyer absent from here has no independent record and
 * its independent check is unmeasured rather than clean.
 */
export const INDEPENDENT_RECORD_BUYERS: ReadonlySet<string> = new Set(['tripoint'])

/**
 * What a paged mismatch line can be, each with its own fix (#835). The fix line
 * names only the kinds the page carries, so a page about winner rows that are
 * LONG never says a bid logger write was lost, and one about a sale with no
 * buyer reference never says Salesforce lacks a write back it was never asked
 * about (L11).
 */
export const MISMATCH_KINDS = [
  'completeness',
  'consistency_short',
  'consistency_long',
  'consistency_split',
  'independent_missing',
  'independent_blank',
] as const
export type MismatchKind = (typeof MISMATCH_KINDS)[number]

const MISMATCH_FIX: Record<MismatchKind, string> = {
  completeness:
    'Completeness: the buyer_sales copy is short or long against the ledger for the day; check the drain job for errors, then ' +
    'compare GET /api/buyer-sales against the ledger summary.',
  consistency_short:
    'Consistency, an hour with fewer winner rows than accepted sales: a bid logger write may have been lost; find the ' +
    'execution in that hour by lead key and read its bid log step.',
  consistency_long:
    'Consistency, an hour with more winner rows than accepted sales: the bid logger recorded a win the ledger does not hold as ' +
    'accepted; find the execution in lead_sighting_bids and compare it with its ledger entry.',
  consistency_split:
    'A short hour next to a long one by the same count is usually one attempt that began in one hour and reserved in the next, ' +
    'not a lost write; check that execution first.',
  independent_missing:
    'Independent: Salesforce holds no write back for a lead the ledger says was sold; look at the patch step of that execution ' +
    'before trusting the sale.',
  independent_blank:
    'Independent: a sale with no buyer reference could not be looked up in Salesforce at all; find the execution by lead key ' +
    'and read what the buyer answered, since a sale the buyer took should carry its lead id.',
}

const MISMATCH_CONSEQUENCE =
  'A buyer ledger and the records it should agree with have disagreed on two consecutive checks. Selling is unaffected; ' +
  'the ledger decides caps and the ledger is what the copies are compared against. Each line names the buyer, which check ' +
  'disagreed and by how much:'

/** The mismatch page for the kinds its lines carry. */
export function buyerSalesMismatchRemedy(kinds: ReadonlySet<MismatchKind>): AlertRemedy {
  return {
    consequence: MISMATCH_CONSEQUENCE,
    fixHint: MISMATCH_KINDS.filter((k) => kinds.has(k)).map((k) => MISMATCH_FIX[k]).join(' '),
    headlineVerb: 'found a disagreement',
    itemNoun: { one: 'disagreement', many: 'disagreements' },
  }
}

/** Every clause at once: what the wording review reads. A page carries only its own kinds. */
export const BUYER_SALES_MISMATCH_REMEDY: AlertRemedy = buyerSalesMismatchRemedy(new Set(MISMATCH_KINDS))

/** The buyer list could not be read, so nothing was compared, and nothing disagreed (#835). */
export const BUYER_SALES_UNLISTED_REMEDY: AlertRemedy = {
  consequence:
    "The buyer sales checks could not read the buyer list, so no buyer's ledger was compared with its copies this run. " +
    'The error was:',
  fixHint:
    'Read the error on the line. If it is a database timeout or outage, check that Supabase is answering; if it names a column, ' +
    'a table or a permission, the buyer_profiles read in the buyer sales checks needs fixing.',
  headlineVerb: 'could not read the buyer list',
}

export const BUYER_OUTCOME_RATE_REMEDY: AlertRemedy = {
  consequence:
    'A buyer failed or declined an unusual share of the leads offered to it in the last hour. A decline or a buyer error ' +
    'is an expected answer, so the outage alerts do not count it. Each line names the buyer and what was measured:',
  fixHint:
    'A run of failed attempts: open the partner page and the newest execution details, and read the HTTP status the ' +
    'buyer answered. A block page, a 401 or a 403 means the buyer is refusing us, not the leads; check its endpoint and ' +
    'credential. A run of declines: compare the declined leads with the profile and ask the buyer whether its intake ' +
    'rules changed.',
  headlineVerb: 'shows a buyer failing or declining an unusual share of leads',
  itemNoun: { one: 'buyer', many: 'buyers' },
}

export const BUYER_SALES_UNRESOLVED_REMEDY: AlertRemedy = {
  consequence:
    "Sales nobody could classify are waiting on a person. One reserved today holds a slot and its payout against the buyer's " +
    'caps until it is settled, so a buyer can be refused leads over sales that may never have happened. Nothing failed; the lines ' +
    'below say which buyer and how many:',
  fixHint:
    'Open the partner page linked on each line, read what the buyer answered for each sale, and settle it: Count as sold when ' +
    "the buyer has the lead, Free the slot when it does not. The buyer's own portal or report says which.",
  headlineVerb: 'has sales waiting on a person',
  itemNoun: { one: 'buyer', many: 'buyers' },
}

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface CheckBuyer {
  partner_id: string
  organization_id: string
  slug: string
  caps: CapLimits
  /** Whether another node writes this buyer's accepted sales somewhere the check can read. */
  has_independent_record: boolean
}

export interface ChecksLedger {
  entries(kind: 'live' | 'rehearsal', day: string): Promise<LedgerEntry[]>
  unmirrored(): Promise<UnmirroredResult>
  unresolved(): Promise<LedgerEntry[]>
}

export interface SalesRow {
  lead_key: string
  status: string
  kind: string
}

export interface WinnerRow {
  execution_id: string
  attempted_at_utc: string
}

/** Live attempts over the baseline window: every resolved attempt, those that failed, those declined. */
export interface OutcomeBaseline {
  attempts: number
  failed: number
  declined: number
}

export interface ChecksDeps {
  listBuyers(): Promise<CheckBuyer[]>
  ledger(partnerId: string): ChecksLedger
  /** buyer_sales rows for the partner and Eastern day, every kind. */
  readSalesRows(partnerId: string, day: string): Promise<SalesRow[]>
  /** lead_sighting_bids winner rows this buyer's buyer_select attempts wrote, inside [fromMs, toMs). */
  readWinnerRows(slug: string, fromMs: number, toMs: number): Promise<WinnerRow[]>
  /** The buyer references Salesforce holds among those asked for, on prospects created from `fromMs`; null when the buyer has no independent record. */
  readIndependentRecord(buyer: CheckBuyer, references: string[], fromMs: number): Promise<Set<string> | null>
  /** Counts over live buyer_sales rows with et_day in [fromDay, toDay). */
  readOutcomeBaseline(partnerId: string, fromDay: string, toDay: string): Promise<OutcomeBaseline>
  kv: BackoffKv
  /** The remedy is chosen by what the lines carry (#835): the buyer list unread, or the kinds of disagreement. */
  notifyMismatch(lines: string[], remedy: AlertRemedy): Promise<void>
  notifyUnresolved(lines: string[]): Promise<void>
  notifyOutcomeRate(lines: string[]): Promise<void>
  now(): number
  localDev: boolean
  appUrl: string
  log(line: string): void
}

export type Verdict<Good extends string, Bad extends string> =
  | { verdict: Good; detail?: string }
  | { verdict: Bad; detail: string }
  | { verdict: 'unmeasured'; reason: string; unmeasured_hours?: number }

/** One Eastern hour whose accepted sales and winner rows differ, as the consistency check counted it. */
export interface ConsistencyHour {
  hour: number
  ledger: number
  winners: number
}

export interface BuyerCheckSummary {
  partner_id: string
  slug: string
  completeness: Verdict<'complete', 'mismatch'>
  /** `hours` is set on an inconsistent verdict, so the page's fix can say which way each hour differs (#835). */
  consistency: Verdict<'consistent', 'inconsistent'> & { unmeasured_hours?: number; hours?: ConsistencyHour[] }
  /** `missing` and `blank` are set on an unverified verdict: references Salesforce lacks, and sales with no reference to ask about. */
  independent: Verdict<'verified', 'unverified'> & { missing?: number; blank?: number }
  unresolved: { count: number; oldest_age_ms: number | null; paged: boolean }
  /** Rehearsal reservations the ledger alarm released over the days read (#1515): a leak count, never a page. */
  rehearsals_expired: number
  outcome_rate: Verdict<'normal' | 'quiet', 'elevated'>
}

export interface ChecksSummary {
  skipped?: 'local_dev'
  unmeasured?: string
  days: string[]
  buyers: BuyerCheckSummary[]
  mismatch_lines: string[]
  unresolved_lines: string[]
  outcome_rate_lines: string[]
}

const STATUSES: SaleStatus[] = ['reserved', 'accepted', 'declined', 'released', 'unresolved']
const HOUR_MS = 3_600_000
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'non Error thrown')
const money = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export const mismatchMarkerKey = (partnerId: string) => `buyer-sales-mismatch-seen:${partnerId}`
export const unresolvedPagedKey = (partnerId: string) => `unresolved-paged:${partnerId}`
export const outcomeRatePagedKey = (partnerId: string) => `outcome-rate-paged:${partnerId}`

function isoDateMinus(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10)
}
const previousIsoDate = (day: string) => isoDateMinus(day, 1)

// ── The checks ────────────────────────────────────────────────────────────────

function countByStatus(entries: LedgerEntry[]): Record<SaleStatus, number> {
  const out = { reserved: 0, accepted: 0, declined: 0, released: 0, unresolved: 0 }
  for (const e of entries) out[e.status] += 1
  return out
}

/** The copy against the ledger, by status, for the days given. */
export function judgeCompleteness(ledgerEntries: LedgerEntry[], sales: SalesRow[], outbox: UnmirroredResult): BuyerCheckSummary['completeness'] {
  if (outbox.entries.length > 0 || (outbox.oldest_age_ms !== null && outbox.oldest_age_ms > 0)) {
    const age = outbox.oldest_age_ms === null ? 'unknown age' : (describeDuration(outbox.oldest_age_ms) ?? `${outbox.oldest_age_ms} ms`)
    return { verdict: 'unmeasured', reason: `the outbox holds ${plural(outbox.entries.length, 'entry', 'entries')} not yet copied, oldest ${age}, so the copy is known to lag` }
  }
  const ledger = countByStatus(ledgerEntries)
  const copy = { reserved: 0, accepted: 0, declined: 0, released: 0, unresolved: 0 } as Record<SaleStatus, number>
  for (const s of sales) {
    if (s.kind !== 'live') continue
    if ((STATUSES as string[]).includes(s.status)) copy[s.status as SaleStatus] += 1
  }
  const diffs = STATUSES.filter((s) => ledger[s] !== copy[s]).map((s) => `ledger ${ledger[s]} ${s}, buyer_sales ${copy[s]}`)
  if (diffs.length === 0) return { verdict: 'complete' }
  return { verdict: 'mismatch', detail: diffs.join('; ') }
}

/**
 * Accepted live entries against winner rows per Eastern hour, judging only hours
 * whose end is younger than the purge horizon.
 */
export function judgeConsistency(accepted: LedgerEntry[], winners: WinnerRow[], nowMs: number): BuyerCheckSummary['consistency'] {
  const horizonStart = nowMs - BID_PURGE_HORIZON_MS
  const byHour = new Map<number, { ledger: number; winners: number }>()
  for (const e of accepted) {
    const h = e.hour_bucket
    const slot = byHour.get(h) ?? { ledger: 0, winners: 0 }
    slot.ledger += 1
    byHour.set(h, slot)
  }
  for (const w of winners) {
    const at = Date.parse(w.attempted_at_utc)
    if (!Number.isFinite(at)) continue
    const h = hourBucket(at)
    const slot = byHour.get(h) ?? { ledger: 0, winners: 0 }
    slot.winners += 1
    byHour.set(h, slot)
  }
  let unmeasuredHours = 0
  const diffs: string[] = []
  const differing: ConsistencyHour[] = []
  for (const [h, slot] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    const hourEnd = (h + 1) * HOUR_MS
    if (hourEnd <= horizonStart) { unmeasuredHours += 1; continue }
    if (slot.ledger !== slot.winners) {
      const label = new Date(h * HOUR_MS).toISOString().slice(0, 13) + ':00Z'
      diffs.push(`hour ${label}: ${slot.ledger} accepted in the ledger, ${slot.winners} winner rows`)
      differing.push({ hour: h, ledger: slot.ledger, winners: slot.winners })
    }
  }
  if (diffs.length > 0) return { verdict: 'inconsistent', detail: diffs.join('; '), unmeasured_hours: unmeasuredHours, hours: differing }
  if (unmeasuredHours > 0 && byHour.size === unmeasuredHours) return { verdict: 'unmeasured', reason: 'beyond_bid_purge_horizon', unmeasured_hours: unmeasuredHours }
  return { verdict: 'consistent', unmeasured_hours: unmeasuredHours }
}

export function judgeIndependent(accepted: LedgerEntry[], found: Set<string> | null): BuyerCheckSummary['independent'] {
  if (found === null) return { verdict: 'unmeasured', reason: 'no_independent_record' }
  const missing = accepted
    .map((e) => e.outcome?.buyer_reference ?? null)
    .filter((r): r is string => typeof r === 'string' && r.length > 0)
    .filter((r) => !found.has(r))
  const blank = accepted.filter((e) => !e.outcome?.buyer_reference).length
  if (missing.length === 0 && blank === 0) return { verdict: 'verified' }
  const parts: string[] = []
  if (missing.length) parts.push(`${plural(missing.length, 'accepted sale has', 'accepted sales have')} no Salesforce write back: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`)
  if (blank) parts.push(`${plural(blank, 'accepted sale carries', 'accepted sales carry')} no buyer reference to look up`)
  return { verdict: 'unverified', detail: parts.join('; '), missing: missing.length, blank }
}

/** The fix kinds a buyer's paged mismatch carries, read from what each check found. */
export function mismatchKindsOf(s: Pick<BuyerCheckSummary, 'completeness' | 'consistency' | 'independent'>): MismatchKind[] {
  const kinds: MismatchKind[] = []
  if (s.completeness.verdict === 'mismatch') kinds.push('completeness')
  if (s.consistency.verdict === 'inconsistent') {
    const hours = s.consistency.hours ?? []
    if (hours.some((h) => h.ledger > h.winners)) kinds.push('consistency_short')
    if (hours.some((h) => h.winners > h.ledger)) kinds.push('consistency_long')
    const split = hours.some((a) => hours.some((b) => b.hour === a.hour + 1 && a.winners - a.ledger === b.ledger - b.winners && a.winners > a.ledger))
    if (split) kinds.push('consistency_split')
  }
  if (s.independent.verdict === 'unverified') {
    if ((s.independent.missing ?? 0) > 0) kinds.push('independent_missing')
    if ((s.independent.blank ?? 0) > 0) kinds.push('independent_blank')
  }
  return kinds
}

/** How a baseline that could not be read is handed to the judge, with the reason. */
export interface BaselineUnreadable {
  unreadable: string
}

const percent = (n: number): string => `${Math.round(n * 100)}%`

/**
 * The last hour's live attempts against the baseline. Saturation is judged
 * first and needs no baseline; the rate needs both a big enough hour and a big
 * enough baseline, and says which is missing when one is (L11).
 */
export function judgeOutcomeRate(
  entries: LedgerEntry[],
  baseline: OutcomeBaseline | BaselineUnreadable | null,
  nowMs: number,
): BuyerCheckSummary['outcome_rate'] {
  const hour = entries.filter((e) => e.kind === 'live' && e.status !== 'reserved' && e.reserved_at > nowMs - HOUR_MS && e.reserved_at <= nowMs)
  const attempts = hour.length
  const failed = hour.filter((e) => e.status === 'released' || e.status === 'unresolved').length
  const declined = hour.filter((e) => e.status === 'declined').length
  const failedWhat = 'failed before the buyer processed the lead (a buyer error or an answer nobody could classify)'

  if (attempts >= OUTCOME_SATURATION_MIN_ATTEMPTS && failed === attempts) {
    return { verdict: 'elevated', detail: `all ${attempts} attempts in the last hour ${failedWhat}` }
  }
  if (attempts < OUTCOME_RATE_MIN_ATTEMPTS) {
    return { verdict: 'quiet', detail: `${attempts} attempts in the last hour, fewer than the ${OUTCOME_RATE_MIN_ATTEMPTS} a rate needs, and not every one failed` }
  }
  if (baseline === null) return { verdict: 'unmeasured', reason: `the baseline over the prior ${OUTCOME_BASELINE_DAYS} days could not be read` }
  if ('unreadable' in baseline) return { verdict: 'unmeasured', reason: `the baseline over the prior ${OUTCOME_BASELINE_DAYS} days could not be read: ${baseline.unreadable}` }
  if (baseline.attempts < OUTCOME_BASELINE_MIN_ATTEMPTS) {
    return { verdict: 'unmeasured', reason: `the baseline over the prior ${OUTCOME_BASELINE_DAYS} days holds ${baseline.attempts} attempts, fewer than the ${OUTCOME_BASELINE_MIN_ATTEMPTS} it needs` }
  }

  const elevated = (now: number, base: number) => now > base * OUTCOME_RATE_MULTIPLE && now - base >= OUTCOME_RATE_MIN_RISE
  const against = (base: number) => `against ${percent(base)} over the prior ${OUTCOME_BASELINE_DAYS} days`
  const findings: string[] = []
  const failedShare = failed / attempts
  const failedBase = baseline.failed / baseline.attempts
  if (elevated(failedShare, failedBase)) findings.push(`${failed} of ${attempts} attempts in the last hour ${failedWhat}, ${percent(failedShare)} ${against(failedBase)}`)
  const declinedShare = declined / attempts
  const declinedBase = baseline.declined / baseline.attempts
  if (elevated(declinedShare, declinedBase)) findings.push(`${declined} of ${attempts} attempts in the last hour were declined by the buyer, ${percent(declinedShare)} ${against(declinedBase)}`)
  if (findings.length > 0) return { verdict: 'elevated', detail: findings.join('; ') }
  return { verdict: 'normal', detail: `${attempts} attempts in the last hour, ${percent(failedShare)} failed ${against(failedBase)}, ${percent(declinedShare)} declined ${against(declinedBase)}` }
}

/**
 * The page line for a buyer's unresolved sales. The count and the oldest age are
 * every unresolved entry; the slots and dollars are only today's, because the
 * daily caps count entries by the Eastern day they were reserved on (the
 * ledger's counted()), so one from an earlier day holds nothing against today's
 * caps (#835). This changes the words only: the count, which decides the page,
 * is the same.
 */
export function unresolvedLine(buyer: CheckBuyer, entries: LedgerEntry[], nowMs: number, appUrl: string): string {
  const oldest = entries.reduce<number | null>((min, e) => (min === null || e.reserved_at < min ? e.reserved_at : min), null)
  const age = oldest === null ? 'unknown age' : (describeDuration(nowMs - oldest) ?? `${nowMs - oldest} ms`)
  const todays = entries.filter((e) => e.et_day === easternParts(nowMs).date)
  const cents = todays.reduce((n, e) => n + e.payout_cents, 0)
  const slots = buyer.caps.daily_lead_cap === null ? `${plural(todays.length, 'lead slot', 'lead slots')} (no daily lead cap)` : `${todays.length} of the ${buyer.caps.daily_lead_cap} lead slots`
  const spend = buyer.caps.daily_spend_cap_cents === null ? `${money(cents)} (no daily spend cap)` : `${money(cents)} of the ${money(buyer.caps.daily_spend_cap_cents)} daily spend`
  return `${buyer.slug}: ${plural(entries.length, 'unresolved sale', 'unresolved sales')}, oldest ${age}, holding ${slots} and ${spend} today. Settle them at ${appUrl}/partners?selected=${encodeURIComponent(buyer.slug)}`
}

// ── The run ───────────────────────────────────────────────────────────────────

export async function runBuyerSalesChecks(deps: ChecksDeps): Promise<ChecksSummary> {
  const now = deps.now()
  const today = easternParts(now).date
  const days = [today, previousIsoDate(today)]

  if (deps.localDev) {
    deps.log(`[${BUYER_SALES_CHECKS_JOB}] skipped: local dev`)
    return { skipped: 'local_dev', days, buyers: [], mismatch_lines: [], unresolved_lines: [], outcome_rate_lines: [] }
  }

  let buyers: CheckBuyer[]
  try {
    buyers = await deps.listBuyers()
  } catch (err) {
    const reason = `the buyer list could not be read, so nothing was checked: ${messageOf(err)}`
    await deps.notifyMismatch([reason], BUYER_SALES_UNLISTED_REMEDY)
    return { unmeasured: reason, days, buyers: [], mismatch_lines: [reason], unresolved_lines: [], outcome_rate_lines: [] }
  }

  const summaries: BuyerCheckSummary[] = []
  const mismatchLines: string[] = []
  const unresolvedLines: string[] = []
  const outcomeRateLines: string[] = []
  const mismatchKinds = new Set<MismatchKind>()
  let unresolvedGrew = false
  let newlyElevated = false

  for (const buyer of buyers) {
    const s = await checkBuyer(deps, buyer, days, now)
    summaries.push(s)

    // A mismatch pages only once it has stood across two runs.
    const mismatches: string[] = []
    if (s.completeness.verdict === 'mismatch') mismatches.push(`completeness: ${s.completeness.detail}`)
    if (s.consistency.verdict === 'inconsistent') mismatches.push(`consistency: ${s.consistency.detail}`)
    if (s.independent.verdict === 'unverified') mismatches.push(`independent: ${s.independent.detail}`)
    const marker = mismatchMarkerKey(buyer.partner_id)
    if (mismatches.length > 0) {
      const seenBefore = (await deps.kv.get(marker)) !== null
      if (seenBefore) {
        mismatchLines.push(`${buyer.slug}: ${mismatches.join(' | ')}`)
        for (const k of mismatchKindsOf(s)) mismatchKinds.add(k)
      }
      await deps.kv.put(marker, new Date(now).toISOString(), { expirationTtl: 24 * 3600 })
    } else {
      await deps.kv.delete(marker)
    }

    // The unresolved page, keyed on the count.
    const pagedKey = unresolvedPagedKey(buyer.partner_id)
    if (s.unresolved.count === 0) {
      await deps.kv.delete(pagedKey)
    } else {
      const lastPaged = Number((await deps.kv.get(pagedKey)) ?? '0')
      if (s.unresolved.count > lastPaged) {
        unresolvedLines.push(unresolvedLine(buyer, s.unresolved.entries, now, deps.appUrl))
        s.unresolved.paged = true
        if (lastPaged > 0) unresolvedGrew = true
        await deps.kv.put(pagedKey, String(s.unresolved.count), { expirationTtl: 7 * 24 * 3600 })
      }
    }

    // The outcome rate page, one line per elevated buyer. A buyer paged for the
    // first time while another's page is standing must not wait out that
    // buyer's reminder backoff (L707).
    const rateKey = outcomeRatePagedKey(buyer.partner_id)
    if (s.outcome_rate.verdict === 'elevated') {
      outcomeRateLines.push(`${buyer.slug}: ${s.outcome_rate.detail}. Partner page: ${deps.appUrl}/partners?selected=${encodeURIComponent(buyer.slug)}`)
      if ((await deps.kv.get(rateKey)) === null) newlyElevated = true
      await deps.kv.put(rateKey, new Date(now).toISOString(), { expirationTtl: 24 * 3600 })
    } else {
      await deps.kv.delete(rateKey)
    }
  }

  // A count that grew must get out past the reminder backoff, but only when it
  // was this job that set the condition: a cooldown standing on its own is a
  // person's mute and stays (L523).
  if (unresolvedGrew) {
    const family = `export-alert:${BUYER_SALES_UNRESOLVED_JOB}`
    if ((await readCondition(deps.kv, family)) !== null) await clearCondition(deps.kv, family)
  }
  if (newlyElevated) {
    const family = `export-alert:${BUYER_OUTCOME_RATE_JOB}`
    if ((await readCondition(deps.kv, family)) !== null) await clearCondition(deps.kv, family)
  }

  await deps.notifyMismatch(mismatchLines, buyerSalesMismatchRemedy(mismatchKinds))
  await deps.notifyUnresolved(unresolvedLines)
  await deps.notifyOutcomeRate(outcomeRateLines)
  return {
    days,
    buyers: summaries.map(({ unresolved, ...rest }) => ({ ...rest, unresolved: { count: unresolved.count, oldest_age_ms: unresolved.oldest_age_ms, paged: unresolved.paged } })),
    mismatch_lines: mismatchLines,
    unresolved_lines: unresolvedLines,
    outcome_rate_lines: outcomeRateLines,
  }
}

type BuyerWork = Omit<BuyerCheckSummary, 'unresolved'> & { unresolved: BuyerCheckSummary['unresolved'] & { entries: LedgerEntry[] } }

async function checkBuyer(deps: ChecksDeps, buyer: CheckBuyer, days: string[], now: number): Promise<BuyerWork> {
  const ledger = deps.ledger(buyer.partner_id)
  const base = { partner_id: buyer.partner_id, slug: buyer.slug }
  const unmeasuredAll = (reason: string): BuyerWork => ({
    ...base,
    completeness: { verdict: 'unmeasured', reason },
    consistency: { verdict: 'unmeasured', reason },
    independent: { verdict: 'unmeasured', reason },
    unresolved: { count: 0, oldest_age_ms: null, paged: false, entries: [] },
    rehearsals_expired: 0,
    outcome_rate: { verdict: 'unmeasured', reason },
  })

  let entries: LedgerEntry[]
  let rehearsals: LedgerEntry[]
  let outbox: UnmirroredResult
  let unresolvedEntries: LedgerEntry[]
  try {
    entries = (await Promise.all(days.map((d) => ledger.entries('live', d)))).flat()
    rehearsals = (await Promise.all(days.map((d) => ledger.entries('rehearsal', d)))).flat()
    outbox = await ledger.unmirrored()
    unresolvedEntries = await ledger.unresolved()
  } catch (err) {
    return unmeasuredAll(`the buyer ledger could not be read: ${messageOf(err)}`)
  }

  let completeness: BuyerCheckSummary['completeness']
  try {
    const sales = (await Promise.all(days.map((d) => deps.readSalesRows(buyer.partner_id, d)))).flat()
    completeness = judgeCompleteness(entries, sales, outbox)
  } catch (err) {
    completeness = { verdict: 'unmeasured', reason: `buyer_sales could not be read: ${messageOf(err)}` }
  }

  const accepted = entries.filter((e) => e.status === 'accepted')
  let consistency: BuyerCheckSummary['consistency']
  try {
    const from = easternDayStartUtc(days[days.length - 1])
    const winners = await deps.readWinnerRows(buyer.slug, from, now + HOUR_MS)
    consistency = judgeConsistency(accepted, winners, now)
  } catch (err) {
    consistency = { verdict: 'unmeasured', reason: `lead_sighting_bids could not be read: ${messageOf(err)}` }
  }

  let independent: BuyerCheckSummary['independent']
  try {
    const references = accepted.map((e) => e.outcome?.buyer_reference).filter((r): r is string => typeof r === 'string' && r.length > 0)
    const lookbackFrom = easternDayStartUtc(days[days.length - 1]) - INDEPENDENT_LOOKBACK_MARGIN_MS
    const found = buyer.has_independent_record ? await deps.readIndependentRecord(buyer, references, lookbackFrom) : null
    independent = judgeIndependent(accepted, found)
  } catch (err) {
    independent = { verdict: 'unmeasured', reason: `the independent record could not be read: ${messageOf(err)}` }
  }

  // The baseline is the 14 Eastern days before today, today excluded because it is still being written (L696).
  let baseline: OutcomeBaseline | BaselineUnreadable
  try {
    baseline = await deps.readOutcomeBaseline(buyer.partner_id, isoDateMinus(days[0], OUTCOME_BASELINE_DAYS), days[0])
  } catch (err) {
    baseline = { unreadable: messageOf(err) }
  }
  const outcome_rate = judgeOutcomeRate(entries, baseline, now)

  const oldest = unresolvedEntries.reduce<number | null>((min, e) => (min === null || e.reserved_at < min ? e.reserved_at : min), null)
  return {
    ...base,
    completeness,
    consistency,
    independent,
    unresolved: { count: unresolvedEntries.length, oldest_age_ms: oldest === null ? null : now - oldest, paged: false, entries: unresolvedEntries },
    rehearsals_expired: rehearsals.filter((e) => e.status === 'released' && e.resolution_source === 'expired').length,
    outcome_rate,
  }
}

/** What the run records about itself: ok only when every check on every buyer measured and agreed. */
export function endingOf(summary: ChecksSummary): JobRunEnding {
  if (summary.skipped) return { outcome: 'skipped', detail: summary.skipped, summary: { days: summary.days } }
  if (summary.unmeasured) return { outcome: 'unmeasured', detail: summary.unmeasured, summary: { days: summary.days } }
  const verdicts = summary.buyers.flatMap((b) => [b.completeness.verdict, b.consistency.verdict, b.independent.verdict, b.outcome_rate.verdict])
  const findings = summary.mismatch_lines.length > 0 || verdicts.some((v) => v === 'mismatch' || v === 'inconsistent' || v === 'unverified' || v === 'elevated')
  const unmeasured = verdicts.some((v) => v === 'unmeasured')
  const outcome = findings ? 'findings' : unmeasured ? 'unmeasured' : 'ok'
  return {
    outcome,
    summary: {
      days: summary.days,
      buyers: summary.buyers.map((b) => ({ slug: b.slug, completeness: b.completeness.verdict, consistency: b.consistency.verdict, independent: b.independent.verdict, unresolved: b.unresolved.count, rehearsals_expired: b.rehearsals_expired, outcome_rate: b.outcome_rate.verdict })),
      paged_mismatches: summary.mismatch_lines.length,
      paged_unresolved: summary.unresolved_lines.length,
      paged_outcome_rates: summary.outcome_rate_lines.length,
    },
  }
}

// ── Production wiring ─────────────────────────────────────────────────────────

interface ProfileRow {
  partner_id: string
  hourly_lead_cap: number | null
  daily_lead_cap: number | null
  hourly_spend_cap_cents: number | null
  daily_spend_cap_cents: number | null
  partner_configs: { organization_id: string; slug: string }
}

const SOQL_CHUNK = 150

/**
 * How far before the earliest checked Eastern day the Salesforce lookup starts (#1737). The
 * prospect is created earlier in the same execution as the sale, so a sale just after midnight
 * Eastern can belong to a prospect created just before it.
 */
const INDEPENDENT_LOOKBACK_MARGIN_MS = HOUR_MS

/**
 * The Salesforce query for the Tripoint lead ids among `references` (#1737). The field is
 * TripointLeadID__c, the one the Engine Bidding patch writes and the only Tripoint lead id field
 * on Prospect__c. It is not indexed, so a lookup by it alone times out on the whole object; the
 * CreatedDate bound makes it selective (3 s for a day, measured 2026-10-02).
 */
export function independentRecordSoql(references: string[], fromMs: number): string {
  const from = new Date(fromMs).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `SELECT TripointLeadID__c FROM Prospect__c WHERE CreatedDate >= ${from} AND TripointLeadID__c IN (${references.map((r) => `'${r}'`).join(',')})`
}

export function productionChecksDeps(supabase: SupabaseClient, env: Env): ChecksDeps {
  return {
    listBuyers: async () => {
      const { data, error } = await supabase
        .from('buyer_profiles')
        .select('partner_id, hourly_lead_cap, daily_lead_cap, hourly_spend_cap_cents, daily_spend_cap_cents, partner_configs!inner(organization_id, slug), organizations!inner(is_synthetic)')
        // A click sold buyer (#1541) has no ledger day and no buyer_sales rows,
        // so listing it would turn every run unmeasured.
        .eq('sold_on', 'offer')
        // Never a synthetic organization's buyer (#2135): the one predicate that
        // marks the partners page delivery monitor's organization (L261).
        .eq('organizations.is_synthetic', false)
      if (error) throw new Error(`buyer_profiles: ${error.message}`)
      return ((data ?? []) as unknown as ProfileRow[]).map((r) => ({
        partner_id: r.partner_id,
        organization_id: r.partner_configs.organization_id,
        slug: r.partner_configs.slug,
        caps: { hourly_lead_cap: r.hourly_lead_cap, daily_lead_cap: r.daily_lead_cap, hourly_spend_cap_cents: r.hourly_spend_cap_cents, daily_spend_cap_cents: r.daily_spend_cap_cents },
        has_independent_record: INDEPENDENT_RECORD_BUYERS.has(r.partner_configs.slug),
      }))
    },
    ledger: (partnerId) => new BuyerLedgerClient(env.BUYER_LEDGER, partnerId),
    // Both reads are paged (#1497): PostgREST answers at most 1,000 rows however
    // high the limit, and a buyer's day (up to the 1,695 daily cap in rehearsal,
    // more live) or a busy hour of winner rows exceeds that, so a single read
    // came back short and the completeness and consistency checks would have
    // paged a mismatch that was the reader's own.
    readSalesRows: (partnerId, day) =>
      fetchAllPaged<{ lead_key: string; status: string; kind: string }>(
        (from, to) => supabase
          .from('buyer_sales')
          .select('lead_key, status, kind')
          .eq('partner_id', partnerId)
          .eq('et_day', day)
          .order('id', { ascending: true })
          .range(from, to),
        'buyer_sales',
      ),
    readWinnerRows: (slug, fromMs, toMs) =>
      fetchAllPaged<{ execution_id: string; attempted_at_utc: string }>(
        (from, to) => supabase
          .from('lead_sighting_bids')
          .select('execution_id, attempted_at_utc')
          .eq('partner_slug', slug)
          .eq('is_winner', true)
          .eq('resolver_type', 'buyer_select')
          .gte('attempted_at_utc', new Date(fromMs).toISOString())
          .lt('attempted_at_utc', new Date(toMs).toISOString())
          .order('attempted_at_utc', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
        'lead_sighting_bids',
      ),
    readIndependentRecord: async (buyer, references, fromMs) => {
      if (!buyer.has_independent_record) return null
      if (references.length === 0) return new Set()
      const { creds, missing } = await resolveSalesforceCredsFor(env, supabase, buyer.organization_id)
      if (!creds) throw new Error(`Salesforce credentials missing: ${missing.join(', ')}`)
      const token = await getSalesforceToken(env, buyer.organization_id, creds.instanceUrl, creds.clientId, creds.clientSecret)
      const found = new Set<string>()
      const safe = references.filter((r) => /^[A-Za-z0-9_-]{1,64}$/.test(r))
      for (let i = 0; i < safe.length; i += SOQL_CHUNK) {
        const chunk = safe.slice(i, i + SOQL_CHUNK)
        const soql = independentRecordSoql(chunk, fromMs)
        let next: string | undefined = `${creds.instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`
        while (next) {
          const res: Response = await fetch(next, { headers: { Authorization: `Bearer ${token}` } })
          if (!res.ok) throw new Error(`Salesforce query failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
          const body = await parseJson<{ records: Array<{ TripointLeadID__c?: unknown }>; done: boolean; nextRecordsUrl?: string }>(res)
          for (const rec of body.records) if (typeof rec.TripointLeadID__c === 'string') found.add(rec.TripointLeadID__c)
          next = body.done ? undefined : body.nextRecordsUrl ? `${creds.instanceUrl}${body.nextRecordsUrl}` : undefined
        }
      }
      return found
    },
    readOutcomeBaseline: async (partnerId, fromDay, toDay) => {
      // Head counts, never rows: fourteen days can hold more than the 1,000 row page.
      const count = async (statuses: SaleStatus[]): Promise<number> => {
        const { count, error } = await supabase
          .from('buyer_sales')
          .select('id', { count: 'exact', head: true })
          .eq('partner_id', partnerId)
          .eq('kind', 'live')
          .gte('et_day', fromDay)
          .lt('et_day', toDay)
          .in('status', statuses)
        if (error) throw new Error(`buyer_sales count: ${error.message}`)
        return count ?? 0
      }
      const [attempts, failed, declined] = await Promise.all([
        count(['accepted', 'declined', 'released', 'unresolved']),
        count(['released', 'unresolved']),
        count(['declined']),
      ])
      return { attempts, failed, declined }
    },
    kv: env.IDEMPOTENCY,
    notifyMismatch: (lines, remedy) => notifyExportFailure(supabase, BUYER_SALES_MISMATCH_JOB, lines, env.IDEMPOTENCY, remedy),
    notifyUnresolved: (lines) => notifyExportFailure(supabase, BUYER_SALES_UNRESOLVED_JOB, lines, env.IDEMPOTENCY, BUYER_SALES_UNRESOLVED_REMEDY),
    notifyOutcomeRate: (lines) => notifyExportFailure(supabase, BUYER_OUTCOME_RATE_JOB, lines, env.IDEMPOTENCY, BUYER_OUTCOME_RATE_REMEDY),
    now: () => Date.now(),
    localDev: Boolean(env.LOCAL_DEV),
    appUrl: env.APP_URL,
    log: (line) => console.log(line),
  }
}

/** What the scheduled handler calls: the checks under a job run record (L557). */
export function runBuyerSalesChecksForEnv(supabase: SupabaseClient, env: Env): Promise<ChecksSummary> {
  return withJobRun(supabase, BUYER_SALES_CHECKS_JOB, () => runBuyerSalesChecks(productionChecksDeps(supabase, env)), endingOf)
}
