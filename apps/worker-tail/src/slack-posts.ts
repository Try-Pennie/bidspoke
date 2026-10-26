/**
 * One row per Slack post of the bidding Worker (#2364).
 *
 * deliverMessage and sendThreadReply (apps/worker/src/lib/slack.ts) log one
 * `[slack] post outcome {...}` line per post: delivered, refused (with Slack's
 * error code or the HTTP status) or no answer. This copies each into
 * slack_post_outcomes, which the bidding Worker's minute refusal check reads
 * (slack-refusal-watch.ts) to page through Better Stack when Slack refuses
 * alert posts. From 2026-10-23 to 26 about 3,400 posts were refused with
 * not_in_channel and only a free text log line said so. Written by a different
 * Worker into a different store from the posts themselves, so it does not
 * share their failure (L561).
 *
 * The key is the post id the logger minted, so a batch written twice is one
 * row. The ops Worker's traces are skipped. A line that does not parse, or
 * whose values the table would refuse, is dropped on its own: one bad row in an
 * upsert would refuse the whole batch, and hold every good row with it.
 */
import { OPS_WORKER_SCRIPT } from './scripts'
import { createRowCopier, type RowCopier, type RowCopierDeps } from './row-copier'
import { SLACK_POST_HELD_CAP } from './copier-caps'

export { SLACK_POST_HELD_CAP }

export type SlackPostOutcome = 'delivered' | 'refused' | 'no_answer'

export interface SlackPostRow {
  post_id: string
  occurred_at: string
  channel: string
  outcome: SlackPostOutcome
  reason: string | null
  kind: 'destination' | 'transient' | null
  status: number | null
  title: string | null
}

/** Kept in step with SLACK_POST_OUTCOME_PREFIX in slack-post-outcome.ts; the worker's test feeds its real line here. */
const PREFIX = '[slack] post outcome '

const OUTCOMES: ReadonlySet<string> = new Set(['delivered', 'refused', 'no_answer'])
const KINDS: ReadonlySet<string> = new Set(['destination', 'transient'])

/** The table's limits, so a row it would refuse never reaches the batch. */
const MAX_ID = 100
const MAX_CHANNEL = 200
const MAX_REASON = 100
const MAX_TITLE = 200

function messageText(message: unknown): string | null {
  if (typeof message === 'string') return message
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0]
  return null
}

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max
const textOrNull = (v: unknown, max: number): v is string | null => v === null || text(v, max)

function parseLine(line: string, occurredAt: string): SlackPostRow | null {
  if (!line.startsWith(PREFIX)) return null
  let body: unknown
  try {
    body = JSON.parse(line.slice(PREFIX.length))
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (!text(b.post_id, MAX_ID) || !text(b.channel, MAX_CHANNEL)) return null
  if (typeof b.outcome !== 'string' || !OUTCOMES.has(b.outcome)) return null
  if (!textOrNull(b.reason, MAX_REASON) || !textOrNull(b.title, MAX_TITLE)) return null
  const status = b.status
  if (!(status === null || (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599))) return null
  const kind = b.kind
  if (!(kind === null || (typeof kind === 'string' && KINDS.has(kind)))) return null
  // A delivered post carries no refusal kind, and every refusal carries one: the table's own rule.
  if ((b.outcome === 'delivered') !== (kind === null)) return null
  return {
    post_id: b.post_id,
    occurred_at: occurredAt,
    channel: b.channel,
    outcome: b.outcome as SlackPostOutcome,
    reason: b.reason,
    kind: kind as SlackPostRow['kind'],
    status,
    title: b.title,
  }
}

const isoOrNull = (ms: unknown): string | null =>
  typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null

/** The Slack posts one trace records, each timed by its own log line. */
export function slackPostsIn(trace: TraceItem): SlackPostRow[] {
  if (trace.scriptName === OPS_WORKER_SCRIPT) return []
  const rows: SlackPostRow[] = []
  for (const log of trace.logs ?? []) {
    const line = messageText(log.message)
    if (line === null || !line.startsWith(PREFIX)) continue
    const at = isoOrNull(log.timestamp) ?? isoOrNull(trace.eventTimestamp)
    if (at === null) continue
    const row = parseLine(line, at)
    if (row) rows.push(row)
  }
  return rows
}

export type SlackPostCopier = RowCopier<SlackPostRow>

export function createSlackPostCopier(deps: RowCopierDeps = {}): SlackPostCopier {
  return createRowCopier<'post_id', SlackPostRow>(
    { table: 'slack_post_outcomes', key: 'post_id', one: 'Slack post outcome', many: 'Slack post outcomes', label: 'post', maxHeld: SLACK_POST_HELD_CAP },
    deps,
  )
}

/** The one copier per isolate, so a row held by one invocation is written by the next. */
export const isolateSlackPostCopier: SlackPostCopier = createSlackPostCopier()
