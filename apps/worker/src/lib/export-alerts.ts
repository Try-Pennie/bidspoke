/**
 * Export-failure alerting (#412).
 *
 * The nightly Snowflake export jobs (sightings-export, achieve-export) catch their
 * own errors and accumulate them into a returned `summary.errors[]` rather than
 * throwing, so a Snowflake outage was previously only console-logged with no page.
 * This notifies every Slack-connected org when an export reports errors. The export
 * jobs are global (one Snowflake account), so like the required-secrets guard there
 * is no single org to target. No-ops on a clean run.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'
import { sendExportFailureAlert } from './slack'
import { buildFixHint, buildConsequence, isTransientExportError } from './export-error-hints'
import { clearCondition, describeRepeat, inCooldown, readCondition, recordAlert } from './alert-backoff'

interface KvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

// The reminder gap used to be a flat eight hours, which meant a failure that
// stood for a week arrived three times a day, every day, each message identical
// to the last (#1334). It now comes from the shared escalating schedule in
// alert-backoff, which lengthens to a day and resets on the first clean run, so
// a flapping job is still paged every time it breaks. The old
// `export-alert-state:` key is superseded by that module's own; an export that
// is failing across the deploy pages once more and then follows the new
// schedule, which is the safe direction for a key change to be wrong in.

// How long a held-back first transient failure stays armed. Must outlive one
// full cycle of the slowest job (the daily Achieve export) so its "next run"
// still sees the marker; refreshed on every consecutive failure, cleared by the
// first clean run.
export const EXPORT_ALERT_PENDING_TTL_SECONDS = 26 * 60 * 60

/**
 * The grace marker, which now records whether a run has SUCCEEDED since the
 * first failure (#1441).
 *
 * It used to be a bare ISO timestamp, and a success never touched it, because
 * the only way to clear it was a call with no errors and that call deletes the
 * cooldown too. The consequence was measured on 2026-09-22: two archive
 * timeouts 22 successful runs apart were reported as one incident, "failing
 * since" a day earlier, with reminders escalating against a condition that had
 * healed twice.
 *
 * Deleting it on a success is not the answer, and that is why it was never
 * done: a job alternating a failure with a clean run would re-arm the grace
 * every other run and never reach the second consecutive failure that pages. So
 * the marker is KEPT and stamped instead, which leaves the paging behaviour
 * exactly as it was while letting the message say which of the two it is.
 *
 * A marker written before this change is a bare timestamp, and there is one in
 * production KV as this ships, so the reader accepts both shapes. An
 * unparseable one is read as a standing failure, which is the direction that
 * reports MORE rather than less.
 */
interface PendingFailure {
  /** ISO timestamp of the first failure in this stretch. */
  since: string
  /** True once a run has succeeded after that first failure. */
  recovered: boolean
}

export function parsePendingFailure(raw: string | null): PendingFailure | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{')) return { since: trimmed, recovered: false }
  try {
    const parsed = JSON.parse(trimmed) as { since?: unknown; recovered?: unknown }
    if (typeof parsed.since !== 'string') return { since: trimmed, recovered: false }
    return { since: parsed.since, recovered: parsed.recovered === true }
  } catch {
    return { since: trimmed, recovered: false }
  }
}

const writePendingFailure = (pending: PendingFailure): string => JSON.stringify(pending)

/**
 * What a HEALTHY run of a job that alerts through this module reports (#1441).
 *
 * Two separate things, and the difference is the whole point. The standing
 * condition is DELETED, because the condition has cleared and that is what the
 * escalating reminder schedule means by clearing: the next failure starts a
 * fresh schedule rather than continuing a day-old one. The grace marker is KEPT
 * and stamped as interrupted, because it is the only record that a failure
 * happened recently at all, and the alternating pattern it protects against is
 * exactly the one a delete would hide.
 *
 * A job with nothing recorded writes nothing, so a healthy job that has never
 * failed costs one KV read.
 */
export async function notifyExportRecovery(kv: KvLike | undefined, jobName: string): Promise<void> {
  if (!kv) return
  await clearCondition(kv, `export-alert:${jobName}`)
  const pendingKey = `export-alert-pending:${jobName}`
  const pending = parsePendingFailure(await kv.get(pendingKey))
  if (!pending || pending.recovered) return
  await kv.put(pendingKey, writePendingFailure({ since: pending.since, recovered: true }), {
    expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS,
  })
}

/**
 * What the alert should say happened, and what to do, when the caller knows
 * better than the message classifier.
 *
 * The classifier below reads export error TEXT, and every scheduled check
 * borrows this alerter, so a check whose messages it does not recognise used
 * to be told "the rows were not exported, check Snowflake" whatever it was
 * about. On 2026-09-06 the Tripoint pricing check paged with exactly that under
 * a pricing disagreement (#1166). A check about settings, not rows, supplies
 * both sentences itself; the classification is only for the export jobs whose
 * failures it was written from (#542).
 */
export interface AlertRemedy {
  /** The sentence between "reported N errors" and the list. */
  consequence: string
  /** The "How to fix" line. */
  fixHint: string
  /**
   * What the job DID, for the header, when "failed" is untrue. A check that ran
   * correctly and found something has not failed, and on 2026-09-10 one such
   * finding arrived headlined "code-node-payload-prints failed".
   */
  headlineVerb?: string
  /** What the listed items ARE, when "error" is untrue (a finding, a difference). */
  itemNoun?: { one: string; many: string }
}

/**
 * What a GENUINE export or purge job passes, saying so out loud.
 *
 * The remedy is required (2026-09-10) rather than optional, because an optional
 * one is a rule every call site has to remember and eleven checks did not, so
 * each of them inherited wording about un-exported rows and Snowflake for
 * conditions that involve neither. A rule each site must opt into cannot be
 * enforced by a scan (L621), so the type enforces it: omitting this argument is
 * now a compile error, and inheriting the export wording is a deliberate word
 * in the source rather than a silence.
 */
export type ExportJobWording = 'export-job'

export async function notifyExportFailure(
  supabase: SupabaseClient,
  jobName: string,
  errors: string[],
  kv: KvLike | undefined,
  remedy: AlertRemedy | ExportJobWording,
  nowMs: number = Date.now(),
): Promise<void> {
  const pendingKey = `export-alert-pending:${jobName}`
  // The reminder schedule for this job's standing failure (#1334).
  const backoff = `export-alert:${jobName}`

  if (errors.length === 0) {
    if (kv) {
      await clearCondition(kv, backoff)
      await kv.delete(pendingKey)
    }
    return
  }

  // Transient-failure grace (2026-07-24): every run automatically re-attempts
  // whatever the failed run left behind, so a lone connectivity blip self-heals
  // and paging on it is noise. Hold the FIRST all-transient failure silently and
  // page only when the next run fails too. Anything a retry cannot fix (auth,
  // permissions, schema, unrecognised errors) still pages immediately.
  let failingSince: string | undefined
  let intermittentSince: string | undefined
  if (kv && errors.every(isTransientExportError)) {
    const pending = parsePendingFailure(await kv.get(pendingKey))
    if (!pending) {
      await kv.put(pendingKey, writePendingFailure({ since: new Date().toISOString(), recovered: false }), {
        expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS,
      })
      console.log(`[export-alerts] ${jobName}: transient failure held (no alert unless the next run also fails):`, errors)
      return
    }
    // Keep the original first-failure time and re-arm the TTL so a long outage
    // cannot expire the marker mid-outage and silently restart the grace.
    await kv.put(pendingKey, writePendingFailure(pending), { expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS })
    // WHICH of the two sentences this earns is decided here, from what was
    // recorded rather than from the fact that a marker exists (#1441, L11). A
    // run succeeded in between means this is intermittent, and saying "failing
    // since" would name a stretch that demonstrably ended.
    if (pending.recovered) intermittentSince = pending.since
    else failingSince = pending.since
  }

  // Already paged for this ongoing issue; stay quiet until it recovers (the
  // condition is cleared above) or the current interval expires. The interval
  // grows while the failure stands, so a long outage is still reported and does
  // not arrive at the volume that teaches people to skip the channel.
  if (kv && (await inCooldown(kv, backoff))) return
  const standing = kv ? await readCondition(kv, backoff) : null
  const repeat = describeRepeat(standing, nowMs) ?? undefined

  const { data: conns, error: connsError } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure('export-alerts', 'slack connections', connsError)
  const orgIds = [...new Set((conns ?? []).map((r) => (r as { organization_id: string }).organization_id))]

  // Classify once, not per org: the same errors produce the same advice. The
  // consequence sentence comes from the same classification (#1180), so the
  // alert's second sentence and its remedy cannot disagree about what happened.
  // 'export-job' means "classify my message text as an export error", which is
  // right for the export and purge jobs the classifier was built from and wrong
  // for everything else (#542, #1166).
  const own = remedy === 'export-job' ? undefined : remedy
  const fixHint = own?.fixHint ?? buildFixHint(errors)
  const consequence = own?.consequence ?? buildConsequence(errors)

  let delivered = false
  for (const orgId of orgIds) {
    try {
      if (await sendExportFailureAlert(supabase, orgId, null, {
        jobName,
        errors,
        fixHint,
        consequence,
        failingSince,
        intermittentSince,
        repeat,
        headlineVerb: own?.headlineVerb,
        itemNoun: own?.itemNoun,
      })) delivered = true
    } catch (err) {
      console.error(`[export-alerts] alert failed for org ${orgId}:`, err)
    }
  }

  // Only start the cooldown once something actually delivered -- otherwise a
  // Slack outage would suppress retries for hours while nobody got paged.
  if (kv && delivered) await recordAlert(kv, backoff, standing, nowMs)
}
