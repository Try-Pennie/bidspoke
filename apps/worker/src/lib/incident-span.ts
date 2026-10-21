/**
 * How long an incident lasted: the ONE span rule (#2101, under #818).
 *
 * The Slack all-clear (slack.ts, recoveryTiming) and the dashboard's incident
 * record (incidents-read.ts) both say how long an incident lasted. They read it
 * from here, so the two can never describe the same incident two ways (L118).
 *
 * The rule:
 *  - The span runs from the incident's start to the LAST OBSERVED sighting, not
 *    to the moment the all-clear went out (#814): the all-clear waits out a re
 *    arm window first, and measuring to it would add that quiet window to every
 *    outage. With no recorded end the span runs to `now` and claims no clearing
 *    time.
 *  - That end is when the problem was last SEEN (`lastSeenAt`), never when it
 *    cleared (#2580): for a per run check a one run incident's last sighting is
 *    the tick that paged. The all-clear names the first healthy check after it
 *    alongside, which the dashboard record does not hold.
 *  - A check that judges a TRAILING WINDOW sees the condition once per tick, so a
 *    span shorter than one window is not a measurement: a one tick incident has a
 *    span of zero (#1101). Such a span reports the window instead (L11).
 *  - An end before the start is a ZERO length span ending at the start, never a
 *    negative one. A real db-unreachable row recorded before #2115 (one clock
 *    reading per pass) has its last sighting 36 seconds before its start; new
 *    rows cannot, but that one is kept 90 days. A now before the start (one
 *    isolate's clock behind another's) is read the same way.
 *  - An unreadable start says nothing rather than something wrong (L11, L50).
 */

export type IncidentSpan =
  | { kind: 'unknown' }
  | { kind: 'within_window'; windowMs: number }
  | { kind: 'measured'; ms: number; lastSeenAt: number | null }

export function measureIncidentSpan(
  startedAt: string,
  endedAt: string | null | undefined,
  windowMinutes: number | null | undefined,
  now: number,
): IncidentSpan {
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started)) return { kind: 'unknown' }
  const ended = endedAt ? Date.parse(endedAt) : NaN
  const lastSeenAt = Number.isFinite(ended) ? Math.max(ended, started) : null
  const spanMs = Math.max(0, (lastSeenAt ?? now) - started)
  const windowMs = (windowMinutes ?? 0) * 60 * 1000
  if (windowMs > 0 && spanMs < windowMs) return { kind: 'within_window', windowMs }
  return { kind: 'measured', ms: spanMs, lastSeenAt }
}

/** A duration in plain words. Rounded, because nobody acts on the seconds. */
export function describeDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  const h = `${hours} hour${hours === 1 ? '' : 's'}`
  return rem === 0 ? h : `${h} ${rem} minute${rem === 1 ? '' : 's'}`
}

/** A check's window as a compound adjective: "5 minute", "60 minute", "7 day". */
function windowAdjective(windowMs: number): string {
  const minutes = Math.round(windowMs / 60000)
  return minutes % 1440 === 0 ? `${minutes / 1440} day` : `${minutes} minute`
}

/**
 * The span as one short phrase for a table cell, or null when the start cannot
 * be read. An end recorded before the start is a zero length span by the time it
 * gets here (measureIncidentSpan clamps it), so it reads as under a minute, or
 * the window wording where the signal has a window.
 */
export function incidentDurationText(span: IncidentSpan): string | null {
  if (span.kind === 'unknown') return null
  if (span.kind === 'within_window') return `Within one ${windowAdjective(span.windowMs)} window`
  return describeDuration(span.ms)
}

/**
 * How long an OPEN incident has run, measured to now, as a phrase that ends a
 * sentence ("1 hour 20 minutes so far"), or null for an unreadable start.
 */
export function incidentSoFarText(span: IncidentSpan): string | null {
  if (span.kind === 'unknown') return null
  if (span.kind === 'within_window') return `within its first ${windowAdjective(span.windowMs)} window`
  const d = describeDuration(span.ms)
  return d ? `${d} so far` : null
}
