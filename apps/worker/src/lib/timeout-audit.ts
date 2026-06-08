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
 * Daily cron: scan every Slack-connected org's active workflows and alert when
 * the offending set changes. Called from the Worker scheduled handler.
 */
export async function runTimeoutAuditCheck(supabase: SupabaseClient, kv: KvLike): Promise<void> {
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
    await sendTimeoutConfigAlert(connection, warnings)
  }
}
