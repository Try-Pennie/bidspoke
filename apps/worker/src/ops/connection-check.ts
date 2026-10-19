/**
 * The connection_check sweep, and the login states the ops minute tick reports
 * (#2340, phase 10 of #1689; plan: discussion #2329). The sweep is one of the
 * tick's claimed sweeps (tick.ts TICK_SWEEPS); the login states are read every
 * tick.
 *
 * WHY. A credential can go bad between runs (revoked, expired, its user turned
 * off, its permission removed), and nothing would say so until an ops workflow
 * step failed on it. The sweep proves each connection's login on a schedule, so
 * the failure is found and paged before a workflow meets it.
 *
 * WHAT, per connection connection_check_targets lists (every copy not withdrawn
 * and not removed, least recently checked first, supabase-ops migration
 * 20261020030000): ask the service who the credential is, through
 * connectionFetch with the connection's committed copy, purpose
 * connection_check, by the service's registered identity probe (the one verify
 * uses: Salesforce /services/oauth2/userinfo, Snowflake CURRENT_USER() and the
 * account), and write the result with record_connection_check, which writes the
 * last_check_* columns only. A Salesforce identity must still be the one verify
 * measured for the generation (identity_changed otherwise); a Snowflake one is
 * held to the declared target by its probe. Not probed: a copy past its serve
 * window (connectionFetch would refuse it), and one in needs_reauth (only a
 * Reconnect clears it, and the login state below pages it). A service with no
 * probe on this Worker is counted: verify refuses such a service at save, so
 * no verified connection of one exists.
 *
 * THE INTERVAL (CONNECTION_CHECK_EVERY_SECONDS). Claimed every 14 minutes, so
 * with the tick landing once a minute the sweep runs every 14 or 15 minutes,
 * or 16 when a tick is missing (#2347). Three things set it:
 *  - Ops workflows are scheduled hourly or slower, so a credential that went bad
 *    after one run is proved bad, and paged, before the next.
 *  - Dan's decision 2 holds a token endpoint that times out or answers 5xx in
 *    refresh_failing until 5 failures, the first 15 minutes old. A probe is a
 *    login whenever no token is held, so during an outage nothing else meets,
 *    the sweep alone carries the streak to that bound within five sweeps, about
 *    an hour, rather than leaving it below the bound and unpaged for ever.
 *  - Each probe is one identity read (and a login only when no token is held):
 *    about a hundred a day per connection, a small share of a Salesforce org's
 *    daily allocation. The Salesforce ones take a lease under the
 *    connection_check purpose, whose approved share is 1 (Dan, migration
 *    20261020010000), so the connections of one Salesforce org are probed one
 *    after another, never meeting that share themselves.
 *
 * FAILURES are keyed tick problems (OPS_TICK_PROBLEM_RULES), each at once,
 * because a sweep that runs every fourteenth tick can never be reported by
 * three ticks in a row. The hold is done here instead, by the age of the
 * connection's last passing check on the database clock:
 *  - refused (connection_check_refused) or unreadable
 *    (connection_check_unreadable): the next probe will meet it again (a 4xx,
 *    a refusal by rule, an identity other than the verified one, an answer that
 *    is not an identity). Recorded as a failed check, paged at once.
 *  - failed: the service did not answer the probe (a timeout, a network error,
 *    a 5xx). Recorded as a failed check.
 *  - not_run: the probe could not be made (the pool was busy or below its
 *    budget floor, the service asked to wait, the copy could not be read). Not
 *    a failed check (Dan: a refusal for a full pool is not a failed check), so
 *    nothing is recorded.
 *  - failed and not_run are held while the last passing check is younger than
 *    CONNECTION_CHECK_HOLD_WHILE_YOUNGER_MS, which only the previous sweep's can
 *    be, and paged (connection_check_unavailable) once it is older: the second
 *    in a row, or a connection that has never passed one.
 *  - login: the login was refused (needs_reauth) or its token endpoint failed
 *    (the refresh streak). Recorded as a failed check and not reported as a
 *    tick problem, because the login state below pages it, through its own
 *    signal, by Dan's decision 2 rules.
 *  - gone: the connection was removed between the list and its probe. Counted.
 * A cause is always a name (a refusal code, http_<status>, identity_changed),
 * never a message: a refusal's message is built from names, and an error that
 * is not one is named by its kind alone (F120).
 *
 * Each connection is its own failure boundary with its own deadline, and the
 * sweep never throws. It stamps start and completion with the bidding Worker
 * (OpsGateway.opsJobStarted and opsJobCompleted, under CONNECTION_CHECK_JOB); a
 * stamp that fails is counted and never stops the sweep, and a sweep that stops
 * stamping is the ops-connection-check heartbeat's to page (cron-heartbeat.ts),
 * on the bidding Worker, which this Worker's health cannot silence (L71).
 *
 * THE LOGIN STATES (judgeConnectionLogins), read every tick from the same list,
 * whether or not the sweep runs, so a needs_reauth a workflow step wrote pages
 * within a minute or two rather than at the next sweep. needs_reauth is listed
 * at once: a person must reconnect. refresh_failing is listed once Dan's
 * decision 2 bound is met (REFRESH_FAILING_PAGE_FAILURES failures, the first at
 * least REFRESH_FAILING_PAGE_SPAN_MS old), the same bound
 * record_connection_refresh escalates by, so it pages the streak that has met
 * the bound and is waiting only for its next failure to become needs_reauth.
 * The bidding Worker pages each listed login through the ops-connection-login
 * signal (lib/ops-connection-logins.ts) and sends the all clear once a complete
 * list no longer names it.
 */
import { raceDeadline } from '../lib/alert-claim'
import { formatErr } from '../lib/format-error'
import {
  MAX_REPORT_LOGINS, REFRESH_FAILING_PAGE_FAILURES, REFRESH_FAILING_PAGE_SPAN_MS, tickProblem, type ConnectionLoginAlert, type ConnectionLoginsReport, type NeedsReauthReason, type OpsJobReport, type TickProblem,
} from '../lib/ops-gateway-contract'
import { NEEDS_REAUTH_CAUSES } from './connections/connection-fetch'
import { IdentityMismatch, IdentityUnreadable, type MeasuredIdentity } from './connections/identity'
import { ConnectionRefusal, type ConnectionRefusalCode } from './connections/refusals'
import type { ConnectionCheckTarget } from './ops-writes'

/** claim_ops_sweep's interval for connection_check: see THE INTERVAL above. */
export const CONNECTION_CHECK_EVERY_SECONDS = 14 * 60
/** The most connections one sweep probes. None in production today; the least recently checked come first, so a full sweep rotates. */
export const CONNECTION_CHECK_MAX_CONNECTIONS = 50
/** connectionFetch's own deadline for each request of a probe: an identity read is one small GET or statement. */
export const CONNECTION_CHECK_PROBE_DEADLINE_MS = 30_000
/** One connection's whole probe, the copy read, lease, login, identity read and record included. Past it the probe is a failure of that connection alone. */
export const CONNECTION_CHECK_DEADLINE_MS = 45_000
/** A failure the next probe may not meet is held while the last passing check is younger than this: one interval with a missed tick (16 minutes), and less than two (28). */
export const CONNECTION_CHECK_HOLD_WHILE_YOUNGER_MS = 20 * 60_000
/** The login states one tick reads: every ops connection, well inside PostgREST's 1,000 rows (L24). */
export const CONNECTION_LOGINS_READ_LIMIT = 500

/** Dan's decision 2 bound, defined once in the contract both Workers read. */
export { REFRESH_FAILING_PAGE_FAILURES, REFRESH_FAILING_PAGE_SPAN_MS } from '../lib/ops-gateway-contract'

export type ConnectionCheckKind = 'refused' | 'login' | 'failed' | 'not_run' | 'gone'

/**
 * How the sweep treats each refusal connectionFetch can throw (see FAILURES
 * above). Every code is listed, so a new one fails to compile until it is
 * decided here.
 */
export const CONNECTION_CHECK_REFUSAL_KINDS = {
  connection_call_invalid: 'refused',
  connection_removed: 'gone',
  connection_withdrawn: 'gone',
  connection_copy_expired: 'gone',
  connection_not_found: 'gone',
  connection_copy_unreadable: 'not_run',
  connection_service_unknown: 'refused',
  connection_service_mismatch: 'refused',
  connection_generation_older: 'refused',
  connection_candidate_not_allowed: 'refused',
  connection_seal_refused: 'refused',
  connection_target_invalid: 'refused',
  connection_url_invalid: 'refused',
  connection_host_not_declared: 'refused',
  // The pool, our side: the probe was not made.
  sf_pool_busy: 'not_run',
  // A Salesforce connection whose generation verify never measured: a person must verify it.
  sf_org_unmeasured: 'refused',
  sf_cap_unset: 'refused',
  sf_purpose_cap_unset: 'refused',
  // The org's budget, which the sf_limits sweep reports: the probe was not made.
  sf_budget_floor: 'not_run',
  sf_budget_unmeasured: 'not_run',
  sf_lease_unavailable: 'not_run',
  // The probe records nothing (recordsNothing), so this cannot happen; one that does is a defect.
  connection_record_failed: 'refused',
  connection_needs_reauth: 'login',
  connection_auth_unavailable: 'login',
  connection_not_allowed: 'refused',
  connection_auth_check_unavailable: 'not_run',
  connection_token_object_unavailable: 'not_run',
  // A login that failed naming no cause: connectionFetch records nothing for it, so it is paged here.
  connection_auth_failed: 'refused',
  connection_network_error: 'failed',
  connection_aborted: 'failed',
  connection_timeout: 'failed',
  connection_body_not_resendable: 'refused',
  connection_rate_limited: 'not_run',
} as const satisfies Record<ConnectionRefusalCode, ConnectionCheckKind>

/** What the live probe saw of the identity request: the last response status, so a 5xx is told from a 4xx. */
export interface ProbeSeen {
  lastStatus: number | null
}

/** What a probe answers: the identity measured, or that the service has no probe on this Worker. A refusal is thrown. */
export type ProbeAnswer = { readonly kind: 'measured'; readonly identity: MeasuredIdentity } | { readonly kind: 'unprobed' }

export interface ConnectionCheckSweepDeps {
  /** connection_check_targets (ops-writes.ts readConnectionCheckTargets). Throws on a failed read. */
  targets(limit: number): Promise<{ targets: ConnectionCheckTarget[]; reachedLimit: boolean }>
  /**
   * The service's identity probe through connectionFetch, purpose
   * connection_check, the committed copy only. Throws a ConnectionRefusal,
   * IdentityUnreadable or IdentityMismatch by name; fills `seen` as it goes.
   */
  probe(target: ConnectionCheckTarget, seen: ProbeSeen): Promise<ProbeAnswer>
  /** record_connection_check: the last_check_* columns only. */
  record(target: ConnectionCheckTarget, result: { ok: true } | { ok: false; cause: string }): Promise<'recorded' | 'connection_removed'>
  /** OpsGateway.opsJobStarted(CONNECTION_CHECK_JOB). */
  started(): Promise<void>
  /** OpsGateway.opsJobCompleted(CONNECTION_CHECK_JOB, report). */
  completed(report: OpsJobReport): Promise<void>
  /** This Worker's clock: only the job report's start and finish read it. */
  now(): number
  /** The per connection deadline (L524: injected). */
  sleep(ms: number): Promise<void>
  /** A JSON log line of names and counts, never a payload. */
  log(fields: Record<string, string | number | boolean | null>): void
}

export interface ConnectionCheckSweepResult {
  problems: TickProblem[]
  counts: Record<string, number>
}

type Outcome =
  | { kind: 'passed' }
  | { kind: 'unprobed' }
  | { kind: 'refused' | 'unreadable' | 'login' | 'failed' | 'not_run' | 'gone'; cause: string }

/** A Salesforce identity is verify's when the org (by its 15 character form) and the username (in any case) agree. */
function sameSalesforceIdentity(measured: { sfOrgId: string; username: string }, verified: { sfOrgId: string; username: string }): boolean {
  return measured.sfOrgId.slice(0, 15) === verified.sfOrgId.slice(0, 15) && measured.username.trim().toLowerCase() === verified.username.trim().toLowerCase()
}

/** One connection's probe, classified. Never throws. */
async function probeConnection(deps: ConnectionCheckSweepDeps, target: ConnectionCheckTarget): Promise<Outcome> {
  const seen: ProbeSeen = { lastStatus: null }
  let answer: ProbeAnswer
  try {
    answer = await deps.probe(target, seen)
  } catch (err) {
    if (err instanceof ConnectionRefusal) return { kind: CONNECTION_CHECK_REFUSAL_KINDS[err.code], cause: err.code }
    if (err instanceof IdentityMismatch) return { kind: 'refused', cause: 'identity_mismatch' }
    if (err instanceof IdentityUnreadable) {
      const status = seen.lastStatus
      if (status !== null && status >= 500) return { kind: 'failed', cause: `http_${status}` }
      if (status !== null && status !== 200) return { kind: 'refused', cause: `http_${status}` }
      return { kind: 'unreadable', cause: 'identity_unreadable' }
    }
    // Only a name: an error that is not a ConnectionRefusal was built by nothing that scrubs its message (F120).
    return { kind: 'refused', cause: `failed without a named refusal (${err instanceof Error ? err.name : 'not an Error'})` }
  }
  if (answer.kind === 'unprobed') return { kind: 'unprobed' }
  const verified = target.measuredIdentity
  if (answer.identity.kind === 'salesforce' && verified !== null && !sameSalesforceIdentity(answer.identity, verified)) {
    return { kind: 'refused', cause: 'identity_changed' }
  }
  return { kind: 'passed' }
}

/** The probe and its record. Never throws. */
async function checkConnection(deps: ConnectionCheckSweepDeps, target: ConnectionCheckTarget, bump: (key: string) => void): Promise<Outcome> {
  const raced = await raceDeadline(() => probeConnection(deps, target), CONNECTION_CHECK_DEADLINE_MS, (ms) => deps.sleep(ms))
  const outcome: Outcome = raced.kind === 'ok'
    ? raced.value
    : raced.kind === 'timed_out'
      ? { kind: 'failed', cause: `deadline of ${CONNECTION_CHECK_DEADLINE_MS / 1000} s` }
      : { kind: 'refused', cause: 'failed without a named refusal' }
  if (outcome.kind === 'unprobed' || outcome.kind === 'not_run' || outcome.kind === 'gone') return outcome

  const result = outcome.kind === 'passed' ? { ok: true as const } : { ok: false as const, cause: outcome.cause }
  let written: 'recorded' | 'connection_removed'
  try {
    written = await deps.record(target, result)
  } catch {
    bump('connection_check_record_failed')
    // A passing probe nobody recorded proves nothing the next reader can see, so it is held as a failure the next sweep may not meet.
    return outcome.kind === 'passed' ? { kind: 'failed', cause: 'record_failed' } : outcome
  }
  if (written === 'connection_removed') return { kind: 'gone', cause: 'connection_removed' }
  return outcome
}

/** The last passing check's age on the database clock, or null when there has been none. */
function lastPassAgeMs(target: ConnectionCheckTarget): number | null {
  if (target.lastCheckOkAt === null) return null
  const age = Date.parse(target.dbNow) - Date.parse(target.lastCheckOkAt)
  // An unreadable age is judged as old, the side that pages (L50).
  return Number.isFinite(age) ? Math.max(age, 0) : Number.POSITIVE_INFINITY
}

const minutes = (ms: number) => `${Math.floor(ms / 60_000)} minutes`

/**
 * The connections probed one after another: those of one measured Salesforce
 * org share its connection_check purpose share of 1. Every other connection is
 * its own group, and the groups run at once.
 */
function groupsOf(targets: readonly ConnectionCheckTarget[]): ConnectionCheckTarget[][] {
  const groups = new Map<string, ConnectionCheckTarget[]>()
  for (const t of targets) {
    const key = t.service === 'salesforce' && t.measuredIdentity !== null ? `sf:${t.measuredIdentity.sfOrgId.slice(0, 15)}` : `c:${t.connectionId}`
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  return [...groups.values()]
}

export async function runConnectionCheckSweep(deps: ConnectionCheckSweepDeps): Promise<ConnectionCheckSweepResult> {
  const startedAt = new Date(deps.now()).toISOString()
  const problems: TickProblem[] = []
  const counts: Record<string, number> = {}
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const stampFailed = (which: 'started' | 'completed', err: unknown) => {
    bump('connection_check_stamps_failed')
    deps.log({ event: 'ops_tick', step: 'connection_check_stamp_failed', stamp: which, error: formatErr(err) })
  }

  try {
    await deps.started()
  } catch (err) {
    stampFailed('started', err)
  }

  let targets: ConnectionCheckTarget[] = []
  try {
    const read = await deps.targets(CONNECTION_CHECK_MAX_CONNECTIONS)
    targets = read.targets
    counts.connection_check_connections = targets.length
    if (read.reachedLimit) {
      problems.push(tickProblem('connection_check_limit', `The connection check found ${CONNECTION_CHECK_MAX_CONNECTIONS} ops connections, its limit, so any past them wait for a later sweep; the least recently checked go first.`))
    }
  } catch (err) {
    problems.push(tickProblem('connection_check_failed', `The connection check could not read which ops connections to check (${formatErr(err)}), so no login was proved; it runs again in ${CONNECTION_CHECK_EVERY_SECONDS / 60} minutes.`))
  }

  const toProbe: ConnectionCheckTarget[] = []
  for (const t of targets) {
    if (!t.servable) bump('connection_check_not_servable')
    else if (t.status === 'needs_reauth') bump('connection_check_skipped_reauth')
    else toProbe.push(t)
  }

  const outcomes = new Map<ConnectionCheckTarget, Outcome>()
  await Promise.all(groupsOf(toProbe).map(async (group) => {
    for (const t of group) outcomes.set(t, await checkConnection(deps, t, bump))
  }))

  for (const t of toProbe) {
    const outcome = outcomes.get(t) ?? { kind: 'refused', cause: 'failed without a named refusal' }
    const id = t.connectionId
    const named = `the ${t.service} connection ${id}`
    switch (outcome.kind) {
      case 'passed':
        bump('connection_check_passed')
        continue
      case 'unprobed':
        bump('connection_check_unprobed')
        continue
      case 'gone':
        bump('connection_check_gone')
        continue
      case 'login':
        bump('connection_check_login_failed')
        continue
      case 'refused':
        problems.push(tickProblem('connection_check_refused', `The connection check of ${named} was refused (${outcome.cause}), and the next check will meet the same; an ops workflow step that uses it will fail too.`, id))
        continue
      case 'unreadable':
        problems.push(tickProblem('connection_check_unreadable', `The connection check of ${named} got an answer that is not an identity (${outcome.cause}), so its login could not be proved.`, id))
        continue
      case 'failed':
      case 'not_run': {
        if (outcome.kind === 'not_run') bump('connection_check_not_run')
        const age = lastPassAgeMs(t)
        if (age !== null && age < CONNECTION_CHECK_HOLD_WHILE_YOUNGER_MS) {
          bump('connection_check_held')
          deps.log({ event: 'ops_tick', step: 'connection_check_held', connection_id: id, cause: outcome.cause, last_pass_age_ms: age })
          continue
        }
        const since = age === null ? 'it has never passed a check' : `its last passing check was ${Number.isFinite(age) ? minutes(age) : 'an unreadable time'} ago`
        const what = outcome.kind === 'failed' ? 'failed again' : 'could not be made again'
        problems.push(tickProblem('connection_check_unavailable', `The connection check of ${named} ${what} (${outcome.cause}), and ${since}.`, id))
        continue
      }
    }
  }

  const report: OpsJobReport = { started_at: startedAt, finished_at: new Date(deps.now()).toISOString(), counts: { ...counts } }
  try {
    await deps.completed(report)
  } catch (err) {
    stampFailed('completed', err)
  }
  return { problems, counts }
}

/** The closed set a needs_reauth cause is read as, by its start (connection-fetch.ts NEEDS_REAUTH_CAUSES). */
function needsReauthReason(cause: string | null): NeedsReauthReason {
  if (cause === null) return 'other'
  if (cause.startsWith(`${NEEDS_REAUTH_CAUSES.loginRefused}:`)) return 'login_refused'
  if (cause === NEEDS_REAUTH_CAUSES.refusedAfterRenew) return 'refused_after_renew'
  if (cause.startsWith(`${NEEDS_REAUTH_CAUSES.refreshFailingExhausted}:`)) return 'refresh_exhausted'
  return 'other'
}

/** Whether a refresh streak has met Dan's decision 2 bound on the database clock. An unreadable start is judged as old (L50). */
function refreshBoundMet(t: ConnectionCheckTarget): boolean {
  if (t.refreshFailures < REFRESH_FAILING_PAGE_FAILURES) return false
  const age = t.refreshFailingSince === null ? Number.NaN : Date.parse(t.dbNow) - Date.parse(t.refreshFailingSince)
  return !Number.isFinite(age) || age >= REFRESH_FAILING_PAGE_SPAN_MS
}

/**
 * The logins due to page, from the tick's read of every connection: each in
 * needs_reauth, and each in refresh_failing past decision 2's bound. Complete
 * only when the read did not reach its limit and every one fits the report, so
 * the bidding Worker never sends an all clear for a connection it was not told
 * about. Copies past their serve window are judged too: bidding being down
 * must not read as a login cleared.
 */
export function judgeConnectionLogins(read: { targets: readonly ConnectionCheckTarget[]; reachedLimit: boolean }): ConnectionLoginsReport {
  const due: ConnectionLoginAlert[] = []
  for (const t of read.targets) {
    if (t.status === 'needs_reauth') {
      due.push({
        organization_id: t.organizationId, connection_id: t.connectionId, service: t.service, state: 'needs_reauth',
        reason: needsReauthReason(t.needsReauthCause), since: t.needsReauthAt ?? t.dbNow, failures: null,
      })
    } else if (t.status === 'refresh_failing' && refreshBoundMet(t)) {
      due.push({
        organization_id: t.organizationId, connection_id: t.connectionId, service: t.service, state: 'refresh_failing',
        reason: null, since: t.refreshFailingSince !== null && Number.isFinite(Date.parse(t.refreshFailingSince)) ? t.refreshFailingSince : t.dbNow,
        failures: t.refreshFailures,
      })
    }
  }
  return { complete: !read.reachedLimit && due.length <= MAX_REPORT_LOGINS, logins: due.slice(0, MAX_REPORT_LOGINS) }
}
