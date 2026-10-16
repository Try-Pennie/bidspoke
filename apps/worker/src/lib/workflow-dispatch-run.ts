import type { SupabaseClient } from '@supabase/supabase-js'
import { orgIdsToTell, slackOrgIds } from './alert-fanout'
import { sendWorkflowDispatchAlert } from './slack'
import {
  type DispatchAttempt,
  dispatchFailed,
  formatDispatchSummary,
  runWorkflowDispatchDriver,
} from './workflow-dispatch-driver'

/** How long the same set of dispatch failures stays quiet after it was reported. */
export const DISPATCH_ALERT_COOLDOWN_SECONDS = 60 * 60

/**
 * How long a first transient failure is remembered (#1751). Long enough to
 * outlast one 15 minute tick with room for a late cron, short enough that a
 * failure two ticks apart, with the workflow undriven in between, counts afresh.
 */
export const TRANSIENT_HOLD_SECONDS = 40 * 60

const holdKey = (file: string) => `workflow-dispatch:transient-since:${file}`

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
  kv: KVNamespace,
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<DispatchAttempt[]> {
  const results = await runWorkflowDispatchDriver(env, nowMs, fetchImpl)

  // Logged on EVERY run, including a clean one. A driver that silently stopped
  // driving is the failure this whole change exists to prevent, and a positive
  // reading is the only way to tell it from a healthy run from the outside
  // (L98, L106).
  console.log(`[workflow-dispatch] ${formatDispatchSummary(results)}`)

  // A dispatch that went through ends any run of transient failures for that
  // workflow. Only `dispatched` clears it: a failed dispatch leaves the workflow
  // due, so the next tick either dispatches or fails again, never `not_due`.
  for (const r of results) {
    if (r.outcome !== 'dispatched') continue
    try {
      await kv.delete(holdKey(r.file))
    } catch (e) {
      console.error(`[workflow-dispatch] could not clear the transient hold for ${r.file}:`, e)
    }
  }

  const failed = dispatchFailed(results)
  if (failed.length === 0) return results
  for (const p of failed) console.error(`[workflow-dispatch] ${p.file} ${p.outcome}: ${p.reason}`)

  // A failure on GitHub's side (a 5xx, a dropped connection) is held for one
  // tick and speaks only if the next tick fails too (#1751). On 2026-10-04 one
  // 500 paged and the next tick dispatched fine, which is the noise L36 warns
  // of. A refusal is never held: it needs somebody to act.
  const problems: DispatchAttempt[] = []
  for (const p of failed) {
    if (!p.transient) {
      problems.push(p)
      continue
    }
    const decision = await holdOrRelease(kv, p.file, nowMs)
    if (decision.hold) {
      console.log(`[workflow-dispatch] ${p.file} held: first transient failure, alerting only if the next tick fails too`)
      continue
    }
    problems.push(decision.since ? { ...p, failingSince: decision.since } : p)
  }
  if (problems.length === 0) return results

  // At most one alert an hour for the same set of failures (#1368). The driver
  // runs every 15 minutes so a refused read is retried within the hour, and a
  // failure that persists would otherwise page four times an hour (L36). Keyed on
  // what failed and how, never on the reason text, which carries a reset time and
  // would make every run look new. A changed set is a different fault and speaks
  // at once.
  const signature = problems
    .map((p) => `${p.file}=${p.outcome}${p.rateLimited ? ':rate_limited' : ''}`)
    .sort()
    .join(',')
  const cooldownKey = `workflow-dispatch:alert:${signature}`
  try {
    if ((await kv.get(cooldownKey)) !== null) {
      console.log(`[workflow-dispatch] alert held: the same failures were reported within the hour (${signature})`)
      return results
    }
  } catch (e) {
    // A protective control fails towards speaking (L42): an unreadable cooldown
    // is not evidence anybody has been told.
    console.error('[workflow-dispatch] cooldown unreadable, alerting anyway:', e)
  }

  // A 'tell-only' list: this check's finding comes from GitHub, so a list read
  // from the saved copy still names who to tell. An unreadable list (slackOrgIds
  // logs why) deliberately folds to nobody to tell through orgIdsToTell, and that
  // is safe because delivery is recorded only from a real send below: with no
  // send, the cooldown is not armed and the next tick tries again.
  let delivered = false
  const orgIds = orgIdsToTell(await slackOrgIds(supabase, 'workflow-dispatch', 'tell-only'))
  for (const orgId of orgIds) {
    // Failing to DELIVER a verdict must not destroy the verdict, nor cost the
    // remaining orgs theirs (L73). The returned results and the run log above
    // are the other half of this check's output.
    try {
      if (await sendWorkflowDispatchAlert(supabase, orgId, problems)) delivered = true
    } catch (e) {
      console.error(`[workflow-dispatch] alert to ${orgId} failed:`, e)
    }
  }
  // Armed only once somebody was actually told, so an undelivered alert is tried
  // again on the next tick rather than held for an hour.
  if (delivered) {
    try {
      await kv.put(cooldownKey, '1', { expirationTtl: DISPATCH_ALERT_COOLDOWN_SECONDS })
    } catch (e) {
      console.error('[workflow-dispatch] cooldown could not be armed:', e)
    }
  }
  return results
}

/**
 * Decide whether a transient failure is the first in a row (hold it) or a
 * repeat (report it, with when it started).
 *
 * Both KV failures release rather than hold, because a protective control fails
 * towards speaking (L42): an unreadable marker is not evidence this is the first
 * failure, and a marker that could not be written would hold every later
 * failure as the first, for ever.
 */
async function holdOrRelease(
  kv: KVNamespace,
  file: string,
  nowMs: number,
): Promise<{ hold: true } | { hold: false; since?: string }> {
  let since: string | null
  try {
    since = await kv.get(holdKey(file))
  } catch (e) {
    console.error(`[workflow-dispatch] transient hold for ${file} unreadable, alerting now:`, e)
    return { hold: false }
  }
  if (since !== null) {
    // Renewed so a failure that persists keeps its true start time rather than
    // restarting the count each time the marker would have expired.
    try {
      await kv.put(holdKey(file), since, { expirationTtl: TRANSIENT_HOLD_SECONDS })
    } catch (e) {
      console.error(`[workflow-dispatch] could not renew the transient hold for ${file}:`, e)
    }
    return { hold: false, since }
  }
  try {
    await kv.put(holdKey(file), new Date(nowMs).toISOString(), { expirationTtl: TRANSIENT_HOLD_SECONDS })
  } catch (e) {
    console.error(`[workflow-dispatch] could not record the first transient failure of ${file}, alerting now:`, e)
    return { hold: false }
  }
  return { hold: true }
}
