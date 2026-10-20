/**
 * What crosses the service binding between the two Workers for the ops minute
 * cron (#1949), in one place both sides import: the bidding Worker's OpsGateway
 * entrypoint (lib/ops-gateway-entrypoint.ts) and the ops tick (ops/tick.ts).
 *
 * Two things cross it:
 *  - the ops workflows' state, served by the bidding Worker (Dan's decision 4,
 *    2026-10-16, on #1949: the bidding Worker serves definitions to the ops
 *    Worker over the service binding, and the ops Worker keeps the last good
 *    copy). Only what a tick needs: each ops workflow's on or off state, its
 *    soft delete, its updated_at (the order key), its latest version and its
 *    trigger. A run's full definition at its version is #1950's to fetch;
 *  - the tick's report, which the bidding Worker stamps as the heartbeat and
 *    judges every minute, so the watchdog never depends on the Worker it
 *    watches (L71).
 *
 * Each side parses what it receives (L50): an RPC argument or answer is
 * whatever the other Worker's code put there, possibly an older release's.
 *
 * A third crosses it since #2335: a person bound connection's rotated login,
 * handed back by the ops ConnectionTokenObject to its one home by compare and
 * set (storeRotatedEnvelope, below). And since #2333, the same for a login the
 * ops Worker's resealConnections moved to the current kid during a rotation of
 * the ops key (replaceConnectionEnvelope, below).
 *
 * And two more since PR 6 of #2335 (plan: discussion #2329, part 2):
 *  - the ops connections, served by the bidding Worker (opsConnections), which
 *    the tick keeps as last good copies: each one's sealed envelope (ciphertext
 *    only), public config, declared target and serve_until, and the removals of
 *    the last 7 hours. Never a plaintext login: the bidding Worker cannot open an
 *    envelope, and a public config or target naming a login field is refused;
 *  - money's measured Salesforce run as identity for one organization
 *    (moneyIdentities), a non secret value ops verify compares a credential's
 *    measured identity against.
 *
 * And since #2340, the heartbeat stamps of the ops jobs other than the tick
 * (opsJobStarted, opsJobCompleted), each a sweep inside the tick that the
 * bidding Worker watches under its own id (OPS_GATEWAY_JOBS, below).
 */
import { CURRENT_OPS_KID, KID_PATTERN } from '@bidspoke/connection-seal'
import type { OpsSweep } from '../ops/run-vocabulary'

/** One ops workflow's state, as the bidding database holds it. */
export interface ServedOpsWorkflow {
  id: string
  organization_id: string
  is_active: boolean
  deleted_at: string | null
  /** workflows.updated_at: a trigger moves it on every update, so it orders copies. */
  updated_at: string
  /** The latest workflow_versions.version_number, or null for a workflow with none. */
  version_number: number | null
  /** definition.trigger, unvalidated. */
  trigger: unknown
}

export interface ServedOpsWorkflows {
  /** The bidding Worker's clock when it read the list. */
  served_at: string
  /** The list names every ops workflow, so one it omits is no longer an ops workflow. */
  complete: boolean
  workflows: ServedOpsWorkflow[]
}

/** The ops Worker's binding to the bidding Worker's OpsGateway entrypoint. */
export interface OpsGatewayBinding {
  opsWorkflows(): Promise<unknown>
  opsTickStarted(): Promise<unknown>
  opsTickCompleted(report: unknown): Promise<unknown>
  /** An ops job's heartbeat stamps (#2340): an id from OPS_GATEWAY_JOBS, and on completion an OpsJobReport. */
  opsJobStarted(jobId: string): Promise<unknown>
  opsJobCompleted(jobId: string, report: unknown): Promise<unknown>
  /** A StoreRotatedEnvelopeRequest in; a StoreRotatedEnvelopeAnswer out (#2335). */
  storeRotatedEnvelope(request: unknown): Promise<unknown>
  /** A ReplaceConnectionEnvelopeRequest in; a ReplaceConnectionEnvelopeAnswer out (#2333, the reseal). */
  replaceConnectionEnvelope(request: unknown): Promise<unknown>
  /** A ServedOpsConnections, for parseServedOpsConnections (#2335). */
  opsConnections(): Promise<unknown>
  /** One organization's ServedMoneyIdentities, for parseServedMoneyIdentities (#2335). */
  moneyIdentities(organizationId: string): Promise<unknown>
}

/**
 * How long a served connection copy may be used: Dan's decision 3 (2026-10-17,
 * discussion #2329). serve_until is served_at plus this, so a removal reaches
 * ops within 6 hours even while the bidding Worker is down (L625). The ops copy's
 * CHECK holds the same bound (connection_copies_serve_window).
 */
export const CONNECTION_SERVE_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * How long a removal is served: the life of an ops tombstone (expires_at is at
 * least removed_at plus 7 hours, connection_tombstones_ops_outlives_copies), the
 * serve window plus an hour, after which every copy served before the removal is
 * past its serve_until anyway.
 */
export const TOMBSTONE_SERVE_WINDOW_MS = 7 * 60 * 60 * 1000

/** The seal's envelope (packages/connection-seal): ciphertext and its key id, nothing else. */
export interface SealedEnvelopeShape {
  v: 1
  kid: string
  wrapped_key: string
  iv: string
  ct: string
}

/** One ops connection as the bidding Worker serves it: ciphertext and public config only. */
export interface ServedOpsConnection {
  /** service_connections.id. */
  id: string
  organization_id: string
  /** service_connections.service_type. */
  service: string
  /** credential_generation, which the envelope's AAD binds. */
  generation: number
  envelope: SealedEnvelopeShape
  public_config: Record<string, unknown>
  /** The declared host and account identity, or null for none. */
  target: Record<string, unknown> | null
  /** served_at plus CONNECTION_SERVE_WINDOW_MS. */
  serve_until: string
}

/** A removal of the last TOMBSTONE_SERVE_WINDOW_MS, at its highest generation. */
export interface ServedConnectionTombstone {
  connection_id: string
  organization_id: string
  generation: number
  removed_at: string
}

export interface ServedOpsConnections {
  /** The bidding Worker's clock when it read the list. */
  served_at: string
  /** The list names every ops connection, so one it omits is withdrawn on ops. */
  complete: boolean
  connections: ServedOpsConnection[]
  tombstones: ServedConnectionTombstone[]
}

/**
 * Money's Salesforce run as identity for one organization, as the bidding
 * Worker last measured it from money's own token (/services/oauth2/userinfo):
 * the Salesforce org id and the username. Non secret identifiers, never a login.
 */
export interface MoneySalesforceIdentity {
  sf_org_id: string
  username: string
  measured_at: string
}

export interface ServedMoneyIdentities {
  /** The organization asked about, and the only one answered. */
  organization_id: string
  served_at: string
  /** Null when there is no reading for that organization: unmeasured, never a pass. */
  salesforce: MoneySalesforceIdentity | null
}

/**
 * A person bound connection's rotated login, handed back to its one home by
 * the ops ConnectionTokenObject (#2335, PR 5 of phase 5 of #1689): a compare
 * and set of service_connections.credential_enc on the generation the object
 * last knew. The envelope is the seal's (packages/connection-seal), ciphertext
 * only; the bidding Worker cannot open it and does not try. `generation` is the
 * one its AAD binds, which the bidding Worker cannot read from it.
 */
export interface StoreRotatedEnvelopeRequest {
  organization_id: string
  connection_id: string
  expected_generation: number
  generation: number
  envelope: { v: 1; kid: string; wrapped_key: string; iv: string; ct: string }
}

/**
 * What store_rotated_envelope answered:
 *   stored          written now
 *   already_stored  the row already held this generation and envelope (a repeat
 *                   after a lost answer)
 *   moved           the row holds another generation, named with its envelope's
 *                   iv (null when it has none readable), so the object can tell
 *                   its own earlier write from a Reconnect: each seal draws a
 *                   fresh random iv
 *   not_found       no person bound ops row of that organization: removed
 */
export const STORE_ROTATED_ENVELOPE_OUTCOMES = ['stored', 'already_stored', 'moved', 'not_found'] as const
export type StoreRotatedEnvelopeOutcome = (typeof STORE_ROTATED_ENVELOPE_OUTCOMES)[number]

export interface StoreRotatedEnvelopeAnswer {
  outcome: StoreRotatedEnvelopeOutcome
  current_generation: number | null
  current_iv: string | null
}

/**
 * One ops connection's login moved from an old kid to the current one during a
 * rotation of the ops key (#2333, the reseal): the ops Worker's
 * resealConnections opens the envelope under expected_kid and seals the same
 * login to the current kid at the SAME generation, and this compare and set
 * writes it only while the row is still at expected_generation under
 * expected_kid. Ciphertext only; the bidding Worker cannot open either envelope.
 */
export interface ReplaceConnectionEnvelopeRequest {
  organization_id: string
  connection_id: string
  /** The kid the row's envelope named when the reseal read it. */
  expected_kid: string
  /** The row's credential_generation then, which the reseal keeps. */
  expected_generation: number
  /** Sealed under the committed current kid (CURRENT_OPS_KID), and no other. */
  envelope: SealedEnvelopeShape
}

/**
 * What replace_connection_envelope answered:
 *   replaced          written now
 *   already_replaced  the row already holds this very envelope (a repeat after a
 *                     lost answer)
 *   moved             the row is at another generation or names another kid,
 *                     named in the answer (kid null when its credential names
 *                     none); not written
 *   not_found         no ops_key row of that organization: removed
 */
export const REPLACE_CONNECTION_ENVELOPE_OUTCOMES = ['replaced', 'already_replaced', 'moved', 'not_found'] as const
export type ReplaceConnectionEnvelopeOutcome = (typeof REPLACE_CONNECTION_ENVELOPE_OUTCOMES)[number]

export interface ReplaceConnectionEnvelopeAnswer {
  outcome: ReplaceConnectionEnvelopeOutcome
  current_generation: number | null
  current_kid: string | null
}

/** The tick's own mode. Observe only (#1949): live claiming and dispatch come with run invocation (#1950). */
export const OPS_TICK_MODES = ['observe'] as const
export type OpsTickMode = (typeof OPS_TICK_MODES)[number]

export const OPS_TICK_OUTCOMES = ['ok', 'problems', 'not_configured'] as const
export type OpsTickOutcome = (typeof OPS_TICK_OUTCOMES)[number]

/** A secret's name, as Cloudflare and secret-lists.ts write it. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const MAX_NOT_CONFIGURED_SECRETS = 10

/** A report carries at most this many problems, each at most this long, so one bad tick cannot fill KV or a Slack post. */
export const MAX_REPORT_PROBLEMS = 20
export const MAX_PROBLEM_LENGTH = 400

/**
 * The two login states that page (#2340, phase 10 of #1689), from
 * connection_status's derivation: needs_reauth, which a person clears by
 * reconnecting, and refresh_failing once Dan's decision 2 bound is met.
 */
export const CONNECTION_LOGIN_STATES = ['needs_reauth', 'refresh_failing'] as const
export type ConnectionLoginState = (typeof CONNECTION_LOGIN_STATES)[number]

/**
 * Why a connection needs a reconnect, from a closed set read off the start of
 * its stored cause (connection-fetch.ts NEEDS_REAUTH_CAUSES), so the page can
 * say it in words. The stored cause's own text never crosses to this Worker.
 */
export const NEEDS_REAUTH_REASONS = ['login_refused', 'refused_after_renew', 'refresh_exhausted', 'other'] as const
export type NeedsReauthReason = (typeof NEEDS_REAUTH_REASONS)[number]

/** One ops connection whose login is due to page. Names and times only: never a credential, a cause's text or a customer value. */
export interface ConnectionLoginAlert {
  organization_id: string
  connection_id: string
  /** The service key, as the copy holds it (salesforce, snowflake). */
  service: string
  state: ConnectionLoginState
  /** needs_reauth: why. Null for refresh_failing. */
  reason: NeedsReauthReason | null
  /** needs_reauth_at, or the start of the refresh streak, on the database clock. */
  since: string
  /** refresh_failing: the failures in the streak. Null for needs_reauth. */
  failures: number | null
}

export interface ConnectionLoginsReport {
  /** Every ops connection was judged and every one due is listed, so a connection not listed has no login to page about. */
  complete: boolean
  logins: ConnectionLoginAlert[]
}

/**
 * Dan's decision 2 bound (2026-10-17), as record_connection_refresh holds it
 * (c_limit and c_span in supabase-ops migration 20261018170000; the guard
 * apps/web/src/lib/__guards__/worker/refresh-failing-page-bound.test.ts holds
 * these equal to it): a refresh_failing streak pages once it has this many
 * failures and the first is at least this old, the same bound its next failure
 * turns into needs_reauth by.
 */
export const REFRESH_FAILING_PAGE_FAILURES = 5
export const REFRESH_FAILING_PAGE_SPAN_MS = 15 * 60_000

/** A report lists at most this many logins; past it the list says it is not complete. */
export const MAX_REPORT_LOGINS = 50

/**
 * One person bound connection whose rotated login its ConnectionTokenObject
 * holds and the row has not taken for longer than the ops tick's bound
 * (#2340, phase 10 item 4 of #1689; ops/write-back-check.ts): the object holds
 * the only copy of that login. Names, times and a count only, never a
 * credential.
 */
export interface WriteBackAlert {
  organization_id: string
  connection_id: string
  service: string
  /** When the write back went pending, on the object's clock; null when the object stored it before that time was kept (unknown, never fresh). */
  since: string | null
  /** The failed write backs in a row. */
  attempts: number
}

export interface WriteBacksReport {
  /** Every ops connection's object answered and every one due is listed, so a connection not listed has nothing pending past the bound. */
  complete: boolean
  pending: WriteBackAlert[]
}

/** A report lists at most this many write backs; past it the list says it is not complete. */
export const MAX_REPORT_WRITE_BACKS = 50

export interface OpsTickReport {
  tick_id: string
  mode: OpsTickMode
  /** The cron's scheduledTime, which lands at :48 within a minute, never aligned (spike, #1946). */
  scheduled_time: string | null
  started_at: string
  finished_at: string
  /** The database clock the tick planned against, or null when it could not read it. */
  db_now: string | null
  outcome: OpsTickOutcome
  /** Each a sentence a person can act on. Empty when the outcome is ok. */
  problems: string[]
  /** What the tick did, as counts, for the logs. */
  counts: Record<string, number>
  /**
   * The secrets a not_configured tick found unset or unusable, by name (#2333),
   * so the page names each one's remedy. Empty on any other outcome. Null on a
   * report from an ops release before #2333, which named none: the only cause
   * such a release could report was the ops database.
   */
  not_configured_secrets: string[] | null
  /**
   * Whether the tick's started stamp through the gateway failed (#2410). True
   * only with a problem reported. Since #2506 the stamp's problem is keyed
   * start_stamp like any other; this flag still lets the bidding Worker hold a
   * lone missed stamp in a report from an ops release that keys nothing. Null
   * on a report from an ops release before #2410.
   */
  start_stamp_failed: boolean | null
  /**
   * One key per problem, side by side with `problems` (#2506): the problem's
   * kind and, where it is about one, its subject (a sweep, a workflow, a
   * connection, a secret), as `kind` or `kind:subject`. The bidding Worker
   * counts a problem across ticks by this key, never by its sentence, which
   * carries an error's own words and figures and moves between ticks. Null on a
   * report from an ops release before #2506, which keyed nothing.
   */
  problem_keys: string[] | null
  /**
   * The ops connections whose login is due to page (#2340), judged by the tick
   * every minute on the database clock. The bidding Worker pages each one
   * through the ops-connection-login signal, and sends the all clear for one
   * no longer listed only while the list is complete. Null when the tick judged
   * no login: no database, a read that failed, or a report from an ops release
   * before #2340. Null is never read as every login cleared.
   */
  connection_logins: ConnectionLoginsReport | null
  /**
   * The person bound logins whose write back has been pending past the bound
   * (#2340, phase 10 item 4), judged only by the tick that owns the
   * connection_check sweep's claim, every 14 to 15 minutes, by asking each
   * connection's ConnectionTokenObject. The bidding Worker keeps the last list
   * apart from the report and pages each one through the
   * ops-connection-write-back signal. Null on every other tick, when the
   * judgement failed, and on a report from an ops release before it: never
   * read as every write back landed.
   */
  write_backs: WriteBacksReport | null
  /**
   * The sweeps this tick ran: each whose claim it owned (#2340). The bidding
   * Worker judges a problem of a sweep that runs less often than the tick
   * (OPS_TICK_PROBLEM_SWEEPS) by that sweep's runs, so a tick that did not run
   * the sweep neither counts its problem, ends it, nor stands it down. Null on a
   * report from an ops release before it: not known, never read as none run.
   */
  sweeps_run: string[] | null
}

/**
 * How a kind of tick problem pages (#2506, Dan's decision 2026-10-19).
 * three_in_a_row: a problem a passing tick would clear, and that the next tick
 * reports again while its cause stands (a call past its deadline, a read or
 * write the database or the gateway did not answer). It pages once three ticks
 * in a row report it; one tick's is logged and counted.
 * at_once: a problem that is not transient (a secret not set, a defect in what
 * was served or found), or one no later tick can report again (a missed slot is
 * recorded once, a slot is dispatched once, the agreement check runs every 14
 * minutes), so holding it for three ticks would hold it for ever.
 */
export type OpsTickProblemRule = 'three_in_a_row' | 'at_once'

/** Every kind of problem the tick reports, and its rule. A kind not listed here pages at once. */
export const OPS_TICK_PROBLEM_RULES = {
  // The gateway, and the ops database, failing to answer in time: each is asked again next tick.
  start_stamp: 'three_in_a_row',
  db_clock: 'three_in_a_row',
  /** claim_ops_sweep itself failed, which every sweep asks again on the next tick (the 2026-10-19 page). */
  sweep_claim_failed: 'three_in_a_row',
  /** A minute sweep (lease_expiry, run_expiry) failed after its claim: claimed again 50 s on. */
  sweep_failed: 'three_in_a_row',
  workflows_fetch_failed: 'three_in_a_row',
  workflows_save_failed: 'three_in_a_row',
  copies_read_failed: 'three_in_a_row',
  /** A schedule's planning or recording failed: the slot stays due and is tried again next tick. */
  schedule_plan_failed: 'three_in_a_row',
  claim_depth_failed: 'three_in_a_row',
  /** The probe through the dispatch path, sent every tick nothing is due. */
  probe_failed: 'three_in_a_row',
  connections_fetch_failed: 'three_in_a_row',
  connections_save_failed: 'three_in_a_row',
  /** A removal is served for 7 hours, so the next tick records it again. */
  tombstone_record_failed: 'three_in_a_row',
  /**
   * The sentence saying how many problems a report left out. Every at_once
   * problem is kept ahead of it (capTickProblems), so it stands only for held
   * ones; were it paged at once, one bad tick with many schedules would page.
   */
  problems_left_out: 'three_in_a_row',

  // Not transient: a person must act, and waiting three minutes only delays them.
  db_not_configured: 'at_once',
  not_configured: 'at_once',
  /** The secrets check reads only this Worker's own secrets, so a throw is a defect, not a blip. */
  secrets_unchecked: 'at_once',
  queue_disagreement: 'at_once',
  workflow_refused: 'at_once',
  workflows_too_many: 'at_once',
  copies_read_limit: 'at_once',
  schedule_refused: 'at_once',
  schedule_no_version: 'at_once',
  connections_list_unreadable: 'at_once',
  connection_refused: 'at_once',
  connections_too_many: 'at_once',
  connection_copies_expired: 'at_once',
  /** The connection step threw past its own boundaries, which nothing expects. */
  connections_step_failed: 'at_once',
  // Reported once, never again by a later tick.
  /** The agreement check failed after its claim; it is not tried again for 14 minutes. */
  agreement_check_failed: 'at_once',
  /** A missed slot is recorded, and reported, once. */
  slot_missed: 'at_once',
  /** A recorded slot is dispatched once. */
  dispatch_failed: 'at_once',
  // Written by the bidding Worker, never by the tick.
  /** A report it could not read. */
  report_unreadable: 'at_once',
  /** A sentence from an ops release before #2506, which says nothing of its kind. */
  unkeyed: 'at_once',
  // The sf_limits sweep (#2336, ops/sf-limits.ts), claimed every 4 minutes.
  // Each of its kinds is judged by the sweep's runs, not the tick's
  // (OPS_TICK_PROBLEM_SWEEPS, #2340), so three in a row is three runs of it.
  /** The read of which orgs are measured failed, or the sweep threw past its own boundaries. */
  sf_limits_failed: 'at_once',
  /** As many measured orgs as one sweep reads: any past them had no reading renewed. */
  sf_limits_orgs_limit: 'at_once',
  /** A refusal the next read will meet again: a 4xx, a refusal by rule or state (sf_cap_unset, needs_reauth). */
  sf_limits_refused: 'at_once',
  /** A body whose DailyApiRequests cannot be read: a named refusal, never a NaN (L50). */
  sf_limits_unreadable: 'at_once',
  /** A failure the next read may not meet, once the org's reading is older than one renewal: the pool is going stale. */
  sf_limits_read_failed: 'at_once',
  /**
   * The same failure while the org's reading is still young (#2340), which
   * other ops Salesforce calls can keep young for ever through
   * Sforce-Limit-Info: three runs of the sweep in a row (sf-limits.ts THE
   * FAILURES says why three).
   */
  sf_limits_read_failing: 'three_in_a_row',
  // The connection_check sweep (#2340, ops/connection-check.ts), claimed every
  // 14 minutes, so no kind of its can be reported by three ticks in a row, and
  // it is not yet judged by its runs as sf_limits is: it holds a failure the
  // next probe may not meet itself, by the age of the connection's last passing check.
  /** The read of which connections to check failed, or the sweep threw past its own boundaries. */
  connection_check_failed: 'at_once',
  /** As many connections as one sweep checks: any past them wait for a later sweep. */
  connection_check_limit: 'at_once',
  /** A probe refused in a way the next probe will meet again: a 4xx, a refusal by rule, an identity other than the one verified. */
  connection_check_refused: 'at_once',
  /** The service answered the identity probe with something that is not an identity. */
  connection_check_unreadable: 'at_once',
  /** A probe that failed or could not run (a timeout, a 5xx, a busy pool), reported only once the last passing check is older than one interval. */
  connection_check_unavailable: 'at_once',
  // The login states, read every tick (#2340): the read is asked again on the next tick.
  /** connection_check_targets did not answer, so no login was judged this tick. */
  connection_logins_failed: 'three_in_a_row',
  /** More connections than one read or one report carries, so a login past them was not judged. */
  connection_logins_limit: 'at_once',
  // The write back check (#2340, phase 10 item 4, ops/write-back-check.ts),
  // run on the connection_check sweep's interval, so as with that sweep no
  // kind of its can be reported by three ticks in a row.
  /** A ConnectionTokenObject that could not say whether it holds a login not yet written back: unreachable, past its deadline, failed, or unread. */
  write_back_unreadable: 'at_once',
  /** More connections than one read carries, or more due than one report carries. */
  write_back_limit: 'at_once',
  /** The judgement could not be made at all: the list of connections could not be read on the tick that owned the sweep, or the check threw. */
  write_back_check_failed: 'at_once',
} as const satisfies Record<string, OpsTickProblemRule>

export type OpsTickProblemKind = keyof typeof OPS_TICK_PROBLEM_RULES

/** One problem as the tick builds it: the key the bidding Worker counts it by, and the sentence a person reads. */
export interface TickProblem {
  key: string
  text: string
}

export function tickProblem(kind: OpsTickProblemKind, text: string, subject?: string): TickProblem {
  return { key: subject === undefined ? kind : `${kind}:${subject}`, text }
}

/** The rule a problem pages by, read from its key's kind; a kind with no rule pages at once (L50). */
export function problemRuleOf(key: string): OpsTickProblemRule {
  const kind = key.split(':')[0]
  return Object.hasOwn(OPS_TICK_PROBLEM_RULES, kind) ? OPS_TICK_PROBLEM_RULES[kind as OpsTickProblemKind] : 'at_once'
}

/**
 * The kinds a sweep that runs less often than the tick reports, each with the
 * sweep whose runs judge it (#2340). The tick reports such a problem only on a
 * tick that runs the sweep, one tick in four for sf_limits, so judged by
 * ticks, the next tick (clean) read as its all clear and the next run paged it
 * anew, and a three_in_a_row kind could never reach three. Judged by the
 * sweep's runs, a tick that did not run the sweep (its report's sweeps_run does
 * not name it) neither counts the problem, ends its run, nor stands it down:
 * the bidding Worker carries it, sentence and count, until the sweep runs
 * again (ops-gateway.ts countRuns). A kind not listed is judged by ticks.
 *
 * Only the sf_limits sweep's kinds are listed. The connection_check sweep and
 * the write back check that rides it, and the queue_agreement sweep, report in
 * the same way and are not yet listed (spooled on #2340).
 */
export const OPS_TICK_PROBLEM_SWEEPS = {
  sf_limits_failed: 'sf_limits',
  sf_limits_orgs_limit: 'sf_limits',
  sf_limits_refused: 'sf_limits',
  sf_limits_unreadable: 'sf_limits',
  sf_limits_read_failed: 'sf_limits',
  sf_limits_read_failing: 'sf_limits',
} as const satisfies Partial<Record<OpsTickProblemKind, OpsSweep>>

/** The sweep whose runs judge a problem's key, read from its kind; null for a kind judged by ticks. */
export function sweepOfProblemKey(key: string): OpsSweep | null {
  const kind = key.split(':')[0]
  return Object.hasOwn(OPS_TICK_PROBLEM_SWEEPS, kind) ? OPS_TICK_PROBLEM_SWEEPS[kind as keyof typeof OPS_TICK_PROBLEM_SWEEPS] : null
}

/** A sweep's name, as claim_ops_sweep's vocabulary writes it; one from a newer ops release is kept as named. */
const SWEEP_NAME = /^[a-z][a-z0-9_]{0,63}$/
/** More than every sweep the tick claims, so a list past it is not one. */
const MAX_SWEEPS_RUN = 20

/** A key's shape: a kind in lower case, and an optional subject (a sweep, an id, a secret's name). */
const PROBLEM_KEY = /^[a-z][a-z0-9_]{0,63}(?::[A-Za-z0-9_.-]{1,128})?$/

/**
 * Caps a keyed problem list as capProblems caps a plain one, keeping each key
 * beside its sentence. A list over the cap keeps every problem that pages at
 * once ahead of those it leaves out, so the sentence saying how many were left
 * out stands only for held ones, and a problem that must page is never hidden
 * behind it.
 */
export function capTickProblems(list: readonly TickProblem[]): { problems: string[]; problem_keys: string[] } {
  if (list.length <= MAX_REPORT_PROBLEMS) return { problems: list.map((p) => clipProblem(p.text)), problem_keys: list.map((p) => p.key) }
  const ordered = [...list.filter((p) => problemRuleOf(p.key) === 'at_once'), ...list.filter((p) => problemRuleOf(p.key) !== 'at_once')]
  const shown = ordered.slice(0, MAX_REPORT_PROBLEMS - 1)
  const leftOut = tickProblem('problems_left_out', `${list.length - shown.length} more problems were left out of this report; the ops Worker's logs have every one.`)
  return { problems: [...shown, leftOut].map((p) => clipProblem(p.text)), problem_keys: [...shown, leftOut].map((p) => p.key) }
}

export class OpsGatewayContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpsGatewayContractError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One problem cut to the length a report carries. */
function clipProblem(p: string): string {
  return p.length > MAX_PROBLEM_LENGTH ? `${p.slice(0, MAX_PROBLEM_LENGTH - 3)}...` : p
}

/** Caps a problem list, saying how many were left out rather than dropping them silently. */
export function capProblems(problems: readonly string[]): string[] {
  const clipped = problems.map(clipProblem)
  if (clipped.length <= MAX_REPORT_PROBLEMS) return clipped
  const shown = clipped.slice(0, MAX_REPORT_PROBLEMS - 1)
  return [...shown, `${clipped.length - shown.length} more problems were left out of this report; the ops Worker's logs have every one.`]
}

/**
 * The served list, with each row that is not a well formed ops workflow refused
 * by name rather than saved. Throws when the list itself is malformed.
 */
export function parseServedOpsWorkflows(raw: unknown): { list: ServedOpsWorkflows; refused: string[] } {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the workflow list with something other than an object')
  if (!isTime(raw.served_at)) throw new OpsGatewayContractError('the bidding Worker\'s workflow list has no served_at time')
  if (typeof raw.complete !== 'boolean') throw new OpsGatewayContractError('the bidding Worker\'s workflow list does not say whether it is complete')
  if (!Array.isArray(raw.workflows)) throw new OpsGatewayContractError('the bidding Worker\'s workflow list has no workflows array')
  const workflows: ServedOpsWorkflow[] = []
  const refused: string[] = []
  raw.workflows.forEach((row: unknown, i: number) => {
    const id = isRecord(row) && typeof row.id === 'string' ? row.id : `row ${i}`
    if (
      !isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id) ||
      typeof row.organization_id !== 'string' || !UUID.test(row.organization_id) ||
      typeof row.is_active !== 'boolean' ||
      !(row.deleted_at === null || isTime(row.deleted_at)) ||
      !isTime(row.updated_at) ||
      !(row.version_number === null || (typeof row.version_number === 'number' && Number.isInteger(row.version_number) && row.version_number >= 1))
    ) {
      refused.push(`The bidding Worker served workflow ${id} in a shape the ops Worker does not read, so it was not saved.`)
      return
    }
    workflows.push({
      id: row.id,
      organization_id: row.organization_id,
      is_active: row.is_active,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
      version_number: row.version_number,
      trigger: row.trigger ?? null,
    })
  })
  // A list with refused rows does not name every ops workflow it could read, so
  // it must not withdraw the ones it failed to describe.
  return { list: { served_at: raw.served_at, complete: raw.complete && refused.length === 0, workflows }, refused }
}

/** The tick's report as the bidding Worker received it. Throws on one it cannot read. */
export function parseOpsTickReport(raw: unknown): OpsTickReport {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the ops tick sent a report that is not an object')
  const {
    tick_id, mode, scheduled_time, started_at, finished_at, db_now, outcome, problems, counts, not_configured_secrets, start_stamp_failed, problem_keys,
    connection_logins, write_backs, sweeps_run,
  } = raw
  if (typeof tick_id !== 'string' || tick_id === '' || tick_id.length > 200) throw new OpsGatewayContractError('the ops tick report has no tick id')
  if (!(OPS_TICK_MODES as readonly unknown[]).includes(mode)) throw new OpsGatewayContractError(`the ops tick report names a mode this Worker does not know: ${String(mode)}`)
  if (!(scheduled_time === null || isTime(scheduled_time))) throw new OpsGatewayContractError('the ops tick report has an unreadable scheduled time')
  if (!isTime(started_at) || !isTime(finished_at)) throw new OpsGatewayContractError('the ops tick report has an unreadable start or finish')
  if (!(db_now === null || isTime(db_now))) throw new OpsGatewayContractError('the ops tick report has an unreadable database clock')
  if (!(OPS_TICK_OUTCOMES as readonly unknown[]).includes(outcome)) throw new OpsGatewayContractError(`the ops tick report names an outcome this Worker does not know: ${String(outcome)}`)
  if (!Array.isArray(problems) || problems.some((p) => typeof p !== 'string')) throw new OpsGatewayContractError('the ops tick report\'s problems are not a list of sentences')
  if (outcome === 'ok' ? problems.length > 0 : problems.length === 0) throw new OpsGatewayContractError(`the ops tick report says ${String(outcome)} with ${problems.length} problems`)
  if (!isRecord(counts) || Object.values(counts).some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new OpsGatewayContractError('the ops tick report\'s counts are not numbers')
  // Absent on a report from a release before #2333, and null once the bidding
  // Worker has kept such a report and reads it back (recordOpsTickCompleted
  // stores what this returns): both mean no secret was named.
  let secrets: string[] | null = null
  if (not_configured_secrets !== undefined && not_configured_secrets !== null) {
    if (
      !Array.isArray(not_configured_secrets) || not_configured_secrets.length > MAX_NOT_CONFIGURED_SECRETS ||
      not_configured_secrets.some((n) => typeof n !== 'string' || !SECRET_NAME.test(n))
    ) throw new OpsGatewayContractError('the ops tick report\'s not configured secrets are not a list of secret names')
    // The names pick the page's remedy, so they must agree with the outcome.
    if (outcome === 'not_configured' ? not_configured_secrets.length === 0 : not_configured_secrets.length > 0) {
      throw new OpsGatewayContractError(`the ops tick report says ${String(outcome)} naming ${not_configured_secrets.length} unconfigured secrets`)
    }
    secrets = [...(not_configured_secrets as string[])]
  }
  // Absent before #2410, null once such a report is kept and read back.
  let stampFailed: boolean | null = null
  if (start_stamp_failed !== undefined && start_stamp_failed !== null) {
    if (typeof start_stamp_failed !== 'boolean') throw new OpsGatewayContractError('the ops tick report says neither that its start stamp failed nor that it did not')
    // A failed stamp is reported as a problem, so one with no problem is not a report to trust.
    if (start_stamp_failed && outcome === 'ok') throw new OpsGatewayContractError('the ops tick report says its start stamp failed and reports no problem')
    stampFailed = start_stamp_failed
  }
  // Absent before #2506, null once such a report is kept and read back. The
  // keys pick which problems page now, so a list that cannot be matched to
  // the sentences one for one is refused and the report pages as unreadable.
  let capped: { problems: string[]; problem_keys: string[] | null } = { problems: capProblems(problems as string[]), problem_keys: null }
  if (problem_keys !== undefined && problem_keys !== null) {
    if (!Array.isArray(problem_keys) || problem_keys.some((k) => typeof k !== 'string' || !PROBLEM_KEY.test(k))) {
      throw new OpsGatewayContractError('the ops tick report\'s problem keys are not a list of problem keys')
    }
    if (problem_keys.length !== problems.length) {
      throw new OpsGatewayContractError(`the ops tick report names ${problem_keys.length} problem keys for ${problems.length} problems`)
    }
    capped = capTickProblems((problems as string[]).map((text, i) => ({ key: problem_keys[i] as string, text })))
  }
  // Absent before #2340, null once such a report is kept and read back, or when
  // the tick judged no login: all of them mean unjudged, never all clear.
  const logins = connection_logins === undefined || connection_logins === null ? null : parseConnectionLogins(connection_logins)
  // Absent before #2340 phase 10 item 4, null on a tick that judged none: unjudged, never all landed.
  const writeBacks = write_backs === undefined || write_backs === null ? null : parseWriteBacks(write_backs)
  // Absent before #2340's sweep runs, null once such a report is kept and read
  // back: not known, so nothing is carried, never read as no sweep run.
  let sweepsRun: string[] | null = null
  if (sweeps_run !== undefined && sweeps_run !== null) {
    if (!Array.isArray(sweeps_run) || sweeps_run.length > MAX_SWEEPS_RUN || sweeps_run.some((s) => typeof s !== 'string' || !SWEEP_NAME.test(s))) {
      throw new OpsGatewayContractError('the ops tick report\'s sweeps run are not a list of sweep names')
    }
    sweepsRun = [...(sweeps_run as string[])]
  }
  return {
    tick_id,
    mode: mode as OpsTickMode,
    scheduled_time: scheduled_time,
    started_at,
    finished_at,
    db_now: db_now,
    outcome: outcome as OpsTickOutcome,
    problems: capped.problems,
    counts: counts as Record<string, number>,
    not_configured_secrets: secrets,
    start_stamp_failed: stampFailed,
    problem_keys: capped.problem_keys,
    connection_logins: logins,
    write_backs: writeBacks,
    sweeps_run: sweepsRun,
  }
}

/**
 * A report's write back list as the bidding Worker received it. Throws on one
 * it cannot read, so the whole report pages as unreadable rather than a login
 * at risk going unsaid. Every field is an id, a name, a time or a count.
 */
export function parseWriteBacks(raw: unknown): WriteBacksReport {
  if (!isRecord(raw) || typeof raw.complete !== 'boolean' || !Array.isArray(raw.pending)) {
    throw new OpsGatewayContractError('the ops tick report\'s write backs are not a list that says whether it is complete')
  }
  if (raw.pending.length > MAX_REPORT_WRITE_BACKS) throw new OpsGatewayContractError(`the ops tick report lists ${raw.pending.length} write backs, more than ${MAX_REPORT_WRITE_BACKS}`)
  const pending = raw.pending.map((row: unknown, i: number): WriteBackAlert => {
    const bad = (why: string) => new OpsGatewayContractError(`write back ${i} of the ops tick report ${why}`)
    if (!isRecord(row)) throw bad('is not an object')
    const { organization_id, connection_id, service, since, attempts } = row
    if (typeof organization_id !== 'string' || !UUID.test(organization_id)) throw bad('names no organization')
    if (typeof connection_id !== 'string' || !UUID.test(connection_id)) throw bad('names no connection')
    if (typeof service !== 'string' || !SERVICE_KEY.test(service)) throw bad('names no service')
    if (!(since === null || isTime(since))) throw bad('has an unreadable time')
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) throw bad('has an unreadable count of tries')
    return { organization_id, connection_id, service, since, attempts }
  })
  return { complete: raw.complete, pending }
}

/**
 * A report's login list as the bidding Worker received it. Throws on one it
 * cannot read, so the whole report pages as unreadable rather than a login the
 * page would have named going unsaid. Every field is a name, an id or a time,
 * so a payload cannot ride it into a page.
 */
export function parseConnectionLogins(raw: unknown): ConnectionLoginsReport {
  if (!isRecord(raw) || typeof raw.complete !== 'boolean' || !Array.isArray(raw.logins)) {
    throw new OpsGatewayContractError('the ops tick report\'s connection logins are not a list that says whether it is complete')
  }
  if (raw.logins.length > MAX_REPORT_LOGINS) throw new OpsGatewayContractError(`the ops tick report lists ${raw.logins.length} connection logins, more than ${MAX_REPORT_LOGINS}`)
  const logins = raw.logins.map((row: unknown, i: number): ConnectionLoginAlert => {
    const bad = (why: string) => new OpsGatewayContractError(`connection login ${i} of the ops tick report ${why}`)
    if (!isRecord(row)) throw bad('is not an object')
    const { organization_id, connection_id, service, state, reason, since, failures } = row
    if (typeof organization_id !== 'string' || !UUID.test(organization_id)) throw bad('names no organization')
    if (typeof connection_id !== 'string' || !UUID.test(connection_id)) throw bad('names no connection')
    if (typeof service !== 'string' || !SERVICE_KEY.test(service)) throw bad('names no service')
    if (!(CONNECTION_LOGIN_STATES as readonly unknown[]).includes(state)) throw bad('names a state this Worker does not page on')
    if (!isTime(since)) throw bad('has an unreadable time')
    if (state === 'needs_reauth') {
      if (!(NEEDS_REAUTH_REASONS as readonly unknown[]).includes(reason) || failures !== null) throw bad('is a needs_reauth with no reason, or with a failure count')
    } else if (reason !== null || typeof failures !== 'number' || !Number.isInteger(failures) || failures < 1) {
      throw bad('is a refresh_failing with no failure count, or with a reason')
    }
    return {
      organization_id, connection_id, service, state: state as ConnectionLoginState,
      reason: reason as NeedsReauthReason | null, since, failures,
    }
  })
  return { complete: raw.complete, logins }
}

/**
 * The ops jobs other than the tick that stamp a heartbeat through the gateway
 * (#2340, phase 10 of #1689): OpsGateway.opsJobStarted and opsJobCompleted
 * accept only these, and dispatch each to its own literal stamp in
 * lib/ops-gateway.ts. Each is a sweep inside the ops minute tick, watched from
 * the bidding Worker (L71) by its own CRON_JOBS entry under the same id. The
 * tick itself is not one: it stamps through opsTickStarted and opsTickCompleted.
 *
 * SF_LIMITS_JOB is the sf_limits sweep (#2336, ops/sf-limits.ts), and
 * CONNECTION_CHECK_JOB the connection_check sweep (#2340,
 * ops/connection-check.ts). NEVER rename either: each keys its job's heartbeat
 * state in KV.
 */
export const SF_LIMITS_JOB = 'ops-sf-limits'
export const CONNECTION_CHECK_JOB = 'ops-connection-check'
export const OPS_GATEWAY_JOBS = [SF_LIMITS_JOB, CONNECTION_CHECK_JOB] as const
export type OpsGatewayJob = (typeof OPS_GATEWAY_JOBS)[number]

/** An ops job id as the bidding Worker receives it, refused by name when it stamps none. */
export function parseOpsJobId(raw: unknown): OpsGatewayJob {
  if (typeof raw === 'string' && (OPS_GATEWAY_JOBS as readonly string[]).includes(raw)) return raw as OpsGatewayJob
  // Cut short and kept to an id's characters, so a refusal cannot carry a payload into the logs.
  const named = typeof raw === 'string' ? `'${raw.slice(0, 64).replace(/[^a-z0-9-]/gi, '?')}'` : `a ${raw === null ? 'null' : typeof raw}`
  throw new OpsGatewayContractError(`${named} is not an ops job this Worker stamps (${OPS_GATEWAY_JOBS.join(', ')})`)
}

/** What an ops job sends with its completion: when it ran, and what it did as counts, for the logs. */
export interface OpsJobReport {
  started_at: string
  finished_at: string
  counts: Record<string, number>
}

const MAX_JOB_COUNTS = 50

/** An ops job's report as the bidding Worker received it. Throws on one it cannot read. */
export function parseOpsJobReport(raw: unknown): OpsJobReport {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the ops job sent a report that is not an object')
  const { started_at, finished_at, counts } = raw
  if (!isTime(started_at) || !isTime(finished_at)) throw new OpsGatewayContractError('the ops job report has an unreadable start or finish')
  if (!isRecord(counts) || Object.keys(counts).length > MAX_JOB_COUNTS
    || Object.entries(counts).some(([k, n]) => !/^[a-z][a-z0-9_]{0,63}$/.test(k) || typeof n !== 'number' || !Number.isFinite(n))) {
    throw new OpsGatewayContractError('the ops job report\'s counts are not named numbers')
  }
  return { started_at, finished_at, counts: { ...(counts as Record<string, number>) } }
}

/** What the ops copy's CHECK holds an envelope to (connection_copies_envelope_shape). */
const MAX_ENVELOPE_BYTES = 65_536
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const ENVELOPE_FIELDS = ['ct', 'iv', 'kid', 'v', 'wrapped_key']
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

/**
 * A storeRotatedEnvelope request as the bidding Worker receives it, refused by
 * name before anything reaches the database when it is not one. The envelope is
 * checked for the seal's shape only: this Worker holds no key that opens it.
 */
export function parseStoreRotatedEnvelopeRequest(raw: unknown): StoreRotatedEnvelopeRequest {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the rotated envelope request is not an object')
  const { organization_id, connection_id, expected_generation, generation, envelope } = raw
  if (typeof organization_id !== 'string' || !UUID.test(organization_id)) throw new OpsGatewayContractError('the rotated envelope request names no organization uuid')
  if (typeof connection_id !== 'string' || !UUID.test(connection_id)) throw new OpsGatewayContractError('the rotated envelope request names no connection uuid')
  if (!isWhole(expected_generation) || expected_generation < 1) throw new OpsGatewayContractError('the rotated envelope request\'s expected generation is not a whole number of at least 1')
  if (!isWhole(generation) || generation <= expected_generation) throw new OpsGatewayContractError('the rotated envelope request\'s generation is not above the expected one')
  return { organization_id, connection_id, expected_generation, generation, envelope: parseSealedEnvelope(envelope, 'the rotated envelope') }
}

/**
 * The seal's envelope and nothing else, as the ops copy's CHECK holds it
 * (connection_copies_envelope_shape), refused by name (`what`) otherwise. One
 * rule for every envelope that crosses the binding, either way. Each message
 * names a field, never a value.
 */
export function parseSealedEnvelope(envelope: unknown, what: string): SealedEnvelopeShape {
  if (!isRecord(envelope)) throw new OpsGatewayContractError(`${what} is not an object`)
  if (Object.keys(envelope).sort().join(',') !== ENVELOPE_FIELDS.join(',')) throw new OpsGatewayContractError(`${what} must have exactly the fields ${ENVELOPE_FIELDS.join(', ')}`)
  const { v, kid, wrapped_key, iv, ct } = envelope
  if (v !== 1) throw new OpsGatewayContractError(`${what} is not version 1`)
  if (typeof kid !== 'string' || !KID_PATTERN.test(kid)) throw new OpsGatewayContractError(`${what}'s kid is not a kid`)
  for (const [name, value] of [['wrapped_key', wrapped_key], ['iv', iv], ['ct', ct]] as const) {
    if (typeof value !== 'string' || !BASE64.test(value)) throw new OpsGatewayContractError(`${what}'s ${name} is not base64`)
  }
  const shaped = { v: 1 as const, kid, wrapped_key: wrapped_key as string, iv: iv as string, ct: ct as string }
  // Measured as the database measures it: jsonb renders a space after each colon and each comma.
  const jsonbBytes = new TextEncoder().encode(JSON.stringify(shaped)).length + ENVELOPE_FIELDS.length * 2 - 1
  if (jsonbBytes > MAX_ENVELOPE_BYTES) throw new OpsGatewayContractError(`${what} is over ${MAX_ENVELOPE_BYTES} bytes`)
  return shaped
}

/** store_rotated_envelope's answer as the ops Worker receives it. Throws on one it cannot read. */
export function parseStoreRotatedEnvelopeAnswer(raw: unknown): StoreRotatedEnvelopeAnswer {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the rotated envelope with something other than an object')
  const { outcome, current_generation, current_iv } = raw
  if (!(STORE_ROTATED_ENVELOPE_OUTCOMES as readonly unknown[]).includes(outcome)) {
    throw new OpsGatewayContractError(`the bidding Worker answered the rotated envelope with an outcome this Worker does not know: ${String(outcome)}`)
  }
  if (!(current_generation === null || (isWhole(current_generation) && current_generation >= 1))) {
    throw new OpsGatewayContractError('the bidding Worker answered the rotated envelope with an unreadable generation')
  }
  if (!(current_iv === null || typeof current_iv === 'string')) throw new OpsGatewayContractError('the bidding Worker answered the rotated envelope with an unreadable iv')
  // A row was found exactly when a generation is named.
  if ((outcome === 'not_found') !== (current_generation === null)) {
    throw new OpsGatewayContractError(`the bidding Worker answered the rotated envelope ${String(outcome)} with${current_generation === null ? ' no' : ''} generation`)
  }
  return { outcome: outcome as StoreRotatedEnvelopeOutcome, current_generation, current_iv }
}

/**
 * A replaceConnectionEnvelope request as the bidding Worker receives it,
 * refused by name before anything reaches the database when it is not one. The
 * new envelope must name the committed current kid (currentKid, CURRENT_OPS_KID
 * in packages/connection-seal/src/keys.ts), so the ops Worker can move a login
 * only to the key every new seal already uses, never to a kid of its choosing;
 * while no kid is current, every request is refused.
 */
export function parseReplaceConnectionEnvelopeRequest(raw: unknown, currentKid: string | null = CURRENT_OPS_KID): ReplaceConnectionEnvelopeRequest {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the envelope replace request is not an object')
  const { organization_id, connection_id, expected_kid, expected_generation, envelope } = raw
  if (typeof organization_id !== 'string' || !UUID.test(organization_id)) throw new OpsGatewayContractError('the envelope replace request names no organization uuid')
  if (typeof connection_id !== 'string' || !UUID.test(connection_id)) throw new OpsGatewayContractError('the envelope replace request names no connection uuid')
  if (typeof expected_kid !== 'string' || !KID_PATTERN.test(expected_kid)) throw new OpsGatewayContractError('the envelope replace request\'s expected kid is not a kid')
  if (!isWhole(expected_generation) || expected_generation < 1) throw new OpsGatewayContractError('the envelope replace request\'s expected generation is not a whole number of at least 1')
  const shaped = parseSealedEnvelope(envelope, 'the replacing envelope')
  if (currentKid === null) throw new OpsGatewayContractError('no kid is current on the bidding Worker, so no envelope may replace another')
  if (shaped.kid !== currentKid) throw new OpsGatewayContractError(`the replacing envelope is sealed under kid ${shaped.kid}, not the current kid ${currentKid}`)
  if (expected_kid === currentKid) throw new OpsGatewayContractError('the envelope replace request expects the current kid, so there is nothing to reseal')
  return { organization_id, connection_id, expected_kid, expected_generation, envelope: shaped }
}

/** replace_connection_envelope's answer as the ops Worker receives it. Throws on one it cannot read. */
export function parseReplaceConnectionEnvelopeAnswer(raw: unknown): ReplaceConnectionEnvelopeAnswer {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the envelope replace with something other than an object')
  const { outcome, current_generation, current_kid } = raw
  if (!(REPLACE_CONNECTION_ENVELOPE_OUTCOMES as readonly unknown[]).includes(outcome)) {
    throw new OpsGatewayContractError(`the bidding Worker answered the envelope replace with an outcome this Worker does not know: ${String(outcome)}`)
  }
  if (!(current_generation === null || (isWhole(current_generation) && current_generation >= 1))) {
    throw new OpsGatewayContractError('the bidding Worker answered the envelope replace with an unreadable generation')
  }
  if (!(current_kid === null || typeof current_kid === 'string')) throw new OpsGatewayContractError('the bidding Worker answered the envelope replace with an unreadable kid')
  // A row was found exactly when a generation is named.
  if ((outcome === 'not_found') !== (current_generation === null)) {
    throw new OpsGatewayContractError(`the bidding Worker answered the envelope replace ${String(outcome)} with${current_generation === null ? ' no' : ''} generation`)
  }
  return { outcome: outcome as ReplaceConnectionEnvelopeOutcome, current_generation, current_kid }
}

/** What the ops copy's CHECKs hold public config and a target to (connection_copies_public_config_shape, _target_shape). */
const MAX_CONFIG_BYTES = 16_384
const SERVICE_KEY = /^[a-z][a-z0-9_]{0,63}$/
/**
 * A field name that holds a login rather than describing one. Public config and
 * a target are served in the clear, so a row naming one of these is refused
 * rather than carried to ops: the login belongs only inside the sealed envelope.
 */
const LOGIN_FIELD = /secret|passw|private_?key|api_?key|access_?token|refresh_?token|bot_?token|^token$|bearer/i
const MAX_DEPTH = 10

/** A safe name for a row in a sentence: its id when it is a plain id, otherwise its position. */
function rowName(value: unknown, index: number): string {
  return typeof value === 'string' && value.length <= 64 && /^[\w-]+$/.test(value) ? value : `row ${index}`
}

/**
 * At least as many bytes as jsonb renders the value in: jsonb puts a space after
 * each colon and each comma, so every one in the JSON is counted twice, those
 * inside strings too. An overcount only refuses earlier than the CHECK would.
 */
function jsonbBytesAtMost(value: unknown): number {
  const json = JSON.stringify(value)
  let extra = 0
  for (const ch of json) if (ch === ':' || ch === ',') extra++
  return new TextEncoder().encode(json).length + extra
}

/** The first field naming a login, by its name (never its value). */
function loginField(value: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return 'a field nested too deep to check'
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = loginField(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!isRecord(value)) return null
  for (const [key, inner] of Object.entries(value)) {
    if (LOGIN_FIELD.test(key)) return /^[\w.-]{1,64}$/.test(key) ? key : 'a field'
    const found = loginField(inner, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Why public config or a target cannot be served in the clear, or null when it
 * can. Also holds a candidate passed to OpsConnections (ops-connections-contract.ts)
 * to the same rule, so both ways in carry one.
 */
export function clearFieldProblem(value: unknown, what: 'public config' | 'a target'): string | null {
  const found = loginField(value)
  if (found) return `${what} naming the login field ${found}`
  if (jsonbBytesAtMost(value) > MAX_CONFIG_BYTES) return `${what} over ${MAX_CONFIG_BYTES} bytes`
  return null
}

/**
 * Why one served connection cannot be saved on ops, or null when it can. Each
 * reason names a field, never a value. The bidding Worker runs every row it
 * serves through this too (lib/ops-gateway.ts), so the two sides hold one rule.
 */
export function servedConnectionProblem(row: unknown, servedAt: string): string | null {
  if (!isRecord(row)) return 'a row that is not an object'
  if (typeof row.id !== 'string' || !UUID.test(row.id)) return 'an id that is not a uuid'
  if (typeof row.organization_id !== 'string' || !UUID.test(row.organization_id)) return 'an organization that is not a uuid'
  if (typeof row.service !== 'string' || !SERVICE_KEY.test(row.service)) return 'a service that is not a service key'
  if (!isWhole(row.generation) || row.generation < 1) return 'a generation that is not a whole number of at least 1'
  try {
    parseSealedEnvelope(row.envelope, 'the envelope')
  } catch (err) {
    return `an envelope that is not the seal's (${(err as Error).message})`
  }
  if (!isRecord(row.public_config)) return 'public config that is not an object'
  const config = clearFieldProblem(row.public_config, 'public config')
  if (config) return config
  if (row.target !== null) {
    if (!isRecord(row.target)) return 'a target that is neither an object nor null'
    const target = clearFieldProblem(row.target, 'a target')
    if (target) return target
  }
  if (!isTime(row.serve_until)) return 'a serve_until that is not a time'
  const until = Date.parse(row.serve_until)
  const served = Date.parse(servedAt)
  if (until <= served || until - served > CONNECTION_SERVE_WINDOW_MS) return 'a serve_until more than 6 hours after it was served, or not after it'
  return null
}

function servedTombstoneProblem(row: unknown): string | null {
  if (!isRecord(row)) return 'a row that is not an object'
  if (typeof row.connection_id !== 'string' || !UUID.test(row.connection_id)) return 'a connection that is not a uuid'
  if (typeof row.organization_id !== 'string' || !UUID.test(row.organization_id)) return 'an organization that is not a uuid'
  if (!isWhole(row.generation) || row.generation < 1) return 'a generation that is not a whole number of at least 1'
  if (!isTime(row.removed_at)) return 'a removal time that is not a time'
  return null
}

/**
 * The served connections, with each row that cannot be saved on ops refused by
 * name rather than saved. Throws when the list itself is malformed. A list with
 * a refused connection is not complete, so it withdraws nothing on ops. A
 * refused removal leaves the list complete: the removed connection is not in the
 * list either, so the complete list still withdraws its copy.
 */
export function parseServedOpsConnections(raw: unknown): { list: ServedOpsConnections; refused: string[] } {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the connection list with something other than an object')
  if (!isTime(raw.served_at)) throw new OpsGatewayContractError('the bidding Worker\'s connection list has no served_at time')
  if (typeof raw.complete !== 'boolean') throw new OpsGatewayContractError('the bidding Worker\'s connection list does not say whether it is complete')
  if (!Array.isArray(raw.connections)) throw new OpsGatewayContractError('the bidding Worker\'s connection list has no connections array')
  if (!Array.isArray(raw.tombstones)) throw new OpsGatewayContractError('the bidding Worker\'s connection list has no removals array')
  const servedAt = raw.served_at
  const refused: string[] = []
  const connections: ServedOpsConnection[] = []
  raw.connections.forEach((row: unknown, i: number) => {
    const problem = servedConnectionProblem(row, servedAt)
    if (problem !== null) {
      refused.push(`The bidding Worker served connection ${rowName(isRecord(row) ? row.id : null, i)} with ${problem}, so it was not saved.`)
      return
    }
    const r = row as Record<string, unknown>
    connections.push({
      id: r.id as string,
      organization_id: r.organization_id as string,
      service: r.service as string,
      generation: r.generation as number,
      envelope: parseSealedEnvelope(r.envelope, 'the envelope'),
      public_config: r.public_config as Record<string, unknown>,
      target: r.target as Record<string, unknown> | null,
      serve_until: r.serve_until as string,
    })
  })
  const refusedConnections = refused.length
  const tombstones: ServedConnectionTombstone[] = []
  raw.tombstones.forEach((row: unknown, i: number) => {
    const problem = servedTombstoneProblem(row)
    if (problem !== null) {
      refused.push(`The bidding Worker served the removal of ${rowName(isRecord(row) ? row.connection_id : null, i)} with ${problem}, so it was not recorded.`)
      return
    }
    const r = row as Record<string, unknown>
    tombstones.push({ connection_id: r.connection_id as string, organization_id: r.organization_id as string, generation: r.generation as number, removed_at: r.removed_at as string })
  })
  return { list: { served_at: servedAt, complete: raw.complete && refusedConnections === 0, connections, tombstones }, refused }
}

/** A Salesforce org id: 00D and 12 more, or 15 more in its 18 character form. */
const SF_ORG_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/
const MAX_USERNAME = 320

/** One stored or served reading, refused by name when it is not one. */
export function parseMoneySalesforceIdentity(raw: unknown, what: string): MoneySalesforceIdentity {
  if (!isRecord(raw)) throw new OpsGatewayContractError(`${what} is not an object`)
  const { sf_org_id, username, measured_at } = raw
  if (typeof sf_org_id !== 'string' || !SF_ORG_ID.test(sf_org_id)) throw new OpsGatewayContractError(`${what} has no Salesforce org id`)
  if (typeof username !== 'string' || username.trim() === '' || username.length > MAX_USERNAME) throw new OpsGatewayContractError(`${what} has no username`)
  if (!isTime(measured_at)) throw new OpsGatewayContractError(`${what} has no measurement time`)
  return { sf_org_id, username, measured_at }
}

/**
 * The money identities the bidding Worker answered for one organization, as
 * the ops Worker receives them. Refuses an answer for any organization but the
 * one asked about, so another organization's reading can never be read as this
 * one's. A null salesforce is unmeasured, which verify refuses by name
 * (money_identity_unmeasured), never a pass.
 */
export function parseServedMoneyIdentities(raw: unknown, organizationId: string): ServedMoneyIdentities {
  if (!isRecord(raw)) throw new OpsGatewayContractError('the bidding Worker answered the money identities with something other than an object')
  if (typeof raw.organization_id !== 'string' || raw.organization_id.toLowerCase() !== organizationId.toLowerCase()) {
    throw new OpsGatewayContractError('the bidding Worker answered the money identities for another organization than the one asked about')
  }
  if (!isTime(raw.served_at)) throw new OpsGatewayContractError('the bidding Worker\'s money identities have no served_at time')
  const salesforce = raw.salesforce === null ? null : parseMoneySalesforceIdentity(raw.salesforce, 'the money Salesforce identity')
  return { organization_id: raw.organization_id, served_at: raw.served_at, salesforce }
}
