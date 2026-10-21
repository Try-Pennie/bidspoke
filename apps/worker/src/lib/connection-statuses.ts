/**
 * The Connections page's statuses (#2338, build PR 4; R3, R22, D22): how each
 * status ops derives reads on the page, and the last known statuses the list
 * route answers when the login checks do not.
 *
 * THE WORDS. Ops derives five statuses (connection_status, ops migration
 * 20261018170000; CONNECTION_STATUSES in ops/run-vocabulary.ts) and the page
 * shows three (CONNECTION_STATUS_WORDS in @bidspoke/service-catalogue). Dan
 * decided the two that were open on 2026-10-20 (#2338): refresh_failing reads
 * Check failing, and unchecked reads Working, because a connection is saved
 * only after its verify passed. OPS_TO_PAGE is keyed by ops's own list, so a
 * sixth ops status does not compile until somebody says how it reads. A status
 * this Worker does not know (ops deployed ahead of bidding) reads as no status,
 * logged, never as a guess.
 *
 * THE LAST KNOWN COPY. When health does not answer, the page keeps the last
 * known statuses on screen under a strip naming their time ("Statuses are as of
 * <time> ET", D22), so the list never empties and no status is made up. They
 * are kept in KV (WORKFLOW_CACHE), one key per organization, following the
 * repo's other last good copies (partner-last-good.ts, slack-copy.ts): written
 * from a healthy answer, read only when the answer fails, and rewritten only
 * when the statuses change or the copy is STORED_COPY_RECONFIRM_AFTER_MS old,
 * tracked per isolate, which keeps the writes far inside KV's one a second per
 * key. The time it carries is when it was last written, so it never claims to
 * be fresher than it is.
 *
 * It is NOT one of the stored outage copies of stored-copy-age.ts, and is not
 * held to their thirty minute limit, because it decides nothing about a lead:
 * it is shown, with its time, to a person, which is what the settled design
 * asks for at any age (D22), as the Slack copy names its age for the same
 * reason. It is never read on the money path: only the list route reads it.
 *
 * WHOSE DATA. The key and the value both name the organization, from the
 * caller's verified token; a value naming another organization is refused. It
 * holds ops's health rows only: names, times and causes made of names (the
 * contract's rule, F120), never a login.
 */
import type { ConnectionPageStatus } from '@bidspoke/service-catalogue/schema'
import type { ConnectionStatus } from '../ops/run-vocabulary'
import type { HealthRow } from './ops-connections-contract'
import { formatErr } from './format-error'
import { STORED_COPY_RECONFIRM_AFTER_MS } from './stored-copy-age'

const OPS_TO_PAGE: Readonly<Record<ConnectionStatus, ConnectionPageStatus>> = {
  healthy: 'ok',
  unchecked: 'ok',
  needs_reauth: 'reauth',
  check_failing: 'failing',
  refresh_failing: 'failing',
}

/** The page's status for one ops status, or null for one this Worker does not know. */
export function pageStatusOf(opsStatus: string): ConnectionPageStatus | null {
  if (Object.prototype.hasOwnProperty.call(OPS_TO_PAGE, opsStatus)) return OPS_TO_PAGE[opsStatus as ConnectionStatus]
  console.warn(JSON.stringify({ event: 'connection_status_unknown', ops_status: opsStatus }))
  return null
}

/** The KV key holding an organization's last known statuses. */
export const connectionStatusesCopyKey = (organizationId: string): string => `connection-statuses-lastgood:${organizationId}`

interface CopyKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

interface StoredStatuses {
  organization_id: string
  /** When this copy was written from a healthy answer. */
  as_of: string
  rows: HealthRow[]
}

export type ConnectionStatusesRead =
  | { kind: 'read'; as_of: string; rows: HealthRow[] }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string }

// What this isolate last wrote, per organization, and when. Module state on
// purpose: it lives as long as the isolate, which is what keeps the write rate down.
const lastWritten = new Map<string, { fingerprint: string; atMs: number }>()

/** For tests: forget what this isolate wrote. */
export function forgetConnectionStatusesMemory(): void {
  lastWritten.clear()
}

/**
 * Keep a healthy answer's statuses as the organization's last known copy,
 * when they changed since this isolate last wrote them or that write is due to
 * be confirmed again. Never throws: a copy that could not be written must not
 * fail the list it came with, and the next healthy answer tries again.
 */
export async function rememberConnectionStatuses(kv: CopyKv | undefined, organizationId: string, rows: HealthRow[], nowMs: number): Promise<void> {
  if (!kv) return
  const sorted = [...rows].sort((a, b) => (a.connection_id < b.connection_id ? -1 : a.connection_id > b.connection_id ? 1 : 0))
  const fingerprint = JSON.stringify(sorted)
  const written = lastWritten.get(organizationId)
  if (written && written.fingerprint === fingerprint && nowMs - written.atMs < STORED_COPY_RECONFIRM_AFTER_MS) return
  const value: StoredStatuses = { organization_id: organizationId, as_of: new Date(nowMs).toISOString(), rows: sorted }
  try {
    await kv.put(connectionStatusesCopyKey(organizationId), JSON.stringify(value))
    lastWritten.set(organizationId, { fingerprint, atMs: nowMs })
  } catch (err) {
    console.error(JSON.stringify({ event: 'connection_statuses_copy_unwritten', organization_id: organizationId, error: formatErr(err) }))
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function healthRowOf(raw: unknown): HealthRow | null {
  if (!isRecord(raw) || typeof raw.connection_id !== 'string' || typeof raw.status !== 'string') return null
  return raw as unknown as HealthRow
}

function unreadable(organizationId: string, detail: string): ConnectionStatusesRead {
  console.error(JSON.stringify({ event: 'connection_statuses_copy_unreadable', organization_id: organizationId, detail }))
  return { kind: 'unreadable', detail }
}

/** The organization's last known statuses, saying which of read, absent and unreadable it met. Never throws. */
export async function readConnectionStatuses(kv: Pick<CopyKv, 'get'> | undefined, organizationId: string): Promise<ConnectionStatusesRead> {
  if (!kv) return { kind: 'absent' }
  let raw: string | null
  try {
    raw = await kv.get(connectionStatusesCopyKey(organizationId))
  } catch (err) {
    return unreadable(organizationId, `the KV read failed: ${formatErr(err)}`)
  }
  if (raw === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return unreadable(organizationId, 'the copy is not JSON')
  }
  if (!isRecord(parsed)) return unreadable(organizationId, 'the copy is not an object')
  if (parsed.organization_id !== organizationId) return unreadable(organizationId, 'the copy names another organization')
  if (typeof parsed.as_of !== 'string' || !Number.isFinite(Date.parse(parsed.as_of))) return unreadable(organizationId, 'the copy carries no readable time')
  if (!Array.isArray(parsed.rows)) return unreadable(organizationId, 'the copy carries no rows')
  const rows = parsed.rows.map(healthRowOf)
  if (rows.some((r) => r === null)) return unreadable(organizationId, 'a row of the copy is not a status')
  return { kind: 'read', as_of: parsed.as_of, rows: rows as HealthRow[] }
}

// ── The Slack alert login's last known status (build PR 9) ──────────────────
//
// Ops never holds the Slack alert login, so health gives it no status. The list
// route asks Slack itself (lib/slack-token-check.ts), inside the same deadline
// as health, and keeps what it measured here, one key per organization, so a
// Slack that does not answer shows the last known status under the same stale
// strip, as an ops login does. Its own key, never folded into the ops copy:
// the two are measured apart, and a copy whose one time covered both would
// claim one side was as fresh as the other. Written and read like the ops
// copy: changed or due to be confirmed, tracked per isolate; never throws.

/** The KV key holding an organization's Slack alert login's last known status. */
export const slackAlertStatusCopyKey = (organizationId: string): string => `slack-alert-status-lastgood:${organizationId}`

export interface SlackAlertStatus {
  status: ConnectionPageStatus
  /** Who the bot is, as Slack last named it ("<bot> in <workspace>"). */
  acts_as: string | null
}

export type SlackAlertStatusRead =
  | { kind: 'read'; as_of: string; value: SlackAlertStatus }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string }

const lastSlackWritten = new Map<string, { fingerprint: string; atMs: number }>()

/** For tests: forget what this isolate wrote of the Slack alert status. */
export function forgetSlackAlertStatusMemory(): void {
  lastSlackWritten.clear()
}

export async function rememberSlackAlertStatus(kv: CopyKv | undefined, organizationId: string, value: SlackAlertStatus, nowMs: number): Promise<void> {
  if (!kv) return
  const fingerprint = JSON.stringify([value.status, value.acts_as])
  const written = lastSlackWritten.get(organizationId)
  if (written && written.fingerprint === fingerprint && nowMs - written.atMs < STORED_COPY_RECONFIRM_AFTER_MS) return
  try {
    await kv.put(slackAlertStatusCopyKey(organizationId), JSON.stringify({ organization_id: organizationId, as_of: new Date(nowMs).toISOString(), status: value.status, acts_as: value.acts_as }))
    lastSlackWritten.set(organizationId, { fingerprint, atMs: nowMs })
  } catch (err) {
    console.error(JSON.stringify({ event: 'slack_alert_status_copy_unwritten', organization_id: organizationId, error: formatErr(err) }))
  }
}

const PAGE_STATUSES: ReadonlySet<string> = new Set(Object.values(OPS_TO_PAGE))

export async function readSlackAlertStatus(kv: Pick<CopyKv, 'get'> | undefined, organizationId: string): Promise<SlackAlertStatusRead> {
  if (!kv) return { kind: 'absent' }
  const fail = (detail: string): SlackAlertStatusRead => {
    console.error(JSON.stringify({ event: 'slack_alert_status_copy_unreadable', organization_id: organizationId, detail }))
    return { kind: 'unreadable', detail }
  }
  let raw: string | null
  try {
    raw = await kv.get(slackAlertStatusCopyKey(organizationId))
  } catch (err) {
    return fail(`the KV read failed: ${formatErr(err)}`)
  }
  if (raw === null) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('the copy is not JSON')
  }
  if (!isRecord(parsed)) return fail('the copy is not an object')
  if (parsed.organization_id !== organizationId) return fail('the copy names another organization')
  if (typeof parsed.as_of !== 'string' || !Number.isFinite(Date.parse(parsed.as_of))) return fail('the copy carries no readable time')
  if (typeof parsed.status !== 'string' || !PAGE_STATUSES.has(parsed.status)) return fail('the copy carries no status the page shows')
  if (parsed.acts_as !== null && typeof parsed.acts_as !== 'string') return fail('the copy carries no readable acts as')
  return { kind: 'read', as_of: parsed.as_of, value: { status: parsed.status as ConnectionPageStatus, acts_as: parsed.acts_as as string | null } }
}
