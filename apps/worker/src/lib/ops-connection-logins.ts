/**
 * The page for an ops connection whose login needs a person (#2340, phase 10
 * of #1689; plan: discussion #2329).
 *
 * WHERE IT COMES FROM. The ops minute tick reads every ops connection's login
 * state every minute (ops/connection-check.ts judgeConnectionLogins) and sends
 * the ones due to page in its report: each in needs_reauth (a person must
 * reconnect it), and each in refresh_failing once Dan's decision 2 bound is met
 * (5 failures, the first at least 15 minutes old). The report is kept by
 * recordOpsTickCompleted (ops-gateway.ts); this reads that kept report, on the
 * bidding Worker, which the ops Worker's health cannot silence (L71).
 *
 * WHAT PAGES, per connection, to the connection's own organization (its Slack
 * alert channel, under the configuration alerts toggle), naming it by its name
 * and service from service_connections, never by a credential, a cause's text
 * or a customer value. The signal is ops-connection-login (incident-signals.ts),
 * keyed on the connection id, with the name and service as the incident's
 * label. A change of state (refresh_failing going on to needs_reauth) is a new
 * fact and posts at once; a repeat waits for the shared reminder schedule.
 *
 * THE ALL CLEAR. Sent once a COMPLETE list no longer names the connection: a
 * Reconnect cleared it, a login worked again, or the connection was removed. A
 * needs_reauth incident ends at once, since only a person's Reconnect clears it
 * (it cannot flap); a refresh_failing one ends only after the re-arm window,
 * since a provider can fail and recover by turns (#814). A list that is not
 * complete, a report that is missing, stale or unreadable, or a tick that
 * judged no login is UNJUDGED (L10, L11): no page, no all clear, and every open
 * incident's marker is kept alive. A tick that stopped reporting is the ops-tick
 * heartbeat's to page.
 *
 * Each connection is its own failure boundary, and nothing here throws to the
 * minute cron.
 */
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, recoveryKey, refreshAlerted, RECOVERY_REARM_MINUTES, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { backoffCooldownKey, clearCondition, describeRepeat, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf } from './alert-backoff'
import { minuteAllClearClaim, postMinutePage } from './alert-fanout'
import type { SupabaseClient } from '@supabase/supabase-js'
import { raceDeadline, type AlertClaims } from './alert-claim'
import { formatErr } from './format-error'
import { parseOpsTickReport, type ConnectionLoginAlert, type ConnectionLoginState, type ConnectionLoginsReport } from './ops-gateway-contract'
import { OPS_TICK_REPORT_FRESH_MS, OPS_TICK_REPORT_KEY } from './ops-gateway'
import { opsConnectionLabel, sendOpsConnectionLoginAlert, sendOpsConnectionLoginRecoveryAlert, type OpsConnectionLoginAlert } from './slack'

/** The incident record's signal (incident-signals.ts) and the prefix of every key below. */
export const OPS_CONNECTION_LOGIN_SIGNAL = 'ops-connection-login'

/**
 * Which connections have an incident open, so an owed all clear is not
 * forgotten. Written only when it changes, and with no expiry: an entry leaves
 * it only once its incident is settled, so it is bounded by the connections.
 */
export const OPS_CONNECTION_LOGIN_STATE_KEY = 'ops-connection-login:state'

const conditionKey = (connectionId: string) => `${OPS_CONNECTION_LOGIN_SIGNAL}:${connectionId}`

interface OpenLogin {
  organization_id: string
  service: string
  state: ConnectionLoginState
}

interface LoginState {
  open: Record<string, OpenLogin>
}

function parseState(raw: string | null): LoginState {
  if (!raw) return { open: {} }
  try {
    const v = JSON.parse(raw) as { open?: unknown }
    const open: Record<string, OpenLogin> = {}
    if (v.open && typeof v.open === 'object' && !Array.isArray(v.open)) {
      for (const [id, e] of Object.entries(v.open as Record<string, unknown>)) {
        const o = e as Partial<OpenLogin> | null
        if (o && typeof o.organization_id === 'string' && typeof o.service === 'string' && (o.state === 'needs_reauth' || o.state === 'refresh_failing')) {
          open[id] = { organization_id: o.organization_id, service: o.service, state: o.state }
        }
      }
    }
    return { open }
  } catch {
    // An unreadable record forgets which incidents were open; their markers still lapse at their expiry, and the drain closes them as lapsed.
    return { open: {} }
  }
}

export type KeptLogins = { judged: true; report: ConnectionLoginsReport } | { judged: false; why: string }

/**
 * The logins the tick's last kept report judged, or why there is no judgement
 * to act on. Never throws, and never answers an empty list for a report it
 * could not read.
 */
export async function readKeptConnectionLogins(kv: Pick<RecoveryKv, 'get'>, nowMs: number): Promise<KeptLogins> {
  let raw: string | null
  try {
    raw = await kv.get(OPS_TICK_REPORT_KEY)
  } catch (err) {
    return { judged: false, why: `the tick's report could not be read (${formatErr(err)})` }
  }
  if (raw === null) return { judged: false, why: 'there is no report from the ops tick' }
  let receivedMs: number
  let logins: ConnectionLoginsReport | null
  try {
    const parsed: unknown = JSON.parse(raw)
    receivedMs = Date.parse(String((parsed as { received_at?: unknown } | null)?.received_at))
    if (!Number.isFinite(receivedMs)) throw new Error('it has no time it was received')
    logins = parseOpsTickReport(parsed).connection_logins
  } catch (err) {
    return { judged: false, why: `the tick's report could not be read (${formatErr(err)})` }
  }
  if (nowMs - receivedMs > OPS_TICK_REPORT_FRESH_MS) return { judged: false, why: `the tick's report is ${Math.floor((nowMs - receivedMs) / 60_000)} minutes old` }
  if (logins === null) return { judged: false, why: 'the tick judged no login' }
  return { judged: true, report: logins }
}

export interface OpsConnectionLoginDeps {
  kv: RecoveryKv
  readLogins(): Promise<KeptLogins>
  /** service_connections.name of the connection, read inside its organization; null when it has no row. Throws on a failed read. */
  connectionName(organizationId: string, connectionId: string): Promise<string | null>
  /** Pages the connection's organization. Returns whether it reached Slack. */
  sendAlert(organizationId: string, alert: OpsConnectionLoginAlert): Promise<boolean>
  /** The all clear. Returns whether it reached Slack. */
  sendRecovery(organizationId: string, recovery: { subject: string; alertedAt: string; endedAt: string | null }): Promise<boolean>
  claims?: AlertClaims
  now(): number
}

export interface OpsConnectionLoginSummary {
  judged: boolean
  why?: string
  paged: string[]
  allClear: string[]
  /** Faults in the check's own bookkeeping, reported rather than thrown. */
  errors: string[]
}

async function nameOf(deps: OpsConnectionLoginDeps, organizationId: string, connectionId: string, errors: string[]): Promise<string | null> {
  try {
    return await deps.connectionName(organizationId, connectionId)
  } catch (err) {
    errors.push(`${connectionId}: its name could not be read: ${formatErr(err)}`)
    return null
  }
}

const incidentFor = (organizationId: string, label: string, errors: string[]): IncidentContext => ({
  scope: { kind: 'org', organizationId },
  subjectLabel: label,
  onRecordError: (message) => errors.push(message),
})

/** One due login: page it unless its reminder interval runs. Returns whether it was paged. */
async function pageLogin(deps: OpsConnectionLoginDeps, login: ConnectionLoginAlert, nowMs: number, errors: string[]): Promise<boolean> {
  const { kv } = deps
  const id = login.connection_id
  const name = await nameOf(deps, login.organization_id, id, errors)
  const incident = incidentFor(login.organization_id, opsConnectionLabel(name, login.service), errors)
  const key = conditionKey(id)
  await markSpikeSeen(kv, OPS_CONNECTION_LOGIN_SIGNAL, id, nowMs)
  const marker = await kv.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, id))
  const standing = await readCondition(kv, key)
  // The state is the problem: a change of state is a new one and posts at once (#1768).
  const print = await fingerprintAlert({ title: OPS_CONNECTION_LOGIN_SIGNAL, findings: [login.state], keys: [login.state] })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const posted = await postMinutePage({
    claims: deps.claims,
    key,
    inCooldown: async () => !different && (await inCooldown(kv, key)),
    send: () => deps.sendAlert(login.organization_id, {
      name, service: login.service, state: login.state, reason: login.reason, since: login.since, failures: login.failures,
      ...(reminderOf ? { repeat: describeRepeat(reminderOf, nowMs, recurrence.kind === 'reminder' && recurrence.unchanged) ?? undefined } : {}),
    }),
  })
  if (posted !== 'sent') {
    // Armed only on delivery, so a Slack outage does not buy silence, and an all clear never follows an unseen page.
    if (marker !== null) await refreshAlerted(kv, OPS_CONNECTION_LOGIN_SIGNAL, id)
    return false
  }
  await recordAlert(kv, key, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
  await markAlerted(kv, OPS_CONNECTION_LOGIN_SIGNAL, id, incident, nowMs)
  await recordPaged(kv, OPS_CONNECTION_LOGIN_SIGNAL, id, incident, nowMs)
  return true
}

/** One open incident no longer listed: its all clear. Returns whether its incident is still open afterwards. */
async function clearLogin(deps: OpsConnectionLoginDeps, id: string, open: OpenLogin, nowMs: number, errors: string[], allClear: string[]): Promise<boolean> {
  const { kv } = deps
  if ((await kv.get(recoveryKey(OPS_CONNECTION_LOGIN_SIGNAL, id))) === null) {
    // Never paged (its page did not deliver), or already settled: nothing is owed.
    await clearCondition(kv, conditionKey(id))
    return false
  }
  const name = await nameOf(deps, open.organization_id, id, errors)
  const label = opsConnectionLabel(name, open.service)
  const delivered = await announceRecovery(
    kv,
    OPS_CONNECTION_LOGIN_SIGNAL,
    id,
    backoffCooldownKey(conditionKey(id)),
    incidentFor(open.organization_id, label, errors),
    (alertedAt, endedAt) => deps.sendRecovery(open.organization_id, { subject: label, alertedAt, endedAt }),
    // Only a Reconnect clears needs_reauth, so it cannot flap; a refresh streak can.
    { now: nowMs, rearmMinutes: open.state === 'needs_reauth' ? 0 : RECOVERY_REARM_MINUTES, claim: minuteAllClearClaim(deps.claims, OPS_CONNECTION_LOGIN_SIGNAL, id) },
  )
  if (!delivered) return true
  await clearCondition(kv, conditionKey(id))
  allClear.push(id)
  return false
}

export async function runOpsConnectionLoginCheck(deps: OpsConnectionLoginDeps): Promise<OpsConnectionLoginSummary> {
  const nowMs = deps.now()
  const errors: string[] = []
  const summary: OpsConnectionLoginSummary = { judged: false, paged: [], allClear: [], errors }
  let rawState: string | null = null
  // A record that could not be read is not an empty one: writing over it would
  // drop every incident it holds, and with it the all clear each is owed.
  let stateRead = true
  try {
    rawState = await deps.kv.get(OPS_CONNECTION_LOGIN_STATE_KEY)
  } catch (err) {
    stateRead = false
    errors.push(`the open incidents could not be read, so they are left as stored: ${formatErr(err)}`)
  }
  const previous = parseState(rawState)
  const read = await deps.readLogins()

  if (!read.judged) {
    summary.why = read.why
    for (const id of Object.keys(previous.open)) {
      try {
        await refreshAlerted(deps.kv, OPS_CONNECTION_LOGIN_SIGNAL, id)
      } catch (err) {
        errors.push(`${id}: the open incident could not be kept: ${formatErr(err)}`)
      }
    }
    return summary
  }
  summary.judged = true

  const next: LoginState = { open: {} }
  const due = new Map(read.report.logins.map((l) => [l.connection_id, l]))
  for (const login of due.values()) {
    // Listed whatever the page does, so its all clear is asked for once it clears.
    next.open[login.connection_id] = { organization_id: login.organization_id, service: login.service, state: login.state }
    try {
      if (await pageLogin(deps, login, nowMs, errors)) summary.paged.push(login.connection_id)
    } catch (err) {
      errors.push(`${login.connection_id}: the page failed: ${formatErr(err)}`)
    }
  }
  for (const [id, open] of Object.entries(previous.open)) {
    if (due.has(id)) continue
    try {
      if (!read.report.complete) {
        // Past the list's limit, so unknown, not cleared: keep it.
        await refreshAlerted(deps.kv, OPS_CONNECTION_LOGIN_SIGNAL, id)
        next.open[id] = open
        continue
      }
      if (await clearLogin(deps, id, open, nowMs, errors, summary.allClear)) next.open[id] = open
    } catch (err) {
      errors.push(`${id}: the all clear failed: ${formatErr(err)}`)
      next.open[id] = open
    }
  }

  if (stateRead && JSON.stringify(next) !== JSON.stringify(previous)) {
    try {
      await deps.kv.put(OPS_CONNECTION_LOGIN_STATE_KEY, JSON.stringify(next))
    } catch (err) {
      errors.push(`the open incidents could not be kept for the next check: ${formatErr(err)}`)
    }
  }
  return summary
}

// ── Production wiring ───────────────────────────────────────────────────────

/** The name read may take this long before the page goes out naming the service alone. */
export const OPS_CONNECTION_NAME_DEADLINE_MS = 10_000

/**
 * The connection's name, read inside its own organization (the worker reads as
 * service_role, so the organization filter is the scoping), and nothing else of
 * the row: never its config, target or sealed login. Null when no row matches,
 * which is a connection that was removed. Throws on a failed read.
 */
export async function readOpsConnectionName(supabase: SupabaseClient, organizationId: string, connectionId: string): Promise<string | null> {
  const raced = await raceDeadline(
    async () => supabase.from('service_connections').select('name').eq('organization_id', organizationId).eq('id', connectionId).limit(1),
    OPS_CONNECTION_NAME_DEADLINE_MS,
  )
  if (raced.kind === 'timed_out') throw new Error(`the connection's name was not read within ${OPS_CONNECTION_NAME_DEADLINE_MS / 1000} seconds`)
  if (raced.kind === 'threw') throw raced.error
  const { data, error } = raced.value
  if (error) throw new Error(`the connection's name could not be read: ${formatErr(error)}`)
  if (!Array.isArray(data)) throw new Error('the connection\'s name read answered no rows')
  const row = data[0] as { name?: unknown } | undefined
  return row && typeof row.name === 'string' && row.name.trim() !== '' ? row.name : null
}

/** The minute check wired to the bidding Worker: the kept report in KV, the names in the bidding database, Slack. */
export function runOpsConnectionLoginCheckForEnv(supabase: SupabaseClient, kv: KVNamespace, claims?: AlertClaims): Promise<OpsConnectionLoginSummary> {
  return runOpsConnectionLoginCheck({
    kv,
    readLogins: () => readKeptConnectionLogins(kv, Date.now()),
    connectionName: (organizationId, connectionId) => readOpsConnectionName(supabase, organizationId, connectionId),
    sendAlert: (organizationId, alert) => sendOpsConnectionLoginAlert(supabase, organizationId, alert),
    sendRecovery: (organizationId, recovery) => sendOpsConnectionLoginRecoveryAlert(supabase, organizationId, recovery),
    claims,
    now: () => Date.now(),
  })
}
