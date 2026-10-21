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
 * THE WRITE BACK PAGE (#2340, phase 10 item 4 of #1689; the requirement is
 * #2425's), on the same engine. A person bound login's rotated refresh token
 * is held by its ConnectionTokenObject until service_connections takes it, and
 * while it waits the object holds the only copy. The ops tick asks each
 * connection's object on the connection check's interval and lists each write
 * back pending past its bound (ops/write-back-check.ts says why 30 minutes);
 * the bidding Worker keeps that list apart from the report
 * (OPS_TICK_WRITE_BACKS_KEY, recordOpsTickCompleted) and this pages each one
 * to its organization through the ops-connection-write-back signal, keyed on
 * the connection id and labelled with its name and service, as the login page
 * is. It is a signal of its own rather than a third login state, so a
 * connection whose write back waits while its login also fails has two
 * incidents, neither silencing nor clearing the other, and each judged on its
 * own cadence and freshness. Its all clear goes once a complete list no longer
 * names the connection, the write back having landed (or the connection
 * having been removed or reconnected), at once: a landed write back is a fact
 * the row holds, not a sample that can flap, and a later rotation must wait
 * out the whole bound again before it pages. Unjudged (no judgement kept, one
 * older than OPS_TICK_WRITE_BACKS_FRESH_MS, or one that cannot be read) is no
 * page, no all clear and every open incident kept, as for logins; an object
 * that could not say is the tick's write_back_unreadable problem, which pages.
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
import {
  CONNECTION_LOGIN_STATES, parseOpsTickReport, parseWriteBacks, type ConnectionLoginAlert, type ConnectionLoginsReport, type WriteBackAlert, type WriteBacksReport,
} from './ops-gateway-contract'
import { OPS_TICK_REPORT_FRESH_MS, OPS_TICK_REPORT_KEY, OPS_TICK_WRITE_BACKS_FRESH_MS, OPS_TICK_WRITE_BACKS_KEY } from './ops-gateway'
import {
  opsConnectionLabel, sendOpsConnectionLoginAlert, sendOpsConnectionLoginRecoveryAlert, sendOpsConnectionWriteBackAlert, sendOpsConnectionWriteBackRecoveryAlert,
  type OpsConnectionLoginAlert, type OpsConnectionWriteBackAlert,
} from './slack'

/** The incident record's signal (incident-signals.ts) and the prefix of every key below. */
export const OPS_CONNECTION_LOGIN_SIGNAL = 'ops-connection-login'

/** The write back page's signal (incident-signals.ts) and the prefix of its keys. */
export const OPS_CONNECTION_WRITE_BACK_SIGNAL = 'ops-connection-write-back'

/**
 * This check's minute job in the heartbeat registry (#2519), so a run that
 * stops is paged as itself. Never rename it: it keys its KV state.
 */
export const OPS_CONNECTION_LOGINS_JOB = 'ops-connection-logins'
/** The minute job that pages write backs pending past their bound, with its own heartbeat (#2519, #2340). */
export const OPS_CONNECTION_WRITE_BACKS_JOB = 'ops-connection-write-backs'

/**
 * Which connections have an incident open, so an owed all clear is not
 * forgotten. Written only when it changes, and with no expiry: an entry leaves
 * it only once its incident is settled, so it is bounded by the connections.
 */
export const OPS_CONNECTION_LOGIN_STATE_KEY = 'ops-connection-login:state'

/** The same for the write back page: its own record, so neither page's bookkeeping can drop the other's incidents. */
export const OPS_CONNECTION_WRITE_BACK_STATE_KEY = 'ops-connection-write-back:state'

type ConnectionSignal = typeof OPS_CONNECTION_LOGIN_SIGNAL | typeof OPS_CONNECTION_WRITE_BACK_SIGNAL

interface OpenEntry {
  organization_id: string
  service: string
  state: string
}

interface OpenState {
  open: Record<string, OpenEntry>
}

/**
 * The stored record, and how many of its entries could not be read. Nothing
 * can be recovered from an entry that cannot be read (it is the only copy of
 * whose incident it was), so the record is written over all the same: refusing
 * to would leave the check unable to keep any incident again. Each lost
 * incident's marker lapses at its expiry, and the drain closes it as lapsed,
 * which says truthfully that no all clear was sent. The count is reported.
 */
function parseState(raw: string | null, states: readonly string[]): { state: OpenState; unreadable: number } {
  if (!raw) return { state: { open: {} }, unreadable: 0 }
  try {
    const v = JSON.parse(raw) as { open?: unknown }
    const open: Record<string, OpenEntry> = {}
    if (!v.open || typeof v.open !== 'object' || Array.isArray(v.open)) return { state: { open }, unreadable: 1 }
    let unreadable = 0
    for (const [id, e] of Object.entries(v.open as Record<string, unknown>)) {
      const o = e as Partial<OpenEntry> | null
      if (o && typeof o.organization_id === 'string' && typeof o.service === 'string' && typeof o.state === 'string' && states.includes(o.state)) {
        open[id] = { organization_id: o.organization_id, service: o.service, state: o.state }
      } else {
        unreadable++
      }
    }
    return { state: { open }, unreadable }
  } catch {
    return { state: { open: {} }, unreadable: 1 }
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

export type KeptWriteBacks = { judged: true; report: WriteBacksReport } | { judged: false; why: string }

/**
 * The write backs the tick last judged (kept by recordOpsTickCompleted), or
 * why there is no judgement to act on: none kept, one older than
 * OPS_TICK_WRITE_BACKS_FRESH_MS, or one that cannot be read. Never throws, and
 * never answers an empty list for a judgement it could not read.
 */
export async function readKeptWriteBacks(kv: Pick<RecoveryKv, 'get'>, nowMs: number): Promise<KeptWriteBacks> {
  let raw: string | null
  try {
    raw = await kv.get(OPS_TICK_WRITE_BACKS_KEY)
  } catch (err) {
    return { judged: false, why: `the kept write back judgement could not be read (${formatErr(err)})` }
  }
  if (raw === null) return { judged: false, why: 'the ops tick has judged no write back' }
  let receivedMs: number
  let report: WriteBacksReport
  try {
    const parsed = JSON.parse(raw) as { received_at?: unknown; write_backs?: unknown } | null
    receivedMs = Date.parse(String(parsed?.received_at))
    if (!Number.isFinite(receivedMs)) throw new Error('it has no time it was received')
    report = parseWriteBacks(parsed?.write_backs)
  } catch (err) {
    return { judged: false, why: `the kept write back judgement could not be read (${formatErr(err)})` }
  }
  if (nowMs - receivedMs > OPS_TICK_WRITE_BACKS_FRESH_MS) return { judged: false, why: `the last write back judgement is ${Math.floor((nowMs - receivedMs) / 60_000)} minutes old` }
  return { judged: true, report }
}

/** What either check reads its names, its KV and its clock from. */
interface ConnectionSignalDeps {
  kv: RecoveryKv
  /** service_connections.name of the connection, read inside its organization; null when it has no row. Throws on a failed read. */
  connectionName(organizationId: string, connectionId: string): Promise<string | null>
  claims?: AlertClaims
  now(): number
}

export interface OpsConnectionLoginDeps extends ConnectionSignalDeps {
  readLogins(): Promise<KeptLogins>
  /** Pages the connection's organization. Returns whether it reached Slack. */
  sendAlert(organizationId: string, alert: OpsConnectionLoginAlert): Promise<boolean>
  /** The all clear. Returns whether it reached Slack. */
  sendRecovery(organizationId: string, recovery: { subject: string; alertedAt: string; endedAt: string | null; firstHealthyAt: string | null }): Promise<boolean>
}

export interface OpsConnectionWriteBackDeps extends ConnectionSignalDeps {
  readWriteBacks(): Promise<KeptWriteBacks>
  /** Pages the connection's organization. Returns whether it reached Slack. */
  sendAlert(organizationId: string, alert: OpsConnectionWriteBackAlert): Promise<boolean>
  /** The all clear. Returns whether it reached Slack. */
  sendRecovery(organizationId: string, recovery: { subject: string; alertedAt: string; endedAt: string | null; firstHealthyAt: string | null }): Promise<boolean>
}

export interface OpsConnectionLoginSummary {
  judged: boolean
  why?: string
  paged: string[]
  allClear: string[]
  /** Faults in the check's own bookkeeping, reported rather than thrown. */
  errors: string[]
}

/** One due item of either page: the connection it is about. */
interface DueItem {
  organization_id: string
  connection_id: string
  service: string
}

/**
 * What tells one page from the other: its signal and record, its states, how
 * it words a page and an all clear, how long an all clear waits, and the
 * arming of its marker, written per signal with its own constant so the
 * registry's armed guard (incident-signals-armed.test.ts) sees each one.
 */
interface ConnectionSignalRules<I extends DueItem> {
  signal: ConnectionSignal
  stateKey: string
  /** The states its open record may hold, each one a problem a change to which posts at once (#1768). */
  states: readonly string[]
  stateOf(item: I): string
  arm(kv: RecoveryKv, id: string, incident: IncidentContext, nowMs: number): Promise<void>
  send(organizationId: string, item: I, name: string | null, repeat: string | undefined): Promise<boolean>
  recover(organizationId: string, recovery: { subject: string; alertedAt: string; endedAt: string | null; firstHealthyAt: string | null }): Promise<boolean>
  /** How long a state must have stayed clear before its all clear goes. */
  rearmMinutes(state: string): number
}

type JudgedItems<I> = { judged: true; complete: boolean; items: readonly I[] } | { judged: false; why: string }

async function nameOf(deps: ConnectionSignalDeps, organizationId: string, connectionId: string, errors: string[]): Promise<string | null> {
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

/** One due item: page it unless its reminder interval runs. Returns whether it was paged. */
async function pageItem<I extends DueItem>(rules: ConnectionSignalRules<I>, deps: ConnectionSignalDeps, item: I, nowMs: number, errors: string[]): Promise<boolean> {
  const { kv } = deps
  const id = item.connection_id
  const name = await nameOf(deps, item.organization_id, id, errors)
  const incident = incidentFor(item.organization_id, opsConnectionLabel(name, item.service), errors)
  const key = `${rules.signal}:${id}`
  await markSpikeSeen(kv, rules.signal, id, nowMs)
  const marker = await kv.get(recoveryKey(rules.signal, id))
  const standing = await readCondition(kv, key)
  // The state is the problem: a change of state is a new one and posts at once (#1768).
  const state = rules.stateOf(item)
  const print = await fingerprintAlert({ title: rules.signal, findings: [state], keys: [state] })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const posted = await postMinutePage({
    claims: deps.claims,
    key,
    inCooldown: async () => !different && (await inCooldown(kv, key)),
    send: () => rules.send(
      item.organization_id, item, name,
      reminderOf ? describeRepeat(reminderOf, nowMs, recurrence.kind === 'reminder' && recurrence.unchanged) ?? undefined : undefined,
    ),
  })
  if (posted !== 'sent') {
    // Armed only on delivery, so a Slack outage does not buy silence, and an all clear never follows an unseen page.
    if (marker !== null) await refreshAlerted(kv, rules.signal, id)
    return false
  }
  await recordAlert(kv, key, reminderOf, nowMs, { fingerprint: nextFingerprint(standing, print) })
  await rules.arm(kv, id, incident, nowMs)
  await recordPaged(kv, rules.signal, id, incident, nowMs)
  return true
}

/** One open incident no longer listed: its all clear. Returns whether its incident is still open afterwards. */
async function clearItem<I extends DueItem>(
  rules: ConnectionSignalRules<I>, deps: ConnectionSignalDeps, id: string, open: OpenEntry, nowMs: number, errors: string[], allClear: string[],
): Promise<boolean> {
  const { kv } = deps
  if ((await kv.get(recoveryKey(rules.signal, id))) === null) {
    // Never paged (its page did not deliver), or already settled: nothing is owed.
    await clearCondition(kv, `${rules.signal}:${id}`)
    return false
  }
  const name = await nameOf(deps, open.organization_id, id, errors)
  const label = opsConnectionLabel(name, open.service)
  const delivered = await announceRecovery(
    kv,
    rules.signal,
    id,
    backoffCooldownKey(`${rules.signal}:${id}`),
    incidentFor(open.organization_id, label, errors),
    (alertedAt, endedAt, firstHealthyAt) => rules.recover(open.organization_id, { subject: label, alertedAt, endedAt, firstHealthyAt }),
    { now: nowMs, rearmMinutes: rules.rearmMinutes(open.state), claim: minuteAllClearClaim(deps.claims, rules.signal, id) },
  )
  if (!delivered) return true
  await clearCondition(kv, `${rules.signal}:${id}`)
  allClear.push(id)
  return false
}

/** Either page's minute check: page what is listed, clear what a complete list no longer names, keep the rest. */
async function runConnectionSignalCheck<I extends DueItem>(
  rules: ConnectionSignalRules<I>, deps: ConnectionSignalDeps, read: () => Promise<JudgedItems<I>>,
): Promise<OpsConnectionLoginSummary> {
  const nowMs = deps.now()
  const errors: string[] = []
  const summary: OpsConnectionLoginSummary = { judged: false, paged: [], allClear: [], errors }
  let rawState: string | null = null
  // A record that could not be read is not an empty one: writing over it would
  // drop every incident it holds, and with it the all clear each is owed.
  let stateRead = true
  try {
    rawState = await deps.kv.get(rules.stateKey)
  } catch (err) {
    stateRead = false
    errors.push(`the open incidents could not be read, so they are left as stored: ${formatErr(err)}`)
  }
  const parsed = parseState(rawState, rules.states)
  const previous = parsed.state
  if (parsed.unreadable > 0) {
    errors.push(`${parsed.unreadable} open incident record${parsed.unreadable === 1 ? '' : 's'} could not be read, so ${parsed.unreadable === 1 ? 'its' : 'their'} all clear cannot be sent; each closes as lapsed when its marker expires`)
  }
  const judged = await read()

  if (!judged.judged) {
    summary.why = judged.why
    for (const id of Object.keys(previous.open)) {
      try {
        await refreshAlerted(deps.kv, rules.signal, id)
      } catch (err) {
        errors.push(`${id}: the open incident could not be kept: ${formatErr(err)}`)
      }
    }
    return summary
  }
  summary.judged = true

  const next: OpenState = { open: {} }
  const due = new Map(judged.items.map((item) => [item.connection_id, item]))
  for (const item of due.values()) {
    // Listed whatever the page does, so its all clear is asked for once it clears.
    next.open[item.connection_id] = { organization_id: item.organization_id, service: item.service, state: rules.stateOf(item) }
    try {
      if (await pageItem(rules, deps, item, nowMs, errors)) summary.paged.push(item.connection_id)
    } catch (err) {
      errors.push(`${item.connection_id}: the page failed: ${formatErr(err)}`)
    }
  }
  for (const [id, open] of Object.entries(previous.open)) {
    if (due.has(id)) continue
    try {
      if (!judged.complete) {
        // Past the list's limit, or not answered, so unknown, not cleared: keep it.
        await refreshAlerted(deps.kv, rules.signal, id)
        next.open[id] = open
        continue
      }
      if (await clearItem(rules, deps, id, open, nowMs, errors, summary.allClear)) next.open[id] = open
    } catch (err) {
      errors.push(`${id}: the all clear failed: ${formatErr(err)}`)
      next.open[id] = open
    }
  }

  if (stateRead && JSON.stringify(next) !== JSON.stringify(previous)) {
    try {
      await deps.kv.put(rules.stateKey, JSON.stringify(next))
    } catch (err) {
      errors.push(`the open incidents could not be kept for the next check: ${formatErr(err)}`)
    }
  }
  return summary
}

export async function runOpsConnectionLoginCheck(deps: OpsConnectionLoginDeps): Promise<OpsConnectionLoginSummary> {
  return runConnectionSignalCheck<ConnectionLoginAlert>({
    signal: OPS_CONNECTION_LOGIN_SIGNAL,
    stateKey: OPS_CONNECTION_LOGIN_STATE_KEY,
    states: CONNECTION_LOGIN_STATES,
    stateOf: (login) => login.state,
    arm: (kv, id, incident, nowMs) => markAlerted(kv, OPS_CONNECTION_LOGIN_SIGNAL, id, incident, nowMs),
    send: (organizationId, login, name, repeat) => deps.sendAlert(organizationId, {
      name, service: login.service, state: login.state, reason: login.reason, since: login.since, failures: login.failures,
      ...(repeat ? { repeat } : {}),
    }),
    recover: (organizationId, recovery) => deps.sendRecovery(organizationId, recovery),
    // Only a Reconnect clears needs_reauth, so it cannot flap; a refresh streak can (#814).
    rearmMinutes: (state) => (state === 'needs_reauth' ? 0 : RECOVERY_REARM_MINUTES),
  }, deps, async () => {
    const read = await deps.readLogins()
    return read.judged ? { judged: true, complete: read.report.complete, items: read.report.logins } : read
  })
}

/** The one state the write back page records. */
const WRITE_BACK_PENDING = 'write_back_pending'

export async function runOpsConnectionWriteBackCheck(deps: OpsConnectionWriteBackDeps): Promise<OpsConnectionLoginSummary> {
  return runConnectionSignalCheck<WriteBackAlert>({
    signal: OPS_CONNECTION_WRITE_BACK_SIGNAL,
    stateKey: OPS_CONNECTION_WRITE_BACK_STATE_KEY,
    states: [WRITE_BACK_PENDING],
    // One state, whatever the count of tries: a growing count is the same problem, which the reminder schedule repeats.
    stateOf: () => WRITE_BACK_PENDING,
    arm: (kv, id, incident, nowMs) => markAlerted(kv, OPS_CONNECTION_WRITE_BACK_SIGNAL, id, incident, nowMs),
    send: (organizationId, wb, name, repeat) => deps.sendAlert(organizationId, {
      name, service: wb.service, since: wb.since, attempts: wb.attempts, ...(repeat ? { repeat } : {}),
    }),
    recover: (organizationId, recovery) => deps.sendRecovery(organizationId, recovery),
    // A landed write back is a fact the row holds, and a later rotation waits out the whole bound before it pages again.
    rearmMinutes: () => 0,
  }, deps, async () => {
    const read = await deps.readWriteBacks()
    return read.judged ? { judged: true, complete: read.report.complete, items: read.report.pending } : read
  })
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

/** The write back page wired to the bidding Worker: the kept judgement in KV, the names in the bidding database, Slack. */
export function runOpsConnectionWriteBackCheckForEnv(supabase: SupabaseClient, kv: KVNamespace, claims?: AlertClaims): Promise<OpsConnectionLoginSummary> {
  return runOpsConnectionWriteBackCheck({
    kv,
    readWriteBacks: () => readKeptWriteBacks(kv, Date.now()),
    connectionName: (organizationId, connectionId) => readOpsConnectionName(supabase, organizationId, connectionId),
    sendAlert: (organizationId, alert) => sendOpsConnectionWriteBackAlert(supabase, organizationId, alert),
    sendRecovery: (organizationId, recovery) => sendOpsConnectionWriteBackRecoveryAlert(supabase, organizationId, recovery),
    claims,
    now: () => Date.now(),
  })
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
