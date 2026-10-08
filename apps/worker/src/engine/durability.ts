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
//    A write that only TIMED OUT at the post-response budget is not a loss: it
//    is recorded as unconfirmed (engine/unconfirmed-writes.ts) and read back by
//    the minute sweep, which dead-letters it only if it never landed (#1880).
//  - recordOutcomeDeadLetter — the shared dead-letter handler. Also called
//    DIRECTLY for the tier-3 external Salesforce writeback, whose own withRetry
//    already provided at-least-once delivery (so it must not be wrapped in
//    withDbRetry — an HTTP PATCH is not a PostgREST op).

import type { SupabaseClient } from '@supabase/supabase-js'
import { withDbRetry, isDuplicateError, toDbError, DB_WRITE_RETRY_DELAYS_MS, READ_BACK_MISSING_CODE, type DbError } from '../lib/db-retry'
import { withinBudget, type RetryTiming } from '../lib/post-response-budget'
import { formatErr } from '../lib/format-error'
import { getSlackConnection, sendOutcomeDeadLetterAlert, type OutcomeDeadLetterAlert } from '../lib/slack'
import { putUnconfirmedWrite, type ReadBack, type UnconfirmedRun } from './unconfirmed-writes'
import type { AlertClaims } from '../lib/alert-claim'

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expiration?: number; expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

export interface OutcomeDeps {
  kv: KvLike
  supabase: SupabaseClient
  orgId: string
  appUrl: string
  /**
   * The run's clock and post-response budget (#1850). When present the retry
   * ladder stops at the cut-off, so a returned error is dead-lettered before
   * Cloudflare cancels the request's waitUntil work, and a write still
   * unanswered there is recorded as unconfirmed for the minute sweep to read
   * back (#1880); it is dead-lettered then only if that record cannot be
   * written. Absent, nothing is bounded.
   */
  timing?: RetryTiming
  /**
   * The run the write belongs to (#1880). Carried onto an unconfirmed entry so
   * the sweep's alert can name the workflow and link the run.
   */
  run?: UnconfirmedRun
  /** Wall clock for an unconfirmed entry's first seen time; Date.now unless a test sets it. */
  now?: () => number
  /**
   * The atomic claim that decides which dead letter of a burst posts (#1881).
   * Absent, the eventually consistent KV cooldown stands in.
   */
  claims?: AlertClaims
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

// Count of losses in the current burst, NOT a consecutive streak (#599). It is a
// KV read then write, so isolates writing at once can overwrite each other's
// increment: the count is approximate, never above the truth, and the alert says
// "about" (#1881). Who posts is decided atomically, by the AlertClaim. The old
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
//
// `readBack` names the record and the effect that prove the write landed. It is
// required, so no new outcome write can be added without saying how a timed out
// one is confirmed (#1880).
export async function writeOutcome(
  label: string,
  op: () => Promise<{ error: DbError | null }>,
  deps: OutcomeDeps,
  readBack: ReadBack,
): Promise<{ error: DbError | null }> {
  // A duplicate-key error means the row already landed — that is success, not a
  // loss. Surface it as a non-error to withDbRetry so it stops immediately (no
  // wasteful retry ladder, no dead-letter), but remember it so the caller's own
  // isDuplicateError check still sees it.
  let duplicate: DbError | null = null
  const attempt = withDbRetry(async () => {
    const r = await op()
    if (r.error && isDuplicateError(r.error)) {
      duplicate = r.error
      return { error: null }
    }
    return r
  }, DB_WRITE_RETRY_DELAYS_MS, deps.timing)
  // A request that never answers would hold the dead letter past the platform's
  // limit, so the wait stops at the cut-off. The request is not cancelled: the
  // write may still land, so it is recorded as unconfirmed for the sweep to read
  // back, never dead-lettered as lost on the strength of a timeout (#1880).
  const raced = await withinBudget(attempt, deps.timing)
  if (!raced.settled) {
    const unconfirmed = { message: `${label}: no answer within the post-response budget; the write may still land, but nothing confirmed it` }
    await recordUnconfirmedOutcome(label, readBack, unconfirmed, deps)
    return { error: unconfirmed }
  }
  const result = raced.value

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

/**
 * Records a must-not-lose write that timed out as unconfirmed (#1880): one KV
 * write naming what the minute sweep reads back. Fits in the dead letter's
 * reserve, which is three KV operations and a Slack post. When the entry itself
 * cannot be written the write is dead-lettered as before, because a timed out
 * write with no record anywhere is the silent loss the dead letter exists for.
 * Never throws.
 */
export async function recordUnconfirmedOutcome(
  label: string,
  readBack: ReadBack,
  error: DbError,
  deps: OutcomeDeps,
  // False for a tier 1 record (the step rows, #1881): read back for the slowdown
  // summary, but its loss is never dead-lettered, so neither is a failed entry.
  options: { deadLetterOnFailure: boolean } = { deadLetterOnFailure: true },
): Promise<void> {
  const nowMs = (deps.now ?? Date.now)()
  try {
    await putUnconfirmedWrite(
      deps.kv,
      {
        id: crypto.randomUUID(),
        label,
        org_id: deps.orgId,
        first_seen_at: new Date(nowMs).toISOString(),
        read_back: readBack,
        ...(deps.run ? { run: deps.run } : {}),
        error_message: error.message,
      },
      nowMs,
    )
  } catch (e) {
    if (!options.deadLetterOnFailure) {
      console.error(`[durability] ${label}: could not record the unconfirmed write:`, formatErr(e))
      return
    }
    console.error(`[durability] ${label}: could not record the unconfirmed write, dead-lettering it instead:`, formatErr(e))
    await recordOutcomeDeadLetter(label, error, deps, deps.run ? { ...deps.run, at: new Date(nowMs).toISOString() } : undefined).catch((err) =>
      console.error('[durability] dead-letter alert failed:', err),
    )
  }
}

// Shared dead-letter handler. Increments a per-(org,label) streak in KV and fires
// a rate-aggregated Slack alert once the streak crosses the threshold, deduped by
// a cooldown. Reuses the existing failure channel + config_alerts_enabled toggle.
// Callable directly (tier-3 SF writeback) as well as via writeOutcome.
export async function recordOutcomeDeadLetter(
  label: string,
  error: unknown,
  deps: OutcomeDeps,
  run?: OutcomeDeadLetterAlert['run'],
  // Why the record was lost, when the caller knows better than the error code:
  // the read back sweep gives a missing execution row NO_ROW_MATCHED for its
  // wording, and that loss is still a slowdown's, not a returned error.
  options: { cause?: 'read-back' | 'error' } = {},
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

  // Who posts (#1881). The KV cooldown below is a read then a later write, and KV
  // is eventually consistent across isolates, so every dead letter of one burst
  // read no cooldown and posted: 11, 12 and 13 within a minute on 2026-10-08. The
  // AlertClaim object answers that atomically. It is keyed on the CAUSE as well as
  // the label, so a write that returned an error still pages beside a slowdown's
  // read back losses of the same label (L707). Without a claim (tests, one off
  // backfills) the KV cooldown stands in, as before.
  const errorCode = toDbError(error).code ?? null
  const cause = options.cause ?? (errorCode === READ_BACK_MISSING_CODE ? 'read-back' : 'error')
  const claimKey = `outcome-deadletter:${orgId}:${label}:${cause}`
  if (deps.claims) {
    if (!(await deps.claims.claim(claimKey, OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS))) return false
  } else if (await kv.get(cooldownKey(orgId, label))) {
    return false
  }

  // A read that throws frees the claim too, or one bad read would silence this
  // label for the whole window.
  const slack = await getSlackConnection(deps.supabase, orgId).catch(async (e: unknown) => {
    await deps.claims?.release(claimKey)
    throw e
  })
  if (!slack) {
    // No connection could be read, which mid outage is the database: free the
    // claim so a later loss can still post.
    await deps.claims?.release(claimKey)
    return false
  }
  // Alerts switched off: the claim is kept, since there is nothing to post and
  // nothing a later loss could post either.
  if (!slack.config_alerts_enabled) return false

  const sent = await sendOutcomeDeadLetterAlert(
    slack,
    {
      label,
      window_loss_count: windowCount,
      window_minutes: OUTCOME_DEAD_LETTER_WINDOW_MINUTES,
      error_message: formatErr(error),
      // Pass the SQLSTATE / PostgREST code so the alert can give cause-specific
      // remediation instead of always blaming Supabase / the purge window (#600).
      error_code: errorCode,
      ...(run ? { run } : {}),
    },
    deps.appUrl,
  )

  // Only hold the cooldown once the alert delivered, so a failed Slack post
  // doesn't suppress the next attempt while the loss goes unannounced.
  if (!sent) await deps.claims?.release(claimKey)
  else if (!deps.claims) await kv.put(cooldownKey(orgId, label), '1', { expirationTtl: OUTCOME_DEAD_LETTER_COOLDOWN_TTL_SECONDS })
  return sent
}
