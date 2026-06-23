/**
 * Shared-upstream outage aggregation (#331).
 *
 * When a dependency shared by many leads degrades (Salesforce slows past its
 * concurrency governor, a partner proxy 5xxes, outbound calls time out), the
 * engine fires one "Workflow Execution Failed" Slack alert PER affected lead.
 * During the 2026-06-23 Salesforce degradation that flooded the channel with
 * dozens of near-identical pages and buried the signal. The team wants ONE
 * actionable page per cause, not a per-lead flood.
 *
 * Two halves, both keyed off the same built-in cause signatures so they can't
 * drift:
 *   1. Suppression — the engine alert gate skips the per-run page when the
 *      error matches a built-in outage signature (classifyOutageCause). The run
 *      still records as `failed`; only the page is muted. Safe because these
 *      signatures are transient-upstream (SF 5xx / governor, partner proxy 5xx,
 *      timeout/abort) and cannot be confused with per-lead business errors
 *      (validation, duplicate, "reason: eq/in" code rejections), which still
 *      page per run.
 *   2. Aggregation — this minute cron counts matching failures across all
 *      active workflows in each Slack org, grouped by cause, and fires ONE
 *      @here alert per (org, cause) when the count crosses the threshold, with
 *      a per-(org, cause) KV cooldown so a sustained outage pages once.
 *
 * Mirrors the failure-rate.ts / volume-cliff.ts pattern (cron + windowed
 * workflow_executions query + KV cooldown + pure detector). The difference from
 * #248's failure-rate is that those signals are per-workflow opt-in config; a
 * shared-upstream outage hits many workflows at once, so these causes are
 * built-in and org-wide with no configuration.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendUpstreamOutageAlert } from './slack'
import { fetchAllPaged } from './paginate'

export interface OutageCause {
  /** Stable id used in the cooldown key and alert payload. */
  key: string
  /** Human label shown in the aggregated alert. */
  label: string
  /** Case-insensitive substrings; the error matches this cause if ANY appears. */
  matchers: string[]
}

/**
 * Built-in shared-upstream outage signatures, derived from the real
 * `workflow_executions.error_message` strings these failures produce. Ordered
 * so a more specific, named upstream (Salesforce, Tripoint) wins over the
 * generic timeout bucket when a message could match both.
 *
 * Deliberately excludes per-lead business/code errors ("reason: eq/in" code
 * rejections, VALIDATION/DUPLICATE_VALUE, "expected rejection") — those are
 * lead-specific outcomes, not a degraded shared dependency, and must keep
 * paging per run.
 */
export const UPSTREAM_OUTAGE_CAUSES: OutageCause[] = [
  {
    key: 'salesforce',
    label: 'Salesforce',
    // SF 5xx edge timeouts (520/502/503) and the concurrency governor, which
    // surfaces as a 403 REQUEST_LIMIT_EXCEEDED / ConcurrentPerOrgLongTxn.
    matchers: [
      'salesforce api error (5',
      'concurrentperorglongtxn',
      'request_limit_exceeded',
    ],
  },
  {
    key: 'tripoint',
    label: 'Tripoint',
    matchers: ['tripoint proxy 5'],
  },
  {
    key: 'timeout',
    label: 'Upstream timeout',
    matchers: [
      'the operation was aborted',
      'canceled via abort signal',
      'did not complete in time',
      'parallel node timed out',
    ],
  },
]

/** The first cause whose any matcher appears (case-insensitively) in the error,
 *  or null when the error is not a recognized shared-upstream outage. */
export function classifyOutageCause(
  errorMessage: string | null | undefined,
  causes: OutageCause[] = UPSTREAM_OUTAGE_CAUSES,
): OutageCause | null {
  if (!errorMessage) return null
  const lower = errorMessage.toLowerCase()
  for (const cause of causes) {
    if (cause.matchers.some((m) => lower.includes(m))) return cause
  }
  return null
}

/** Whether a windowed count should fire the aggregated alert. */
export function detectOutageSpike(count: number, threshold: number): boolean {
  if (threshold <= 0) return false
  return count >= threshold
}

// A spike is ~10 failures sharing a cause within a single minute (Dan, 2026-06-23).
// The check runs on the minute cron, so the window is the trailing 60 seconds.
export const DEFAULT_OUTAGE_THRESHOLD = 10
export const DEFAULT_OUTAGE_WINDOW_MINUTES = 1
export const DEFAULT_COOLDOWN_MINUTES = 30
// Cap the started_at floor so the scan stays partition-pruned.
export const LOOKBACK_MINUTES = 60

interface FailedRow {
  workflow_id: string
  error_message: string | null
  completed_at: string | null
}

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export interface OutageGroup {
  cause: OutageCause
  count: number
  workflowNames: string[]
}

/**
 * Aggregate failed rows (already scoped to one org's workflows) by outage cause,
 * counting only rows that completed on/after windowStartMs. Pure — the windowed
 * core of the aggregated check. Returns groups with count > 0, busiest first.
 */
export function groupOutages(
  rows: FailedRow[],
  workflowNameById: Map<string, string>,
  windowStartMs: number,
  causes: OutageCause[] = UPSTREAM_OUTAGE_CAUSES,
): OutageGroup[] {
  const byCause = new Map<string, { cause: OutageCause; count: number; workflows: Set<string> }>()
  for (const r of rows) {
    if (!r.completed_at || new Date(r.completed_at).getTime() < windowStartMs) continue
    const cause = classifyOutageCause(r.error_message, causes)
    if (!cause) continue
    let g = byCause.get(cause.key)
    if (!g) {
      g = { cause, count: 0, workflows: new Set() }
      byCause.set(cause.key, g)
    }
    g.count++
    const name = workflowNameById.get(r.workflow_id)
    if (name) g.workflows.add(name)
  }
  return [...byCause.values()]
    .map((g) => ({ cause: g.cause, count: g.count, workflowNames: [...g.workflows] }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Aggregated upstream-outage check (#331). Every minute: for each org with Slack
 * connected, count matching failed runs across its active workflows in the
 * trailing window, group by cause, and fire ONE @here alert per cause whose
 * count crosses the threshold. Cooldown per (org, cause) so a sustained outage
 * pages once.
 */
export async function runUpstreamOutageCheck(
  supabase: SupabaseClient,
  kv: KvLike,
  appUrl: string,
): Promise<void> {
  const { data: slackOrgs } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const slackOrgIds = (slackOrgs ?? []).map((c) => c.organization_id as string)
  if (slackOrgIds.length === 0) return

  const { data: workflows } = await supabase
    .from('workflows')
    .select('id, name, organization_id')
    .in('organization_id', slackOrgIds)
    .eq('is_active', true)
    .is('deleted_at', null)
  if (!workflows?.length) return

  const now = Date.now()
  const workflowIds = workflows.map((w) => w.id as string)
  const nameById = new Map(workflows.map((w) => [w.id as string, w.name as string]))
  const orgByWorkflow = new Map(workflows.map((w) => [w.id as string, w.organization_id as string]))

  const windowStartMs = now - DEFAULT_OUTAGE_WINDOW_MINUTES * 60 * 1000
  const lookbackStart = new Date(now - LOOKBACK_MINUTES * 60 * 1000).toISOString()
  const windowStart = new Date(windowStartMs).toISOString()

  const failed = await fetchAllPaged<FailedRow>(
    (from, to) => supabase
      .from('workflow_executions')
      .select('workflow_id, error_message, completed_at')
      .in('workflow_id', workflowIds)
      .gte('started_at', lookbackStart)
      .gte('completed_at', windowStart)
      .eq('is_test', false)
      .eq('status', 'failed')
      .not('error_message', 'is', null)
      .order('completed_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
    'upstream-outage failed query',
  )

  // Partition the failures by org, then group each org's failures by cause.
  const rowsByOrg = new Map<string, FailedRow[]>()
  for (const r of failed) {
    const org = orgByWorkflow.get(r.workflow_id)
    if (!org) continue
    const list = rowsByOrg.get(org) ?? []
    list.push(r)
    rowsByOrg.set(org, list)
  }

  for (const [orgId, rows] of rowsByOrg) {
    const groups = groupOutages(rows, nameById, windowStartMs)
    for (const group of groups) {
      if (!detectOutageSpike(group.count, DEFAULT_OUTAGE_THRESHOLD)) continue

      const cooldownKey = `upstream-outage-cooldown:${orgId}:${group.cause.key}`
      if (await kv.get(cooldownKey)) continue

      console.log(`[upstream-outage] org=${orgId} cause=${group.cause.key} count=${group.count}/${DEFAULT_OUTAGE_THRESHOLD} window=${DEFAULT_OUTAGE_WINDOW_MINUTES}m workflows=${group.workflowNames.length}`)

      const sent = await sendUpstreamOutageAlert(
        supabase,
        orgId,
        {
          cause_key: group.cause.key,
          cause_label: group.cause.label,
          failure_count: group.count,
          window_minutes: DEFAULT_OUTAGE_WINDOW_MINUTES,
          workflow_names: group.workflowNames,
          timestamp: new Date(now).toISOString(),
        },
        appUrl,
      )

      if (sent) {
        await kv.put(cooldownKey, '1', { expirationTtl: DEFAULT_COOLDOWN_MINUTES * 60 })
      }
    }
  }
}
