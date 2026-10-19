/**
 * The one read of every organization's active workflows (#1437), shared by the
 * scheduled checks that judge them all: the minute checks (failure rate, slow
 * runs, upstream outage, volume cliff), the daily volume check, the field
 * presence sweep and the cache prewarm.
 *
 * Paged, because PostgREST answers at most 1,000 rows however many match and
 * says nothing about the rest, and ordered by the primary key, because a page
 * ordered on anything that ties (the organization, a name) can skip one row
 * and repeat another between requests.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPaged } from './paginate'

/** A workflow row as these checks read it; each caller picks the columns it selects. */
export interface ActiveWorkflowRow {
  id: string
  name: string
  organization_id: string
  slack_channel: string | null
  definition: unknown
}

/**
 * Every active, undeleted workflow, of `orgIds` when given, with `columns`.
 * Throws on a failed page, so a caller never judges a list it did not read whole.
 */
export async function readActiveWorkflows<T>(
  supabase: SupabaseClient,
  columns: string,
  label: string,
  orgIds?: readonly string[],
): Promise<T[]> {
  return fetchAllPaged<T>((from, to) => {
    const page = supabase
      .from('workflows')
      .select(columns)
      .eq('is_active', true)
      .is('deleted_at', null)
      .order('id', { ascending: true })
      .range(from, to)
    return orgIds ? page.in('organization_id', orgIds as string[]) : page
  }, label)
}
