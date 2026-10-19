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
 * runs but fails, or is not configured, pages too. Neither depends on the ops
 * Worker being up: it is the thing watched.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPaged } from './paginate'
import { writeHeartbeat, writeHeartbeatCompleted } from './cron-heartbeat'
import { notifyExportFailure, notifyExportRecovery } from './export-alerts'
import {
  CONNECTION_SERVE_WINDOW_MS, OpsGatewayContractError, TOMBSTONE_SERVE_WINDOW_MS, parseOpsTickReport, parseSealedEnvelope,
  parseReplaceConnectionEnvelopeAnswer, parseReplaceConnectionEnvelopeRequest, parseStoreRotatedEnvelopeAnswer, parseStoreRotatedEnvelopeRequest,
  servedConnectionProblem,
  type OpsTickReport, type ReplaceConnectionEnvelopeAnswer, type ServedConnectionTombstone, type ServedOpsConnection, type ServedOpsConnections,
  type ServedOpsWorkflow, type ServedOpsWorkflows, type StoreRotatedEnvelopeAnswer,
} from './ops-gateway-contract'
import { formatErr } from './format-error'

/** The tick's id in the heartbeat registry and the export alerter. Never rename it: it keys its KV state. */
export const OPS_TICK_JOB = 'ops-tick'
/** The last report the tick sent. */
export const OPS_TICK_REPORT_KEY = 'ops-tick:last-report'
/** A report older than this says nothing about now; the heartbeat judges a tick that stopped. */
export const OPS_TICK_REPORT_FRESH_MS = 10 * 60_000

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
 * What is kept: the report as the tick sent it, when this Worker received it,
 * and how many reports in a row, this one included, said the start stamp failed
 * (#2410). The run is counted per report as it arrives, never per check, because
 * the minute check can read one report twice.
 */
type KeptReport = OpsTickReport & { received_at: string; start_stamp_misses: number }

/**
 * The missed start stamps in a row at which one is paged (#2410). A lone miss is
 * held: at 15:02:29 UTC on 2026-10-18 one start stamp ran past the tick's 15 s
 * gateway deadline two minutes after the ops Worker's deploy, paged, and no tick
 * failed after it. Two in a row is no longer a lone miss, so it pages, one tick
 * later than a miss paged before.
 */
export const OPS_TICK_START_MISSES_TO_PAGE = 2

/**
 * Stamps completed and keeps the report. A report that cannot be read is kept as
 * a failing one naming why, so it pages: it must never read as a healthy tick.
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
  const misses = report.start_stamp_failed === true ? (await previousStartMisses(kv, nowMs)) + 1 : 0
  if (misses > 0) {
    console.warn(`[ops-tick] tick ${report.tick_id} could not stamp its start, ${misses} report${misses === 1 ? '' : 's'} in a row`)
  }
  const kept: KeptReport = { ...report, received_at: receivedAt, start_stamp_misses: misses }
  await kv.put(OPS_TICK_REPORT_KEY, JSON.stringify(kept))
}

/**
 * The run of missed start stamps the kept report ended on. A report too old to
 * say anything about now (OPS_TICK_REPORT_FRESH_MS) is not the tick before, so it
 * starts no run. One that cannot be read counts as a miss, the side that pages
 * sooner. Two overlapping ticks can both read the same previous report, which
 * costs at most one tick before a run of misses pages.
 */
async function previousStartMisses(kv: KVNamespace, nowMs: number): Promise<number> {
  let raw: string | null
  try {
    raw = await kv.get(OPS_TICK_REPORT_KEY)
  } catch (err) {
    // The report must still be kept, so a failed read is counted as a miss
    // before this one: the run then pages rather than being held.
    console.error(`[ops-tick] could not read the last report to count missed start stamps (${formatErr(err)}); counting it as a miss`)
    return OPS_TICK_START_MISSES_TO_PAGE - 1
  }
  if (raw === null) return 0
  let prev: { received_at?: unknown; start_stamp_failed?: unknown; start_stamp_misses?: unknown }
  try {
    prev = JSON.parse(raw) as typeof prev
  } catch {
    return 1
  }
  if (prev === null || typeof prev !== 'object') return 1
  const receivedMs = typeof prev.received_at === 'string' ? Date.parse(prev.received_at) : Number.NaN
  if (Number.isFinite(receivedMs) && nowMs - receivedMs > OPS_TICK_REPORT_FRESH_MS) return 0
  if (prev.start_stamp_failed !== true) return 0
  const n = prev.start_stamp_misses
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : 1
}

function unreadableReport(why: string, at: string): OpsTickReport {
  return {
    tick_id: 'unreadable', mode: 'observe', scheduled_time: null, started_at: at, finished_at: at, db_now: null,
    outcome: 'problems', problems: [`The ops tick's report could not be read (${why}), so whether the tick worked is not known.`], counts: {},
    not_configured_secrets: [], start_stamp_failed: null,
  }
}

export interface OpsTickReportCheckDeps {
  notifyFailure: (supabase: SupabaseClient, job: string, errors: string[], kv: KvLike, remedy: { title: string; context?: string; fixHint?: string }, nowMs: number) => Promise<void>
  notifyRecovery: (kv: KvLike, job: string, nowMs: number) => Promise<void>
}

const LIVE_DEPS: OpsTickReportCheckDeps = {
  notifyFailure: (supabase, job, errors, kv, remedy, nowMs) => notifyExportFailure(supabase, job, errors, kv, remedy, nowMs),
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
 * Judges the tick's last report, once a minute: pages on one naming problems
 * (the shared export alerter holds its own reminder schedule and its first
 * transient failure), stands an alert down on a clean one, and leaves a report
 * too old to say anything about now to the heartbeat. A report whose only
 * problem is the first missed start stamp in a row is held (#2410): neither
 * paged nor read as clean, so an open incident stays open.
 */
export async function runOpsTickReportCheck(
  supabase: SupabaseClient, kv: KVNamespace, nowMs: number, deps: OpsTickReportCheckDeps = LIVE_DEPS,
): Promise<OpsTickReportVerdict> {
  const raw = await kv.get(OPS_TICK_REPORT_KEY)
  if (raw === null) return 'no_report'
  let kept: KeptReport
  try {
    const parsed: unknown = JSON.parse(raw)
    const extra = parsed as { received_at?: unknown; start_stamp_misses?: unknown } | null
    const receivedAt = extra?.received_at
    const misses = extra?.start_stamp_misses
    kept = {
      ...parseOpsTickReport(parsed),
      received_at: typeof receivedAt === 'string' ? receivedAt : '',
      // A run that cannot be read is judged long enough to page, never held (L50).
      start_stamp_misses: typeof misses === 'number' && Number.isInteger(misses) ? misses : OPS_TICK_START_MISSES_TO_PAGE,
    }
  } catch (err) {
    kept = { ...unreadableReport(formatErr(err), new Date(nowMs).toISOString()), received_at: new Date(nowMs).toISOString(), start_stamp_misses: 0 }
  }
  const receivedMs = Date.parse(kept.received_at)
  // An unreadable time is judged as fresh, the side that pages, never read as an
  // old report and left quiet (L50). Only a readable, old one is the heartbeat's.
  if (Number.isFinite(receivedMs) && nowMs - receivedMs > OPS_TICK_REPORT_FRESH_MS) return 'stale'
  if (kept.outcome === 'ok') {
    await deps.notifyRecovery(kv, OPS_TICK_JOB, nowMs)
    return 'healthy'
  }
  const stampMissed = kept.start_stamp_failed === true
  // A lone missed start stamp is held for one tick (#2410); with any other
  // problem beside it, or the second in a row, the report pages as before.
  if (kept.outcome === 'problems' && stampMissed && kept.problems.length === 1 && kept.start_stamp_misses < OPS_TICK_START_MISSES_TO_PAGE) {
    console.warn(`[ops-tick] held tick ${kept.tick_id}: its start stamp failed and nothing else did; the next tick pages if its stamp fails too`)
    return 'held'
  }
  const remedy = kept.outcome === 'not_configured'
    ? { title: 'The ops minute cron is not configured', fixHint: notConfiguredFix(kept.not_configured_secrets) }
    : {
        title: 'The ops minute cron reported a problem',
        // A fixed sentence, never the running count: the alerter would read a
        // new count each minute as a new problem and post it at once (#1768).
        ...(stampMissed && kept.start_stamp_misses >= OPS_TICK_START_MISSES_TO_PAGE
          ? { context: `The start stamp failed on ${OPS_TICK_START_MISSES_TO_PAGE} or more ticks in a row.` }
          : {}),
        fixHint: PROBLEMS_FIX,
      }
  await deps.notifyFailure(supabase, OPS_TICK_JOB, kept.problems, kv, remedy, nowMs)
  return 'alerted'
}
