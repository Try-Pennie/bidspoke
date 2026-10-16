/**
 * Shared Slack-alert fan-out plumbing (#357).
 *
 * Several scheduled alerts (drain-stall, big-table-guard, sf-matrix-audit, ...)
 * each re-implemented the same three steps: look up the orgs with a Slack
 * connection, fan a per-org send out across them, and (for the once-per-incident
 * ones) gate the whole thing behind a KV cooldown that is set only after a
 * successful post. That boilerplate lived in ~8 near-identical copies, so a
 * change to the cooldown semantics or the multi-org handling had to be made in
 * every one. This module is the single home for it.
 *
 * It deliberately does NOT cover the per-workflow / per-org cooldown alerts
 * (failure-rate, slow-execution-rate, volume-cliff's db-unreachable path): those
 * key their cooldown on a workflow or a single org and announce recovery, which
 * is a different shape. They still share `slackOrgIds` for the org lookup.
 *
 * Every read of `service_connections` outside the signed-in app's routes
 * (routes/api/) lives here or in slack.ts (#1303, guarded by
 * service-connections-readers.test.ts); the routes that change a Slack
 * connection also edit the saved copy (#2060, last-good-copies-retired.test.ts).
 * The org lists answer a discriminated
 * result (`SlackOrgList`, `SlackFanout`, `SlackConnectionsRead`): from the
 * database, from the saved copy, or unreachable and why, so "no orgs" and "could
 * not read" differ. A caller whose next step is the same either way folds it with
 * `orgIdsToTell`, `anyDelivered` or `everyDelivered`. On the scheduled handler's
 * client the read is bounded and falls back to the copy (scheduled-slack.ts).
 * Every list helper requires a `SlackListUse`, so a check that measures its
 * finding from the database cannot be handed the copy's list by forgetting to
 * say so: it judges nothing on a tick the database did not answer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { parseSlackConnection, type SlackConnection } from './slack-connection'
import { copyUnreachableLine, describeCopyAge, scheduledSlackFor, type BoundableQuery, type CopyUnreachableReason } from './scheduled-slack'

/**
 * The slice of KV this module uses: a get and a cooldown put. Narrower than
 * KVNamespace so a caller holding a minimal KV double (a test, or a helper typed
 * on get/put) can pass it without an unsafe cast; a real KVNamespace satisfies it.
 */
export interface CooldownKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/**
 * Why an org list could not be used. `read_failed` only on a client with no
 * saved copy to fall back on; `database_not_answering` when the caller measures
 * its finding from the database and the list could come only from the copy.
 */
export type SlackListUnreachableReason = Exclude<CopyUnreachableReason, 'org_not_in_copy'> | 'read_failed' | 'database_not_answering'

/**
 * What the caller does with the org list, which every list helper requires so
 * that no caller can leave it out (#1303 review, L621):
 *
 * - `'measure-from-database'`: the caller goes on to read the database for the
 *   orgs to decide what it says (counts, workflows, durations, variables). A
 *   list answered from the saved copy means the database did not answer this
 *   tick, so the list is refused (`database_not_answering`) and the caller
 *   judges nothing: no all-clear, no transition, no alert. Before the copy such
 *   a tick had no orgs at all; a check whose own reads swallow their errors
 *   (timeout-audit did) would otherwise record an all-clear in an outage and
 *   re-alert an unchanged set when the database came back.
 * - `'tell-only'`: the caller already holds its finding, or measures it without
 *   the database (KV, env, Salesforce, GitHub, a probe), and only needs to know
 *   who to tell. The copy's list tells them during an outage.
 */
export type SlackListUse = 'measure-from-database' | 'tell-only'

/**
 * The orgs with a Slack connection (#1303): read from the database, read from the
 * saved copy because the database did not answer (with that copy's age), or not
 * read at all, so "no organizations" and "could not read" are different answers.
 */
export type SlackOrgList =
  | { kind: 'live'; orgIds: string[] }
  | { kind: 'stored'; orgIds: string[]; ageMs: number | null }
  | { kind: 'unreachable'; reason: SlackListUnreachableReason }

/**
 * The org ids to send to, empty when the list could not be read. For a caller
 * whose next step is the same either way (nothing can be sent, and the helper
 * has already logged why); a caller whose state depends on "everyone was told"
 * must look at `kind` instead (sf-matrix-audit).
 */
export function orgIdsToTell(list: SlackOrgList): string[] {
  return list.kind === 'unreachable' ? [] : list.orgIds
}

/** Deduped org ids that have a Slack connection. Never throws. */
export async function slackOrgIds(supabase: SupabaseClient, logLabel: string, use: SlackListUse): Promise<SlackOrgList> {
  const read = await readSlackRows<{ organization_id: string }>(supabase, logLabel, 'slack organizations', 'organization_id', use)
  if (read.kind === 'unreachable') return read
  const orgIds = [...new Set(read.kind === 'live' ? read.rows.map((r) => r.organization_id) : [...read.copy.keys()])]
  return read.kind === 'live' ? { kind: 'live', orgIds } : { kind: 'stored', orgIds, ageMs: read.ageMs }
}

/**
 * Every org's Slack connection (#1303), in one read: for a check that belongs to
 * no org and posts to all of them. On the scheduled client a database that does
 * not answer is replaced by the saved copy; an empty live answer is an answer.
 */
export type SlackConnectionsRead =
  | { kind: 'live'; connections: Map<string, SlackConnection> }
  | { kind: 'stored'; connections: Map<string, SlackConnection>; ageMs: number | null }
  | { kind: 'unreachable'; reason: SlackListUnreachableReason }

export async function readEverySlackConnection(supabase: SupabaseClient, logLabel: string, use: SlackListUse): Promise<SlackConnectionsRead> {
  const read = await readSlackRows<{ organization_id: string; config: unknown }>(supabase, logLabel, 'slack connections', 'organization_id, config', use)
  if (read.kind === 'unreachable') return read
  if (read.kind === 'stored') return { kind: 'stored', connections: read.copy, ageMs: read.ageMs }
  const connections = new Map<string, SlackConnection>()
  for (const row of read.rows) {
    const conn = parseSlackConnection(row.config)
    if (conn) connections.set(row.organization_id, conn)
  }
  return { kind: 'live', connections }
}

type RowsRead<R> =
  | { kind: 'live'; rows: R[] }
  | { kind: 'stored'; copy: Map<string, SlackConnection>; ageMs: number | null }
  | { kind: 'unreachable'; reason: SlackListUnreachableReason }

/** The one all-org read of service_connections behind both lists above, bounded on the scheduled client. */
async function readSlackRows<R>(supabase: SupabaseClient, logLabel: string, what: string, columns: string, use: SlackListUse): Promise<RowsRead<R>> {
  const query = supabase.from('service_connections').select(columns).eq('service_type', 'slack')
  const scheduled = scheduledSlackFor(supabase)
  if (!scheduled) {
    // Any other client: one read, as before, with the failure said rather than read as "no orgs".
    const { data, error } = await query
    logReadFailure(logLabel, 'slack connections', error)
    if (error) return { kind: 'unreachable', reason: 'read_failed' }
    return { kind: 'live', rows: (data ?? []) as unknown as R[] }
  }
  const subject = `${logLabel} ${what}`
  const live = await scheduled.read<R[]>(subject, query as unknown as BoundableQuery<R[]>)
  if (live.kind === 'answered') {
    const rows = live.data ?? []
    console.log(`[scheduled-slack] ${subject}: read live (${rows.length} rows)`)
    return { kind: 'live', rows }
  }
  if (use === 'measure-from-database') {
    // The database did not answer, so this caller could only judge reads that
    // failed: it judges nothing this tick rather than post or clear on them.
    console.error(`[scheduled-slack] ${subject}: the database did not answer (${live.how}) and this check measures its finding from the database, so it judges nothing this run`)
    return { kind: 'unreachable', reason: 'database_not_answering' }
  }
  const copy = await scheduled.copy()
  if (copy.kind === 'read') {
    console.warn(`[scheduled-slack] ${subject}: answered from the saved copy (${describeCopyAge(copy.ageMs)}, ${copy.copy.connections.size} organizations) because the database did not answer (${live.how})`)
    return { kind: 'stored', copy: copy.copy.connections, ageMs: copy.ageMs }
  }
  const reason = copy.kind === 'absent' ? 'no_copy' : 'copy_unreadable'
  console.error(copyUnreachableLine(subject, reason, copy.kind === 'unreadable' ? copy.detail : undefined))
  return { kind: 'unreachable', reason }
}

/**
 * The volume check's read of every connection, the one whose answer is written
 * to the saved copy (volume-cliff.ts). Deliberately NOT the bounded read above
 * and never answered from the copy: what it reads becomes the copy, and its
 * failure is the volume check's own evidence that the database is down, judged
 * with the client's full deadline as before. #2061 moves the copy's writer to
 * the database probe.
 *
 * It takes no SlackListUse because it can only answer from the database: it is
 * 'measure-from-database' by construction. It must never be 'tell-only', since
 * writing the copy from the copy would re-date stale entries as fresh (#2060).
 */
export function readSlackConnectionRowsForCopy(supabase: SupabaseClient) {
  return supabase.from('service_connections').select('organization_id, config').eq('service_type', 'slack')
}

/**
 * The volume check's cheapest proof that the database answers: one row of this
 * tiny table, under the caller's signal (#1297). Here only so every read of
 * service_connections lives in one module.
 */
export function probeSlackConnectionsTable(supabase: SupabaseClient, signal: AbortSignal) {
  return supabase.from('service_connections').select('organization_id').limit(1).abortSignal(signal)
}

/** What forEachSlackOrg did: ran perOrg for each org (from the database or the copy), or could not read the list. */
export type SlackFanout =
  | { kind: 'ran'; source: 'live' | 'stored'; results: boolean[] }
  | { kind: 'unreachable'; reason: SlackListUnreachableReason }

/**
 * Run `perOrg` once for each org with a Slack connection, in order, and return
 * each result. `perOrg` returns true when it delivered (or was a legitimate
 * no-op, e.g. the org opted out). Callers fold the `SlackFanout` with
 * `anyDelivered` (drain-stall, big-table-guard and the other once per incident
 * alerts, through rateLimitedOrgAlert) or `everyDelivered` (sf-matrix-audit),
 * both false when the list could not be read at all.
 */
export async function forEachSlackOrg(
  supabase: SupabaseClient,
  logLabel: string,
  use: SlackListUse,
  perOrg: (orgId: string) => Promise<boolean>,
): Promise<SlackFanout> {
  const list = await slackOrgIds(supabase, logLabel, use)
  if (list.kind === 'unreachable') return list
  const results: boolean[] = []
  for (const orgId of list.orgIds) results.push(await perOrg(orgId))
  return { kind: 'ran', source: list.kind, results }
}

/** True when at least one org was told; false when none was, or the org list could not be read. */
export function anyDelivered(fanout: SlackFanout): boolean {
  return fanout.kind === 'ran' && fanout.results.some(Boolean)
}

/**
 * True only when the list was read (live or from the copy) and every org was
 * told; an unread list is never "everyone was told" (#1303). An empty list is
 * "everyone" only when the database said so: an empty saved copy during an
 * outage names nobody, so nobody was told, and it is false.
 */
export function everyDelivered(fanout: SlackFanout): boolean {
  if (fanout.kind !== 'ran') return false
  if (fanout.source === 'stored' && fanout.results.length === 0) return false
  return fanout.results.every(Boolean)
}

/**
 * A once-per-incident org alert: suppressed while `cooldownKey` is set, otherwise
 * fanned out to every Slack org, and the cooldown is set (for `ttlSeconds`) only
 * when at least one org was alerted. Returns whether anything was alerted.
 */
export async function rateLimitedOrgAlert(opts: {
  kv: CooldownKv
  cooldownKey: string
  ttlSeconds: number
  supabase: SupabaseClient
  logLabel: string
  /** See SlackListUse; the finding is in hand before this is called, so almost always 'tell-only'. */
  use: SlackListUse
  perOrg: (orgId: string) => Promise<boolean>
}): Promise<boolean> {
  if (await opts.kv.get(opts.cooldownKey)) return false
  const alerted = anyDelivered(await forEachSlackOrg(opts.supabase, opts.logLabel, opts.use, opts.perOrg))
  if (alerted) await opts.kv.put(opts.cooldownKey, '1', { expirationTtl: opts.ttlSeconds })
  return alerted
}
