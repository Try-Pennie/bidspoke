/**
 * What loading an export writes to porting.pipedream_inventory (#1710, plan 0.2).
 *
 * Pure: given the stored rows and an export read by readExport, returns the full
 * rows to upsert and what changed. scripts/porting/load-inventory.ts reads the
 * stored rows, calls this, and writes the rows.
 *
 * The rules:
 * - every row carries the same columns (INVENTORY_COLUMNS), so a bulk upsert
 *   never writes NULL into a column one row omitted (L705), and porting_stage is
 *   never among them: it belongs to Bidspoke, and a new row takes its default;
 * - first_seen_export_at is kept once set; last_seen_export_at is the export of
 *   the workflow's project that listed it;
 * - a stored workflow is absent when its project is in this export and no project
 *   in the export lists it; it is kept, stamped with that project's export time,
 *   never deleted (it may carry a porting_stage). Projects the export does not
 *   hold are not judged at all, since Pipedream exports one project at a time;
 * - an export older than what is stored for any of its workflows is refused, so
 *   loading an old folder cannot turn states back;
 * - a stored row of another organization is refused rather than overwritten.
 */
import type { ExportedProject, ExportedWorkflow } from './read-export.ts'

export type PipedreamState = 'on' | 'off' | 'never_deployed'

/** One inventory row as the loader writes it: every column except porting_stage and updated_at. */
export interface InventoryRow {
  organization_id: string
  pipedream_hashid: string
  project_hashid: string
  name: string
  pipedream_state: PipedreamState
  definition_sha256: string | null
  trigger_types: string[]
  step_count: number
  deployment_count: number
  first_seen_export_at: string
  last_seen_export_at: string
  absent_since_export_at: string | null
}

/** A stored row as the loader reads it back: the same columns. */
export type StoredRow = InventoryRow

export const INVENTORY_COLUMNS = [
  'organization_id', 'pipedream_hashid', 'project_hashid', 'name', 'pipedream_state', 'definition_sha256',
  'trigger_types', 'step_count', 'deployment_count', 'first_seen_export_at', 'last_seen_export_at', 'absent_since_export_at',
] as const satisfies ReadonlyArray<keyof InventoryRow>

export interface LoadPlan {
  /** Every row to upsert, sorted by hashid. Unchanged absent rows are not rewritten. */
  rows: InventoryRow[]
  inserted: string[]
  newlyAbsent: string[]
  reappeared: string[]
  stateChanged: Array<{ hashid: string; from: PipedreamState; to: PipedreamState }>
}

const byHashid = (a: { pipedream_hashid: string }, b: { pipedream_hashid: string }) => (a.pipedream_hashid < b.pipedream_hashid ? -1 : a.pipedream_hashid > b.pipedream_hashid ? 1 : 0)
const time = (iso: string) => Date.parse(iso)

export function stateOf(w: ExportedWorkflow): PipedreamState {
  if (w.status === 'skipped_never_deployed') return 'never_deployed'
  return w.workflow?.inactive === true ? 'off' : 'on'
}

function exportFields(w: ExportedWorkflow) {
  const wf = w.workflow
  const triggers = (wf?.triggers ?? []) as Array<{ type?: unknown; disabled?: unknown }>
  const types = [...new Set(triggers.filter((t) => t.disabled !== true && typeof t.type === 'string').map((t) => t.type as string))].sort()
  const deployments = Object.values(wf?.deployments ?? {})
  return {
    trigger_types: types,
    step_count: (wf?.steps?.length ?? 0) + deployments.reduce((n, d) => n + (d.steps?.length ?? 0), 0),
    deployment_count: deployments.length,
  }
}

export function planLoad(stored: StoredRow[], projects: ExportedProject[], organizationId: string): LoadPlan {
  const storedBy = new Map(stored.map((r) => [r.pipedream_hashid, r]))
  const listed = new Map<string, { w: ExportedWorkflow; exportedAt: string }>()
  for (const p of projects) for (const w of p.workflows) listed.set(w.hashid, { w, exportedAt: p.exportedAt })

  for (const p of projects) {
    for (const r of stored) {
      const inProject = r.project_hashid === p.projectHashid || listed.get(r.pipedream_hashid)?.w.projectHashid === p.projectHashid
      if (inProject && time(r.last_seen_export_at) > time(p.exportedAt)) {
        throw new Error(`the export of ${p.projectHashid} (${p.exportedAt}) is older than what is stored for ${r.pipedream_hashid} (${r.last_seen_export_at}); load the newer export`)
      }
    }
  }

  const plan: LoadPlan = { rows: [], inserted: [], newlyAbsent: [], reappeared: [], stateChanged: [] }

  for (const [hashid, { w, exportedAt }] of listed) {
    const prior = storedBy.get(hashid)
    if (prior && prior.organization_id !== organizationId) {
      throw new Error(`${hashid} is stored for organization ${prior.organization_id}, not ${organizationId}; refusing to write over it`)
    }
    const state = stateOf(w)
    if (!prior) plan.inserted.push(hashid)
    else {
      if (prior.pipedream_state !== state) plan.stateChanged.push({ hashid, from: prior.pipedream_state, to: state })
      if (prior.absent_since_export_at !== null) plan.reappeared.push(hashid)
    }
    plan.rows.push({
      organization_id: organizationId,
      pipedream_hashid: hashid,
      project_hashid: w.projectHashid,
      name: w.name,
      pipedream_state: state,
      definition_sha256: w.sha256,
      ...exportFields(w),
      first_seen_export_at: prior?.first_seen_export_at ?? exportedAt,
      last_seen_export_at: exportedAt,
      absent_since_export_at: null,
    })
  }

  const exportedAtOf = new Map(projects.map((p) => [p.projectHashid, p.exportedAt]))
  for (const r of stored) {
    if (listed.has(r.pipedream_hashid)) continue
    const exportedAt = exportedAtOf.get(r.project_hashid)
    if (exportedAt === undefined || r.absent_since_export_at !== null) continue
    if (r.organization_id !== organizationId) {
      throw new Error(`${r.pipedream_hashid} is stored for organization ${r.organization_id}, not ${organizationId}; refusing to mark it absent`)
    }
    plan.newlyAbsent.push(r.pipedream_hashid)
    const row = {} as Record<string, unknown>
    for (const c of INVENTORY_COLUMNS) row[c] = r[c]
    row.absent_since_export_at = exportedAt
    plan.rows.push(row as unknown as InventoryRow)
  }

  plan.rows.sort(byHashid)
  for (const list of [plan.inserted, plan.newlyAbsent, plan.reappeared]) list.sort()
  plan.stateChanged.sort((a, b) => (a.hashid < b.hashid ? -1 : 1))
  return plan
}
