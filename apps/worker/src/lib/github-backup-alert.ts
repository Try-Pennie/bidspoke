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

// Alert after this many consecutive failed saves (org-wide). Saves are infrequent
// and the usual cause (bad token / wrong repo) fails every save, so a low bar both
// rides out one-off blips and announces a real outage within a couple of saves.
export const BACKUP_FAILURE_THRESHOLD = 2
// 6h between alerts for the same org — backups only happen on save, so a tighter
// window would rarely re-fire anyway; this just guards a burst of saves.
export const BACKUP_COOLDOWN_TTL_SECONDS = 6 * 60 * 60
// Let a stale streak expire so a failure months ago doesn't count toward today's.
const STREAK_TTL_SECONDS = 7 * 24 * 60 * 60

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

const streakKey = (orgId: string) => `github-backup-failures:${orgId}`
const cooldownKey = (orgId: string) => `github-backup-alert-cooldown:${orgId}`

/** Clear the failure streak after a successful backup. */
export async function recordBackupSuccess(kv: KvLike, orgId: string): Promise<void> {
  await kv.delete(streakKey(orgId))
}

export interface BackupFailureInput {
  supabase: SupabaseClient
  kv: KvLike
  orgId: string
  workflowId: string
  workflowName: string
  error: unknown
  appUrl: string
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
  if (await kv.get(cooldownKey(orgId))) return false

  const slack = await getSlackConnection(input.supabase, orgId)
  if (!slack || !slack.backup_alerts_enabled) return false

  const sent = await sendBackupFailureAlert(
    slack,
    {
      workflow_id: input.workflowId,
      workflow_name: input.workflowName,
      consecutive_failures: streak,
      error_message: input.error instanceof Error ? input.error.message : String(input.error),
    },
    input.appUrl
  )

  // Only start the cooldown once the alert actually delivered — otherwise a failed
  // Slack post would suppress retries while the outage went unannounced.
  if (sent) await kv.put(cooldownKey(orgId), '1', { expirationTtl: BACKUP_COOLDOWN_TTL_SECONDS })
  return sent
}
