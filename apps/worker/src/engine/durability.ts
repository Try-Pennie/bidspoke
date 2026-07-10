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
import { withDbRetry, isDuplicateError, toDbError, type DbError } from '../lib/db-retry'
import { formatErr } from '../lib/format-error'
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

// The deps an outcome-write function carries when its caller already holds the
// SupabaseClient as a separate argument. Optional on those functions: when
// present the write routes through writeOutcome (retry + dead-letter); when
// omitted (tests, one-off backfills) it falls back to a bare withDbRetry.
export type OutcomeAlertDeps = Omit<OutcomeDeps, 'supabase'>

// Each writeOutcome failure already survived the full retry ladder, so a single
// exhausted loss is a real must-not-lose miss — alert on the first one. A cooldown
// then rate-aggregates a burst so one outage pages once, not once per lead.
export const OUTCOME_DEAD_LETTER_THRESHOLD = 1
export const OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS = 30 * 60
export const OUTCOME_DEAD_LETTER_WINDOW_MINUTES = OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS / 60

// Count of losses in the current burst, NOT a consecutive streak (#599). The old
// streak was cleared on every success, so a partial outage (only the fast path
// racing, successes interleaved) almost never exceeded 1 and every alert said
// "1 in a row" while hundreds were lost. This counter is incremented on every
// dead-letter and never cleared on success, so the alert reports the true window
// total. A sliding TTL equal to the cooldown lets an ongoing outage keep climbing
// while a finished burst expires (so a later, unrelated loss starts fresh at 1).
const windowKey = (orgId: string, label: string) => `outcome-deadletter-window:${orgId}:${label}`
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
  // A duplicate-key error means the row already landed — that is success, not a
  // loss. Surface it as a non-error to withDbRetry so it stops immediately (no
  // wasteful retry ladder, no dead-letter), but remember it so the caller's own
  // isDuplicateError check still sees it.
  let duplicate: DbError | null = null
  const result = await withDbRetry(async () => {
    const r = await op()
    if (r.error && isDuplicateError(r.error)) {
      duplicate = r.error
      return { error: null }
    }
    return r
  })

  // A duplicate landed (success), and a clean success both do nothing to the
  // window counter: it must survive interleaved successes to count a partial
  // outage (#599). The counter expires on its own sliding TTL once losses stop.
  if (duplicate) return { error: duplicate }
  if (result.error) {
    await recordOutcomeDeadLetter(label, result.error, deps).catch((e) =>
      console.error('[durability] dead-letter alert failed:', e),
    )
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

  // Count this loss into the window BEFORE the cooldown check, so suppressed
  // losses still accumulate and the next alert reports what was suppressed (#599).
  // Sliding TTL: refreshed on every loss, so an ongoing outage never expires
  // mid-burst, and a finished burst clears itself after the window.
  const windowCount = Number((await kv.get(windowKey(orgId, label))) ?? '0') + 1
  await kv.put(windowKey(orgId, label), String(windowCount), {
    expirationTtl: OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS,
  })

  if (windowCount < OUTCOME_DEAD_LETTER_THRESHOLD) return false
  if (await kv.get(cooldownKey(orgId, label))) return false

  const slack = await getSlackConnection(deps.supabase, orgId)
  if (!slack || !slack.config_alerts_enabled) return false

  const sent = await sendOutcomeDeadLetterAlert(
    slack,
    {
      label,
      window_loss_count: windowCount,
      window_minutes: OUTCOME_DEAD_LETTER_WINDOW_MINUTES,
      error_message: formatErr(error),
      // Pass the SQLSTATE / PostgREST code so the alert can give cause-specific
      // remediation instead of always blaming Supabase / the purge window (#600).
      error_code: toDbError(error).code ?? null,
    },
    deps.appUrl,
  )

  // Only start the cooldown once the alert delivered, so a failed Slack post
  // doesn't suppress the next attempt while the loss goes unannounced.
  if (sent) await kv.put(cooldownKey(orgId, label), '1', { expirationTtl: OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS })
  return sent
}
