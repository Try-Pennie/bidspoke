/**
 * The partners page History (#2141, PR10 of #2114): who made each change to a
 * partner, merged from audit_log and bid_config_history.
 *
 * Editor names, in this order (L37, Dan's decision on #2141):
 *  1. the users row for changed_by: its display name, else its email.
 *     audit_log.changed_by and bid_config_history.changed_by both reference
 *     users(id) with NO ACTION, and users.email is NOT NULL, so a row with an
 *     editor always resolves; a changed_by the users read does not return is
 *     an error, never a label (A5).
 *  2. for a row with no changed_by, the _actor name a SECURITY DEFINER function
 *     stamped (its email when it carried no name).
 *  3. a job credited by bidspoke.actor_job (_source job, _job <name>), and a
 *     matrix sync row with no person, which is the hourly Salesforce sync.
 *  4. otherwise "Changed directly in the database": no actor at all.
 *
 * Grouping by Eastern day is the page's (etDayKey and etDayHeading in
 * apps/web/src/lib/dates.ts): this module hands it entries newest first with
 * ISO instants.
 *
 * One package, because the Worker builds the answer and the web app reads it:
 * the response type and the labels live once, for both (L370).
 */

export type HistoryEditor =
  | { kind: 'person'; userId: string | null; name: string; via: 'sync_now' | null }
  | { kind: 'job'; job: string }
  | { kind: 'direct' }

export type HistoryEntityType = 'partner_config' | 'buyer_profile' | 'partner_bid_config' | 'partner_uuid' | 'held_click' | 'bid_matrix'

export interface HistoryEntry {
  /** Unique across both sources: `audit:<id>` or `matrix:<id>`. */
  key: string
  source: 'audit_log' | 'bid_config_history'
  /** The instant of the change, as the database recorded it. */
  at: string
  entityType: HistoryEntityType
  entityId: string
  /** created, updated or deleted; `synced` for a matrix sync. */
  action: string
  editor: HistoryEditor
  editorLabel: string
  /** The audit row's changes, or the sync's diff, as stored. */
  changes: unknown
  /** For a matrix sync, and for a matrix config's audit row: the config. */
  matrix: { configId: string; configName: string | null; source: string | null } | null
}

export interface PartnerHistory {
  partnerId: string
  entries: HistoryEntry[]
  /** False when a source held more rows than one read returns (see completeSince). */
  complete: boolean
  /** When not complete: every change after this instant is listed, and none at or before it. */
  completeSince: string | null
}

/** The audit entity types History reads. */
export const HISTORY_AUDIT_ENTITY_TYPES = ['partner_config', 'buyer_profile', 'partner_bid_config', 'partner_uuid', 'held_click'] as const

/** The hourly Salesforce matrix sync, which writes bid_config_history with no person. */
export const MATRIX_SYNC_JOB = 'salesforce_matrix_sync'

/**
 * Jobs that write partner settings, by the name they set in bidspoke.actor_job
 * or are credited under. The matrix sync is the only one today. partner_daily_counts
 * is not here: it holds counts the cap Durable Object writes, not settings, and
 * no audit trigger records it.
 */
export const HISTORY_JOB_LABELS: Record<string, string> = {
  [MATRIX_SYNC_JOB]: 'Bidspoke, hourly Salesforce matrix sync',
}

export const DIRECT_EDIT_LABEL = 'Changed directly in the database'

/**
 * The most rows one source is read to: five PostgREST pages of 1,000. The
 * busiest partner held 56 rows in production on 2026-10-15; a source past this
 * bound makes the answer incomplete by name (completeSince), never silently
 * shorter.
 */
export const HISTORY_ROWS_PER_SOURCE = 5000
const PAGE = 1000

export interface UserName {
  id: string
  display_name: string | null
  email: string
}

export class UnresolvedEditorError extends Error {
  constructor(public readonly userId: string) {
    super(`no users row for editor ${userId}`)
    this.name = 'UnresolvedEditorError'
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

function person(userId: string, users: ReadonlyMap<string, UserName>, via: 'sync_now' | null): HistoryEditor {
  const u = users.get(userId)
  if (!u) throw new UnresolvedEditorError(userId)
  return { kind: 'person', userId, name: nonEmpty(u.display_name) ?? u.email, via }
}

export function auditEditor(row: { changed_by: string | null; changes: unknown }, users: ReadonlyMap<string, UserName>): HistoryEditor {
  if (row.changed_by) return person(row.changed_by, users, null)
  const changes = isRecord(row.changes) ? row.changes : {}
  const actor = isRecord(changes._actor) ? changes._actor : null
  const stamped = actor ? nonEmpty(actor.name) ?? nonEmpty(actor.email) : null
  if (stamped) return { kind: 'person', userId: null, name: stamped, via: null }
  const job = changes._source === 'job' ? nonEmpty(changes._job) : null
  if (job) return { kind: 'job', job }
  return { kind: 'direct' }
}

export function matrixEditor(row: { changed_by: string | null; source: string }, users: ReadonlyMap<string, UserName>): HistoryEditor {
  if (row.changed_by) return person(row.changed_by, users, row.source === 'salesforce_sync' ? 'sync_now' : null)
  if (row.source === 'salesforce_sync') return { kind: 'job', job: MATRIX_SYNC_JOB }
  return { kind: 'direct' }
}

export function editorLabel(editor: HistoryEditor): string {
  switch (editor.kind) {
    case 'person':
      return editor.via === 'sync_now' ? `${editor.name}, Sync now from Salesforce` : editor.name
    case 'job':
      return HISTORY_JOB_LABELS[editor.job] ?? `Bidspoke job ${editor.job}`
    case 'direct':
      return DIRECT_EDIT_LABEL
  }
}

/**
 * Reads a source newest first, a page at a time, up to HISTORY_ROWS_PER_SOURCE.
 * `makeQuery` must order by a unique key last. A failed page throws: the
 * caller answers an error, never the rows it had.
 */
export async function readNewest<T>(
  makeQuery: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  for (let from = 0; from < HISTORY_ROWS_PER_SOURCE; from += PAGE) {
    const { data, error } = await makeQuery(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE) return { rows, truncated: false }
  }
  // Every page came back full: ask for the one row past the bound, so a source
  // holding exactly HISTORY_ROWS_PER_SOURCE rows is not reported as cut.
  const { data, error } = await makeQuery(HISTORY_ROWS_PER_SOURCE, HISTORY_ROWS_PER_SOURCE)
  if (error) throw new Error(error.message)
  return { rows, truncated: (data ?? []).length > 0 }
}

/**
 * Newest first, ties by key. When a source was cut at the bound, every entry at
 * or before the newest instant such a source no longer fully covers is
 * dropped, so the list never shows one source's older rows across another's gap.
 */
export function mergeHistory(sources: Array<{ entries: HistoryEntry[]; truncated: boolean }>): Omit<PartnerHistory, 'partnerId'> {
  let cutoff: number | null = null
  for (const s of sources) {
    if (!s.truncated || s.entries.length === 0) continue
    const oldest = Math.min(...s.entries.map((e) => Date.parse(e.at)))
    cutoff = cutoff === null ? oldest : Math.max(cutoff, oldest)
  }
  const all = sources.flatMap((s) => s.entries)
  const bound = cutoff
  const kept = bound === null ? all : all.filter((e) => Date.parse(e.at) > bound)
  kept.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return {
    entries: kept,
    complete: cutoff === null,
    completeSince: cutoff === null ? null : new Date(cutoff).toISOString(),
  }
}
