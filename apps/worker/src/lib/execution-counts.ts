/**
 * The per minute run counts behind the volume cliff alert and failure
 * saturation's denominator (#1437): one row per workflow per minute with runs,
 * from the `execution_counts_per_minute` function.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllPaged } from './paginate'

export interface MinuteCount {
  workflow_id: string
  minute: string
  /** A bigint, which PostgREST renders as a string. */
  cnt: number | string
}

/**
 * Every minute bucket of `workflowIds` since `since`. Paged (#1437): an hour of
 * buckets reaches PostgREST's 1,000 row cap at about 17 busy workflows, and a
 * capped answer would read as runs that stopped. The function groups by
 * workflow and minute, so that pair is a full order. Throws on a failed page.
 */
export async function readExecutionCountsPerMinute(
  supabase: SupabaseClient,
  workflowIds: string[],
  since: string,
  label: string,
): Promise<MinuteCount[]> {
  return fetchAllPaged<MinuteCount>(
    (from, to) =>
      supabase
        .rpc('execution_counts_per_minute', { p_workflow_ids: workflowIds, p_since: since })
        .order('workflow_id', { ascending: true })
        .order('minute', { ascending: true })
        .range(from, to),
    label,
  )
}
