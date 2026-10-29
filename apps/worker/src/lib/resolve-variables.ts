/**
 * Which saved environment variable row a workflow's run reads, for each name
 * (#2997, phase 1 of #2982). The one place the precedence rules live (L370):
 *  - a row reaches a run only as rowReach says (env-row-reach.ts): an
 *    organization row reaches every workflow, a workflow's own row reaches that
 *    workflow alone, and a row saved for another workflow, a workflow row
 *    naming none, or a workflow's own row of an organization only key, none;
 *  - the workflow's own row is laid over the organization's;
 *  - of two rows at one level with one name, the later saved wins, so the rows
 *    must be handed over in the order they were saved (created_at, then id);
 *  - a row with no value (empty or null) is no value, so the run names the
 *    variable missing, or an older or organization value shows through.
 *
 * Two readers apply it: an ops version's kept variables (version-variables.ts,
 * #2702) and the current variables (current-variables.ts), which the ops
 * gateway serves a run (ops-gateway.ts readOpsRunVariables, #2997) and the ops
 * step test sends with the step (routes/api/ops-step-test.ts, #3002). The money lane's env loader keeps its
 * own loop, because its cache holds the organization's values and each
 * workflow's apart and lays them together at each run; resolve-variables-parity
 * .test.ts proves the two agree over shared rows.
 *
 * Pure, and imports only the reach predicate, so neither Worker takes the env
 * loader's cache or database code with it.
 */
import { rowReach } from './env-row-reach'

/** The fields of a saved row the rules read. The value is the caller's own: text, ciphertext, or a stand in. */
export interface ResolvableRow {
  key: string
  scope: string
  workflow_id: string | null
  value: unknown
}

const hasValue = (row: ResolvableRow) => row.value !== null && row.value !== undefined && row.value !== ''

/**
 * For each name asked, in the order asked, the row a run of `workflowId` reads.
 * A name no row reaches is left out. Rows are read in the order given.
 */
export function resolveVariables<R extends ResolvableRow>(rows: readonly R[], workflowId: string, names: readonly string[]): Map<string, R> {
  const orgRows = new Map<string, R>()
  const ownRows = new Map<string, R>()
  for (const row of rows) {
    if (!hasValue(row)) continue
    const reach = rowReach(row)
    if (reach === 'org') orgRows.set(row.key, row)
    else if (reach === 'workflow' && row.workflow_id === workflowId) ownRows.set(row.key, row)
  }
  const resolved = new Map<string, R>()
  for (const name of names) {
    // Maps, never plain objects, so a name can only ever find a stored row (L738).
    const row = ownRows.get(name) ?? orgRows.get(name)
    if (row !== undefined && !resolved.has(name)) resolved.set(name, row)
  }
  return resolved
}
