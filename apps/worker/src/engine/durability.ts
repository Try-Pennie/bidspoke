// Durability-tier seam (#309).
//
// Names the durability guarantee of every write AT THE CALL SITE, so the
// observability-vs-outcome boundary is greppable and enforceable (Phase 3 guard)
// rather than implicit in which file the call lives in.
//
//  - writeObservability — tier 1: best-effort, at-most-once, no retry, no alert
//    on loss (execution_steps, audit). An occasional lost debug row is tolerable.
//  - writeOutcome — tier 2: must-not-lose Supabase outcome ops (lead_sightings,
//    lead_sighting_bids, planned opportunities). Retried via withDbRetry; on a
//    returned error (retries exhausted or permanent) the loss is dead-lettered.
//  - recordOutcomeDeadLetter — the shared dead-letter handler. Also called
//    DIRECTLY for the tier-3 external Salesforce writeback, whose own withRetry
//    already provided at-least-once delivery (so it must not be wrapped in
//    withDbRetry — an HTTP PATCH is not a PostgREST op).

import type { SupabaseClient } from '@supabase/supabase-js'
import { withDbRetry, type DbError } from '../lib/db-retry'
import { getSlackConnection, sendOutcomeDeadLetterAlert } from '../lib/slack'

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface OutcomeDeps {
  kv: KvLike
  supabase: SupabaseClient
  orgId: string
  appUrl: string
}

// Each writeOutcome failure already survived the full retry ladder, so a single
// exhausted loss is a real must-not-lose miss — alert on the first one. A cooldown
// then rate-aggregates a burst so one outage pages once, not once per lead.
export const OUTCOME_DEAD_LETTER_THRESHOLD = 1
export const OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS = 30 * 60
// Let a stale streak expire so a loss months ago doesn't count toward today's.
const STREAK_TTL_SECONDS = 7 * 24 * 60 * 60

const streakKey = (orgId: string, label: string) => `outcome-deadletter:${orgId}:${label}`
const cooldownKey = (orgId: string, label: string) => `outcome-deadletter-cooldown:${orgId}:${label}`

// Tier 1. Named home for best-effort observability writes; behavior unchanged
// (no retry, no alert), so the boundary is symmetric and greppable.
export async function writeObservability(
  _label: string,
  op: () => Promise<{ error: DbError | null }>,
): Promise<{ error: DbError | null }> {
  return op()
}

// Tier 2. Must-not-lose Supabase outcome op: retry, then dead-letter on a
// returned error. Clears the failure streak on success. Safe to call inside
// waitUntil (off the request path).
export async function writeOutcome(
  label: string,
  op: () => Promise<{ error: DbError | null }>,
  deps: OutcomeDeps,
): Promise<{ error: DbError | null }> {
  const result = await withDbRetry(op)
  if (result.error) {
    await recordOutcomeDeadLetter(label, result.error, deps).catch((e) =>
      console.error('[durability] dead-letter alert failed:', e),
    )
  } else {
    await deps.kv.delete(streakKey(deps.orgId, label)).catch(() => {})
  }
  return result
}

// Shared dead-letter handler. Increments a per-(org,label) streak in KV and fires
// a rate-aggregated Slack alert once the streak crosses the threshold, deduped by
// a cooldown. Reuses the existing failure channel + config_alerts_enabled toggle.
// Callable directly (tier-3 SF writeback) as well as via writeOutcome.
export async function recordOutcomeDeadLetter(
  label: string,
  error: unknown,
  deps: OutcomeDeps,
): Promise<boolean> {
  const { kv, orgId } = deps

  const streak = Number((await kv.get(streakKey(orgId, label))) ?? '0') + 1
  await kv.put(streakKey(orgId, label), String(streak), { expirationTtl: STREAK_TTL_SECONDS })

  if (streak < OUTCOME_DEAD_LETTER_THRESHOLD) return false
  if (await kv.get(cooldownKey(orgId, label))) return false

  const slack = await getSlackConnection(deps.supabase, orgId)
  if (!slack || !slack.config_alerts_enabled) return false

  const sent = await sendOutcomeDeadLetterAlert(
    slack,
    {
      label,
      consecutive_failures: streak,
      error_message: error instanceof Error ? error.message : String(error),
    },
    deps.appUrl,
  )

  // Only start the cooldown once the alert delivered, so a failed Slack post
  // doesn't suppress the next attempt while the loss goes unannounced.
  if (sent) await kv.put(cooldownKey(orgId, label), '1', { expirationTtl: OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS })
  return sent
}
