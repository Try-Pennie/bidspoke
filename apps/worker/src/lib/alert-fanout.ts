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
 * (failure-rate, slow-execution-rate, database-reachability.ts): those
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
 *
 * CLAIMS FOR THE MINUTE ALERTS ONLY (#2062, #1303 phase 4). A second delivery of
 * the same tick is already stopped before any job starts (runCronTickOnce,
 * cron-once.ts). What that cannot stop is a tick from one minute still running
 * when the next minute's starts, which needs a tick longer than a minute: what
 * a stalled database or KV produces. Only the every minute cron runs often
 * enough to overlap itself like that, so only its alerts take a claim here:
 * failure-rate, slow-execution-rate, upstream-outage, the cron heartbeat and the
 * database reachability owner (which keeps the claim key it already had,
 * `db-unreachable:<org>`). The volume check claims its page under its own key
 * from before (#1298). The hourly and daily checks get no claim: one of their
 * ticks would have to run for a whole hour or day to meet the next, and a claim
 * per check per tick would be a Durable Object call for a race that cannot
 * happen. web guard minute-alert-claims-wired.test.ts holds both halves.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AlertClaims } from './alert-claim'
import type { AllClearClaim } from './alert-recovery'
import { logReadFailure } from './scheduled-read'
import { formatErr } from './format-error'
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
 * Every Slack connection, straight from the database and never from the copy,
 * for the two readers whose failure is itself the evidence (#2061): the
 * database reachability probe, which bounds it and writes what it reads to the
 * saved copy (database-reachability.ts), and the volume check, which reads its
 * organizations with it under the client's full deadline as before
 * (volume-cliff.ts). Deliberately NOT the bounded read above.
 *
 * It takes no SlackListUse because it can only answer from the database: it is
 * 'measure-from-database' by construction. It must never be 'tell-only', since
 * writing the copy from the copy would re-date stale entries as fresh (#2060).
 */
export function readSlackConnectionRows(supabase: SupabaseClient) {
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
  /** See SlackListUse; the finding is in hand before this is called, so almost always 'tell-only'. */
  use: SlackListUse
  perOrg: (orgId: string) => Promise<boolean>
}): Promise<boolean> {
  if (await opts.kv.get(opts.cooldownKey)) return false
  const alerted = anyDelivered(await forEachSlackOrg(opts.supabase, opts.logLabel, opts.use, opts.perOrg))
  if (alerted) await opts.kv.put(opts.cooldownKey, '1', { expirationTtl: opts.ttlSeconds })
  return alerted
}

/**
 * How long a minute alert's claim is held (#2062). At least the worst case from
 * the claim to the cooldown write, so a tick behind the claimant cannot post
 * before the cooldown is there to stop it. Everything between the two runs
 * inside one minute job: the bounded Slack lookup (SCHEDULED_SLACK_READ_DEADLINE_MS,
 * 3 s), the claim's own deadline (CLAIM_DEADLINE_MS) and the post, which has no
 * deadline of its own, and past MINUTE_JOB_DEADLINE_MS (50 s, index.ts) the
 * minute stops waiting and Cloudflare cancels the calls it left (#2058). Five
 * minutes is that bound six times over, which also outlasts KV's propagation of
 * the cooldown to another location. The cost is on the other side: a claimant
 * that dies before posting holds the page back for up to five minutes.
 * minute-alert-claims.test.ts ties it to those deadlines.
 */
export const MINUTE_ALERT_CLAIM_TTL_SECONDS = 5 * 60

/**
 * A minute alert's claim key: `minute-alert:` is its own namespace, so it can
 * never meet an existing alert claim (volume-cliff:<wf>, db-unreachable:<org>,
 * <signal>-recovery-<id>) or the cron tick claim.
 */
export function minuteAlertClaimKey(kind: 'page' | 'all-clear', signal: string, id: string): string {
  return `minute-alert:${kind}:${signal}:${id}`
}

/** The claim a minute alert passes to announceRecovery, which takes it only once the all-clear is owed and evident. */
export function minuteAllClearClaim(claims: AlertClaims | undefined, signal: string, id: string): AllClearClaim {
  return { claims, key: minuteAlertClaimKey('all-clear', signal, id), ttlSeconds: MINUTE_ALERT_CLAIM_TTL_SECONDS }
}

export type MinutePageOutcome = 'sent' | 'not_sent' | 'in_cooldown' | 'claimed_elsewhere'

/**
 * Post a minute alert's page under a claim (#2062): claim, THEN read the
 * cooldown that decides, then post (L157). Reading the cooldown first and
 * claiming after would act on a judgement formed before the claim: two ticks
 * both read no cooldown, the first posts and writes it, its claim lapses, and
 * the second claims and posts the same page again.
 *
 * The cooldown is also read once before the claim, which can only ever skip: a
 * standing cooldown means a post already went out, so a tick inside it makes no
 * call to the claim object. The read that lets a post through is the second.
 *
 * The claim is kept on a delivered post, for its TTL, and freed when the post is
 * refused or throws, so the next tick can retry. With no claims (a test, or a
 * worker with no ALERT_CLAIM binding) it posts as before. A claim that cannot be
 * asked fails open and is logged by makeAlertClaims.
 */
export async function postMinutePage(opts: {
  claims: AlertClaims | undefined
  key: string
  inCooldown: () => Promise<boolean>
  send: () => Promise<boolean>
}): Promise<MinutePageOutcome> {
  const { claims, key } = opts
  if (await opts.inCooldown()) return 'in_cooldown'
  if (claims && !(await claims.claim(key, MINUTE_ALERT_CLAIM_TTL_SECONDS))) {
    console.log(`[alert-claim] ${key} claimed by another tick`)
    return 'claimed_elsewhere'
  }
  // Never throws: a release that fails must not replace the post's own error,
  // or turn a refused post into a throw (the claim then lapses at its TTL).
  const release = async () => {
    if (!claims) return
    try {
      await claims.release(key)
    } catch (e) {
      console.error(`[alert-claim] release ${key} failed: ${formatErr(e)}`)
    }
  }
  if (await opts.inCooldown()) {
    await release()
    return 'in_cooldown'
  }
  let sent: boolean
  try {
    sent = await opts.send()
  } catch (e) {
    await release()
    throw e
  }
  if (!sent) await release()
  return sent ? 'sent' : 'not_sent'
}
