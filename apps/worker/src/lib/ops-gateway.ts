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
import { parseOpsTickReport, type OpsTickReport, type ServedOpsWorkflow, type ServedOpsWorkflows } from './ops-gateway-contract'
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

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export async function recordOpsTickStarted(kv: KVNamespace, nowMs: number): Promise<void> {
  await writeHeartbeat(kv, OPS_TICK_JOB, nowMs)
}

/** What is kept: the report as the tick sent it, and when this Worker received it. */
type KeptReport = OpsTickReport & { received_at: string }

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
  const kept: KeptReport = { ...report, received_at: receivedAt }
  await kv.put(OPS_TICK_REPORT_KEY, JSON.stringify(kept))
}

function unreadableReport(why: string, at: string): OpsTickReport {
  return {
    tick_id: 'unreadable', mode: 'observe', scheduled_time: null, started_at: at, finished_at: at, db_now: null,
    outcome: 'problems', problems: [`The ops tick's report could not be read (${why}), so whether the tick worked is not known.`], counts: {},
  }
}

export interface OpsTickReportCheckDeps {
  notifyFailure: (supabase: SupabaseClient, job: string, errors: string[], kv: KvLike, remedy: { title: string; fixHint?: string }, nowMs: number) => Promise<void>
  notifyRecovery: (kv: KvLike, job: string, nowMs: number) => Promise<void>
}

const LIVE_DEPS: OpsTickReportCheckDeps = {
  notifyFailure: (supabase, job, errors, kv, remedy, nowMs) => notifyExportFailure(supabase, job, errors, kv, remedy, nowMs),
  notifyRecovery: (kv, job, nowMs) => notifyExportRecovery(kv, job, nowMs),
}

const NOT_CONFIGURED_FIX =
  'Create a secret key for bidspoke-worker-ops on the Bidspoke Ops project, then set OPS_SUPABASE_URL and OPS_SUPABASE_SECRET_KEY on bidspoke-worker-ops (the steps are on the pull request that added the ops minute cron, #1949).'
const PROBLEMS_FIX = 'Search the bidspoke-worker-ops logs for ops_tick around the time of this alert: every problem is logged there with the tick it came from.'

export type OpsTickReportVerdict = 'healthy' | 'alerted' | 'stale' | 'no_report'

/**
 * Judges the tick's last report, once a minute: pages on one naming problems
 * (the shared export alerter holds its own reminder schedule and its first
 * transient failure), stands an alert down on a clean one, and leaves a report
 * too old to say anything about now to the heartbeat.
 */
export async function runOpsTickReportCheck(
  supabase: SupabaseClient, kv: KVNamespace, nowMs: number, deps: OpsTickReportCheckDeps = LIVE_DEPS,
): Promise<OpsTickReportVerdict> {
  const raw = await kv.get(OPS_TICK_REPORT_KEY)
  if (raw === null) return 'no_report'
  let kept: KeptReport
  try {
    const parsed: unknown = JSON.parse(raw)
    const receivedAt = (parsed as { received_at?: unknown } | null)?.received_at
    kept = { ...parseOpsTickReport(parsed), received_at: typeof receivedAt === 'string' ? receivedAt : '' }
  } catch (err) {
    kept = { ...unreadableReport(formatErr(err), new Date(nowMs).toISOString()), received_at: new Date(nowMs).toISOString() }
  }
  const receivedMs = Date.parse(kept.received_at)
  // An unreadable time is judged as fresh, the side that pages, never read as an
  // old report and left quiet (L50). Only a readable, old one is the heartbeat's.
  if (Number.isFinite(receivedMs) && nowMs - receivedMs > OPS_TICK_REPORT_FRESH_MS) return 'stale'
  if (kept.outcome === 'ok') {
    await deps.notifyRecovery(kv, OPS_TICK_JOB, nowMs)
    return 'healthy'
  }
  const remedy = kept.outcome === 'not_configured'
    ? { title: 'The ops minute cron is not configured', fixHint: NOT_CONFIGURED_FIX }
    : { title: 'The ops minute cron reported a problem', fixHint: PROBLEMS_FIX }
  await deps.notifyFailure(supabase, OPS_TICK_JOB, kept.problems, kv, remedy, nowMs)
  return 'alerted'
}
