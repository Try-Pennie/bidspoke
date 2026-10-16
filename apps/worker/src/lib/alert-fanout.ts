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

/** Why an org list could not be read. `read_failed` only on a client with no saved copy to fall back on. */
export type SlackListUnreachableReason = Exclude<CopyUnreachableReason, 'org_not_in_copy'> | 'read_failed'

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
export async function slackOrgIds(supabase: SupabaseClient, logLabel: string): Promise<SlackOrgList> {
  const read = await readSlackRows<{ organization_id: string }>(supabase, logLabel, 'slack organizations', 'organization_id')
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

export async function readEverySlackConnection(supabase: SupabaseClient, logLabel: string): Promise<SlackConnectionsRead> {
  const read = await readSlackRows<{ organization_id: string; config: unknown }>(supabase, logLabel, 'slack connections', 'organization_id, config')
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
async function readSlackRows<R>(supabase: SupabaseClient, logLabel: string, what: string, columns: string): Promise<RowsRead<R>> {
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
  const copy = await scheduled.copy()
  if (copy.kind === 'read') {
    console.warn(`[scheduled-slack] ${subject}: answered from the saved copy (${describeCopyAge(copy.ageMs)}, ${copy.copy.connections.size} organizations) because the database did not answer (${live.how})`)
    return { kind: 'stored', copy: copy.copy.connections, ageMs: copy.ageMs }
  }
  const reason = copy.kind === 'absent' ? 'no_copy' : 'copy_unreadable'
  console.error(copyUnreachableLine(subject, reason, copy.kind === 'unreadable' ? copy.detail : undefined))
  return { kind: 'unreachable', reason }
}

/** What forEachSlackOrg did: ran perOrg for each org (from the database or the copy), or could not read the list. */
export type SlackFanout =
  | { kind: 'ran'; source: 'live' | 'stored'; results: boolean[] }
  | { kind: 'unreachable'; reason: SlackListUnreachableReason }

/**
 * Run `perOrg` once for each org with a Slack connection, in order, and return
 * each result. `perOrg` returns true when it delivered (or was a legitimate
 * no-op, e.g. the org opted out). Callers fold the results themselves:
 * drain-stall and big-table-guard want "any delivered" (`.some`),
 * sf-matrix-audit wants "every delivered" (`.every`) and also that the list
 * was read at all.
 */
export async function forEachSlackOrg(
  supabase: SupabaseClient,
  logLabel: string,
  perOrg: (orgId: string) => Promise<boolean>,
): Promise<SlackFanout> {
  const list = await slackOrgIds(supabase, logLabel)
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
 * told; an unread list is never "everyone was told" (#1303).
 */
export function everyDelivered(fanout: SlackFanout): boolean {
  return fanout.kind === 'ran' && fanout.results.every(Boolean)
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
  perOrg: (orgId: string) => Promise<boolean>
}): Promise<boolean> {
  if (await opts.kv.get(opts.cooldownKey)) return false
  const alerted = anyDelivered(await forEachSlackOrg(opts.supabase, opts.logLabel, opts.perOrg))
  if (alerted) await opts.kv.put(opts.cooldownKey, '1', { expirationTtl: opts.ttlSeconds })
  return alerted
}
