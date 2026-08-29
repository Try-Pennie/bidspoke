import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { sendWorkflowDispatchAlert } from './slack'
import {
  type DispatchAttempt,
  dispatchFailed,
  formatDispatchSummary,
  runWorkflowDispatchDriver,
} from './workflow-dispatch-driver'

interface DriverEnv {
  GITHUB_ACTIONS_TOKEN?: string
  GITHUB_TOKEN?: string
  GITHUB_CODE_REPO?: string
}

/**
 * Run the workflow dispatch driver and tell somebody if it could not do its job
 * (#1058).
 *
 * A separate module from both the driver and the Slack message on purpose. The
 * driver decides and acts, `sendWorkflowDispatchAlert` words the message, and
 * this joins them to the org list. Keeping it out of `scheduled()` is what makes
 * the interesting parts testable: the behaviour worth checking here is all in
 * what happens when something goes wrong, and none of it is reachable from a
 * test while it sits inline in the cron handler.
 */
export async function runAndReportDispatch(
  supabase: SupabaseClient,
  env: DriverEnv,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchAttempt[]> {
  const results = await runWorkflowDispatchDriver(env, nowMs, fetchImpl)

  // Logged on EVERY run, including a clean one. A driver that silently stopped
  // driving is the failure this whole change exists to prevent, and a positive
  // reading is the only way to tell it from a healthy run from the outside
  // (L98, L106).
  console.log(`[workflow-dispatch] ${formatDispatchSummary(results)}`)

  const problems = dispatchFailed(results)
  if (problems.length === 0) return results
  for (const p of problems) console.error(`[workflow-dispatch] ${p.file} ${p.outcome}: ${p.reason}`)

  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  // The error is READ, not discarded. A failed lookup yields no orgs, the loop
  // below runs zero times, and the alert silently does not go out, so a
  // transient database error and a system with no Slack orgs would otherwise
  // produce the identical outcome with nothing to tell them apart (L10, L11).
  logReadFailure('workflow-dispatch', 'slack connections', connsError)

  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]
  for (const orgId of orgIds) {
    // Failing to DELIVER a verdict must not destroy the verdict, nor cost the
    // remaining orgs theirs (L73). The returned results and the run log above
    // are the other half of this check's output.
    try {
      await sendWorkflowDispatchAlert(supabase, orgId, results)
    } catch (e) {
      console.error(`[workflow-dispatch] alert to ${orgId} failed:`, e)
    }
  }
  return results
}
