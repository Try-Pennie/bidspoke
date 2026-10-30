/**
 * Pages through Better Stack, never Slack, when Slack refuses Bidspoke's alert
 * posts (#2364; Dan's decisions of 2026-10-26).
 *
 * WHY. A Reconnect at 10:05 PM ET on 2026-10-22 saved a bot token that was not
 * in #statuspage. For three days about 3,400 alert posts were refused with
 * not_in_channel, about 2 a minute, and nothing paged: every page that could
 * have said so was itself a Slack post, and the nobody can be told page
 * (nobody-told-page.ts) fires only when the database does not answer. Measured
 * from 2026-10-19 to 23, Workers Logs hold no `[slack]` error line of any kind,
 * so the baseline is zero and this judges a run of refusals, not a rate.
 *
 * WHAT IT READS. Every post writes one outcome line (slack-post-outcome.ts),
 * which the tail Worker copies into slack_post_outcomes. Each minute this reads
 * slack_refusal_runs: per channel, the newest delivered post and the RUN of
 * refusals after it. A channel is matched to its organization by the Slack
 * connections' default channel. A run on a channel no connection names (a
 * workflow's own channel) still pages, with no organization, and has no
 * incident record or Slack all clear, since no organization's Slack is known
 * to name it.
 *
 * WHEN IT PAGES (decisions 1 and 2, classes in slack-refusal.ts). A run holding
 * any destination refusal (the bot cannot post where it is pointed) pages at
 * once. Otherwise TRANSIENT_RUN_COUNT temporary refusals with no delivered post
 * between, spanning TRANSIENT_RUN_SPAN_MS, page; a lone 429, or a burst inside
 * a second, does not.
 *
 * THE PAGE (decisions 3 and 4) is one fixed line to the Better Stack source,
 * through the shared sender (better-stack-line.ts), matched by the Better
 * Stack alert SLACK_REFUSING_ALERT_NAME, which routes to the same escalation as
 * the nobody can be told alert. Its fields are pinned whole by a test and carry
 * no applicant data. ALERT_CLAIM, keyed by organization and minute, makes a
 * doubled tick page once; while the incident stands it is sent again every
 * RESEND_INTERVAL_MS, never every minute.
 *
 * THE INCIDENT (`slack-post-refused` in incident-signals.ts) opens with the
 * run's first refusal, before any page (keepAlerted), and `recordPageOutcome`
 * records each page Better Stack answered: paged once it has taken one, and not
 * delivered when it refused one or its secrets are unset (#3056). A page Better
 * Stack does not take (refused, unanswered, its secrets unset) writes a distinct
 * line and no paged record, is tried again the next minute, records the run as failed in
 * job_runs, and fails the run (failedRun), so three such minutes page through
 * the failing scheduled job alert as well. The all clear says it failed and when.
 *
 * STANDING DOWN. A delivered post ends the run, which stops the lines. Once no
 * run has been seen for RECOVERY_REARM_MINUTES, and a post was delivered after
 * the last refusal (so a run that only aged out of the window never reads as
 * recovered), ONE Slack all clear names the start, the end, the count by
 * reason and the lost alerts by title (decision 5: title only, never a body),
 * and settles the incident.
 *
 * WHAT IT CANNOT MEASURE IT SAYS. A record that cannot be read, a tail Worker
 * that has written no cron delivery for TAIL_STALE_MS (so no post outcome can
 * be reaching the record either), or Slack connections that cannot be read is
 * reported as unmeasured, never as no refusals: it sends nothing, ends no
 * incident, records the run in job_runs and fails it.
 *
 * Who may run it: the bidding Worker's minute cron only. Whose data: every
 * organization's Slack channels, read as service_role; a page names one
 * organization id and no channel, token or alert text.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { activeKey, announceRecovery, keepAlerted, markSpikeSeen, recordPageOutcome, recoveryKey, RECOVERY_TTL_SECONDS, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { MINUTE_ALERT_CLAIM_TTL_SECONDS, minuteAlertClaimKey, minuteAllClearClaim, readEverySlackConnection } from './alert-fanout'
import { releaseClaimQuietly, type AlertClaims } from './alert-claim'
import { sendBetterStackLine, type BetterStackLineOptions, type BetterStackSendOutcome } from './better-stack-line'
import { failedRun, type FailedRun } from './minute-job-failures'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'
import { formatErr } from './format-error'
import { slackRefusalLabel, type SlackRefusalKind } from './slack-refusal'
import { etTime, sendSlackRefusalAllClear } from './slack'

/** The job's id in CRON_JOBS, its heartbeat and its job_runs rows. */
export const SLACK_REFUSAL_WATCH_JOB = 'slack-refusal-watch'

export const SLACK_REFUSED_SIGNAL = 'slack-post-refused'

/**
 * The Better Stack alert that matches on SLACK_REFUSED_LINE (decision 3),
 * created by hand after the merge (docs/reference/observability.md). The alert
 * matches on the line, never on this name.
 */
export const SLACK_REFUSING_ALERT_NAME = 'Bidspoke Slack refusing alerts'

/** The one line the alert matches on, sent as the event's `message`. */
export const SLACK_REFUSED_LINE = 'bidspoke Slack is refusing alert posts'

/** Temporary refusals with no delivered post between that page (decision 1). */
export const TRANSIENT_RUN_COUNT = 5

/** ...when they span at least this long (decision 1). */
export const TRANSIENT_RUN_SPAN_MS = 5 * 60_000

/** How often a standing incident is sent again. */
export const RESEND_INTERVAL_MS = 5 * 60_000

/** A tail Worker that has written no cron delivery for this long is not copying post outcomes either. */
export const TAIL_STALE_MS = 10 * 60_000

/** How far back a run is read: the record's retention, since a run can last days, as the 2026-10-23 one did. */
export const RUN_WINDOW_MS = 7 * 24 * 60 * 60_000

/** How long the send may take. */
export const SLACK_REFUSAL_PAGE_DEADLINE_MS = 5_000

/** How many lost alert titles the all clear lists before it counts the rest. */
export const ALL_CLEAR_TITLES_SHOWN = 15

/** The subject of a run on a channel no Slack connection names as its default. */
export const UNATTRIBUTED = 'unattributed'

const STATE_PREFIX = 'slack-post-refused:state:'

/** The log line a failed run is searched for by, from the failing job page. */
export const PAGE_FAILED_LINE = '[slack-refusal-watch] Better Stack did not take the page'
export const UNMEASURED_LINE = '[slack-refusal-watch] unmeasured:'

export interface RefusalReasonCount {
  reason: string | null
  status: number | null
  kind: SlackRefusalKind
  refused: number
}

export interface TitleCount {
  title: string | null
  refused: number
}

/** One row of slack_refusal_runs. */
export interface ChannelRun {
  channel: string
  lastDeliveredAt: string | null
  refused: number
  destination: number
  firstRefusedAt: string | null
  lastRefusedAt: string | null
  reasons: RefusalReasonCount[]
  titles: TitleCount[]
}

/** The one row of slack_refusal_summary. */
export interface RefusalSummary {
  refused: number
  firstRefusedAt: string | null
  lastRefusedAt: string | null
  reasons: RefusalReasonCount[]
  titles: TitleCount[]
}

/** The only fields a page carries. */
export interface SlackRefusedEvent {
  message: typeof SLACK_REFUSED_LINE
  /** Null for a channel no Slack connection names, and for a drill. */
  organization_id: string | null
  /** destination or transient, or drill for a page sent on demand. */
  kind: SlackRefusalKind | 'drill'
  /** The commonest reason of that kind: Slack's error code, `HTTP <status>`, or `no answer`. */
  reason: string
  /** Refused posts in the run. */
  refused: number
  /** When the incident started: its first refusal, RFC 3339. */
  since: string
  /** When this page was sent, RFC 3339; Better Stack reads `dt` as the event time. */
  dt: string
}

/** The one place a page's body is built. */
export function slackRefusedEvent(orgId: string | null, kind: SlackRefusedEvent['kind'], reason: string, refused: number, sinceIso: string, nowMs: number): SlackRefusedEvent {
  return { message: SLACK_REFUSED_LINE, organization_id: orgId, kind, reason, refused, since: sinceIso, dt: new Date(nowMs).toISOString() }
}

export interface SlackRefusalConnection {
  bot_token: string
  default_channel: string
}

export interface SlackRefusalWatchDeps {
  kv: RecoveryKv
  claims?: AlertClaims
  now: () => number
  /** The newest cron_tick_deliveries row's time, or null for none. Throws when it cannot be read. */
  readNewestDelivery: () => Promise<string | null>
  /** slack_refusal_runs from `sinceIso`. Throws when it cannot be read. */
  readRuns: (sinceIso: string) => Promise<ChannelRun[]>
  /** Every organization's Slack connection, or null when they cannot be read. */
  readConnections: () => Promise<Map<string, SlackRefusalConnection> | null>
  /** slack_refusal_summary. Throws when it cannot be read. */
  readSummary: (channels: string[], fromIso: string, toIso: string) => Promise<RefusalSummary>
  sendPage: (event: SlackRefusedEvent) => Promise<BetterStackSendOutcome>
  sendAllClear: (slack: SlackRefusalConnection, channel: string, message: { title: string; sections: string[] }) => Promise<boolean>
  recordRun?: (ending: JobRunEnding) => Promise<void>
}

export interface SlackRefusalWatchSummary {
  measured: boolean
  /** Why nothing could be judged this minute, or null. */
  unmeasured: string | null
  /** Subjects (organization ids, or UNATTRIBUTED) whose page Better Stack took this minute. */
  paged: string[]
  /** Subjects whose page Better Stack did not take. */
  pageFailed: string[]
  /** Subjects whose incident stands with no page due this minute. */
  standing: string[]
  allClear: string[]
  errors: string[]
}

/** What a subject's incident has sent, kept beside alert-recovery's markers. */
interface PageState {
  firstSentAt: string | null
  lastSentAt: string | null
  firstFailedAt: string | null
  /** The newest refusal seen in the run, so recovery needs a post delivered after it. */
  lastRefusedAt: string | null
}

const EMPTY_STATE: PageState = { firstSentAt: null, lastSentAt: null, firstFailedAt: null, lastRefusedAt: null }

const isoOrNull = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null

function parseState(raw: string | null): PageState {
  if (raw === null) return { ...EMPTY_STATE }
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    return { firstSentAt: isoOrNull(p.firstSentAt), lastSentAt: isoOrNull(p.lastSentAt), firstFailedAt: isoOrNull(p.firstFailedAt), lastRefusedAt: isoOrNull(p.lastRefusedAt) }
  } catch {
    return { ...EMPTY_STATE }
  }
}

/** Whether a run pages: any destination refusal, or enough temporary ones over long enough. */
export function runPages(run: ChannelRun): boolean {
  if (run.refused <= 0) return false
  if (run.destination > 0) return true
  const first = run.firstRefusedAt ? Date.parse(run.firstRefusedAt) : NaN
  const last = run.lastRefusedAt ? Date.parse(run.lastRefusedAt) : NaN
  return run.refused >= TRANSIENT_RUN_COUNT && Number.isFinite(first) && Number.isFinite(last) && last - first >= TRANSIENT_RUN_SPAN_MS
}

/** Counts merged by label, commonest first, ties by label. */
function mergeReasons(reasons: readonly RefusalReasonCount[]): Array<{ label: string; kind: SlackRefusalKind; refused: number }> {
  const byLabel = new Map<string, { label: string; kind: SlackRefusalKind; refused: number }>()
  for (const r of reasons) {
    const label = slackRefusalLabel(r.reason, r.status)
    const seen = byLabel.get(label)
    if (seen) seen.refused += r.refused
    else byLabel.set(label, { label, kind: r.kind, refused: r.refused })
  }
  return [...byLabel.values()].sort((a, b) => b.refused - a.refused || a.label.localeCompare(b.label))
}

const count = (n: number): string => n.toLocaleString('en-US')

/** The all clear's title and sentences, separate from the send so the words can be tested. */
export function slackRefusalAllClearMessage(input: { startedAt: string; summary: RefusalSummary; firstFailedAt: string | null; firstSentAt: string | null }): { title: string; sections: string[] } {
  const s = input.summary
  const sections: string[] = []
  if (s.refused > 0) {
    const reasons = mergeReasons(s.reasons).map((r) => `${count(r.refused)} ${r.label}`).join(', ')
    sections.push(`Slack is taking alert posts again. It refused ${count(s.refused)} ${s.refused === 1 ? 'post' : 'posts'} between ${etTime(s.firstRefusedAt ?? input.startedAt)} and ${etTime(s.lastRefusedAt ?? input.startedAt)}: ${reasons}.`)
    const titled = s.titles.filter((t) => t.title !== null).sort((a, b) => b.refused - a.refused || (a.title ?? '').localeCompare(b.title ?? ''))
    const untitled = s.titles.filter((t) => t.title === null).reduce((n, t) => n + t.refused, 0)
    const parts = titled.slice(0, ALL_CLEAR_TITLES_SHOWN).map((t) => `${t.title} (${count(t.refused)})`)
    const rest = titled.slice(ALL_CLEAR_TITLES_SHOWN)
    if (rest.length > 0) parts.push(`${rest.length} more ${rest.length === 1 ? 'title' : 'titles'} (${count(rest.reduce((n, t) => n + t.refused, 0))})`)
    if (untitled > 0) parts.push(`${count(untitled)} untitled`)
    sections.push(`Alerts that did not reach Slack, by title: ${parts.join(', ')}.`)
  } else {
    sections.push(`Slack is taking alert posts again, after refusing them from ${etTime(input.startedAt)}. No refused post from it is left on record (they are kept for 7 days), so the alerts lost cannot be listed.`)
  }
  if (input.firstFailedAt !== null) {
    sections.push(input.firstSentAt !== null
      ? `The Better Stack page for this first failed at ${etTime(input.firstFailedAt)}; one was accepted at ${etTime(input.firstSentAt)}.`
      : `The Better Stack page for this first failed at ${etTime(input.firstFailedAt)}, and none was accepted, so nobody was paged.`)
  }
  return { title: 'Recovered', sections }
}

function failureLine(who: string, out: Exclude<BetterStackSendOutcome, { outcome: 'sent' }>): string {
  switch (out.outcome) {
    case 'refused':
      return `${PAGE_FAILED_LINE}: Better Stack refused the Slack refusal page for ${who} with ${out.status}; nobody was paged this minute, and the next minute tries again`
    case 'no_answer':
      return `${PAGE_FAILED_LINE}: the Slack refusal page for ${who} got no answer from Better Stack in ${out.deadline_ms} ms; it may have landed, and the next minute tries again`
    case 'threw':
      return `${PAGE_FAILED_LINE}: the Slack refusal page for ${who} could not be sent to Better Stack (${out.error}); the next minute tries again`
    case 'not_configured':
      return `${PAGE_FAILED_LINE}: the Slack refusal page for ${who} was not sent because ${out.missing.join(' and ')} ${out.missing.length === 1 ? 'is' : 'are'} unset; nobody is paged until it is set`
  }
}

/** One minute of the check. Never throws; what it could not do is in the summary. */
export async function runSlackRefusalWatch(deps: SlackRefusalWatchDeps): Promise<SlackRefusalWatchSummary> {
  const now = deps.now()
  const nowIso = new Date(now).toISOString()
  const summary: SlackRefusalWatchSummary = { measured: true, unmeasured: null, paged: [], pageFailed: [], standing: [], allClear: [], errors: [] }

  const record = async (ending: JobRunEnding): Promise<void> => {
    try {
      await deps.recordRun?.(ending)
    } catch (e) {
      console.error(`[slack-refusal-watch] could not record the run: ${formatErr(e)}`)
    }
  }

  const unmeasured = async (why: string): Promise<SlackRefusalWatchSummary> => {
    summary.measured = false
    summary.unmeasured = why
    console.error(`${UNMEASURED_LINE} ${why}. This minute is not a reading of no refusals: nothing is paged and no incident ends.`)
    await record({ outcome: 'unmeasured', detail: why })
    return summary
  }

  let newest: string | null
  try {
    newest = await deps.readNewestDelivery()
  } catch (e) {
    return unmeasured(`could not read cron_tick_deliveries: ${formatErr(e)}`)
  }
  if (newest === null) return unmeasured('no cron delivery on record, so the tail Worker that copies Slack post outcomes may not be running')
  const newestMs = Date.parse(newest)
  if (!Number.isFinite(newestMs) || now - newestMs > TAIL_STALE_MS) {
    return unmeasured(`the tail Worker has written no cron delivery since ${newest}, so Slack post outcomes may not be reaching slack_post_outcomes`)
  }

  let runs: ChannelRun[]
  try {
    runs = await deps.readRuns(new Date(now - RUN_WINDOW_MS).toISOString())
  } catch (e) {
    return unmeasured(`could not read slack_post_outcomes: ${formatErr(e)}`)
  }

  let connections: Map<string, SlackRefusalConnection> | null
  try {
    connections = await deps.readConnections()
  } catch (e) {
    console.error(`[slack-refusal-watch] the Slack connections read threw: ${formatErr(e)}`)
    connections = null
  }
  if (connections === null) return unmeasured('could not read the Slack connections, so no channel can be matched to its organization')

  const orgsByChannel = new Map<string, string[]>()
  for (const [orgId, c] of connections) orgsByChannel.set(c.default_channel, [...(orgsByChannel.get(c.default_channel) ?? []), orgId])
  const runByChannel = new Map(runs.map((r) => [r.channel, r]))

  const paging = new Map<string, ChannelRun[]>()
  for (const r of runs) {
    if (!runPages(r)) continue
    for (const subject of orgsByChannel.get(r.channel) ?? [UNATTRIBUTED]) paging.set(subject, [...(paging.get(subject) ?? []), r])
  }

  const stateKey = (subject: string) => `${STATE_PREFIX}${subject}`
  const readState = async (subject: string): Promise<PageState> => parseState(await deps.kv.get(stateKey(subject)))
  const writeState = (subject: string, state: PageState) => deps.kv.put(stateKey(subject), JSON.stringify(state), { expirationTtl: RECOVERY_TTL_SECONDS })
  const incident = (orgId: string): IncidentContext => ({
    scope: { kind: 'org', organizationId: orgId },
    subjectLabel: 'Slack alerts',
    onRecordError: (m) => summary.errors.push(m),
  })

  for (const [subject, subjectRuns] of paging) {
    try {
      await standing(subject, subjectRuns)
    } catch (e) {
      const line = `[slack-refusal-watch] ${subject} could not be judged: ${formatErr(e)}`
      console.error(line)
      summary.errors.push(line)
    }
  }
  for (const [orgId, connection] of connections) {
    if (paging.has(orgId)) continue
    try {
      await standDown(orgId, connection)
    } catch (e) {
      const line = `[slack-refusal-watch] the all clear for ${orgId} could not be judged: ${formatErr(e)}`
      console.error(line)
      summary.errors.push(line)
    }
  }
  if (!paging.has(UNATTRIBUTED)) {
    try {
      if ((await deps.kv.get(stateKey(UNATTRIBUTED))) !== null) {
        await deps.kv.delete(stateKey(UNATTRIBUTED))
        console.warn('[slack-refusal-watch] a channel no Slack connection names stopped refusing; no organization\'s Slack names it, so no all clear is sent')
      }
    } catch (e) {
      summary.errors.push(`[slack-refusal-watch] the unattributed page state could not be cleared: ${formatErr(e)}`)
    }
  }

  const did = summary.pageFailed.length > 0 ? 'failed' : summary.paged.length > 0 ? 'paged' : summary.allClear.length > 0 ? 'all_clear' : null
  if (did !== null) {
    await record({
      outcome: did,
      detail: summary.errors.length > 0 ? summary.errors.join(' | ').slice(0, 2_000) : undefined,
      summary: { paged: summary.paged, page_failed: summary.pageFailed, standing: summary.standing, all_clear: summary.allClear },
    })
  }
  return summary

  async function standing(subject: string, subjectRuns: ChannelRun[]): Promise<void> {
    const orgId = subject === UNATTRIBUTED ? null : subject
    const who = orgId ? `organization ${orgId}` : 'a channel no Slack connection names'
    const refused = subjectRuns.reduce((n, r) => n + r.refused, 0)
    const kind: SlackRefusalKind = subjectRuns.some((r) => r.destination > 0) ? 'destination' : 'transient'
    const reason = mergeReasons(subjectRuns.flatMap((r) => r.reasons)).find((r) => r.kind === kind)?.label ?? kind
    const firsts = subjectRuns.map((r) => r.firstRefusedAt).filter((v): v is string => v !== null).sort()
    const lasts = subjectRuns.map((r) => r.lastRefusedAt).filter((v): v is string => v !== null).sort()
    const first = firsts[0] ?? nowIso
    const lastRefusedAt = lasts.at(-1) ?? null

    let since = first
    const ctx = orgId ? incident(orgId) : null
    if (orgId && ctx) {
      await keepAlerted(deps.kv, SLACK_REFUSED_SIGNAL, orgId, first, ctx, now)
      await markSpikeSeen(deps.kv, SLACK_REFUSED_SIGNAL, orgId, now)
      since = (await deps.kv.get(recoveryKey(SLACK_REFUSED_SIGNAL, orgId))) ?? first
    }

    let state = await readState(subject)
    if (lastRefusedAt !== null && state.lastRefusedAt !== lastRefusedAt) {
      state = { ...state, lastRefusedAt }
      await writeState(subject, state)
    }
    if (state.lastSentAt !== null && now - Date.parse(state.lastSentAt) < RESEND_INTERVAL_MS) {
      summary.standing.push(subject)
      return
    }

    // One page per organization per minute, however many deliveries of the tick see it.
    const minute = new Date(Math.floor(now / 60_000) * 60_000).toISOString()
    const claimKey = minuteAlertClaimKey('page', SLACK_REFUSED_SIGNAL, `${subject}:${minute}`)
    if (deps.claims && !(await deps.claims.claim(claimKey, MINUTE_ALERT_CLAIM_TTL_SECONDS))) {
      console.log(`[slack-refusal-watch] the page for ${who} this minute is claimed by another tick`)
      summary.standing.push(subject)
      return
    }

    let out: BetterStackSendOutcome
    try {
      out = await deps.sendPage(slackRefusedEvent(orgId, kind, reason, refused, since, now))
    } catch (e) {
      out = { outcome: 'threw', error: formatErr(e) }
    }
    const delivered = out.outcome === 'sent'
    // Recorded delivered or not (#3056). A page Better Stack refused, or one with no
    // secrets to send it with, reached nobody; an unanswered or throwing one may
    // have landed, so it is recorded as neither.
    const answered = delivered || out.outcome === 'refused' || out.outcome === 'not_configured'
    if (orgId && ctx && answered) await recordPageOutcome(deps.kv, SLACK_REFUSED_SIGNAL, orgId, ctx, now, delivered)
    if (out.outcome === 'sent') {
      await writeState(subject, { ...state, lastSentAt: nowIso, firstSentAt: state.firstSentAt ?? nowIso })
      console.warn(`[slack-refusal-watch] paged Better Stack for ${who}: ${refused} ${kind} refusals since ${since}, the commonest ${reason}`)
      summary.paged.push(subject)
      return
    }
    const line = failureLine(who, out)
    console.error(line)
    summary.errors.push(line)
    summary.pageFailed.push(subject)
    await writeState(subject, { ...state, firstFailedAt: state.firstFailedAt ?? nowIso })
    // Freed so another delivery this minute may try; an unanswered send may have
    // landed, so its claim is kept and the next minute (a new key) tries again.
    if (out.outcome !== 'no_answer') await releaseClaimQuietly(deps.claims, claimKey)
  }

  async function standDown(orgId: string, connection: SlackRefusalConnection): Promise<void> {
    const channel = connection.default_channel
    const delivered = await announceRecovery(
      deps.kv,
      SLACK_REFUSED_SIGNAL,
      orgId,
      null,
      incident(orgId),
      async (alertedAt) => {
        const state = await readState(orgId)
        let refusals: RefusalSummary
        try {
          refusals = await deps.readSummary([channel], alertedAt, nowIso)
        } catch (e) {
          const line = `[slack-refusal-watch] the all clear for ${orgId} is held: slack_refusal_summary could not be read: ${formatErr(e)}`
          console.error(line)
          summary.errors.push(line)
          return false
        }
        const message = slackRefusalAllClearMessage({ startedAt: alertedAt, summary: refusals, firstFailedAt: state.firstFailedAt, firstSentAt: state.firstSentAt })
        return deps.sendAllClear(connection, channel, message)
      },
      {
        now,
        claim: minuteAllClearClaim(deps.claims, SLACK_REFUSED_SIGNAL, orgId),
        // A run that only aged out of the window is not a recovery: a post must
        // have been delivered after the last refusal seen (L98).
        hasEvidence: async () => {
          const deliveredAt = runByChannel.get(channel)?.lastDeliveredAt ?? null
          if (deliveredAt === null) return false
          const state = await readState(orgId)
          const after = state.lastRefusedAt ?? (await deps.kv.get(activeKey(SLACK_REFUSED_SIGNAL, orgId)))
          return after === null || Date.parse(deliveredAt) > Date.parse(after)
        },
      },
    )
    if (!delivered) return
    await deps.kv.delete(stateKey(orgId))
    console.warn(`[slack-refusal-watch] all clear sent for organization ${orgId}`)
    summary.allClear.push(orgId)
  }
}

/** The run's failure for completeAfter (minute-job-failures.ts), in this job's own words. */
export function slackRefusalWatchRunFailure(s: SlackRefusalWatchSummary): FailedRun | undefined {
  if (s.pageFailed.length > 0) {
    return failedRun(PAGE_FAILED_LINE, {
      fault: 'in each one, Better Stack did not take the page saying Slack is refusing alert posts (it refused it, did not answer, or its secrets are unset)',
      effect: 'nobody is paged while Slack refuses Bidspoke\'s alert posts, so alerts are being lost without anyone knowing',
      lookFor: 'what Better Stack answered (a 401 or 403 means the BETTERSTACK_OUTAGE_TOKEN secret is wrong)',
    })
  }
  if (!s.measured) {
    return failedRun(UNMEASURED_LINE, {
      fault: 'in each one, it could not measure whether Slack is refusing alert posts',
      effect: 'a run of refused alert posts would not be paged',
      lookFor: 'which read could not be made (the slack_post_outcomes record, the tail Worker\'s cron deliveries, or the Slack connections)',
    })
  }
  return undefined
}

/** Sends ONE drill page on demand (#2364), through the same request as a real page, and answers what happened. */
export async function drillSlackRefusalPage(options: BetterStackLineOptions & { now?: () => number }): Promise<BetterStackSendOutcome> {
  const nowMs = (options.now ?? Date.now)()
  return sendBetterStackLine(options, slackRefusedEvent(null, 'drill', 'drill', 0, new Date(nowMs).toISOString(), nowMs), SLACK_REFUSAL_PAGE_DEADLINE_MS)
}

// ── Production wiring ───────────────────────────────────────────────────────

const toIso = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined) return null
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  if (!Number.isFinite(ms)) throw new Error(`${what} is not a time: ${JSON.stringify(v)}`)
  return new Date(ms).toISOString()
}

const toCount = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${what} is not a count: ${JSON.stringify(v)}`)
  return v
}

function toReasons(v: unknown, what: string): RefusalReasonCount[] {
  if (!Array.isArray(v)) throw new Error(`${what} reasons is not a list`)
  return v.map((r: unknown) => {
    const o = (r ?? {}) as Record<string, unknown>
    if (o.kind !== 'destination' && o.kind !== 'transient') throw new Error(`${what} has a reason of kind ${JSON.stringify(o.kind)}`)
    return {
      reason: typeof o.reason === 'string' ? o.reason : null,
      status: typeof o.status === 'number' ? o.status : null,
      kind: o.kind,
      refused: toCount(o.refused, `${what} reason count`),
    }
  })
}

function toTitles(v: unknown, what: string): TitleCount[] {
  if (!Array.isArray(v)) throw new Error(`${what} titles is not a list`)
  return v.map((t: unknown) => {
    const o = (t ?? {}) as Record<string, unknown>
    return { title: typeof o.title === 'string' ? o.title : null, refused: toCount(o.refused, `${what} title count`) }
  })
}

/** A row of slack_refusal_runs, refused when it does not hold what the function returns (L50). */
export function channelRunFromRow(row: Record<string, unknown>): ChannelRun {
  const channel = typeof row.channel === 'string' ? row.channel : null
  if (channel === null) throw new Error('slack_refusal_runs returned a row with no channel')
  return {
    channel,
    lastDeliveredAt: toIso(row.last_delivered_at, `${channel} last delivery`),
    refused: toCount(row.refused, `${channel} refused`),
    destination: toCount(row.destination, `${channel} destination`),
    firstRefusedAt: toIso(row.first_refused_at, `${channel} first refusal`),
    lastRefusedAt: toIso(row.last_refused_at, `${channel} last refusal`),
    reasons: toReasons(row.reasons, channel),
    titles: toTitles(row.titles, channel),
  }
}

/** The minute job, as index.ts starts it. */
export async function runSlackRefusalWatchForEnv(
  supabase: SupabaseClient,
  env: Pick<Env, 'IDEMPOTENCY' | 'BETTERSTACK_OUTAGE_TOKEN' | 'BETTERSTACK_OUTAGE_URL'>,
  claims: AlertClaims | undefined,
): Promise<SlackRefusalWatchSummary> {
  const startedAt = Date.now()
  return runSlackRefusalWatch({
    kv: env.IDEMPOTENCY,
    claims,
    now: Date.now,
    readNewestDelivery: async () => {
      const { data, error } = await supabase
        .from('cron_tick_deliveries')
        .select('occurred_at')
        .order('occurred_at', { ascending: false })
        .limit(1)
      if (error) throw new Error(formatErr(error))
      const rows = (data ?? []) as Array<{ occurred_at: unknown }>
      return rows.length === 0 ? null : toIso(rows[0].occurred_at, 'the newest cron delivery')
    },
    readRuns: async (sinceIso) => {
      const res = await supabase.rpc('slack_refusal_runs', { p_since: sinceIso })
      if (res.error) throw new Error(formatErr(res.error))
      const data: unknown = res.data
      if (!Array.isArray(data)) throw new Error('slack_refusal_runs did not return a list')
      return (data as Array<Record<string, unknown>>).map(channelRunFromRow)
    },
    readConnections: async () => {
      const read = await readEverySlackConnection(supabase, '[slack-refusal-watch]', 'measure-from-database')
      if (read.kind === 'unreachable') return null
      return new Map([...read.connections].map(([orgId, c]) => [orgId, { bot_token: c.bot_token, default_channel: c.default_channel }]))
    },
    readSummary: async (channels, fromIso, untilIso) => {
      const res = await supabase.rpc('slack_refusal_summary', { p_channels: channels, p_from: fromIso, p_to: untilIso })
      if (res.error) throw new Error(formatErr(res.error))
      const data: unknown = res.data
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
      if (!row) throw new Error('slack_refusal_summary returned no row')
      return {
        refused: toCount(row.refused, 'summary refused'),
        firstRefusedAt: toIso(row.first_refused_at, 'summary first refusal'),
        lastRefusedAt: toIso(row.last_refused_at, 'summary last refusal'),
        reasons: toReasons(row.reasons, 'summary'),
        titles: toTitles(row.titles, 'summary'),
      }
    },
    sendPage: (event) => sendBetterStackLine({ token: env.BETTERSTACK_OUTAGE_TOKEN, url: env.BETTERSTACK_OUTAGE_URL }, event, SLACK_REFUSAL_PAGE_DEADLINE_MS),
    sendAllClear: (slack, channel, message) => sendSlackRefusalAllClear(slack, channel, message),
    recordRun: (ending) => recordFinishedJobRun(supabase, SLACK_REFUSAL_WATCH_JOB, startedAt, ending),
  })
}
