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
 * Two consumers share the pure scan:
 *   - GET /api/config-warnings, for the dashboard panel (live, per org).
 *   - runTimeoutAuditCheck, a daily cron that posts a Slack alert, deduped via
 *     KV so it only fires when the set of offending nodes changes.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorkflowDefinition } from '../types'
import { suggestionFloorMs } from './timeout-floor'
import { getSlackConnection, sendTimeoutConfigAlert } from './slack'

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

export interface NodeDurationStats {
  p99: number | null
  max_ms: number | null
  sample_size: number
}

// Flag a node only when it is configured well above what it needs and we have
// enough runs to trust that. 3x the suggested value, >= 50 completed runs.
export const OVER_PROVISION_FACTOR = 3
export const OVER_PROVISION_MIN_SAMPLE = 50

// Mirror the config panel's suggested timeout so the dashboard agrees with what a
// user sees when they open the node: p99 x1.5 (most calls succeed first try), with
// max x1.05 headroom unless p99 == max, never below the node-type floor.
export function suggestedTimeoutMs(type: string, p99: number, maxMs: number): number {
  const floor = suggestionFloorMs(type)
  const base = p99 === maxMs ? p99 * 1.5 : Math.max(p99 * 1.5, maxMs * 1.05)
  return Math.ceil(Math.max(base, floor))
}

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
 * scans with the same offenders (same workflow, node, value, floor) produce the
 * same string regardless of ordering, so the alert fires only when something
 * actually changes.
 */
export function warningsSignature(warnings: WorkflowTimeoutWarnings[]): string {
  return warnings
    .flatMap((w) => w.nodes.map((n) => `${w.workflow_id}:${n.node_id}:${n.configured_ms}:${n.floor_ms}`))
    .sort()
    .join('|')
}

/** Fetch active workflows (with live definitions) for an org and scan them. */
export async function getOrgTimeoutWarnings(
  supabase: SupabaseClient,
  orgId: string
): Promise<WorkflowTimeoutWarnings[]> {
  const { data } = await supabase
    .from('workflows')
    .select('id, name, definition')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .is('deleted_at', null)
  return scanWorkflowDefinitions(
    (data ?? []).map((w) => ({
      id: w.id as string,
      name: w.name as string,
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
    const suggested = suggestedTimeoutMs(node.type, stats.p99, stats.max_ms)
    if (timeout <= suggested * OVER_PROVISION_FACTOR) continue
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
 * Over-provisioned nodes across an org's active workflows. One grouped
 * percentile query per workflow (step_duration_percentiles_by_workflow) rather
 * than one per node. Dashboard only — not wired into the Slack cron.
 */
export async function getOrgOverProvisionedWarnings(
  supabase: SupabaseClient,
  orgId: string
): Promise<WorkflowOverProvisioned[]> {
  const { data } = await supabase
    .from('workflows')
    .select('id, name, definition')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .is('deleted_at', null)

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // One grouped percentile query per workflow, run in parallel so the dashboard
  // load doesn't serialize them.
  const results = await Promise.all(
    (data ?? []).map(async (w): Promise<WorkflowOverProvisioned | null> => {
      const definition = w.definition as WorkflowDefinition | null
      if (!Array.isArray(definition?.nodes) || definition.nodes.length === 0) return null

      const { data: rows } = await supabase.rpc('step_duration_percentiles_by_workflow', {
        p_workflow_id: w.id as string,
        p_since: since,
      })

      const stats = new Map<string, NodeDurationStats>()
      for (const r of (rows ?? []) as Array<{ step_namespace: string; p99: number | null; max_ms: number | null; sample_size: number }>) {
        stats.set(r.step_namespace, { p99: r.p99, max_ms: r.max_ms, sample_size: Number(r.sample_size) })
      }

      const nodes = findOverProvisionedNodes(definition, stats)
      return nodes.length > 0 ? { workflow_id: w.id as string, workflow_name: w.name as string, nodes } : null
    })
  )

  return results.filter((r): r is WorkflowOverProvisioned => r !== null)
}

/**
 * Daily cron: scan every Slack-connected org's active workflows and alert when
 * the offending set changes. Called from the Worker scheduled handler.
 */
export async function runTimeoutAuditCheck(supabase: SupabaseClient, kv: KvLike, appUrl: string): Promise<void> {
  const { data: slackOrgs } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')

  const orgIds = [...new Set((slackOrgs ?? []).map((c) => c.organization_id as string))]
  if (orgIds.length === 0) return

  for (const orgId of orgIds) {
    const warnings = await getOrgTimeoutWarnings(supabase, orgId)
    const signature = warningsSignature(warnings)
    const key = `timeout-audit:sig:${orgId}`
    const previous = await kv.get(key)

    // Unchanged since the last run: nothing new to surface, stay quiet.
    if (signature === (previous ?? '')) continue

    // Record the new state regardless, so a one-time alert does not repeat daily.
    await kv.put(key, signature, { expirationTtl: SIGNATURE_TTL_SECONDS })

    // Only alert when there is something to act on. A transition to "all clear"
    // updates KV above but does not post (resolution is self-evident in the UI).
    if (warnings.length === 0) continue

    const connection = await getSlackConnection(supabase, orgId)
    if (!connection || !connection.config_alerts_enabled) continue
    await sendTimeoutConfigAlert(connection, warnings, appUrl)
  }
}
