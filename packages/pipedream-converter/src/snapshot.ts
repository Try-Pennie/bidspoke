/**
 * Hard Rule 7: a draft is built only from the newest export snapshot recorded
 * for its workflow (#1695, plan 9.1).
 *
 * The record is the workflow's row in porting.pipedream_inventory, which
 * scripts/porting/load-inventory.ts writes and which refuses to load an export
 * older than what it holds. The row keeps the hash of the workflow file in the
 * newest loaded export of its project (`definition_sha256`), that export's time
 * (`last_seen_export_at`), and, when a still newer export no longer lists the
 * workflow, that export's time (`absent_since_export_at`). So the newest recorded
 * export of the project is the later of the two times, and the snapshot it
 * recorded for the workflow is `definition_sha256`.
 *
 * The export handed to the converter is accepted only when it IS that snapshot:
 * the same export time and the same file hash. Every other case is refused by
 * name, with what was recorded:
 * - no row: the export was never loaded;
 * - older: a newer export is recorded;
 * - newer: this export was not loaded yet, so the inventory does not record the
 *   snapshot a draft would be built from, which the draft's later record (0.2)
 *   and the cutover gate (11) both compare against;
 * - same time, another hash: the folder is not the export that was loaded;
 * - absent: the newest recorded export of the project no longer lists it.
 */
import type { ExportedWorkflow, StoredRow } from '@bidspoke/porting-evidence/inventory'
import type { Refusal } from './draft.ts'

/** An instant from stored or exported text; refuses rather than letting NaN compare false (L50). */
function time(iso: string, what: string): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) throw new Error(`${what} is ${JSON.stringify(iso)}, which is not a time`)
  return t
}

const refuse = (reason: Refusal['reason'], message: string): Refusal => ({ ok: false, reason, message })

/** Null when the export's file is the newest recorded snapshot of the workflow, else why not. */
export function snapshotRefusal(w: ExportedWorkflow, exportedAt: string, stored: StoredRow | null): Refusal | null {
  const id = w.hashid
  if (stored === null) {
    return refuse('snapshot_not_recorded', `${id} has no row in porting.pipedream_inventory, so no snapshot of it is recorded; load this export with scripts/porting/load-inventory.ts first`)
  }
  if (stored.pipedream_hashid !== id) {
    throw new Error(`the inventory row given is for ${stored.pipedream_hashid}, not ${id}, so it cannot vouch for this snapshot`)
  }

  const given = time(exportedAt, `the export time of ${w.projectHashid}`)
  const lastSeen = time(stored.last_seen_export_at, `the stored last_seen_export_at of ${id}`)
  const absent = stored.absent_since_export_at === null ? null : time(stored.absent_since_export_at, `the stored absent_since_export_at of ${id}`)
  const newest = absent ?? lastSeen
  const newestAt = stored.absent_since_export_at ?? stored.last_seen_export_at

  if (given > newest) {
    return refuse('snapshot_newer_than_recorded', `${id}: this export (${exportedAt}) is newer than the newest recorded for it (${newestAt}); load it with scripts/porting/load-inventory.ts first, so the inventory records the snapshot the draft is built from`)
  }
  if (absent !== null) {
    return refuse('absent_from_newest_export', `${id}: the newest recorded export of project ${stored.project_hashid} (${newestAt}) no longer lists it, so there is no current snapshot to draft from; this export is from ${exportedAt}`)
  }
  if (given < newest) {
    return refuse('snapshot_older_than_recorded', `${id}: this export (${exportedAt}) is older than the newest recorded for it (${newestAt}, file sha256 ${stored.definition_sha256 ?? 'none'}); convert from that export`)
  }
  if (w.sha256 !== stored.definition_sha256) {
    return refuse('snapshot_differs_from_recorded', `${id}: this file's sha256 ${w.sha256 ?? 'none'} is not the one recorded for the export of ${newestAt} (${stored.definition_sha256 ?? 'none'}), so this folder is not the export that was loaded`)
  }
  return null
}
