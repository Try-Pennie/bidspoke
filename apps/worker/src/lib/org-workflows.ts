/**
 * An organization's workflows with their definitions (#2142, L613): the one
 * read every route and check asking "which of this organization's workflows
 * ..." makes, instead of a copy per caller. Its callers today (a guard,
 * `__guards__/worker/org-workflows-one-read.test.ts` in apps/web, fails on a
 * hand written copy): the workflow values route
 * (`routes/api/partner-workflow-values.ts`, which hands the rows to the pure
 * scanner), the buyer profile routes (other sellers, and the sold on switch
 * refusal), the step rename impact route (`excludeId`, the workflow being
 * renamed), the code worker migration and the timeout audit (both
 * `activeOnly`), and the partner delete check (#2140, routes/api/partner-delete.ts).
 *
 * The Worker connects as service_role, which bypasses row level security, so
 * this read is what scopes the answer to one organization: it filters
 * `organization_id` and `deleted_at is null` in the query. Each row also carries
 * both columns back, and a row of another organization or a soft deleted one is
 * dropped and logged as a scoping failure, so no caller can ever be handed one.
 *
 * Inactive workflows are included unless the caller asks for active ones only:
 * a workflow switched off today runs again the moment it is switched on, so a
 * question about what a change would break must see it. Every row carries
 * `is_active` so the caller can say which.
 *
 * Paged past PostgREST's 1,000 row cap, ordered by id, and refused rather than
 * truncated if it does not reach its last row within MAX_PAGES (L98). Throws on
 * a failed read; the caller turns that into its own error, never an empty list.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPaged } from './paginate'

export interface OrgWorkflow {
  id: string
  name: string
  is_active: boolean
  definition: unknown
  /**
   * As PostgREST answered it, to the microsecond. The delete check (#2140)
   * sends the (id, updated_at) set of the workflows it scanned back with the
   * delete, and delete_partner_config compares it with the rows it locks, so
   * it is passed through untouched, never parsed into a Date (milliseconds).
   */
  updated_at: string
}

export interface OrgWorkflowsOptions {
  /** Only workflows that are switched on. */
  activeOnly?: boolean
  /** Leave out one workflow (the rename impact route asks about the OTHER workflows), in the query so it takes no page slot. */
  excludeId?: string
}

/** Pages of 1,000: 20 pages is twenty thousand workflows, far past any organization's count (11 live on 2026-10-15). */
const MAX_PAGES = 20

interface Row extends OrgWorkflow {
  organization_id: string
  deleted_at: string | null
}

export async function readOrgWorkflows(supabase: SupabaseClient, orgId: string, options: OrgWorkflowsOptions = {}): Promise<OrgWorkflow[]> {
  const rows = await fetchAllPaged<Row>(
    (from, to) => {
      let query = supabase
        .from('workflows')
        .select('id, name, is_active, definition, updated_at, organization_id, deleted_at')
        .eq('organization_id', orgId)
        .is('deleted_at', null)
      if (options.activeOnly) query = query.eq('is_active', true)
      if (options.excludeId !== undefined) query = query.neq('id', options.excludeId)
      return query.order('id', { ascending: true }).range(from, to)
    },
    `workflows of organization ${orgId}`,
    { maxPages: MAX_PAGES }
  )
  const out: OrgWorkflow[] = []
  for (const row of rows) {
    if (row.organization_id !== orgId || row.deleted_at !== null) {
      console.error(
        `[org-workflows] the workflows read for organization ${orgId} returned workflow ${row.id} of organization ${row.organization_id}${row.deleted_at !== null ? ', soft deleted' : ''}; dropped, because the query's scoping did not hold`
      )
      continue
    }
    if (options.activeOnly && row.is_active !== true) continue
    if (row.id === options.excludeId) continue
    out.push({ id: row.id, name: row.name, is_active: row.is_active === true, definition: row.definition, updated_at: row.updated_at })
  }
  return out
}
