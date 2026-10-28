/**
 * Which runs a stored environment variable row reaches (#1681): every run of
 * the organization ('org'), its own workflow's runs ('workflow'), or none. A
 * workflow scoped row that names no workflow reaches none, and so does a
 * workflow's own value for a key that is the organization's only
 * (org-only-env-keys). The one predicate the env loader, the daily decrypt
 * check, and an ops version's variables (version-variables.ts, #2702) all
 * apply, so each judges exactly the rows a run can be handed (L11).
 *
 * Its own module, with no imports but the organization only keys, so a reader
 * of the predicate takes none of the env loader's cache, key or database code
 * with it. env-loader.ts re-exports it under its old name.
 */
import { isOrgOnlyEnvKey } from './org-only-env-keys'

export function rowReach(row: { scope: string; workflow_id: string | null; key: string }): 'org' | 'workflow' | 'none' {
  if (row.scope === 'global') return 'org'
  if (row.scope === 'workflow' && row.workflow_id && !isOrgOnlyEnvKey(row.key)) return 'workflow'
  return 'none'
}
