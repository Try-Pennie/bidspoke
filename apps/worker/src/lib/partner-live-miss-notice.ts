/**
 * The live miss notice (#2220, Dan's decisions of 2026-10-26).
 *
 * A partners page that finds, by its own versions check, a change it was never
 * told about live (or whose join was refused because the day's live channel
 * did not exist) records one row in partner_page_live_misses through POST
 * /api/partners/live-miss (#2135, #2288). Organic partner edits run 0 to 15 a
 * week, most weeks 0, so a miss RATE cannot be measured and no threshold
 * ships (decision 1): every recorded miss posts ONE non urgent notice to its
 * own organization's alert channel, naming the partner, the cause in plain
 * words, whose page saw it and the version gap.
 *
 * HOW. A check on the five minute cron reads the misses past a watermark kept
 * in KV, oldest first and at most LIVE_MISS_NOTICE_BATCH a tick, and posts
 * each through the organization's Slack connection. The table is insert only
 * for the Worker (no UPDATE grant), so what has been sent lives in KV:
 *  - the watermark, (observed_at, id) of the last miss settled, so a tick reads
 *    only what is newer. It moves only across misses that are settled (posted,
 *    or not posted because the organization has no Slack or turned the alerts
 *    off), never past one whose post failed, which is read and tried again on
 *    the next tick;
 *  - a sent marker per miss, written once it is settled (Slack accepted the
 *    post, or nobody there asked to be told), so a miss after a failed one
 *    (settled, but still behind the watermark) is not posted again when the
 *    watermark comes back for it;
 *  - the claim (ALERT_CLAIM, #1298) asked before each post, so a doubled tick
 *    posts once. The marker is read again after the claim (L157), so a tick
 *    whose claim outlived the other's cannot post a miss already sent.
 *
 * THE FIRST RUN. With no watermark stored, reading starts at
 * LIVE_MISS_INITIAL_WATERMARK, before the deliberate miss of 2026-10-26
 * (row 6461826f, observed 17:11:54 UTC), so that miss is the first notice after
 * deploy, posted as a test alert, which proves the path end to end (decision 2).
 *
 * TEST ALERTS. A miss on the throwaway 'Live miss test' partner
 * (LIVE_MISS_TEST_PARTNER_ID) still posts, but its title starts "Test alert:"
 * and its first sentence says it came from the deliberate test and needs no
 * action (decision 2).
 *
 * THE INCIDENT RECORD (signal partner-page-live-miss). Each miss is a single
 * event, so it is one incident of its own, keyed `<partner id>:<miss id>` and
 * labelled with the partner's name: opened (keepAlerted, starting when the page
 * saw it), paged only once Slack accepted the post (recordPaged), and stood
 * down by design at once (settleRecovery), since no all-clear follows.
 *
 * FAILING LOUD. A read that fails (the watermark, the misses, the partner or
 * person names) posts nothing and is recorded in job_runs as `unmeasured` with
 * why, never as `no_misses` (L10, L11). A post that fails is recorded as
 * `post_failed`. Either resolves the run to failedRun(), so three such runs in a
 * row page through the scheduled job failing alert (minute-job-failures.ts):
 * nothing else would ever say that misses had stopped being reported (L13).
 *
 * Who may run it: the bidding Worker's scheduled handler. Whose data: each
 * notice goes only to the organization the miss belongs to, and a partner or
 * person name is used only when its row belongs to that same organization.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { LIVE_MISS_CAUSES, type LiveMissCause } from '@bidspoke/partner-page-live'
import type { AlertClaims } from './alert-claim'
import { raceDeadline, releaseClaimQuietly } from './alert-claim'
import { keepAlerted, markSpikeSeen, recordPaged, settleRecovery, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { reportRecordError } from './incident-outbox'
import { failedRun, type FailedRun } from './minute-job-failures'
import { formatErr } from './format-error'
import { recordFinishedJobRun } from './job-run-record'
import { lookupSlackConnection, postMessage } from './slack'

/** The heartbeat and job_runs id of this check. */
export const PARTNER_LIVE_MISS_NOTICE_JOB = 'partner-live-miss-notice'
/** The incident record's signal (incident-signals.ts). */
export const PARTNER_LIVE_MISS_SIGNAL = 'partner-page-live-miss'

/**
 * The throwaway 'Live miss test' partner (inactive) that the deliberate miss of
 * #2220 was made on, 2026-10-26. A miss on it posts as a test alert.
 */
export const LIVE_MISS_TEST_PARTNER_ID = 'c21765df-776a-41a9-a291-9547afce4186'

/**
 * Misses read and posted in one tick at most; the rest wait for the next. The
 * table's own migration expects a handful a day, so a full page is a backlog,
 * and twenty posts sit well inside the job's two minute run allowance.
 */
export const LIVE_MISS_NOTICE_BATCH = 20

/** How long the reads of one tick may take before the run counts as unmeasured. */
export const LIVE_MISS_READ_DEADLINE_MS = 20_000

/** Where reading resumes: strictly after this (observed_at, id). */
export interface LiveMissWatermark {
  /** The stored observed_at exactly as the database wrote it, microseconds included. */
  observedAt: string
  id: string
}

/**
 * Where the first run starts: 2026-10-26 17:00 UTC (1 PM ET), before the
 * deliberate miss (row 6461826f, observed 17:11:54 UTC), so it is the first
 * notice (decision 2). The nil id sorts before every id at that instant.
 */
export const LIVE_MISS_INITIAL_WATERMARK: LiveMissWatermark = {
  observedAt: '2026-10-26T17:00:00.000Z',
  id: '00000000-0000-0000-0000-000000000000',
}

export const LIVE_MISS_WATERMARK_KEY = `${PARTNER_LIVE_MISS_NOTICE_JOB}:watermark`
/** Set once the miss is settled (posted, or not wanted). Never rename: it keys live state. */
export const liveMissSentKey = (missId: string) => `${PARTNER_LIVE_MISS_NOTICE_JOB}:sent:${missId}`
/** The claim a tick holds while it posts the miss's notice. */
export const liveMissClaimKey = (missId: string) => `${PARTNER_LIVE_MISS_NOTICE_JOB}:${missId}`

/**
 * How long a sent marker lives. It only has to outlast the watermark's return
 * to a miss behind a failed one, which is the next tick that posts that one;
 * thirty days covers a Slack connection broken for weeks.
 */
const SENT_TTL_SECONDS = 30 * 24 * 60 * 60
/**
 * How long a claim holds: two ticks. A tick that claims and dies before posting
 * delays that notice ten minutes, which a non urgent notice can bear, and no
 * slow tick can still be posting when another claims.
 */
const CLAIM_TTL_SECONDS = 10 * 60

export interface VersionPair {
  partnerVersion: number | null
  profileVersion: number | null
}

/** One miss, with the names it is told by. */
export interface LiveMissRow {
  id: string
  organizationId: string
  partnerId: string
  /** Null when no partner of the miss's organization has this id any more. */
  partnerName: string | null
  /** Null when the report carries no person, or no user of the organization has that id. */
  reporterName: string | null
  /** As stored: one of LIVE_MISS_CAUSES, or a value this code has no words for. */
  cause: string
  noticed: VersionPair
  observed: VersionPair
  sinceLastNoticeMs: number | null
  /** As the database wrote it, so the watermark keeps its full precision. */
  observedAt: string
}

export type LiveMissReading = { ok: true; rows: LiveMissRow[] } | { ok: false; error: string }

/** What posting one notice came to. */
export type NoticePost =
  | { kind: 'posted' }
  | { kind: 'not_posted'; reason: 'no_slack' | 'alerts_off' }
  | { kind: 'failed'; reason: string }

export interface LiveMissNotice {
  title: string
  /** Each a short paragraph of Slack mrkdwn. */
  sections: string[]
  test: boolean
}

export interface LiveMissNoticeDeps {
  kv: RecoveryKv
  claims: AlertClaims | undefined
  /** Misses strictly after `after`, oldest first, at most `limit`. */
  read: (after: LiveMissWatermark, limit: number) => Promise<LiveMissReading>
  /** Posts to the organization's alert channel. May throw for a network failure. */
  post: (organizationId: string, notice: LiveMissNotice) => Promise<NoticePost>
  /** The job_runs record of this run. Never throws (job-run-record.ts). */
  record: (outcome: string, summary: Record<string, unknown>) => Promise<void>
  now: () => number
  log: (line: string) => void
  /** Local dev shares the production database: it reads and posts nothing. */
  localDev?: boolean
}

export interface LiveMissNoticeSummary {
  mode: 'post' | 'silent'
  /** The job_runs outcome, null in silent mode. */
  outcome: 'ok' | 'no_misses' | 'post_failed' | 'unmeasured' | null
  /** Why the run could not measure, when it could not. */
  reason?: string
  read: number
  posted: string[]
  notPosted: string[]
  alreadySent: string[]
  /** Held by another tick's claim: that tick posts it. */
  waiting: string[]
  failed: string[]
  /** The page came back full, so more may wait for the next tick. */
  more: boolean
  /** Faults in the check's own bookkeeping, reported rather than thrown. */
  errors: string[]
}

// ── The words ───────────────────────────────────────────────────────────────

const CAUSE_SENTENCES: Record<LiveMissCause, string> = {
  direct_sql: 'The change was made directly in the database, not through Bidspoke.',
  delivery: 'The change was saved through Bidspoke, but Realtime lost the live update.',
  missing_partition: 'The day\'s live channel was missing.',
}

const CAUSE_FIXES: Record<LiveMissCause, string> = {
  direct_sql: 'make partner changes on the partners page, which tells every open page at once.',
  delivery: 'nothing for a single miss, since the page found the change on its own check. If these repeat, check Supabase Realtime.',
  missing_partition: 'nothing for a single miss, since the page joins once the channel exists. If these repeat, check that Supabase creates each day\'s live channel ahead of time.',
}

const isKnownCause = (cause: string): cause is LiveMissCause => (LIVE_MISS_CAUSES as readonly string[]).includes(cause)

/** The cause in plain words. An unknown cause is named as it is, never guessed at (L11). */
export function causeSentence(cause: string): string {
  return isKnownCause(cause) ? CAUSE_SENTENCES[cause] : `The page gave the cause as "${plain(cause)}", which this notice has no words for.`
}

/** Text made safe inside mrkdwn: `<`, `>` and `&` are markup there. */
function plain(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const easternTime = (iso: string): string =>
  `${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))} ET`

function quietFor(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 120) return `${seconds} seconds`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 120) return `${minutes} minutes`
  return `${Math.round(ms / 3_600_000)} hours`
}

/** The version sentences: one for each half the page held behind what the database had. */
function versionSentences(row: LiveMissRow): string[] {
  const out: string[] = []
  const gap = (held: number | null, found: number | null, what: string) => {
    if (held !== null && found !== null && held !== found) out.push(`The page held ${what} version ${held}, and the database had version ${found}.`)
  }
  gap(row.noticed.partnerVersion, row.observed.partnerVersion, 'partner')
  gap(row.noticed.profileVersion, row.observed.profileVersion, 'buyer profile')
  return out
}

/** The notice for one miss: a plain title and a few short sentences (the repo's alert copy). */
export function composeLiveMissNotice(row: LiveMissRow): LiveMissNotice {
  const test = row.partnerId === LIVE_MISS_TEST_PARTNER_ID
  const partner = row.partnerName ? `*${plain(row.partnerName)}*` : 'a partner that is no longer in Bidspoke'
  const who = row.reporterName ? plain(row.reporterName) : 'Someone'
  const joined = row.cause !== 'missing_partition'

  const what = joined
    ? `${who} had the partners page for ${partner} open, and it found a change it was never told about.`
    : `${who} had the partners page for ${partner} open, and it could not join live updates until the channel existed.`
  const detail = [causeSentence(row.cause)]
  if (joined) {
    const versions = versionSentences(row)
    detail.push(...(versions.length ? versions : ['The page did not say which versions it held.']))
    detail.push(row.sinceLastNoticeMs === null
      ? 'It had heard no live update since it opened.'
      : `It had heard no live update in the ${quietFor(row.sinceLastNoticeMs)} before that.`)
  }
  detail.push(`Seen at ${easternTime(row.observedAt)}.`)

  const sections = [`${what} ${detail.join(' ')}`]
  if (test) {
    sections.unshift('This is a test alert from the deliberate miss on #2220. It needs no action.')
  } else {
    sections.push(`*Fix:* ${isKnownCause(row.cause) ? CAUSE_FIXES[row.cause] : 'nothing for a single miss. Check what the page reports with this cause.'}`)
  }
  return {
    title: test ? 'Test alert: a partners page missed a live update' : 'A partners page missed a live update',
    sections,
    test,
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)$/

/** The stored watermark, or why it cannot be used. Never a guess: a bad one stops the run (L50). */
function parseWatermark(raw: string): LiveMissWatermark | string {
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return 'the stored watermark is not an object'
    const { observedAt, id } = v as Record<string, unknown>
    if (typeof observedAt !== 'string' || !TIMESTAMP.test(observedAt) || !Number.isFinite(Date.parse(observedAt))) return 'the stored watermark holds no readable time'
    if (typeof id !== 'string' || !UUID.test(id)) return 'the stored watermark holds no miss id'
    return { observedAt, id }
  } catch (e) {
    return `the stored watermark is not JSON: ${formatErr(e)}`
  }
}

type Settled = 'posted' | 'not_posted' | 'already_sent'
type Handled = Settled | 'waiting' | 'failed'

/** One run: read the new misses, post each once, move the watermark. Never throws. */
export async function runLiveMissNotice(deps: LiveMissNoticeDeps): Promise<LiveMissNoticeSummary> {
  const summary: LiveMissNoticeSummary = {
    mode: deps.localDev ? 'silent' : 'post',
    outcome: null,
    read: 0,
    posted: [],
    notPosted: [],
    alreadySent: [],
    waiting: [],
    failed: [],
    more: false,
    errors: [],
  }
  if (summary.mode === 'silent') {
    deps.log(`[${PARTNER_LIVE_MISS_NOTICE_JOB}] mode=silent (LOCAL_DEV)`)
    return summary
  }

  const unmeasured = async (reason: string): Promise<LiveMissNoticeSummary> => {
    summary.outcome = 'unmeasured'
    summary.reason = reason
    deps.log(`[${PARTNER_LIVE_MISS_NOTICE_JOB}] outcome=unmeasured reason=${JSON.stringify(reason)}`)
    await deps.record('unmeasured', { reason })
    return summary
  }

  let watermark: LiveMissWatermark
  try {
    const stored = await deps.kv.get(LIVE_MISS_WATERMARK_KEY)
    if (stored === null) watermark = LIVE_MISS_INITIAL_WATERMARK
    else {
      const parsed = parseWatermark(stored)
      if (typeof parsed === 'string') return unmeasured(parsed)
      watermark = parsed
    }
  } catch (e) {
    return unmeasured(`the watermark could not be read: ${formatErr(e)}`)
  }

  let reading: LiveMissReading
  try {
    reading = await deps.read(watermark, LIVE_MISS_NOTICE_BATCH)
  } catch (e) {
    reading = { ok: false, error: formatErr(e) }
  }
  if (!reading.ok) return unmeasured(`the live misses could not be read: ${reading.error}`)

  const rows = reading.rows.slice(0, LIVE_MISS_NOTICE_BATCH)
  summary.read = rows.length
  summary.more = reading.rows.length >= LIVE_MISS_NOTICE_BATCH
  const nowMs = deps.now()

  // Every miss is tried, whatever happened to the one before it: a failure in
  // one organization's Slack must not hold back another organization's notice.
  // The watermark then moves only across the settled run at the front.
  let settledThrough: LiveMissRow | null = null
  let blocked = false
  for (const row of rows) {
    let handled: Handled
    try {
      handled = await handleMiss(deps, row, nowMs, summary)
    } catch (e) {
      summary.errors.push(`${row.id}: ${formatErr(e)}`)
      handled = 'failed'
    }
    if (handled === 'posted') summary.posted.push(row.id)
    else if (handled === 'not_posted') summary.notPosted.push(row.id)
    else if (handled === 'already_sent') summary.alreadySent.push(row.id)
    else if (handled === 'waiting') summary.waiting.push(row.id)
    else summary.failed.push(row.id)
    if (handled === 'waiting' || handled === 'failed') blocked = true
    else if (!blocked) settledThrough = row
  }

  if (settledThrough) {
    const next: LiveMissWatermark = { observedAt: settledThrough.observedAt, id: settledThrough.id }
    try {
      await deps.kv.put(LIVE_MISS_WATERMARK_KEY, JSON.stringify(next))
    } catch (e) {
      // The sent markers still stop a second post when these are read again.
      summary.errors.push(`the watermark could not be moved: ${formatErr(e)}`)
    }
  }

  summary.outcome = summary.failed.length > 0 ? 'post_failed' : rows.length === 0 ? 'no_misses' : 'ok'
  const figures = {
    read: summary.read,
    posted: summary.posted.length,
    not_posted: summary.notPosted.length,
    already_sent: summary.alreadySent.length,
    waiting: summary.waiting.length,
    failed: summary.failed.length,
    more: summary.more,
    ...(summary.failed.length ? { failed_ids: summary.failed } : {}),
    ...(summary.errors.length ? { errors: summary.errors.slice(0, 10) } : {}),
  }
  deps.log(`[${PARTNER_LIVE_MISS_NOTICE_JOB}] outcome=${summary.outcome} ${Object.entries(figures).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`)
  await deps.record(summary.outcome, figures)
  return summary
}

/** Settles one miss. Throws only for a fault the caller records as a failure. */
async function handleMiss(deps: LiveMissNoticeDeps, row: LiveMissRow, nowMs: number, summary: LiveMissNoticeSummary): Promise<Handled> {
  const sentKey = liveMissSentKey(row.id)
  if ((await deps.kv.get(sentKey)) !== null) return 'already_sent'

  const claimKey = liveMissClaimKey(row.id)
  if (deps.claims && !(await deps.claims.claim(claimKey, CLAIM_TTL_SECONDS))) return 'waiting'
  // Read again under the claim (L157): a tick whose claim lapsed may have sent it.
  if ((await deps.kv.get(sentKey)) !== null) return 'already_sent'

  const notice = composeLiveMissNotice(row)
  let post: NoticePost
  try {
    post = await deps.post(row.organizationId, notice)
  } catch (e) {
    post = { kind: 'failed', reason: formatErr(e) }
  }
  if (post.kind === 'failed') {
    summary.errors.push(`${row.id}: the notice was not posted: ${post.reason}`)
    await releaseClaimQuietly(deps.claims, claimKey)
    return 'failed'
  }

  // Settled either way: a miss not posted because nobody there asked to be told
  // is not judged again, nor recorded twice, when the watermark comes back to it.
  try {
    await deps.kv.put(sentKey, JSON.stringify({ at: new Date(nowMs).toISOString(), outcome: post.kind === 'posted' ? 'posted' : post.reason }), { expirationTtl: SENT_TTL_SECONDS })
  } catch (e) {
    // The claim holds for two ticks and the watermark moves past it now, so
    // only a watermark write that also fails could post it twice.
    summary.errors.push(`${row.id}: settled, but its sent marker could not be written: ${formatErr(e)}`)
  }
  await recordIncident(deps.kv, row, post.kind === 'posted', nowMs, summary)
  return post.kind === 'posted' ? 'posted' : 'not_posted'
}

/** One incident per miss: opened when the page saw it, paged if Slack took the post, stood down at once. Never throws. */
async function recordIncident(kv: RecoveryKv, row: LiveMissRow, paged: boolean, nowMs: number, summary: LiveMissNoticeSummary): Promise<void> {
  const subject = `${row.partnerId}:${row.id}`
  const incident: IncidentContext = {
    scope: { kind: 'org', organizationId: row.organizationId },
    subjectLabel: row.partnerName,
    onRecordError: (message) => summary.errors.push(`incident record: ${message}`),
  }
  const seenMs = Date.parse(row.observedAt)
  const seenAt = Number.isFinite(seenMs) ? new Date(seenMs).toISOString() : new Date(nowMs).toISOString()
  try {
    await keepAlerted(kv, PARTNER_LIVE_MISS_SIGNAL, subject, seenAt, incident, nowMs)
    await markSpikeSeen(kv, PARTNER_LIVE_MISS_SIGNAL, subject, Number.isFinite(seenMs) ? seenMs : nowMs)
    if (paged) await recordPaged(kv, PARTNER_LIVE_MISS_SIGNAL, subject, incident, nowMs)
    await settleRecovery(kv, PARTNER_LIVE_MISS_SIGNAL, subject, null, { ...incident, reason: 'stood_down_by_design' }, nowMs)
  } catch (e) {
    reportRecordError(incident, `${PARTNER_LIVE_MISS_SIGNAL} ${subject} not recorded: ${formatErr(e)}`)
  }
}

/** The log line a failed run writes, which the scheduled job failing page names. */
export const LIVE_MISS_RUN_FAILED_LINE = `[${PARTNER_LIVE_MISS_NOTICE_JOB}] run failed`

/**
 * A run that could not read the misses, or could not post a notice, as a failed
 * run for minute-job-failures.ts: nothing else pages either, and a run that
 * stops reporting misses must not read as healthy (L13).
 */
export function liveMissNoticeRunFailure(s: LiveMissNoticeSummary): FailedRun | undefined {
  if (s.outcome !== 'unmeasured' && s.outcome !== 'post_failed') return undefined
  console.error(`${LIVE_MISS_RUN_FAILED_LINE} outcome=${s.outcome} ${s.reason ?? s.errors.join(' | ')}`)
  return failedRun(LIVE_MISS_RUN_FAILED_LINE, {
    fault: 'in each one, the partners page live misses could not be read, or a notice of one could not be posted to Slack',
    effect: 'a partners page that missed a live update is not reported, and its notice waits until a run succeeds',
    lookFor: 'which read or post failed and the error it met',
  })
}

// ── Production wiring ───────────────────────────────────────────────────────

interface MissRecord {
  id: unknown
  organization_id: unknown
  partner_id: unknown
  reported_by: unknown
  cause: unknown
  noticed_partner_version: unknown
  noticed_profile_version: unknown
  observed_partner_version: unknown
  observed_profile_version: unknown
  since_last_notice_ms: unknown
  observed_at: unknown
}

const intOrNull = (v: unknown): number | null | undefined => (v === null ? null : typeof v === 'number' && Number.isInteger(v) ? v : undefined)
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/**
 * The misses strictly after `after`, oldest first, at most `limit`, each with
 * its partner's name and its reporter's name read inside the miss's own
 * organization. Any failed read is a failed reading, never fewer rows.
 */
export async function readLiveMisses(supabase: SupabaseClient, after: LiveMissWatermark, limit: number): Promise<LiveMissReading> {
  const { data, error } = await supabase
    .from('partner_page_live_misses')
    .select('id, organization_id, partner_id, reported_by, cause, noticed_partner_version, noticed_profile_version, observed_partner_version, observed_profile_version, since_last_notice_ms, observed_at')
    .or(`observed_at.gt."${after.observedAt}",and(observed_at.eq."${after.observedAt}",id.gt.${after.id})`)
    .order('observed_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(Math.min(limit, LIVE_MISS_NOTICE_BATCH))
  if (error) return { ok: false, error: formatErr(error) }
  if (!Array.isArray(data)) return { ok: false, error: 'the answer carried no rows' }

  const misses: Array<Omit<LiveMissRow, 'partnerName' | 'reporterName'> & { reportedBy: string | null }> = []
  for (const r of data as MissRecord[]) {
    const versions = [r.noticed_partner_version, r.noticed_profile_version, r.observed_partner_version, r.observed_profile_version, r.since_last_notice_ms].map(intOrNull)
    if (
      typeof r.id !== 'string' || typeof r.organization_id !== 'string' || typeof r.partner_id !== 'string' ||
      typeof r.cause !== 'string' || typeof r.observed_at !== 'string' || !Number.isFinite(Date.parse(r.observed_at)) ||
      !(r.reported_by === null || typeof r.reported_by === 'string') || versions.some((v) => v === undefined)
    ) {
      return { ok: false, error: `a miss row did not read as one (${typeof r.id === 'string' ? r.id : 'no id'})` }
    }
    const [np, nf, op, of, gap] = versions as Array<number | null>
    misses.push({
      id: r.id,
      organizationId: r.organization_id,
      partnerId: r.partner_id,
      reportedBy: r.reported_by,
      cause: r.cause,
      noticed: { partnerVersion: np, profileVersion: nf },
      observed: { partnerVersion: op, profileVersion: of },
      sinceLastNoticeMs: gap,
      observedAt: r.observed_at,
    })
  }
  if (misses.length === 0) return { ok: true, rows: [] }

  const partnerIds = [...new Set(misses.map((m) => m.partnerId))]
  const partners = await supabase
    .from('partner_configs')
    .select('id, name, organization_id')
    .in('id', partnerIds)
    .limit(LIVE_MISS_NOTICE_BATCH)
  if (partners.error || !Array.isArray(partners.data)) return { ok: false, error: `the partner names could not be read: ${formatErr(partners.error ?? 'no rows came back')}` }

  const userIds = [...new Set(misses.map((m) => m.reportedBy).filter((v): v is string => v !== null))]
  let users: Array<{ id: unknown; display_name: unknown; email: unknown; organization_id: unknown }> = []
  if (userIds.length > 0) {
    const read = await supabase
      .from('users')
      .select('id, display_name, email, organization_id')
      .in('id', userIds)
      .limit(LIVE_MISS_NOTICE_BATCH)
    if (read.error || !Array.isArray(read.data)) return { ok: false, error: `the reporters' names could not be read: ${formatErr(read.error ?? 'no rows came back')}` }
    users = read.data
  }

  const key = (id: unknown, org: unknown) => `${String(org)}|${String(id)}`
  const partnerNames = new Map<string, string | null>()
  for (const p of partners.data as Array<{ id: unknown; name: unknown; organization_id: unknown }>) partnerNames.set(key(p.id, p.organization_id), nonEmpty(p.name))
  const userNames = new Map<string, string | null>()
  for (const u of users) userNames.set(key(u.id, u.organization_id), nonEmpty(u.display_name) ?? nonEmpty(u.email))

  return {
    ok: true,
    rows: misses.map(({ reportedBy, ...m }) => ({
      ...m,
      partnerName: partnerNames.get(key(m.partnerId, m.organizationId)) ?? null,
      reporterName: reportedBy === null ? null : userNames.get(key(reportedBy, m.organizationId)) ?? null,
    })),
  }
}

/**
 * Posts one notice to the organization's alert channel, under its
 * configuration warnings switch, through postMessage (deliverMessage, #2331).
 * No connection, or the switch off, is not a failure: nobody there asked to be
 * told. A connection that could not be read, or a post Slack refused, is.
 * Throws when Slack gave no answer, as postMessage does.
 */
export async function postLiveMissNotice(supabase: SupabaseClient, organizationId: string, notice: LiveMissNotice): Promise<NoticePost> {
  const found = await lookupSlackConnection(supabase, organizationId)
  if (found.kind === 'none') return { kind: 'not_posted', reason: 'no_slack' }
  if (found.kind === 'unreachable') return { kind: 'failed', reason: `the Slack connection could not be read: ${found.reason}` }
  if (!found.connection.config_alerts_enabled) return { kind: 'not_posted', reason: 'alerts_off' }
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: notice.title, emoji: false } },
    ...notice.sections.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } })),
  ]
  const ts = await postMessage(found.connection.bot_token, found.connection.default_channel, blocks, notice.title)
  return ts === null ? { kind: 'failed', reason: 'Slack did not accept the post' } : { kind: 'posted' }
}

/**
 * The run as the scheduled handler makes it: the reads raced against
 * LIVE_MISS_READ_DEADLINE_MS, and every run written to job_runs.
 */
export function runLiveMissNoticeForEnv(opts: {
  supabase: SupabaseClient
  kv: RecoveryKv
  claims: AlertClaims | undefined
  localDev: boolean
}): Promise<LiveMissNoticeSummary> {
  const startedAt = Date.now()
  return runLiveMissNotice({
    kv: opts.kv,
    claims: opts.claims,
    read: async (after, limit) => {
      const raced = await raceDeadline(() => readLiveMisses(opts.supabase, after, limit), LIVE_MISS_READ_DEADLINE_MS)
      if (raced.kind === 'timed_out') return { ok: false, error: `the database did not answer within ${LIVE_MISS_READ_DEADLINE_MS / 1000} seconds` }
      if (raced.kind === 'threw') return { ok: false, error: formatErr(raced.error) }
      return raced.value
    },
    post: (organizationId, notice) => postLiveMissNotice(opts.supabase, organizationId, notice),
    record: (outcome, summary) => recordFinishedJobRun(opts.supabase, PARTNER_LIVE_MISS_NOTICE_JOB, startedAt, { outcome, summary }),
    now: Date.now,
    log: (line) => console.log(line),
    localDev: opts.localDev,
  })
}
