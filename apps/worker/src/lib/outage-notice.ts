/**
 * Whether an alert posted by a scheduled tick goes out during an open database
 * outage, so it can carry one line naming it (#2061).
 *
 * Dan's decision (2026-10-14): "While the incident is open, every other alert
 * posts as normal with one line naming the outage; a full outage simulation
 * counts the posts." Nothing is held back; a reader is told the alert may be a
 * consequence of the outage the database owner (database-reachability.ts)
 * already paged about.
 *
 * WHERE: the line is added in postMessage (slack.ts), the one function every
 * Slack alert is posted through, so no sender can leave it out (L621). The
 * owner's own page and all-clear post through slack.ts's private path, which
 * skips it, since a page about the outage naming the outage says nothing.
 *
 * WHICH POSTS: only those made inside a scheduled tick. The scheduled handler
 * runs every job of a tick inside runInScheduledTick (index.ts), and the tick's
 * one Supabase client attaches itself here when it is built
 * (createScheduledSupabaseClient), so every job the tick starts, and every
 * promise those jobs make, posts inside the context (AsyncLocalStorage, which
 * the worker has through nodejs_compat). A post on the request or engine path
 * runs in no tick, finds no context, reads nothing and is posted exactly as
 * before.
 *
 * OPEN: the owner's recovery marker (`db-unreachable-recovery:<org>`, the time
 * it first paged) is set for some organization in the saved Slack copy, and it
 * stays set until the owner's all-clear is delivered. The line names that time
 * and the last failed read (`db-unreachable-active:<org>`), which the owner
 * stamps on every failure, so in the re-arm window after the database came back
 * the line still says only what was measured (L11).
 *
 * NEVER IN THE WAY: the read is raced against OUTAGE_NOTICE_READ_DEADLINE_MS,
 * because a KV call has no deadline of its own and stalls are what this is for
 * (2026-10-14). A read that fails, throws or does not answer posts the alert
 * without the line and logs why; after the first one, the rest of the tick does
 * not ask again, so a stalled store costs a tick at most one deadline. No saved
 * copy (no organizations to read for) is treated the same way.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { raceDeadline } from './alert-claim'
import { activeKey, recoveryKey } from './alert-recovery'
import type { RecoveryMarkerSignal } from './incident-signals'
import type { ScheduledSlack } from './scheduled-slack'
import { formatErr } from './format-error'

/**
 * The owner's incident signal, spelled here rather than imported from
 * database-reachability.ts, which imports slack.ts, which imports this.
 * outage-notice.test.ts holds the two equal.
 */
export const OUTAGE_NOTICE_SIGNAL: RecoveryMarkerSignal = 'db-unreachable'

/**
 * How long a post waits for the incident read before it goes without the line.
 * Two KV reads and the tick's copy (already read once a tick fell back), so far
 * above a healthy answer, and well inside the 3 s Slack lookup deadline a
 * stalled tick already spends per alert.
 */
export const OUTAGE_NOTICE_READ_DEADLINE_MS = 1_000

export interface OutageNoticeSource {
  /** IDEMPOTENCY, where the owner keeps its incident. */
  kv: { get(key: string): Promise<string | null> }
  /** This tick's Slack lookup: its copy lists the organizations, and says whether lookups fell back to it. */
  scheduled: ScheduledSlack
  /** The deadline timer; a test controls it (L524). */
  delay?: (ms: number) => Promise<void>
}

/** An open outage, as the line names it. */
export interface OpenOutage {
  reportedAtMs: number
  lastFailedAtMs: number | null
  /**
   * When this tick's Slack lookups were answered from the saved copy, its age
   * (null when the copy does not say); undefined when they were read live.
   */
  copyAgeMs: number | null | undefined
}

interface TickStore {
  source: OutageNoticeSource | null
  /** Set by the first read that failed this tick; later posts do not ask again. */
  failed: string | null
}

const ticks = new AsyncLocalStorage<TickStore>()

/** Run a scheduled tick's jobs so their posts can name an open outage. */
export function runInScheduledTick<T>(fn: () => T): T {
  return ticks.run({ source: null, failed: null }, fn)
}

/** Give the current tick what it reads the incident with. Outside a tick it does nothing. */
export function attachOutageNotice(source: OutageNoticeSource): void {
  const store = ticks.getStore()
  if (store) store.source = source
}

/** A tick and its source in one call, for a caller that has both at hand (tests). */
export function runWithOutageNotice<T>(source: OutageNoticeSource, fn: () => T): T {
  return runInScheduledTick(() => {
    attachOutageNotice(source)
    return fn()
  })
}

const parseMs = (iso: string | null): number | null => {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

type IncidentRead = { kind: 'open'; outage: OpenOutage } | { kind: 'closed' } | { kind: 'unread'; why: string }

async function readIncident(source: OutageNoticeSource): Promise<IncidentRead> {
  const copy = await source.scheduled.copy()
  if (copy.kind !== 'read') {
    return { kind: 'unread', why: copy.kind === 'absent' ? 'there is no saved Slack copy to list the organizations from' : `the saved Slack copy cannot be read (${copy.detail})` }
  }
  let reportedAtMs: number | null = null
  let lastFailedAtMs: number | null = null
  for (const orgId of copy.copy.connections.keys()) {
    const [reported, failed] = await Promise.all([
      source.kv.get(recoveryKey(OUTAGE_NOTICE_SIGNAL, orgId)),
      source.kv.get(activeKey(OUTAGE_NOTICE_SIGNAL, orgId)),
    ])
    const r = parseMs(reported)
    if (r === null) continue
    reportedAtMs = reportedAtMs === null ? r : Math.min(reportedAtMs, r)
    const f = parseMs(failed)
    if (f !== null) lastFailedAtMs = lastFailedAtMs === null ? f : Math.max(lastFailedAtMs, f)
  }
  if (reportedAtMs === null) return { kind: 'closed' }
  const copyAgeMs = source.scheduled.unreachable ? copy.ageMs : undefined
  return { kind: 'open', outage: { reportedAtMs, lastFailedAtMs, copyAgeMs } }
}

/**
 * The open outage a post made now should name, or null. Never throws, and never
 * waits past OUTAGE_NOTICE_READ_DEADLINE_MS. Null outside a scheduled tick, with
 * nothing read.
 */
export async function openOutageForPost(): Promise<OpenOutage | null> {
  const store = ticks.getStore()
  if (!store) return null
  try {
    if (!store.source) {
      console.error('[outage-notice] a scheduled tick posted before its Slack client was attached, so it was posted without the outage line')
      return null
    }
    if (store.failed !== null) return null
    const read = await raceDeadline(() => readIncident(store.source!), OUTAGE_NOTICE_READ_DEADLINE_MS, store.source.delay)
    let why: string | null = null
    if (read.kind === 'timed_out') why = `no answer in ${OUTAGE_NOTICE_READ_DEADLINE_MS} ms`
    else if (read.kind === 'threw') why = formatErr(read.error)
    else if (read.value.kind === 'unread') why = read.value.why
    if (why !== null) {
      // The tick's copy is read once, so an absent or unreadable one stays so
      // for the tick; a failed or stalled read is not asked again either.
      store.failed = why
      console.error(`[outage-notice] the database incident could not be read (${why}), so this alert was posted without the outage line`)
      return null
    }
    return read.kind === 'ok' && read.value.kind === 'open' ? read.value.outage : null
  } catch (e) {
    console.error(`[outage-notice] reading the database incident failed (${formatErr(e)}), so this alert was posted without the outage line`)
    return null
  }
}
