/**
 * The words of the dashboard's incident record (#2101), as settled with Dan on
 * 2026-10-14 (docs/design/incidents-card.html): the Incidents card grouped by ET
 * day with only the hour on each row, and each open incident one line under the
 * page header. Every field comes resolved from the worker; this only composes
 * the sentences, so the card and the line say a thing one way.
 */
import type { Incident, IncidentFailedRuns, OngoingIncident } from './api'
import { etDayHeading, etDayKey, formatEtClock, formatEtDayTime } from './dates'

/**
 * When the incident record began: the deploy of #2106 on 14 October 2026, taken
 * from midnight ET. Alerts before it were never recorded, so a window reaching
 * further back than this has not seen "no incidents", only no record.
 */
export const INCIDENT_RECORDING_BEGAN = '2026-10-14T00:00:00-04:00'

const recordingBeganWords = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })
  .format(new Date(INCIDENT_RECORDING_BEGAN))

export function slackPagesText(n: number): string {
  return n === 1 ? '1 Slack page' : `${n} Slack pages`
}

/** The signal as a reader knows it; an unrecognised one keeps its raw key beside the label. */
export function signalText(i: Pick<Incident, 'signal' | 'signal_label' | 'signal_known'>): string {
  return i.signal_known ? i.signal_label : `${i.signal_label} (${i.signal})`
}

/**
 * "2:34 PM to 4:06 PM" under the start's day heading; an end on a later day carries its day.
 * With no recorded end it is the start alone, and the duration column says why, so the time
 * column stays one line at laptop width.
 */
export function incidentTimeRange(i: Incident): string {
  const start = formatEtClock(i.started_at)
  if (i.state === 'end_not_recorded' || !i.ended_at) return start
  const end = etDayKey(i.ended_at) === etDayKey(i.started_at) ? formatEtClock(i.ended_at) : formatEtDayTime(i.ended_at)
  return `${start} to ${end}`
}

/** The duration column: the measured span, or that the end was not recorded (there is no span to give). */
export function durationColumnText(i: Incident): string {
  if (i.state === 'end_not_recorded' || !i.ended_at) return 'End not recorded'
  return i.duration ?? ''
}

export interface IncidentDay {
  key: string
  heading: string
  incidents: Incident[]
}

/** The incidents under one heading per ET start day, in the order given; the first heading says the times are ET. */
export function groupIncidentsByDay(incidents: readonly Incident[], now: number): IncidentDay[] {
  const days: IncidentDay[] = []
  for (const i of incidents) {
    const key = etDayKey(i.started_at)
    const last = days[days.length - 1]
    if (last && last.key === key) {
      last.incidents.push(i)
      continue
    }
    const heading = etDayHeading(i.started_at, now)
    days.push({ key, heading: days.length === 0 ? `${heading} (times ET)` : heading, incidents: [i] })
  }
  return days
}

/** "Partner reachability on api.tripoint.com, since 4:52 PM ET, 1 hour 20 minutes so far. 1 Slack page." */
export function ongoingIncidentSentence(i: OngoingIncident, now: number): string {
  const since = etDayKey(i.started_at) === etDayKey(now) ? formatEtClock(i.started_at) : formatEtDayTime(i.started_at)
  const soFar = i.so_far ? `, ${i.so_far}` : ''
  return `${signalText(i)} on ${i.subject_name}, since ${since} ET${soFar}. ${slackPagesText(i.pages_sent)}.`
}

/**
 * What the card says with nothing in it. A window reaching back before the
 * record began says so, and "other" keeps it from contradicting an ongoing
 * incident shown above it.
 */
export function emptyIncidentsText(days: number, now: number, hasOngoing: boolean): string {
  const other = hasOngoing ? 'other ' : ''
  const since = now - days * 24 * 60 * 60 * 1000
  if (since < Date.parse(INCIDENT_RECORDING_BEGAN)) return `No ${other}incidents since recording began on ${recordingBeganWords}`
  return `No ${other}incidents in the last ${days} days`
}

/** "12 failed runs", "1 failed run". */
export function failedRunsText(n: number): string {
  return n === 1 ? '1 failed run' : `${n} failed runs`
}

/**
 * What a card row says about its failed runs after its Slack pages (#2102,
 * settled with Dan on 2026-10-15): a link into the workflow page narrowed to
 * them, plain text for 0, and nothing at all when none of the span is still kept
 * (nothing to open) or the count could not be read (never shown as 0).
 */
export function failedRunsCell(i: Incident): { text: string; href: string | null } | null {
  const f = i.failed_runs
  if (!f || f.state !== 'counted') return null
  const text = failedRunsText(f.count)
  if (f.count === 0) return { text, href: null }
  return { text, href: `/workflows/${f.workflow_id}?incident=${encodeURIComponent(i.id)}` }
}

/** The narrowed run list's title, counted from its own rows so the two never disagree. */
export function incidentRunsTitle(count: number): string {
  return `${failedRunsText(count)} in this incident`
}

/**
 * '"ACRO_GATEWAY", Today 2:34 PM to 4:06 PM ET': the match and the incident's
 * span. An end on another day carries its day; with no recorded end it is since
 * the start.
 */
export function incidentRunsSpanLine(body: IncidentFailedRuns, now: number): string {
  const { match, started_at, ended_at } = body.incident
  const day = etDayHeading(started_at, now)
  const start = formatEtClock(started_at)
  if (!ended_at) return `"${match}", ${day} since ${start} ET`
  const end = etDayKey(ended_at) === etDayKey(started_at) ? formatEtClock(ended_at) : formatEtDayTime(ended_at)
  return `"${match}", ${day} ${start} to ${end} ET`
}

const keptSinceWords = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })

/** "Runs before Oct 8 are no longer kept.", only when the incident reaches back before that. */
export function incidentRunsRetentionLine(body: IncidentFailedRuns): string | null {
  if (!body.clipped) return null
  return `Runs before ${keptSinceWords.format(new Date(body.kept_since))} are no longer kept.`
}
