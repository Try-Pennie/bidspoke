/**
 * The bidding Worker's side of the ops minute cron (#1949). Reached two ways:
 *  - by the ops Worker, through the OpsGateway entrypoint (ops-gateway-entrypoint.ts)
 *    and its OPS_GATEWAY service binding (wrangler.ops.toml);
 *  - by this Worker's own minute cron, which judges the tick's report (index.ts).
 *
 * WHAT IT SERVES (Dan's decision 4, 2026-10-16, on #1949). The bidding database
 * is the one home of every workflow definition: the canvas, versions, GitHub
 * backup and audit keep their single write path, and no ops definition store is
 * built. So the ops Worker, which holds no key to this database, asks here for
 * the ops lane workflows' state and keeps the last good copy itself. Served: each
 * ops workflow's on or off state, soft delete, updated_at (the order its copies
 * are saved by), latest version and trigger, soft deleted and switched off ones
 * included, so the ops copy learns of a delete or a switch off rather than
 * keeping the last on copy for ever. Not its nodes: a run's definition at its
 * version is #1950's to fetch.
 *
 * And, since #2335 (PR 6 of phase 5 of #1689), the ops connections the same
 * way (readOpsConnections): every ops_key row's sealed envelope, public config
 * and target with serve_until 6 hours on, and the removals of the last 7 hours,
 * which the tick keeps as last good copies; never a plaintext login. Money's
 * measured Salesforce identity for one organization is served beside it from
 * money-identity.ts (OpsGateway.moneyIdentities).
 *
 * WHO MAY CALL IT, AND WHOSE DATA. Only a Worker on this Cloudflare account that
 * declares a service binding to the OpsGateway entrypoint, which takes a deploy;
 * the public edge reaches only the default export (spike P6), and
 * apps/web/src/lib/__tests__/ops-worker-config.test.ts allows the ops Worker
 * exactly this one binding into this Worker. It is lane wide system work, like
 * the claim: the list spans organizations, each row carrying its own, and the
 * ops database matches every saved copy against its organization.
 *
 * THE WATCHDOG (L71). The tick stamps its heartbeat here, under OPS_TICK_JOB in
 * the registry every cron of this Worker uses (cron-heartbeat.ts), which pages
 * when the tick stops or never finishes. Its report is judged here every minute
 * (runOpsTickReportCheck), through the shared export alerter, so a tick that
 * runs but fails, or is not configured, pages too: a problem a passing tick
 * would clear once three ticks in a row report it, any other at once (#2506).
 * Neither depends on the ops Worker being up: it is the thing watched.
 *
 * The ops jobs other than the tick (#2340), each a sweep inside it, stamp the
 * same way under their own ids (OpsGateway.opsJobStarted and opsJobCompleted):
 * only the ids in OPS_GATEWAY_JOBS, each by its own literal stamp below, and
 * each watched by its own CRON_JOBS entry. The first is the sf_limits sweep
 * (SF_LIMITS_JOB, #2336). Its problems page through the tick's report.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPaged } from './paginate'
import { writeHeartbeat, writeHeartbeatCompleted } from './cron-heartbeat'
import { notifyExportFailure, notifyExportRecovery } from './export-alerts'
import {
  CONNECTION_CHECK_JOB, CONNECTION_SERVE_WINDOW_MS, OpsGatewayContractError, SF_LIMITS_JOB, TOMBSTONE_SERVE_WINDOW_MS, parseOpsJobId, parseOpsJobReport, parseOpsTickReport,
  parseSealedEnvelope, problemRuleOf, sweepOfProblemKey,
  parseReplaceConnectionEnvelopeAnswer, parseReplaceConnectionEnvelopeRequest, parseStoreRotatedEnvelopeAnswer, parseStoreRotatedEnvelopeRequest,
  servedConnectionProblem,
  type OpsGatewayJob, type OpsJobReport, type OpsTickReport, type ReplaceConnectionEnvelopeAnswer, type ServedConnectionTombstone, type ServedOpsConnection, type ServedOpsConnections,
  type ServedOpsWorkflow, type ServedOpsWorkflows, type StoreRotatedEnvelopeAnswer,
} from './ops-gateway-contract'
import { formatErr } from './format-error'

/** The tick's id in the heartbeat registry and the export alerter. Never rename it: it keys its KV state. */
export const OPS_TICK_JOB = 'ops-tick'
/**
 * The bidding Worker's minute job that judges the tick's report (runOpsTickReportCheck),
 * in the heartbeat registry under its own id (#2519): it delivers the tick's
 * problems, so a run of it that stops is paged as itself. Never rename it: it keys its KV state.
 */
export const OPS_TICK_REPORT_JOB = 'ops-tick-report'
/** The last report the tick sent. */
export const OPS_TICK_REPORT_KEY = 'ops-tick:last-report'
/** A report older than this says nothing about now; the heartbeat judges a tick that stopped. */
export const OPS_TICK_REPORT_FRESH_MS = 10 * 60_000

/**
 * The write backs the tick last judged (#2340, phase 10 item 4), kept apart
 * from its report: only the tick that owns the connection check judges them,
 * every 14 to 15 minutes, and the next minute's report would overwrite them.
 * Written only by a report that carries a judgement, so a tick that judged
 * none leaves the last one as it was. Read by the ops-connection-write-back
 * page (ops-connection-logins.ts).
 */
export const OPS_TICK_WRITE_BACKS_KEY = 'ops-tick:write-backs'

/**
 * How long a kept write back judgement says anything about now: a judgement
 * arrives every 14 to 16 minutes (the connection check's claim), so one lost
 * or failed leaves the one before at most 32 minutes old. Past this the page
 * is unjudged: no page, no all clear, every open incident kept. A check that
 * stopped is the ops-connection-check heartbeat's to page, and one that could
 * not judge is its tick's write_back_* problem.
 */
export const OPS_TICK_WRITE_BACKS_FRESH_MS = 35 * 60_000

/** Pages of 1,000: five is far past the ops lane (346 workflows in the whole Pipedream export). */
const MAX_PAGES = 5

interface Row {
  id: string
  organization_id: string
  is_active: boolean
  deleted_at: string | null
  updated_at: string
  lane: string
  trigger: unknown
  workflow_versions: Array<{ version_number: number }> | null
}

/**
 * Every ops lane workflow's state. Throws on a failed read: an empty list would
 * read as every ops workflow gone, and the ops copy would withdraw them all.
 */
export async function readOpsWorkflows(supabase: SupabaseClient, nowMs: number): Promise<ServedOpsWorkflows> {
  const servedAt = new Date(nowMs).toISOString()
  const rows = await fetchAllPaged<Row>(
    (from, to) => supabase
      .from('workflows')
      // The trigger alone, never the whole definition: every minute, for every ops workflow.
      .select('id, organization_id, is_active, deleted_at, updated_at, lane, trigger:definition->trigger, workflow_versions(version_number)')
      .eq('lane', 'ops')
      .order('version_number', { referencedTable: 'workflow_versions', ascending: false })
      .limit(1, { referencedTable: 'workflow_versions' })
      .order('id', { ascending: true })
      .range(from, to),
    'the ops workflows the minute cron plans from',
    { maxPages: MAX_PAGES },
  )
  const workflows: ServedOpsWorkflow[] = []
  let dropped = 0
  for (const row of rows) {
    if (row.lane !== 'ops') {
      dropped++
      console.error(`[ops-gateway] the ops workflows read returned workflow ${row.id} of lane ${String(row.lane)}; dropped, because the query's scoping did not hold`)
      continue
    }
    workflows.push({
      id: row.id,
      organization_id: row.organization_id,
      is_active: row.is_active,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
      version_number: row.workflow_versions?.[0]?.version_number ?? null,
      trigger: row.trigger ?? null,
    })
  }
  // A list missing a row it read is not every ops workflow, so it withdraws nothing.
  return { served_at: servedAt, complete: dropped === 0, workflows }
}

interface ConnectionRow {
  id: string
  organization_id: string
  service_type: string
  sealed_for: string | null
  credential_generation: number
  credential_enc: string | null
  config: unknown
  target: unknown
}

interface TombstoneRow {
  connection_id: string
  organization_id: string
  generation: number
  removed_at: string
}

/**
 * Every ops connection, as last good copies for the ops Worker (#2335, PR 6 of
 * phase 5 of #1689; plan: discussion #2329, part 2).
 *
 * WHO CALLS IT. The ops minute tick, through the ops Worker's OPS_GATEWAY binding
 * (OpsGateway.opsConnections). No public route reaches it: the public edge
 * reaches only this Worker's default export.
 *
 * WHOSE DATA. Lane wide system work, like the workflow list: every
 * organization's ops_key rows of service_connections, each carrying its own
 * organization_id, and the removals of the last 7 hours from
 * connection_tombstones. Nothing is attributed across organizations: each row is
 * served with the organization stored on it, the ops database matches every
 * saved copy and tombstone against the organization it already holds
 * (save_connection_copies, record_connection_tombstone), and the envelope's AAD
 * binds the organization, so a copy filed under another one cannot be opened.
 * NEVER A PLAINTEXT LOGIN: only rows sealed to the ops key are read, and of
 * them only the sealed envelope (this Worker holds no key that opens it), the
 * public config and the declared target, and a row whose config or target
 * names a login field is refused (servedConnectionProblem). bidding_ring rows,
 * the Slack alert token's, are never read: the filter excludes them and any
 * that came through anyway is dropped.
 *
 * serve_until is served_at plus 6 hours (Dan's decision 3), so a removal reaches
 * ops within 6 hours even while this Worker is down. Throws on a failed read,
 * never serving an empty list, which would withdraw every ops copy. A row it
 * read and could not serve makes the list incomplete, so ops withdraws nothing.
 */
export async function readOpsConnections(supabase: SupabaseClient, nowMs: number): Promise<ServedOpsConnections> {
  const servedAt = new Date(nowMs).toISOString()
  const serveUntil = new Date(nowMs + CONNECTION_SERVE_WINDOW_MS).toISOString()
  const rows = await fetchAllPaged<ConnectionRow>(
    (from, to) => supabase
      .from('service_connections')
      .select('id, organization_id, service_type, sealed_for, credential_generation, credential_enc, config, target')
      .eq('sealed_for', 'ops_key')
      .not('credential_enc', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
    'the ops connections the minute cron keeps copies of',
    { maxPages: MAX_PAGES },
  )
  const connections: ServedOpsConnection[] = []
  let dropped = 0
  for (const row of rows) {
    if (row.sealed_for !== 'ops_key') {
      dropped++
      console.error(`[ops-gateway] the ops connections read returned connection ${row.id}, which is not sealed to the ops key; dropped, because the query's scoping did not hold`)
      continue
    }
    let envelope: unknown = null
    try {
      envelope = JSON.parse(row.credential_enc ?? '')
    } catch {
      // Refused below by name, as an envelope that is not an object.
    }
    const served = {
      id: row.id,
      organization_id: row.organization_id,
      service: row.service_type,
      generation: row.credential_generation,
      envelope,
      public_config: row.config ?? {},
      target: row.target ?? null,
      serve_until: serveUntil,
    }
    const problem = servedConnectionProblem(served, servedAt)
    if (problem !== null) {
      dropped++
      console.error(`[ops-gateway] connection ${row.id} was not served to the ops Worker: it has ${problem}`)
      continue
    }
    connections.push({ ...served, envelope: parseSealedEnvelope(envelope, 'the envelope'), public_config: served.public_config as Record<string, unknown>, target: served.target as Record<string, unknown> | null })
  }

  const removals = await fetchAllPaged<TombstoneRow>(
    (from, to) => supabase
      .from('connection_tombstones')
      .select('connection_id, organization_id, generation, removed_at')
      .gte('removed_at', new Date(nowMs - TOMBSTONE_SERVE_WINDOW_MS).toISOString())
      .order('connection_id', { ascending: true })
      .order('generation', { ascending: false })
      .range(from, to),
    'the removed connections the ops Worker must stop using',
    { maxPages: MAX_PAGES },
  )
  // One per connection, at its highest generation: a tombstone covers every generation up to its own.
  const tombstones = new Map<string, ServedConnectionTombstone>()
  for (const t of removals) {
    const kept = tombstones.get(t.connection_id)
    if (!kept || t.generation > kept.generation) {
      tombstones.set(t.connection_id, { connection_id: t.connection_id, organization_id: t.organization_id, generation: t.generation, removed_at: t.removed_at })
    }
  }
  return { served_at: servedAt, complete: dropped === 0, connections, tombstones: [...tombstones.values()] }
}

/**
 * A person bound connection's rotated login, handed back to its one home
 * (#2335, PR 5 of phase 5 of #1689; plan: discussion #2329, part 2).
 *
 * WHO CALLS IT. The ops ConnectionTokenObject, from its write back alarm, through
 * the ops Worker's OPS_GATEWAY binding (OpsGateway.storeRotatedEnvelope). There
 * is no public route to it: the public edge reaches only this Worker's default
 * export.
 *
 * WHOSE DATA. One service_connections row: the named connection, only within the
 * named organization, only when it is a person bound ops_key row still at the
 * expected generation (store_rotated_envelope, migration 20261018191000), and
 * only its credential_enc, credential_generation and updated_at. The
 * organization is the one the object's login was sealed under, which bidding
 * derived from the caller's JWT when the connection was made.
 *
 * Refuses a malformed request by name before the database is asked, and throws
 * on a database failure, so the object keeps the login and retries rather than
 * reading a write that did not happen.
 */
export async function storeRotatedEnvelope(supabase: SupabaseClient, raw: unknown): Promise<StoreRotatedEnvelopeAnswer> {
  const request = parseStoreRotatedEnvelopeRequest(raw)
  const { data, error } = await supabase.rpc('store_rotated_envelope', {
    p_organization_id: request.organization_id,
    p_connection_id: request.connection_id,
    p_expected_generation: request.expected_generation,
    p_new_generation: request.generation,
    p_envelope: request.envelope,
  })
  if (error) throw new Error(`store_rotated_envelope failed (${error.code ?? 'no code'}: ${error.message})`)
  if (!Array.isArray(data) || data.length !== 1) {
    throw new OpsGatewayContractError(`store_rotated_envelope answered ${Array.isArray(data) ? `${data.length} rows` : 'no rows'}, not one`)
  }
  return parseStoreRotatedEnvelopeAnswer(data[0])
}

/**
 * One ops connection's login, moved to the current ops kid during a rotation
 * of the ops key, handed back to its one home (#2333, the reseal; plan:
 * discussion #2329, phase 3).
 *
 * WHO CALLS IT. The ops Worker's resealConnections (src/ops/reseal.ts), through
 * the ops Worker's OPS_GATEWAY binding (OpsGateway.replaceConnectionEnvelope).
 * There is no public route to it: the public edge reaches only this Worker's
 * default export, and apps/web/src/lib/__tests__/ops-worker-config.test.ts
 * allows the ops Worker this one binding into it.
 *
 * WHOSE DATA. One service_connections row: the named connection, only within
 * the named organization, only an ops_key row (never the bidding_ring Slack
 * alert row), only while it is still at the expected generation and its
 * envelope names the expected kid (replace_connection_envelope, migration
 * 20261019160000), and only its credential_enc and updated_at, never its
 * generation. The new envelope must name the committed current kid, which the
 * request parse holds before the database is asked.
 *
 * Refuses a malformed request by name before the database is asked, and throws
 * on a database failure, so the reseal reports the row as not written rather
 * than reading a write that did not happen.
 */
export async function replaceConnectionEnvelope(supabase: SupabaseClient, raw: unknown): Promise<ReplaceConnectionEnvelopeAnswer> {
  const request = parseReplaceConnectionEnvelopeRequest(raw)
  const { data, error } = await supabase.rpc('replace_connection_envelope', {
    p_organization_id: request.organization_id,
    p_connection_id: request.connection_id,
    p_expected_kid: request.expected_kid,
    p_expected_generation: request.expected_generation,
    p_envelope: request.envelope,
  })
  if (error) throw new Error(`replace_connection_envelope failed (${error.code ?? 'no code'}: ${error.message})`)
  if (!Array.isArray(data) || data.length !== 1) {
    throw new OpsGatewayContractError(`replace_connection_envelope answered ${Array.isArray(data) ? `${data.length} rows` : 'no rows'}, not one`)
  }
  return parseReplaceConnectionEnvelopeAnswer(data[0])
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export async function recordOpsTickStarted(kv: KVNamespace, nowMs: number): Promise<void> {
  await writeHeartbeat(kv, OPS_TICK_JOB, nowMs)
}

/**
 * The sf_limits sweep's id in the heartbeat registry (#2336, #2340), defined
 * in the contract the ops Worker shares and stamped below by its own literal
 * call, as OPS_TICK_JOB is above.
 */
export { SF_LIMITS_JOB } from './ops-gateway-contract'

/** The connection_check sweep's id in the heartbeat registry (#2340), stamped below by its own literal calls. */
export { CONNECTION_CHECK_JOB } from './ops-gateway-contract'

/**
 * An ops job's started stamp (OpsGateway.opsJobStarted, #2340). Only the ids
 * in OPS_GATEWAY_JOBS are accepted, each dispatched to its own literal stamp,
 * so an id this Worker does not watch is refused by name and writes nothing,
 * and the tick cannot be stamped round its own methods.
 */
export async function recordOpsJobStarted(kv: KVNamespace, rawJobId: unknown, nowMs: number): Promise<OpsGatewayJob> {
  const job = parseOpsJobId(rawJobId)
  switch (job) {
    case SF_LIMITS_JOB:
      await writeHeartbeat(kv, SF_LIMITS_JOB, nowMs)
      return job
    case CONNECTION_CHECK_JOB:
      await writeHeartbeat(kv, CONNECTION_CHECK_JOB, nowMs)
      return job
    default: {
      const unhandled: never = job
      throw new OpsGatewayContractError(`no started stamp for ${String(unhandled)}`)
    }
  }
}

/**
 * An ops job's completed stamp (OpsGateway.opsJobCompleted, #2340). The run
 * finished whatever its report says, so a report this Worker cannot read is
 * logged as unreadable and the completion is still stamped: the heartbeat
 * must not read a finished run as killed. The job's problems reach the page
 * through the tick's own report (its keyed problems), not through this one,
 * which is only logged.
 */
export async function recordOpsJobCompleted(kv: KVNamespace, rawJobId: unknown, rawReport: unknown, nowMs: number): Promise<OpsGatewayJob> {
  const job = parseOpsJobId(rawJobId)
  let report: OpsJobReport | null = null
  try {
    report = parseOpsJobReport(rawReport)
  } catch (err) {
    logLine('error', { event: 'ops_job_report_unreadable', job, detail: formatErr(err) })
  }
  switch (job) {
    case SF_LIMITS_JOB:
      await writeHeartbeatCompleted(kv, SF_LIMITS_JOB, nowMs)
      break
    case CONNECTION_CHECK_JOB:
      await writeHeartbeatCompleted(kv, CONNECTION_CHECK_JOB, nowMs)
      break
    default: {
      const unhandled: never = job
      throw new OpsGatewayContractError(`no completed stamp for ${String(unhandled)}`)
    }
  }
  if (report !== null) console.log(JSON.stringify({ event: 'ops_job_completed', job, ...report.counts }))
  return job
}

/**
 * The ticks in a row a problem a passing tick would clear must be reported by
 * before it pages (#2506, Dan's decision 2026-10-19). On 2026-10-18 a start
 * stamp ran past the tick's 15 s gateway deadline, and on 2026-10-19 at 2:36 PM
 * ET the run_expiry sweep's claim_ops_sweep passed its 9000 ms deadline on a
 * stall between the Worker and Supabase while the database answered in 224 ms;
 * each paged on one tick and recovered by itself. At one tick a minute, a real
 * outage still pages within about three minutes. This replaces #2410's two
 * missed start stamps in a row, which was the same rule for one kind of problem.
 * For a kind judged by its sweep's runs (OPS_TICK_PROBLEM_SWEEPS, #2340) it is
 * three runs of that sweep in a row (sf-limits.ts FAILURES says why three).
 */
export const OPS_TICK_TICKS_IN_A_ROW_TO_PAGE = 3

/**
 * Each problem's run of ticks in a row, keyed by the problem's key (its kind
 * and subject, never its sentence, see OpsTickReport.problem_keys). One record,
 * written as each report arrives, so a tick without a problem ends that
 * problem's run, and a clean tick removes the record.
 */
export const OPS_TICK_STREAKS_KEY = 'ops-tick:problem-streaks'

/**
 * The record's expiry, renewed by every tick that keeps a problem standing, so
 * a run can never stay armed for ever: once no report has arrived for this
 * long, the heartbeat judges the tick (cron-heartbeat.ts) and the next problem
 * starts a run of its own. It is the window in which the check reads a report
 * as saying anything about now, and it is judged on the clock as well, because
 * KV expires a key lazily.
 */
export const OPS_TICK_STREAK_TTL_SECONDS = OPS_TICK_REPORT_FRESH_MS / 1000

interface StreakRecord {
  tick_id: string
  received_at: string
  streaks: Record<string, number>
  /**
   * The sentence of each key judged by its sweep's runs (#2340), so a tick that
   * did not run the sweep can carry the problem in its own words. Absent on a
   * record from a release before it, whose carried problems are named by key.
   */
  texts?: Record<string, string>
}

/** One problem of a kept report: its key, and how many ticks in a row, this one included, reported it. */
interface JudgedProblem {
  key: string
  in_a_row: number
}

/**
 * A problem of a sweep that runs less often than the tick, which this tick did
 * not run, carried from the last tick that did (#2340): its key, its run of
 * that sweep's runs, and its sentence.
 */
interface CarriedProblem extends JudgedProblem {
  text: string
}

/**
 * What is kept: the report as the tick sent it, when this Worker received it,
 * and, side by side with its problems, each one's key and run (#2506). The run
 * is counted per report as it arrives, never per check, because the minute
 * check can read one report several times. Beside them, the problems carried
 * from a sweep this tick did not run (#2340); null when the count could not be
 * read, so whether one still stands is not known.
 */
type KeptReport = OpsTickReport & { received_at: string; problem_streaks: JudgedProblem[] | null; carried_problems: CarriedProblem[] | null }

/**
 * The key each problem is judged by. A report from an ops release before #2506
 * keys nothing: its lone missed start stamp is still known by its flag (#2410),
 * and any other sentence cannot be told from a defect, so it pages at once.
 */
function judgedKeys(report: OpsTickReport): string[] {
  if (report.problem_keys !== null) return report.problem_keys
  if (report.start_stamp_failed === true && report.problems.length === 1) return ['start_stamp']
  return report.problems.map(() => 'unkeyed')
}

/** A named line, as JSON, so a search for the event finds every one. */
function logLine(level: 'warn' | 'error', fields: Record<string, string | number | boolean | null>): void {
  console[level](JSON.stringify(fields))
}

/**
 * Each key's run of ticks in a row, this report included, carried forward in
 * KV. Never throws: the report must still be kept.
 *
 * FAILS TOWARD PAGING. A run that cannot be read (a failed or unreadable KV
 * read) or carried forward (a failed write) is counted as already long enough,
 * so this tick pages rather than holding a problem whose count is unknown,
 * which could hold it for ever; each says so in an ops_tick_count_unknown line.
 * A record older than the window, by its own received_at on this Worker's
 * clock, starts every run afresh. The same report delivered twice (one tick id)
 * counts once. Two overlapping ticks can both read the record before either
 * writes, which costs at most one tick before a run pages; a KV read that does
 * not yet see the last write, from another location, can cost the same.
 *
 * A SWEEP'S PROBLEM (#2340). A key whose kind is judged by its sweep's runs
 * (OPS_TICK_PROBLEM_SWEEPS) counts only on a tick that ran that sweep, which
 * is the only tick that can report it. On a tick that did not run the sweep
 * (the report's sweeps_run does not name it) its run is carried as it stood,
 * with its sentence, neither counted, ended nor stood down: so three in a row
 * is three runs of the sweep, and the tick after a sweep's page is not read as
 * its all clear. A tick that ran the sweep and did not report it ends it. A
 * report that does not say which sweeps ran (an ops release before this)
 * carries nothing, as before. With the record unreadable, nothing is known to
 * be carried, and carried is null.
 */
async function countRuns(
  kv: KvLike, report: Pick<OpsTickReport, 'tick_id' | 'problems' | 'sweeps_run'>, keys: readonly string[], nowMs: number,
): Promise<{ runs: number[]; carried: CarriedProblem[] | null }> {
  const tickId = report.tick_id
  const unknown = (why: 'read' | 'write', detail: string) => {
    logLine('error', { event: 'ops_tick_count_unknown', tick_id: tickId, why, detail, pages: true })
  }
  let known = true
  let prev: StreakRecord | null = null
  try {
    const raw = await kv.get(OPS_TICK_STREAKS_KEY)
    if (raw !== null) prev = parseStreakRecord(raw)
  } catch (err) {
    known = false
    unknown('read', formatErr(err))
  }
  const prevMs = prev === null ? Number.NaN : Date.parse(prev.received_at)
  // A readable, old record is not the tick before; an unreadable time is read as recent, the side that pages.
  if (prev !== null && Number.isFinite(prevMs) && nowMs - prevMs > OPS_TICK_REPORT_FRESH_MS) prev = null
  const sameTick = prev !== null && prev.tick_id === tickId

  // What is stored is what is known: with the record unreadable, only this
  // tick, so one failed read pages this tick without making the next ones page
  // as though their problem had already stood for three.
  const streaks: Record<string, number> = {}
  const texts: Record<string, string> = {}
  keys.forEach((key, i) => {
    if (!Object.hasOwn(streaks, key)) {
      const before = prev !== null && Object.hasOwn(prev.streaks, key) ? prev.streaks[key] : 0
      streaks[key] = sameTick ? Math.max(before, 1) : before + 1
    }
    if (sweepOfProblemKey(key) !== null && !Object.hasOwn(texts, key)) texts[key] = report.problems[i]
  })

  const carried: CarriedProblem[] = []
  if (prev !== null && report.sweeps_run !== null) {
    for (const [key, n] of Object.entries(prev.streaks)) {
      const sweep = sweepOfProblemKey(key)
      if (sweep === null || Object.hasOwn(streaks, key) || report.sweeps_run.includes(sweep)) continue
      const text = prev.texts !== undefined && Object.hasOwn(prev.texts, key)
        ? prev.texts[key]
        : `A problem the ${sweep} sweep reported on an earlier tick still stands (${key}); the sweep judges it again on its next run, and the ops Worker's logs have its words.`
      streaks[key] = n
      texts[key] = text
      carried.push({ key, in_a_row: n, text })
    }
  }

  let kept = known
  try {
    if (Object.keys(streaks).length === 0) {
      if (prev !== null || !known) await kv.delete(OPS_TICK_STREAKS_KEY)
    } else {
      const record: StreakRecord = { tick_id: tickId, received_at: new Date(nowMs).toISOString(), streaks, texts }
      await kv.put(OPS_TICK_STREAKS_KEY, JSON.stringify(record), { expirationTtl: OPS_TICK_STREAK_TTL_SECONDS })
    }
  } catch (err) {
    // The next tick cannot carry this run on, so this one does not hold it.
    unknown('write', formatErr(err))
    kept = false
  }
  return {
    runs: keys.map((key) => (kept ? streaks[key] : Math.max(streaks[key], OPS_TICK_TICKS_IN_A_ROW_TO_PAGE))),
    carried: known ? carried : null,
  }
}

/** The stored record, or a throw naming why it is not one. */
function parseStreakRecord(raw: string): StreakRecord {
  const parsed = JSON.parse(raw) as Partial<StreakRecord> | null
  const streaks = parsed?.streaks
  const texts: unknown = parsed?.texts
  if (
    parsed === null || typeof parsed !== 'object' || typeof parsed.tick_id !== 'string' || typeof parsed.received_at !== 'string' ||
    streaks === null || typeof streaks !== 'object' || Array.isArray(streaks) ||
    Object.values(streaks).some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < 1)
  ) throw new Error('the stored record is not a count of ticks in a row')
  if (texts === undefined) return { tick_id: parsed.tick_id, received_at: parsed.received_at, streaks }
  if (texts === null || typeof texts !== 'object' || Array.isArray(texts) || Object.values(texts).some((t) => typeof t !== 'string')) {
    throw new Error('the stored record\'s sentences are not sentences')
  }
  return { tick_id: parsed.tick_id, received_at: parsed.received_at, streaks, texts: texts as Record<string, string> }
}

/**
 * Stamps completed, counts each problem's run, and keeps the report. A report
 * that cannot be read is kept as a failing one naming why, so it pages: it must
 * never read as a healthy tick. Each problem held below three in a row is
 * logged by name (ops_tick_problem_held) with its count.
 */
export async function recordOpsTickCompleted(kv: KVNamespace, raw: unknown, nowMs: number): Promise<void> {
  const receivedAt = new Date(nowMs).toISOString()
  let report: OpsTickReport
  try {
    report = parseOpsTickReport(raw)
  } catch (err) {
    report = unreadableReport(formatErr(err), receivedAt)
  }
  await writeHeartbeatCompleted(kv, OPS_TICK_JOB, nowMs)
  const keys = judgedKeys(report)
  const { runs, carried } = await countRuns(kv, report, keys, nowMs)
  const judged = keys.map((key, i) => ({ key, in_a_row: runs[i] }))
  for (const p of judged) {
    if (problemRuleOf(p.key) === 'three_in_a_row' && p.in_a_row < OPS_TICK_TICKS_IN_A_ROW_TO_PAGE) {
      logLine('warn', {
        event: 'ops_tick_problem_held', tick_id: report.tick_id, key: p.key, in_a_row: p.in_a_row, pages_at: OPS_TICK_TICKS_IN_A_ROW_TO_PAGE,
        counted_by: sweepOfProblemKey(p.key) ?? 'tick',
      })
    }
  }
  const kept: KeptReport = { ...report, received_at: receivedAt, problem_streaks: judged, carried_problems: carried }
  await kv.put(OPS_TICK_REPORT_KEY, JSON.stringify(kept))
  // After the report, so a failure here cannot cost the report; it throws to the tick, which logs it.
  if (report.write_backs !== null) {
    await kv.put(OPS_TICK_WRITE_BACKS_KEY, JSON.stringify({ tick_id: report.tick_id, received_at: receivedAt, write_backs: report.write_backs }))
  }
}

function unreadableReport(why: string, at: string): OpsTickReport {
  return {
    tick_id: 'unreadable', mode: 'observe', scheduled_time: null, started_at: at, finished_at: at, db_now: null,
    outcome: 'problems', problems: [`The ops tick's report could not be read (${why}), so whether the tick worked is not known.`], counts: {},
    not_configured_secrets: [], start_stamp_failed: null, problem_keys: ['report_unreadable'], connection_logins: null, write_backs: null,
    sweeps_run: null,
  }
}

/**
 * The runs kept beside a report's problems, or null when they cannot be matched
 * to them one for one: a report kept before #2506, or a damaged one. Null pages
 * every problem, never holds one (L50).
 */
function keptRuns(raw: unknown, problems: readonly string[]): JudgedProblem[] | null {
  if (!Array.isArray(raw) || raw.length !== problems.length) return null
  const runs: JudgedProblem[] = []
  for (const p of raw as unknown[]) {
    const r = p as { key?: unknown; in_a_row?: unknown } | null
    if (r === null || typeof r !== 'object' || typeof r.key !== 'string' || typeof r.in_a_row !== 'number' || !Number.isInteger(r.in_a_row) || r.in_a_row < 1) return null
    runs.push({ key: r.key, in_a_row: r.in_a_row })
  }
  return runs
}

/**
 * The problems carried beside a kept report (#2340). A report kept before
 * #2340 carries none ([]); null, or a list that cannot be read, is not known
 * (null), which keeps an open incident open rather than reading as clean (L11).
 */
function keptCarried(raw: unknown): CarriedProblem[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const carried: CarriedProblem[] = []
  for (const p of raw as unknown[]) {
    const c = p as { key?: unknown; in_a_row?: unknown; text?: unknown } | null
    if (c === null || typeof c !== 'object' || typeof c.key !== 'string' || typeof c.text !== 'string' || typeof c.in_a_row !== 'number' || !Number.isInteger(c.in_a_row) || c.in_a_row < 1) return null
    carried.push({ key: c.key, in_a_row: c.in_a_row, text: c.text })
  }
  return carried
}

/** The fixed sentence saying a page's problems were each held until they repeated (#1768: never the running count). */
function repeatedContext(keys: readonly string[]): string {
  const bySweep = keys.filter((k) => sweepOfProblemKey(k) !== null).length
  if (bySweep === 0) return `Reported by ${OPS_TICK_TICKS_IN_A_ROW_TO_PAGE} or more ticks in a row.`
  if (bySweep === keys.length) return `Reported by ${OPS_TICK_TICKS_IN_A_ROW_TO_PAGE} or more runs of its sweep in a row.`
  return `Reported by ${OPS_TICK_TICKS_IN_A_ROW_TO_PAGE} or more ticks, or runs of its sweep, in a row.`
}

export interface OpsTickReportCheckDeps {
  notifyFailure: (
    supabase: SupabaseClient, job: string, errors: string[], kv: KvLike, remedy: { title: string; context?: string; fixHint?: string }, nowMs: number,
    options: { repeatsHeldByCaller: boolean },
  ) => Promise<void>
  notifyRecovery: (kv: KvLike, job: string, nowMs: number) => Promise<void>
}

const LIVE_DEPS: OpsTickReportCheckDeps = {
  notifyFailure: (supabase, job, errors, kv, remedy, nowMs, options) => notifyExportFailure(supabase, job, errors, kv, remedy, nowMs, options),
  notifyRecovery: (kv, job, nowMs) => notifyExportRecovery(kv, job, nowMs),
}

const DATABASE_FIX =
  'Create a secret key for bidspoke-worker-ops on the Bidspoke Ops project, then set OPS_SUPABASE_URL and OPS_SUPABASE_SECRET_KEY on bidspoke-worker-ops (the steps are on the pull request that added the ops minute cron, #1949).'

/**
 * The remedy for each secret the tick can report not configured (#2333), so a
 * page names the steps for the secret that is actually missing. The ops private
 * key is restored from its escrow, never generated afresh: every ops connection
 * is sealed to it, and a new key would leave each one unopenable.
 */
export const NOT_CONFIGURED_FIX: Readonly<Record<string, string>> = {
  OPS_SUPABASE_URL: DATABASE_FIX,
  OPS_SUPABASE_SECRET_KEY: DATABASE_FIX,
  OPS_CONNECTIONS_PRIVATE_KEY:
    'Restore the ops private key from the file ops-connections-private.pem attached to the 1Password item Bidspoke recovery keys: from apps/worker, run `op read "op://<vault>/Bidspoke recovery keys/ops-connections-private.pem" | pnpm exec wrangler secret put OPS_CONNECTIONS_PRIVATE_KEY --config wrangler.ops.toml` with the name of the vault that holds the item, never typing the key on a command line. Do not generate a new key while that copy exists: every ops connection is sealed to it (docs/disaster-recovery.md, Secret inventory).',
  OPS_CONNECTIONS_PRIVATE_KEY_NEXT:
    'OPS_CONNECTIONS_PRIVATE_KEY_NEXT is set only during a rotation of the ops key. If one is under way, pipe the NEXT key from the file ops-connections-private-next.pem attached to the 1Password item Bidspoke recovery keys into `pnpm exec wrangler secret put OPS_CONNECTIONS_PRIVATE_KEY_NEXT --config wrangler.ops.toml` from apps/worker, with op read as for the current key; if none is, remove it with `pnpm exec wrangler secret delete OPS_CONNECTIONS_PRIVATE_KEY_NEXT --config wrangler.ops.toml`.',
}

/**
 * The remedy for the secrets a report named, each said once, in the order
 * named. A report naming none comes from an ops release before #2333, whose only
 * not configured cause was the ops database. A name with no written remedy is
 * named as it is, never answered with another secret's steps.
 */
export function notConfiguredFix(secrets: readonly string[] | null): string {
  if (secrets === null || secrets.length === 0) return DATABASE_FIX
  const fixes: string[] = []
  for (const name of secrets) {
    const fix = Object.hasOwn(NOT_CONFIGURED_FIX, name)
      ? NOT_CONFIGURED_FIX[name]
      : `Set ${name} on bidspoke-worker-ops: from apps/worker, pipe its value into \`pnpm exec wrangler secret put ${name} --config wrangler.ops.toml\`.`
    if (!fixes.includes(fix)) fixes.push(fix)
  }
  return fixes.join(' ')
}
const PROBLEMS_FIX = 'Search the bidspoke-worker-ops logs for ops_tick around the time of this alert: every problem is logged there with the tick it came from.'

export type OpsTickReportVerdict = 'healthy' | 'alerted' | 'held' | 'stale' | 'no_report'

/**
 * Judges the tick's last report, once a minute: stands an alert down on a clean
 * one, leaves a report too old to say anything about now to the heartbeat, and
 * pages the problems that are due (#2506): each whose kind pages at once, and
 * each whose kind a passing tick would clear once three ticks in a row have
 * reported it. A report whose problems are all held is neither paged nor read
 * as clean, so an open incident stays open and its all clear still pairs with
 * its page. Problems held beside paged ones are left off the page, since none
 * has stood for three ticks; never all of them, which the alerter would read as
 * a recovery (L785). The alerter keeps its own reminder schedule, and is told
 * the repeats were held here so its grace does not hold the page again.
 */
export async function runOpsTickReportCheck(
  supabase: SupabaseClient, kv: KVNamespace, nowMs: number, deps: OpsTickReportCheckDeps = LIVE_DEPS,
): Promise<OpsTickReportVerdict> {
  const raw = await kv.get(OPS_TICK_REPORT_KEY)
  if (raw === null) return 'no_report'
  let kept: KeptReport
  try {
    const parsed: unknown = JSON.parse(raw)
    const extra = parsed as { received_at?: unknown; problem_streaks?: unknown; carried_problems?: unknown } | null
    const receivedAt = extra?.received_at
    const report = parseOpsTickReport(parsed)
    kept = {
      ...report,
      received_at: typeof receivedAt === 'string' ? receivedAt : '',
      problem_streaks: keptRuns(extra?.problem_streaks, report.problems),
      carried_problems: keptCarried(extra?.carried_problems),
    }
  } catch (err) {
    const at = new Date(nowMs).toISOString()
    kept = { ...unreadableReport(formatErr(err), at), received_at: at, problem_streaks: null, carried_problems: [] }
  }
  const receivedMs = Date.parse(kept.received_at)
  // An unreadable time is judged as fresh, the side that pages, never read as an
  // old report and left quiet (L50). Only a readable, old one is the heartbeat's.
  if (Number.isFinite(receivedMs) && nowMs - receivedMs > OPS_TICK_REPORT_FRESH_MS) return 'stale'
  // A sweep's problem stands until its sweep runs again (#2340), so a tick
  // carrying one is not clean, and one whose carried problems are not known
  // (the count could not be read) is neither paged nor read as clean.
  const carried = kept.carried_problems
  if (kept.outcome === 'ok' && carried === null) {
    console.warn(`[ops-tick] held tick ${kept.tick_id}: its count could not be read, so whether a sweep's problem still stands is not known`)
    return 'held'
  }
  if (kept.outcome === 'ok' && carried !== null && carried.length === 0) {
    await deps.notifyRecovery(kv, OPS_TICK_JOB, nowMs)
    return 'healthy'
  }
  // Runs that cannot be matched to the problems page every problem (L50).
  const runs = kept.problem_streaks
  const isDue = (run: JudgedProblem | null) => run === null || problemRuleOf(run.key) === 'at_once' || run.in_a_row >= OPS_TICK_TICKS_IN_A_ROW_TO_PAGE
  const due: Array<{ text: string; run: JudgedProblem | null }> = [
    ...kept.problems.map((text, i) => ({ text, run: runs === null ? null : runs[i] })),
    ...(carried ?? []).map((c) => ({ text: c.text, run: { key: c.key, in_a_row: c.in_a_row } })),
  ].filter(({ run }) => isDue(run))
  if (due.length === 0) {
    const standing = kept.problems.length + (carried?.length ?? 0)
    console.warn(`[ops-tick] held tick ${kept.tick_id}: each of its ${standing} problem${standing === 1 ? '' : 's'} has stood for fewer than ${OPS_TICK_TICKS_IN_A_ROW_TO_PAGE} ticks, or runs of its sweep, in a row`)
    return 'held'
  }
  const allHeldThree = due.every(({ run }) => run !== null && problemRuleOf(run.key) === 'three_in_a_row')
  const remedy = kept.outcome === 'not_configured'
    ? { title: 'The ops minute cron is not configured', fixHint: notConfiguredFix(kept.not_configured_secrets) }
    : {
        title: 'The ops minute cron reported a problem',
        // A fixed sentence, never the running count: the alerter would read a
        // new count each minute as a new problem and post it at once (#1768).
        ...(allHeldThree ? { context: repeatedContext(due.map(({ run }) => (run as JudgedProblem).key)) } : {}),
        fixHint: PROBLEMS_FIX,
      }
  await deps.notifyFailure(supabase, OPS_TICK_JOB, due.map(({ text }) => text), kv, remedy, nowMs, { repeatsHeldByCaller: true })
  return 'alerted'
}
