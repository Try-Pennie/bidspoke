/**
 * Surface persistent GitHub workflow-backup failures (#206).
 *
 * Every workflow save mirrors the definition to a GitHub backup repo
 * (`pushWorkflowToGitHub`). That push runs in a `waitUntil()` and its failures
 * were previously swallowed into a log line, so an expired token, a misconfigured
 * repo, or a GitHub outage could silently stop all backups until someone went
 * looking for a version that was never pushed.
 *
 * This tracks a per-org consecutive-failure streak in KV and posts a Slack alert
 * once the streak crosses the threshold — so a single transient blip stays quiet
 * but a sustained outage is announced. A cooldown prevents repeat alerts while the
 * outage persists, and the streak clears on the next successful backup. Gated on
 * its own `backup_alerts_enabled` toggle (#223) so muting noisy config alerts
 * doesn't silently disable this data-safety alert.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSlackConnection, sendBackupFailureAlert } from './slack'
import { formatErr } from './format-error'
import { clearCondition, describeRepeat, inCooldown, readCondition, recordAlert } from './alert-backoff'

// Alert after this many consecutive failed saves (org-wide). Saves are infrequent
// and the usual cause (bad token / wrong repo) fails every save, so a low bar both
// rides out one-off blips and announces a real outage within a couple of saves.
export const BACKUP_FAILURE_THRESHOLD = 2
// Let a stale streak expire so a failure months ago doesn't count toward today's.
const STREAK_TTL_SECONDS = 7 * 24 * 60 * 60

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

const streakKey = (orgId: string) => `github-backup-failures:${orgId}`
// The escalating-backoff family key (#1337). Backups are save-triggered and
// slow-burn, so this uses the shared schedule (6h, 12h, daily), not a short first
// step like the urgent volume-cliff paths. This cooldown key differs from the old
// flat one (github-backup-alert-cooldown:), so a failure standing at the deploy
// loses its old cooldown and re-pages once as it enters the schedule: a bounded,
// one-time transition, and re-announcing a still-standing failure is harmless.
const backoffKey = (orgId: string) => `github-backup:${orgId}`

/** Clear the failure streak and reminder schedule after a successful backup. */
export async function recordBackupSuccess(kv: KvLike, orgId: string): Promise<void> {
  await kv.delete(streakKey(orgId))
  // Reset the reminder schedule, so the next outage starts at the first interval
  // rather than wherever the last one had backed off to (#1337).
  await clearCondition(kv, backoffKey(orgId))
}

export interface BackupFailureInput {
  supabase: SupabaseClient
  kv: KvLike
  orgId: string
  workflowId: string
  workflowName: string
  error: unknown
  appUrl: string
  /** Injectable clock for the reminder schedule, defaults to Date.now() (#1337). */
  nowMs?: number
}

/**
 * Record a failed backup and alert when the org's consecutive-failure streak
 * crosses the threshold (deduped by a cooldown). Returns true when an alert was
 * delivered. Best-effort: callers run this inside the save's waitUntil and should
 * swallow its own errors.
 */
export async function recordBackupFailure(input: BackupFailureInput): Promise<boolean> {
  const { kv, orgId } = input

  const streak = Number((await kv.get(streakKey(orgId))) ?? '0') + 1
  await kv.put(streakKey(orgId), String(streak), { expirationTtl: STREAK_TTL_SECONDS })

  if (streak < BACKUP_FAILURE_THRESHOLD) return false
  if (await inCooldown(kv, backoffKey(orgId))) return false

  const slack = await getSlackConnection(input.supabase, orgId)
  if (!slack || !slack.backup_alerts_enabled) return false

  // The reminder interval grows while the outage stands, rather than repeating at a
  // flat 6h, and the message says which reminder this is (#1337). unchanged is false
  // because the consecutive-failure count moves each time, so it is never word for
  // word the last post; the sentence then says "same problem, latest details shown".
  const nowMs = input.nowMs ?? Date.now()
  const standing = await readCondition(kv, backoffKey(orgId))
  const repeat = describeRepeat(standing, nowMs, false) ?? undefined

  const sent = await sendBackupFailureAlert(
    slack,
    {
      workflow_id: input.workflowId,
      workflow_name: input.workflowName,
      consecutive_failures: streak,
      error_message: formatErr(input.error),
      repeat,
    },
    input.appUrl
  )

  // Only record the alert (which arms the next cooldown) once it actually
  // delivered, so a failed Slack post does not suppress retries while the outage
  // goes unannounced.
  if (sent) await recordAlert(kv, backoffKey(orgId), standing, nowMs)
  return sent
}
