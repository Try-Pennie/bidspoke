/**
 * The one request that sends a fixed line to the Better Stack HTTP log source
 * `Bidspoke outage line` (#2364).
 *
 * The Worker's own log lines do not reach Better Stack (forwarding was narrowed
 * on 2026-09-09 to keep applicant data out, #1007), so each alert that must be
 * heard when Slack or the database cannot carry it sends one JSON event there
 * itself, and a Better Stack alert matching its line pages. Four do: the nobody
 * can be told page and its drill (nobody-told-page.ts, #2063, #1303), the row
 * cap report (row-cap.ts, #1436), and the Slack refusal page and its drill
 * (slack-refusal-watch.ts, #2364). They used to carry their own copies of this
 * request; a drill can prove only the request it makes, so they now share this
 * one, and a guard (better-stack-one-sender.test.ts) holds every Worker POST to
 * the source to this file.
 *
 * What an event carries is each caller's own fixed shape, pinned whole by its
 * own test; this module sends whatever it is handed and adds nothing to it.
 */
import { raceDeadline } from './alert-claim'
import { formatErr } from './format-error'

/** The two worker secrets the source is reached with. */
export type BetterStackSecret = 'BETTERSTACK_OUTAGE_TOKEN' | 'BETTERSTACK_OUTAGE_URL'

export interface BetterStackTarget {
  token: string
  url: string
  /** The secrets that are unset, in that order; empty when both are set. */
  missing: BetterStackSecret[]
}

/** The two worker secrets, trimmed, and the names of any that are unset. */
export function betterStackTarget(token: string | undefined, url: string | undefined): BetterStackTarget {
  const t = token?.trim() ?? ''
  const u = url?.trim() ?? ''
  const missing: BetterStackSecret[] = []
  if (!t) missing.push('BETTERSTACK_OUTAGE_TOKEN')
  if (!u) missing.push('BETTERSTACK_OUTAGE_URL')
  return { token: t, url: u, missing }
}

/**
 * THE request: the event as JSON, with the source's bearer token. Answers
 * Better Stack's status; whether that is a failure is the caller's call. A
 * caller racing its own deadline passes the signal that abandons it.
 */
export async function postBetterStackEvent(
  fetchFn: typeof fetch,
  target: { token: string; url: string },
  event: object,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetchFn(target.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
    signal,
  })
  return { ok: res.ok, status: res.status }
}

/** What one send came to, each its own answer, never a blanket ok (L11). */
export type BetterStackSendOutcome =
  | { outcome: 'sent'; status: number }
  | { outcome: 'not_configured'; missing: BetterStackSecret[] }
  | { outcome: 'refused'; status: number }
  | { outcome: 'no_answer'; deadline_ms: number }
  | { outcome: 'threw'; error: string }

export interface BetterStackLineOptions {
  /** BETTERSTACK_OUTAGE_TOKEN: the HTTP source's token. */
  token: string | undefined
  /** BETTERSTACK_OUTAGE_URL: the source's ingesting host, as a URL. */
  url: string | undefined
  fetch?: typeof fetch
  /** The timer seam, so no test waits for real (L524). */
  delay?: (ms: number) => Promise<void>
}

const realDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Send one event, bounded by `deadlineMs`, and say what happened. Never
 * throws. A send that gets no answer in time is abandoned and its request
 * aborted; it may still have landed, which the caller must allow for.
 */
export async function sendBetterStackLine(options: BetterStackLineOptions, event: object, deadlineMs: number): Promise<BetterStackSendOutcome> {
  const target = betterStackTarget(options.token, options.url)
  if (target.missing.length > 0) return { outcome: 'not_configured', missing: target.missing }
  const fetchFn = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const stop = new AbortController()
  const raced = await raceDeadline(() => postBetterStackEvent(fetchFn, target, event, stop.signal), deadlineMs, options.delay ?? realDelay)
  if (raced.kind === 'timed_out') {
    stop.abort()
    return { outcome: 'no_answer', deadline_ms: deadlineMs }
  }
  if (raced.kind === 'threw') return { outcome: 'threw', error: formatErr(raced.error) }
  return raced.value.ok ? { outcome: 'sent', status: raced.value.status } : { outcome: 'refused', status: raced.value.status }
}
