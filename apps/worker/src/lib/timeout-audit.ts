/**
 * Timeout floor audit.
 *
 * Scans active workflows' live definitions for nodes whose configured
 * `timeout_ms` is below the node-type reliability floor (see ./timeout-floor).
 * Such a node looks fine until a cold run, when dispatch alone exceeds the
 * timeout and the step fails on every retry. The config panel and the canvas
 * badge both flag this, but only when someone opens the node, so a sub-floor
 * value set before the save-time guard existed can sit in production unnoticed
 * until it fails (which is exactly how Engine Bidding's parsed_name was found).
 *
 * Two consumers share the pure scans:
 *   - GET /api/config-warnings, for the dashboard panel (live, per org).
 *   - runTimeoutAuditCheck, a daily cron that posts a Slack alert, deduped via
 *     KV so it only fires when the set of offending nodes changes. The alert
 *     covers sub-floor nodes and, judged over five days (#2934,
 *     timeout-findings.ts), steps losing runs to their timeout, likely upstream
 *     outages and thin headroom. Over-provisioned stays dashboard-only, and the
 *     dashboard keeps the fresher adaptive reading below.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { orgIdsToTell, slackOrgIds } from './alert-fanout'
import { logReadFailure } from './scheduled-read'
import { readOrgWorkflows, type OrgWorkflow } from './org-workflows'
import type { WorkflowDefinition } from '../types'
import { suggestionFloorMs } from './timeout-floor'
import { SAMPLE_CONFIDENT, nodeRetries, suggestedTimeoutMs, underProvision } from './timeout-suggestion'
import { getSlackConnection, sendTimeoutConfigAlert } from './slack'
import {
  AUDIT_PERIOD_DAYS,
  findPeriodFindings,
  periodFindingsSignature,
  type PeriodStepStats,
  type WorkflowPeriodFindings,
} from './timeout-findings'

export interface SubFloorNode {
  node_id: string
  namespace: string
  label: string | null
  type: string
  configured_ms: number
  floor_ms: number
}

export interface WorkflowTimeoutWarnings {
  workflow_id: string
  workflow_name: string
  nodes: SubFloorNode[]
}

// Over-provisioned ("could be lower") side of the audit. Unlike the sub-floor
// check this is history-based: a timeout is only "too high" relative to how long
// the step actually takes. Low urgency (a slow call just takes longer to fail),
// so this is surfaced on the dashboard only — never in the Slack alert.
export interface OverProvisionedNode {
  node_id: string
  namespace: string
  label: string | null
  type: string
  configured_ms: number
  suggested_ms: number
  p99_ms: number
  sample_size: number
}

export interface WorkflowOverProvisioned {
  workflow_id: string
  workflow_name: string
  nodes: OverProvisionedNode[]
}

// Under-provisioned ("below suggested") side of the audit. Also history-based,
// but urgent in the other direction: a timeout below the suggested value means
// real runs will time out, either burning retries (amber) or failing outright
// (red, below p99/max). Surfaced on the dashboard from the fresh adaptive
// reading; the daily Slack alert makes the same judgement over five days
// (timeout-findings.ts, #2934).
export interface UnderProvisionedNode {
  node_id: string
  namespace: string
  label: string | null
  type: string
  configured_ms: number
  suggested_ms: number
  p99_ms: number
  max_ms: number
  sample_size: number
  /** The window (in days) this node's p99 locked at; gauges sample confidence. */
  window_days: number | null
  /** The retries severity was judged with: red is below max with none, below p99 with some. */
  retries: number
  severity: 'red' | 'amber'
}

export interface WorkflowUnderProvisioned {
  workflow_id: string
  workflow_name: string
  nodes: UnderProvisionedNode[]
}

export interface NodeDurationStats {
  p99: number | null
  max_ms: number | null
  sample_size: number
  /** Median, used by the config panel copy ("usually finishes in ..."). */
  p50?: number | null
  /** The window (in days) this namespace's stats locked at. */
  window_days?: number
}

// Flag a node only when it is configured well above what it needs and we have
// enough runs to trust that. 3x the suggested value, >= 50 completed runs.
export const OVER_PROVISION_FACTOR = 3
export const OVER_PROVISION_MIN_SAMPLE = 50

// The under-provisioned check uses the config panel's own evidence bar: the
// panel shows its callout at 10+ completed runs, so the audit flags at the same
// threshold — a node never warns in one surface and reads clean in the other.
export const UNDER_PROVISION_MIN_SAMPLE = 10

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

// The audit's KV signature self-heals after this long if it is ever evicted:
// the next run re-alerts on whatever is still offending. Config changes rarely,
// so a month is plenty.
const SIGNATURE_TTL_SECONDS = 30 * 24 * 60 * 60

/** Pure scan of one definition. Returns every node whose timeout is below its floor. */
export function findSubFloorNodes(definition: WorkflowDefinition | null | undefined): SubFloorNode[] {
  const nodes = definition?.nodes
  if (!Array.isArray(nodes)) return []
  const out: SubFloorNode[] = []
  for (const node of nodes) {
    const timeout = node.config?.timeout_ms
    if (typeof timeout !== 'number') continue
    const floor = suggestionFloorMs(node.type)
    if (timeout >= floor) continue
    out.push({
      node_id: node.id,
      namespace: node.namespace,
      label: node.label ?? null,
      type: node.type,
      configured_ms: timeout,
      floor_ms: floor,
    })
  }
  return out
}

/** Scan a set of workflow rows, keeping only those with at least one offending node. */
export function scanWorkflowDefinitions(
  rows: Array<{ id: string; name: string; definition: WorkflowDefinition | null }>
): WorkflowTimeoutWarnings[] {
  const out: WorkflowTimeoutWarnings[] = []
  for (const row of rows) {
    const nodes = findSubFloorNodes(row.definition)
    if (nodes.length === 0) continue
    out.push({ workflow_id: row.id, workflow_name: row.name, nodes })
  }
  return out
}

/**
 * Stable signature of an org's offending set, used for KV change detection. Two
 * scans with the same offenders produce the same string regardless of ordering,
 * so the alert fires only when something actually changes. The five day
 * findings contribute which step, at which setting, read which way
 * (periodFindingsSignature), never their counts, which move every day and would
 * re-send an unchanged alert.
 */
export function warningsSignature(
  warnings: WorkflowTimeoutWarnings[],
  period: WorkflowPeriodFindings[] = []
): string {
  return [
    ...warnings.flatMap((w) => w.nodes.map((n) => `${w.workflow_id}:${n.node_id}:${n.configured_ms}:${n.floor_ms}`)),
    ...(period.length > 0 ? [periodFindingsSignature(period)] : []),
  ]
    .sort()
    .join('|')
}

/**
 * The organization's active workflows through the shared read (#2142), or none
 * with the failure logged and named in the caller's failures list, so the daily
 * alert judges nothing for an org it could not read (#1303) while the dashboard
 * shows what it got.
 */
async function activeWorkflowsOrNone(
  supabase: SupabaseClient,
  orgId: string,
  what: string,
  failure: { failures?: string[]; label: string }
): Promise<OrgWorkflow[]> {
  try {
    return await readOrgWorkflows(supabase, orgId, { activeOnly: true })
  } catch (err) {
    logReadFailure('timeout-audit', what, err)
    failure.failures?.push(failure.label)
    return []
  }
}

/** Fetch active workflows (with live definitions) for an org and scan them. */
export async function getOrgTimeoutWarnings(
  supabase: SupabaseClient,
  orgId: string,
  // The daily alert passes a list and judges nothing for the org when a read
  // lands in it (#1303 review): an empty answer from a failed read is not a
  // clean bill of health. The dashboard leaves it out and shows what it got.
  opts: { failures?: string[] } = {},
): Promise<WorkflowTimeoutWarnings[]> {
  const data = await activeWorkflowsOrNone(supabase, orgId, 'step durations', { failures: opts.failures, label: 'workflows (timeout settings)' })
  return scanWorkflowDefinitions(
    data.map((w) => ({
      id: w.id,
      name: w.name,
      definition: w.definition as WorkflowDefinition | null,
    }))
  )
}

/**
 * Pure scan: nodes whose configured timeout is far above what their run history
 * suggests. `statsByNamespace` maps step_namespace -> duration stats for this
 * workflow. Nodes with thin history (< OVER_PROVISION_MIN_SAMPLE runs) are never
 * flagged — over-provisioning is only meaningful with confidence.
 */
export function findOverProvisionedNodes(
  definition: WorkflowDefinition | null | undefined,
  statsByNamespace: Map<string, NodeDurationStats>
): OverProvisionedNode[] {
  const nodes = definition?.nodes
  if (!Array.isArray(nodes)) return []
  const out: OverProvisionedNode[] = []
  for (const node of nodes) {
    const timeout = node.config?.timeout_ms
    if (typeof timeout !== 'number') continue
    const stats = statsByNamespace.get(node.namespace)
    if (!stats || stats.p99 == null || stats.max_ms == null) continue
    if (stats.sample_size < OVER_PROVISION_MIN_SAMPLE) continue
    const retries = nodeRetries(node.config)
    const suggested = suggestedTimeoutMs(node.type, stats.p99, stats.max_ms, retries)
    // Mirror the config panel's "could be lower" threshold: with retries a
    // long-tail outlier self-heals, so suggested x3 alone qualifies; without
    // retries also require clearing max x2 so we don't push a fat-tail step
    // below its observed worst case.
    const over =
      retries >= 1
        ? timeout > suggested * OVER_PROVISION_FACTOR
        : timeout > suggested * OVER_PROVISION_FACTOR && timeout > stats.max_ms * 2
    if (!over) continue
    out.push({
      node_id: node.id,
      namespace: node.namespace,
      label: node.label ?? null,
      type: node.type,
      configured_ms: timeout,
      suggested_ms: suggested,
      p99_ms: stats.p99,
      sample_size: stats.sample_size,
    })
  }
  return out
}

/**
 * Pure scan: nodes whose configured timeout is below what their run history
 * suggests. Sub-floor nodes are excluded — they're already flagged by
 * findSubFloorNodes and listing them twice would double-report. Severity
 * mirrors the config panel: red when the timeout is below the p99 with
 * retries, or below the slowest run without (so more than 1 run in 100 is
 * retried, or a run that slow fails), amber when only headroom is missing.
 */
export function findUnderProvisionedNodes(
  definition: WorkflowDefinition | null | undefined,
  statsByNamespace: Map<string, NodeDurationStats>
): UnderProvisionedNode[] {
  const nodes = definition?.nodes
  if (!Array.isArray(nodes)) return []
  const out: UnderProvisionedNode[] = []
  for (const node of nodes) {
    const timeout = node.config?.timeout_ms
    if (typeof timeout !== 'number') continue
    if (timeout < suggestionFloorMs(node.type)) continue
    const stats = statsByNamespace.get(node.namespace)
    if (!stats || stats.p99 == null || stats.max_ms == null) continue
    if (stats.sample_size < UNDER_PROVISION_MIN_SAMPLE) continue
    const retries = nodeRetries(node.config)
    const judged = underProvision(node.type, timeout, retries, stats.p99, stats.max_ms)
    if (!judged) continue
    out.push({
      node_id: node.id,
      namespace: node.namespace,
      label: node.label ?? null,
      type: node.type,
      configured_ms: timeout,
      suggested_ms: judged.suggested_ms,
      p99_ms: stats.p99,
      max_ms: stats.max_ms,
      sample_size: stats.sample_size,
      window_days: stats.window_days ?? null,
      retries,
      severity: judged.severity,
    })
  }
  return out
}

export interface OrgHistoryWarnings {
  under_provisioned: WorkflowUnderProvisioned[]
  over_provisioned: WorkflowOverProvisioned[]
}

/**
 * Adaptive per-workflow duration stats: one grouped percentile RPC per window,
 * shortest-first (2h, 1d, 7d), locking each namespace at the first window where
 * its sample clears SAMPLE_CONFIDENT so a quiet couple of hours can't stand in
 * for a real p99. Widening stops once every requested namespace is locked; an
 * RPC error (e.g. statement timeout on the wide join) stops widening and keeps
 * whatever the narrower windows returned.
 *
 * The sampling rule for the interactive surfaces: the canvas badge endpoint
 * and the dashboard panel. The config panel's per-node endpoint applies the
 * same stop threshold to its per-namespace RPC, so those surfaces see the same
 * stats for the same node. The daily Slack alert does NOT use it: it judges
 * five days (collectPeriodStats, #2934), because someone editing a step wants
 * to know how it runs now and an unprompted alert should not fire on one slow
 * patch.
 */
export async function collectWorkflowDurationStats(
  supabase: SupabaseClient,
  workflowId: string,
  namespaces: string[],
  // Told when the FIRST window cannot be read, so nothing was measured (#1303
  // review). A wider window failing keeps the narrower stats by design, which the
  // confident sample rule already discounts, so it is not a failure here.
  failures?: string[],
): Promise<{ stats: Map<string, NodeDurationStats>; windowDays: number }> {
  const HOUR = 60 * 60 * 1000
  const windows = [
    { since: new Date(Date.now() - 2 * HOUR).toISOString(), days: 2 / 24 },
    { since: new Date(Date.now() - 24 * HOUR).toISOString(), days: 1 },
    { since: new Date(Date.now() - 7 * 24 * HOUR).toISOString(), days: 7 },
  ]
  const stats = new Map<string, NodeDurationStats>()
  const locked = (ns: string) => (stats.get(ns)?.sample_size ?? 0) >= SAMPLE_CONFIDENT
  let windowDays = 0
  for (const w of windows) {
    // Re-query only the namespaces that haven't locked yet. The expensive scans
    // in this grouped query are the high-volume namespaces (they sort up to 3000
    // steps each), and those lock at the first window — so a high-volume
    // workflow's wide-window query (Main Flow: 80 namespaces, 7d ~ 11s) blew the
    // 8s gateway timeout by re-scanning them every time. Narrowing to the thin
    // namespaces keeps each widening step cheap so the confident sample is
    // actually reachable instead of silently degrading to the noisy 2h sample.
    const pending = namespaces.length > 0 ? namespaces.filter((ns) => !locked(ns)) : namespaces
    if (namespaces.length > 0 && pending.length === 0) break
    const { data, error } = await supabase.rpc('step_duration_percentiles_by_workflow', {
      p_workflow_id: workflowId,
      p_since: w.since,
      // The RPC samples per (workflow, namespace) — the most recent 3000 steps
      // of each namespace — so sparse nodes get the full window instead of the
      // rolling ~22h an execution-driven bound gave them on busy workflows.
      p_namespaces: pending,
    })
    if (error) {
      // A silently-swallowed widening timeout is what hid the noisy-sample bug:
      // both the daily Slack alert and the config panel were judging low-volume
      // nodes off a 2h sample because this query timed out and we degraded
      // without a trace. Leave one. (Detail goes in the message string, not a
      // second-arg object — CF observability doesn't index those.)
      console.warn(
        `[timeout-audit] widening query failed for workflow ${workflowId} at ${w.days}d window (${pending.length} pending namespaces, kept ${stats.size} from narrower windows): ${String((error as { message?: string })?.message ?? error)}`
      )
      if (w === windows[0]) failures?.push(`step durations for workflow ${workflowId}`)
      break
    }
    for (const r of (data ?? []) as Array<{ step_namespace: string; p50?: number | null; p99: number | null; max_ms: number | null; sample_size: number }>) {
      if (locked(r.step_namespace)) continue
      stats.set(r.step_namespace, {
        p99: r.p99,
        max_ms: r.max_ms,
        sample_size: Number(r.sample_size),
        p50: r.p50 ?? null,
        window_days: w.days,
      })
    }
    windowDays = w.days
  }
  return { stats, windowDays }
}

/**
 * History-based warnings (under- and over-provisioned) across an org's active
 * workflows, from one shared stats pass: one grouped percentile query per
 * workflow (step_duration_percentiles_by_workflow) rather than one per node.
 * Powers the dashboard panel.
 */
export async function getOrgHistoryWarnings(
  supabase: SupabaseClient,
  orgId: string,
  opts: { concurrency?: number; failures?: string[] } = {}
): Promise<OrgHistoryWarnings> {
  const data = await activeWorkflowsOrNone(supabase, orgId, 'step timeouts', { failures: opts.failures, label: 'workflows (step history)' })

  // Adaptive grouped percentile queries per workflow, run in parallel so the
  // dashboard load doesn't serialize them. Same sampling rule as the canvas
  // badge endpoint and the config panel, so the panel never flags a node those
  // surfaces call fine (or vice versa).
  const results = await mapWithConcurrency(
    data,
    opts.concurrency ?? Number.POSITIVE_INFINITY,
    async (w) => {
      const definition = w.definition as WorkflowDefinition | null
      if (!Array.isArray(definition?.nodes) || definition.nodes.length === 0) return null

      const { stats } = await collectWorkflowDurationStats(
        supabase,
        w.id,
        definition.nodes.map((n) => n.namespace),
        opts.failures,
      )

      return {
        workflow_id: w.id,
        workflow_name: w.name,
        under: findUnderProvisionedNodes(definition, stats),
        over: findOverProvisionedNodes(definition, stats),
      }
    }
  )

  const under_provisioned: WorkflowUnderProvisioned[] = []
  const over_provisioned: WorkflowOverProvisioned[] = []
  for (const r of results) {
    if (!r) continue
    if (r.under.length > 0) under_provisioned.push({ workflow_id: r.workflow_id, workflow_name: r.workflow_name, nodes: r.under })
    if (r.over.length > 0) over_provisioned.push({ workflow_id: r.workflow_id, workflow_name: r.workflow_name, nodes: r.over })
  }
  return { under_provisioned, over_provisioned }
}

/** Finished runs sampled from each hour of the period (#2934). */
export const AUDIT_SAMPLE_PER_HOUR = 10

/**
 * Steps asked about in one call. Measured on production 2026-10-29: the even
 * sample of all 22 Engine Bidding steps, the busiest per step, took 5.3 s cold,
 * so ten a call keeps each well inside the Data API's 8 s.
 */
export const AUDIT_STEPS_PER_CALL = 10

/**
 * One workflow's five day reading for the daily alert (#2934): an even sample of
 * finished runs and the runs that failed on the timeout, from
 * step_timeout_audit_by_workflow, AUDIT_STEPS_PER_CALL steps a call. Null, with
 * the failure named in `failures` and logged, when any call fails: the alert
 * does not judge an org on part of a workflow (#1303).
 */
export async function collectPeriodStats(
  supabase: SupabaseClient,
  workflowId: string,
  namespaces: string[],
  now: Date,
  failures?: string[],
): Promise<Map<string, PeriodStepStats> | null> {
  const until = now.toISOString()
  const since = new Date(now.getTime() - AUDIT_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const unique = [...new Set(namespaces)]
  const stats = new Map<string, PeriodStepStats>()
  for (let i = 0; i < unique.length; i += AUDIT_STEPS_PER_CALL) {
    const chunk = unique.slice(i, i + AUDIT_STEPS_PER_CALL)
    const { data, error } = await supabase.rpc('step_timeout_audit_by_workflow', {
      p_workflow_id: workflowId,
      p_since: since,
      p_until: until,
      p_namespaces: chunk,
      p_per_hour: AUDIT_SAMPLE_PER_HOUR,
    })
    if (error) {
      console.error(
        `[timeout-audit] five day reading failed for workflow ${workflowId} (${chunk.length} of ${unique.length} steps, from step ${i}): ${String((error as { message?: string })?.message ?? error)}`
      )
      failures?.push(`five day step timeouts for workflow ${workflowId}`)
      return null
    }
    for (const r of (data ?? []) as Array<{ step_namespace: string; p50: number | null; p99: number | null; max_ms: number | null; sample_size: number | string; timed_out: number | string; timed_out_at: string[] | null }>) {
      const sampleSize = Number(r.sample_size)
      const timedOut = Number(r.timed_out)
      // A count that does not parse would compare false against every
      // threshold and read as a step that lost nothing (L50), so it is a failed
      // read, never a quiet zero.
      if (!Number.isInteger(sampleSize) || !Number.isInteger(timedOut)) {
        console.error(`[timeout-audit] five day reading for workflow ${workflowId} step ${r.step_namespace} answered counts that are not whole numbers: sample_size ${String(r.sample_size)}, timed_out ${String(r.timed_out)}`)
        failures?.push(`five day step timeouts for workflow ${workflowId}`)
        return null
      }
      stats.set(r.step_namespace, {
        p50: r.p50 ?? null,
        p99: r.p99 ?? null,
        max_ms: r.max_ms ?? null,
        sample_size: sampleSize,
        timed_out: timedOut,
        timed_out_at: r.timed_out_at ?? [],
      })
    }
  }
  return stats
}

/**
 * The daily alert's five day findings across an org's active workflows, a few
 * workflows at a time (#1884). Workflows with nothing to list are left out.
 */
export async function getOrgPeriodFindings(
  supabase: SupabaseClient,
  orgId: string,
  opts: { concurrency: number; failures: string[]; now: Date },
): Promise<WorkflowPeriodFindings[]> {
  const data = await activeWorkflowsOrNone(supabase, orgId, 'five day step timeouts', { failures: opts.failures, label: 'workflows (five day step timeouts)' })
  const results = await mapWithConcurrency(data, opts.concurrency, async (w) => {
    const definition = w.definition as WorkflowDefinition | null
    if (!Array.isArray(definition?.nodes) || definition.nodes.length === 0) return null
    const stats = await collectPeriodStats(supabase, w.id, definition.nodes.map((n) => n.namespace), opts.now, opts.failures)
    if (!stats) return null
    const findings = findPeriodFindings(definition, stats)
    return findings.length > 0 ? { workflow_id: w.id, workflow_name: w.name, findings } : null
  })
  return results.filter((r): r is WorkflowPeriodFindings => r !== null)
}

/**
 * How many workflows the daily audit measures at once (#1884). Each one is now
 * its five day reading (collectPeriodStats, #2934), one call per ten steps, run
 * in turn. When each was a grouped percentile query over up to a week, on 2026-10-08
 * at 08:15 UTC the audit started about a dozen of them in the same instant, the
 * slowest took 23.5 s, and lead requests slowed to 8.5 s behind them. Two at a
 * time costs the audit some wall time (about 2 s per query at the mean) and
 * nobody is waiting on it.
 */
export const TIMEOUT_AUDIT_RPC_CONCURRENCY = 2

/**
 * `fn` over every item with at most `limit` calls in flight, results in input
 * order. A rejection rejects the whole map, as Promise.all does.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!(limit >= 1)) throw new Error(`mapWithConcurrency: limit must be at least 1, got ${limit}`)
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/**
 * Daily cron: scan every Slack-connected org's active workflows and alert when
 * the offending set changes. Called from the Worker scheduled handler.
 */
export async function runTimeoutAuditCheck(supabase: SupabaseClient, kv: KvLike, appUrl: string, now: Date = new Date()): Promise<void> {
  const orgIds = orgIdsToTell(await slackOrgIds(supabase, 'timeout-audit', 'measure-from-database'))
  if (orgIds.length === 0) return

  for (const orgId of orgIds) {
    const failures: string[] = []
    const [warnings, period] = await Promise.all([
      getOrgTimeoutWarnings(supabase, orgId, { failures }),
      getOrgPeriodFindings(supabase, orgId, { concurrency: TIMEOUT_AUDIT_RPC_CONCURRENCY, failures, now }),
    ])
    // A read that failed answers empty, which would read as "all clear" and be
    // recorded, and the unchanged set would then re-alert as new once the reads
    // came back (#1303 review). So an org with any failed read is not judged.
    if (failures.length > 0) {
      console.error(`[timeout-audit] org ${orgId} not judged this run, because these reads failed: ${failures.join(', ')}`)
      continue
    }
    const signature = warningsSignature(warnings, period)
    const key = `timeout-audit:sig:${orgId}`
    const previous = await kv.get(key)

    // Unchanged since the last run: nothing new to surface, stay quiet.
    if (signature === (previous ?? '')) continue

    // Transition to "all clear" (nothing to act on): record the new state so we
    // don't re-evaluate it, and stay quiet — resolution is self-evident in the UI.
    if (warnings.length === 0 && period.length === 0) {
      await kv.put(key, signature, { expirationTtl: SIGNATURE_TTL_SECONDS })
      continue
    }

    // Don't record the signature unless the alert is actually delivered.
    // Recording it before sending meant a disabled-then-reenabled org, or a
    // transient Slack failure, deduped this state forever (until the set changed
    // or the 30-day TTL lapsed). Re-checking a non-alerting org is cheap+silent.
    const connection = await getSlackConnection(supabase, orgId)
    if (!connection || !connection.config_alerts_enabled) continue

    try {
      await sendTimeoutConfigAlert(connection, warnings, period, appUrl)
      // Record only after a confirmed send.
      await kv.put(key, signature, { expirationTtl: SIGNATURE_TTL_SECONDS })
    } catch (e) {
      // Transient failure: leave the signature unrecorded so it retries next
      // run, and don't abort the remaining orgs.
      console.error(`[timeout-audit] alert failed for org ${orgId}:`, e)
    }
  }
}
