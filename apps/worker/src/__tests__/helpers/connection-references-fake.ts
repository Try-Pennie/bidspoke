/**
 * connection_references (migration 20261020220000) as the in memory PostgREST
 * answers it (#2946), for a test of code that asks which workflows use a
 * connection.
 *
 * The predicate itself, definition_connection_ids, is NOT re-implemented here,
 * since a TypeScript copy of it is the very thing #2946 removed. Each fixture
 * workflow instead states the connection ids its definition holds, in the
 * field HOLDS_CONNECTION_IDS, as the database answers for that definition: the
 * SQL suite proves the predicate on real definitions
 * (supabase/tests/workflow_connection_check.test.sql, cases A and B). So a
 * fixture can mention an id inside a longer string, which the predicate does
 * not count, and the code under test must still not name that workflow.
 *
 * The rest is the function's own shape: connection_not_found (P0002) for a
 * connection not of the named organization, only that organization's
 * workflows, soft deleted ones included and marked, ordered live first, then
 * by name and id.
 */
import type { Row, RpcHandler } from './postgrest-fake'

/** The fixture field naming the connection ids a workflow's definition holds by definition_connection_ids. */
export const HOLDS_CONNECTION_IDS = 'holds_connection_ids'

export const connectionReferences: RpcHandler = (args, tables) => {
  const organizationId = args.p_organization_id
  const connectionId = args.p_connection_id
  const exists = (tables.service_connections ?? []).some((c) => c.id === connectionId && c.organization_id === organizationId)
  if (!exists) return { error: { code: 'P0002', message: 'connection_not_found', details: null, hint: null }, status: 404 }
  const holds = (w: Row) => Array.isArray(w[HOLDS_CONNECTION_IDS]) && (w[HOLDS_CONNECTION_IDS] as unknown[]).includes(connectionId)
  const rows = (tables.workflows ?? [])
    .filter((w) => w.organization_id === organizationId && holds(w))
    .map((w) => ({ workflow_id: String(w.id), name: String(w.name), deleted: w.deleted_at !== null && w.deleted_at !== undefined }))
    .sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.name.localeCompare(b.name) || a.workflow_id.localeCompare(b.workflow_id))
  return { data: rows }
}

/**
 * Two workflows of `organizationId` on which a match on the definition's text
 * and the database's one predicate disagree (#2946): `wf-note` mentions the id
 * inside a longer string, which the predicate does not count (case A's
 * "braced"), and `wf-caps` holds it in capitals with spaces around it, which
 * the predicate counts (it ignores case and surrounding space) and a text
 * match misses. Both are switched on.
 */
export function workflowsTheTextMatchMisjudges(organizationId: string, connectionId: string): Row[] {
  // An id of digits alone reads the same in capitals, and a text match would then find it after all.
  if (connectionId.toUpperCase() === connectionId) throw new Error(`workflowsTheTextMatchMisjudges needs an id holding a letter, not ${connectionId}`)
  const wf = (id: string, name: string, extra: Row) =>
    ({ id, organization_id: organizationId, name, is_active: true, deleted_at: null, lane: 'ops', updated_at: '2026-10-19T12:00:00.000000+00:00', ...extra })
  return [
    wf('wf-note', 'Lead notes', { [HOLDS_CONNECTION_IDS]: [], definition: { nodes: [{ id: 'n1', type: 'code', config: { code: `// moved off ${connectionId} last week` } }] } }),
    wf('wf-caps', 'Typed by hand', { [HOLDS_CONNECTION_IDS]: [connectionId], definition: { nodes: [{ id: 'n1', type: 'app_action', config: { connection_id: ` ${connectionId.toUpperCase()} ` } }] } }),
  ]
}
