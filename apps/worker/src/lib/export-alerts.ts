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
import { slackOrgIds } from './alert-fanout'
import { sendExportFailureAlert } from './slack'
import { buildFixHint, buildConsequence, isTransientExportError } from './export-error-hints'
import { clearCondition, describeRepeat, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf } from './alert-backoff'

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
// still sees the marker; refreshed on every failure. A clean run stamps it as
// recovered rather than clearing it (#1445), so it is forgotten only by this
// TTL.
export const EXPORT_ALERT_PENDING_TTL_SECONDS = 26 * 60 * 60

/**
 * The grace marker, which now records whether a run has SUCCEEDED since the
 * first failure (#1441).
 *
 * It used to be a bare ISO timestamp that a success deleted outright. The
 * consequence was measured on 2026-09-22: two archive timeouts 22 successful
 * runs apart were reported as one incident, "failing since" a day earlier, with
 * reminders escalating against a condition that had healed twice.
 *
 * Deleting it on a success is not the answer: a job alternating a failure with a
 * clean run would re-arm the grace every other run and never reach the failure
 * that pages (#1445). So a clean run now KEEPS the marker and stamps it as
 * recovered, rather than deleting it, which lets the message say which of the
 * two it is and keeps the alternating pattern pageable. The marker is forgotten
 * only by its TTL.
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
 * The stored instant, or null when it will not parse (L50).
 *
 * Every sentence built from this goes through `new Date(...)` and an
 * Intl formatter, which render an unparseable value as the words "Invalid
 * Date" rather than refusing. A marker that has been damaged must still PAGE,
 * since a failure demonstrably happened, so the remedy is to drop the claim
 * about WHEN rather than the alert itself.
 */
function validInstant(iso: string): string | null {
  return Number.isFinite(new Date(iso).getTime()) ? iso : null
}

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
/**
 * A remedy that replaces the job name and its framing with a plain title
 * (Dan, 2026-10-01: "It's so hard to understand right now"). The alert is the
 * title, the findings, an optional context line and an optional fix, nothing
 * else, so each finding has to read on its own.
 */
export interface TitledRemedy {
  /** The header, in place of "<job name> <verb>". */
  title: string
  /** One line under the findings, such as who last changed the setting. */
  context?: string
  /** The "Fix" line. Absent means the alert carries no fix line at all. */
  fixHint?: string
}

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

/**
 * What identifies each finding's problem across runs (#1768). Without it a
 * finding means its words with every number read as one (alert-backoff
 * meaningOf), which covers a count, an age or a day of the month that moves
 * between runs. A caller whose distinct problems differ only in their numbers,
 * or whose moving part is a word, names its own.
 */
export interface AlertMeaning {
  /** One per finding, in the same order as the findings. */
  keys?: readonly string[]
}

/** The caller's keys when they name every finding; otherwise the default meaning, so a mismatch never loses the page. */
function meaningKeys(jobName: string, errors: readonly string[], keys: readonly string[] | undefined): readonly string[] | undefined {
  if (keys === undefined || keys.length === errors.length) return keys
  console.error(`[export-alerts] ${jobName}: ${keys.length} meaning keys for ${errors.length} findings, so each finding is matched by its default meaning`)
  return undefined
}

export async function notifyExportFailure(
  supabase: SupabaseClient,
  jobName: string,
  errors: string[],
  kv: KvLike | undefined,
  remedy: AlertRemedy | TitledRemedy | ExportJobWording,
  nowMs: number = Date.now(),
  meaning: AlertMeaning = {},
): Promise<void> {
  const pendingKey = `export-alert-pending:${jobName}`
  // The reminder schedule for this job's standing failure (#1334).
  const backoff = `export-alert:${jobName}`

  // A clean run is a recovery, so it goes through the same path a caller that
  // reports its health separately uses (#1441): the standing condition clears,
  // but the grace marker is KEPT and stamped as interrupted rather than deleted.
  // Deleting it was the #1445 bug: a job that fails every other run re-armed the
  // grace on each clean run and never reached the second failure that pages.
  // Handling it here fixes every clean-run caller at once (L30), not only the
  // few that could be moved onto notifyExportRecovery by hand.
  if (errors.length === 0) {
    await notifyExportRecovery(kv, jobName)
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
    // WHICH of the two sentences this earns is decided from what was recorded
    // rather than from the fact that a marker exists (#1441, L11). A run
    // succeeded in between means this is intermittent, and saying "failing since"
    // would name a stretch that demonstrably ended.
    const since = validInstant(pending.since)
    if (since === null) console.warn(`[export-alerts] ${jobName}: pending marker holds an unreadable time, alerting without it`)
    else if (pending.recovered) intermittentSince = since
    else failingSince = since

    // Record the marker forward. With no success in between, keep the original
    // first-failure time and re-arm the TTL so a long outage cannot expire the
    // marker mid-outage and silently restart the grace. If a success DID come
    // between (this is the first failure after a recovery), start a FRESH
    // standing streak from now: a run that then keeps failing is a standing
    // outage and must read "failing since", not "intermittent since <an old
    // time>" for ever (#1445).
    const forward: PendingFailure = pending.recovered
      ? { since: new Date().toISOString(), recovered: false }
      : pending
    await kv.put(pendingKey, writePendingFailure(forward), { expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS })
  }

  // Classify once, not per org: the same errors produce the same advice. The
  // consequence sentence comes from the same classification (#1180), so the
  // alert's second sentence and its remedy cannot disagree about what happened.
  // 'export-job' means "classify my message text as an export error", which is
  // right for the export and purge jobs the classifier was built from and wrong
  // for everything else (#542, #1166).
  const own = remedy === 'export-job' ? undefined : remedy
  const titled = own && 'title' in own ? own : undefined
  const explained = own && !('title' in own) ? own : undefined
  const fixHint = titled ? titled.fixHint : (explained?.fixHint ?? buildFixHint(errors))
  const consequence = titled ? undefined : (explained?.consequence ?? buildConsequence(errors))

  // What this alert says, compared with what the last one for this job said
  // (#1768). The standing condition is keyed on the job, so without this a
  // different problem from the same job was posted as a reminder that nothing
  // had changed. A new problem goes out at once and restarts the schedule.
  const print = await fingerprintAlert({
    title: titled?.title ?? `${jobName} ${explained?.headlineVerb ?? ''}`.trim(),
    findings: errors,
    keys: meaningKeys(jobName, errors, meaning.keys),
    alsoShown: [consequence, fixHint, titled?.context].filter((s): s is string => typeof s === 'string' && s !== ''),
  })
  const standing = kv ? await readCondition(kv, backoff) : null
  const recurrence = recurrenceOf(standing, print)

  // Already paged for this ongoing issue; stay quiet until it recovers (the
  // condition is cleared above) or the current interval expires. The interval
  // grows while the failure stands, so a long outage is still reported and does
  // not arrive at the volume that teaches people to skip the channel. Only a
  // record that shows the last post was about something else skips the
  // cooldown. One from before fingerprints, or a cooldown whose record cannot be
  // read, says something was posted without saying what, so it waits: every
  // condition standing at the deploy does not post at once, and when it does
  // post, it posts as new.
  const different = recurrence.kind === 'new' && standing !== null
  if (kv && !different && (await inCooldown(kv, backoff))) return
  const repeat = recurrence.kind === 'reminder' ? (describeRepeat(recurrence.standing, nowMs, recurrence.unchanged) ?? undefined) : undefined

  const orgIds = await slackOrgIds(supabase, 'export-alerts')

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
        headlineVerb: explained?.headlineVerb,
        itemNoun: explained?.itemNoun,
        title: titled?.title,
        context: titled?.context,
      })) delivered = true
    } catch (err) {
      console.error(`[export-alerts] alert failed for org ${orgId}:`, err)
    }
  }

  // Only start the cooldown once something actually delivered -- otherwise a
  // Slack outage would suppress retries for hours while nobody got paged.
  if (kv && delivered) {
    await recordAlert(kv, backoff, recurrence.kind === 'reminder' ? recurrence.standing : null, nowMs, { fingerprint: nextFingerprint(standing, print) })
  }
}
