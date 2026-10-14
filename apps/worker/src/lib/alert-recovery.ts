/**
 * All-clear notifications for the rate-aggregated alerts (#253).
 *
 * volume-cliff, failure-rate and slow-execution-rate all page when a rate STARTS
 * spiking and say nothing when it recovers. That makes silence ambiguous in the
 * worst possible way: it means both "still broken, suppressed by the cooldown"
 * and "fine again", which are the two states a reader most needs to tell apart
 * during an incident.
 *
 * THE RECOVERY MARKER IS NOT THE COOLDOWN KEY. They answer different questions:
 * the cooldown says "do not page again yet", the marker says "we owe an
 * all-clear". Reading the second off the first (LESSONS L53, two independent
 * facts sharing one field) would break on precisely the outages that matter,
 * because the cooldown is 30 minutes: anything longer expires it, and the
 * recovery would then arrive with nothing to say it had ever been broken. So the
 * marker gets its own key and a TTL long enough to outlive a real outage.
 *
 * THE INCIDENT RECORD (#2099). The marker's transitions are also the incident's:
 * it appears (opened), a page about it reaches Slack (paged, recorded by the
 * caller at each delivery site with recordPaged), and it is settled (ended). Each
 * is written to the KV outbox (incident-outbox.ts) on the transition only, never
 * per sighting, and never in the way of a page or an all-clear: a recorder fault
 * is reported and the alert carries on. Every function here takes the signal as
 * `IncidentSignal`, so a check arming a prefix the registry does not name fails
 * to compile.
 */
import type { IncidentSignal } from './incident-signals'
import { reportRecordError, writeIncidentEvent, type IncidentContext, type IncidentEnd } from './incident-outbox'
import { formatErr } from './format-error'

export type { IncidentContext, IncidentEnd } from './incident-outbox'

/** KV surface these checks share. Canonical here so the three copies converge. */
export interface RecoveryKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * How long we remember that we owe an all-clear. It is a backstop, not a
 * schedule: the marker is normally cleared by the recovery itself.
 *
 * It must exceed the LONGEST cadence of any check that uses it, by a margin, or a
 * marker written just after one run expires at almost exactly the moment the next
 * run reads it and the all-clear is lost to a race (#1343). The longest such
 * cadence is the daily dead-field tier at 24h, so this is 48h: a full day of
 * margin. A check that ever runs less often than daily must lift this (or derive
 * its own marker TTL from its cadence).
 */
export const RECOVERY_TTL_SECONDS = 48 * 60 * 60

/**
 * How long the condition must stay healthy before the incident counts as OVER
 * (#814). Never shorter than the 30 minute alert cooldown: declaring an incident
 * finished while a repeat page for it is still suppressed would announce an
 * all-clear over an outage the reader has simply stopped being told about.
 *
 * Without this the FIRST healthy tick ended the incident, so a relapse a few
 * minutes later was announced as a brand new one. On 2026-08-14 an Equifax
 * ACRO_GATEWAY outage running 9:25 to 11:04 PM was reported to the team as an
 * incident lasting 5 minutes (LESSONS L160).
 */
export const RECOVERY_REARM_MINUTES = 30

/** Key holding the time we first paged for `id`. */
export function recoveryKey(prefix: IncidentSignal, id: string): string {
  return `${prefix}-recovery:${id}`
}

/**
 * Key holding the last time the condition was observed TRUE.
 *
 * Its own key, not a second use of the recovery marker: that one pins the START
 * of the incident and must never move, this one pins its running END and moves
 * on every failing tick (LESSONS L53).
 */
export function activeKey(prefix: IncidentSignal, id: string): string {
  return `${prefix}-active:${id}`
}

/**
 * Keep the recovery marker alive from a KNOWN start, on every sighting (#1274).
 *
 * `markAlerted` pins the start from the time it is first called and is called only
 * on a page; this one takes the start the caller already knows and is called on
 * every SIGHTING of the condition, whether or not it paged, so a block that is
 * re-observed between pages still refreshes the marker. An existing EARLIER start
 * wins, so a caller holding a later time cannot move it forward either.
 */
export async function keepAlerted(
  kv: RecoveryKv,
  prefix: IncidentSignal,
  id: string,
  alertedAtIso: string,
  incident: IncidentContext,
  now: number,
): Promise<void> {
  const key = recoveryKey(prefix, id)
  const existing = await kv.get(key)
  const existingMs = existing ? Date.parse(existing) : NaN
  const givenMs = Date.parse(alertedAtIso)
  const keep = Number.isFinite(existingMs) && (!Number.isFinite(givenMs) || existingMs <= givenMs) ? existing! : alertedAtIso
  await kv.put(key, keep, { expirationTtl: RECOVERY_TTL_SECONDS })
  // The transitions only: the marker appearing, or its start moving earlier (a
  // caller holding an earlier first sighting). A sighting that changes nothing,
  // which is nearly all of them, records nothing.
  if (existing === null) {
    await writeIncidentEvent(kv, { type: 'opened', signal: prefix, subject: id, startedAt: keep }, incident, now)
  } else if (keep !== existing) {
    await writeIncidentEvent(kv, { type: 'opened', signal: prefix, subject: id, startedAt: keep, previousStartedAt: existing }, incident, now)
  }
}

/**
 * Keep an OPEN incident's marker alive without moving its start, and never open
 * one (#1803). For a run that could not judge the condition: unjudged is not
 * over, but it is not a sighting either, so it can neither start an incident nor
 * say whose it is.
 */
export async function refreshAlerted(kv: RecoveryKv, prefix: IncidentSignal, id: string): Promise<void> {
  const key = recoveryKey(prefix, id)
  const existing = await kv.get(key)
  if (existing !== null) await kv.put(key, existing, { expirationTtl: RECOVERY_TTL_SECONDS })
}

/**
 * Record that a page about the open incident reached Slack (#2099). Called by
 * the check at each DELIVERY site, after its marker is armed, so the record
 * counts pages where they were sent rather than inferring them from the marker
 * (three signals arm with keepAlerted on sightings and page separately). Never
 * throws.
 */
export async function recordPaged(
  kv: RecoveryKv,
  prefix: IncidentSignal,
  id: string,
  incident: IncidentContext,
  now: number,
): Promise<void> {
  let startedAt: string | null
  try {
    startedAt = await kv.get(recoveryKey(prefix, id))
  } catch (e) {
    reportRecordError(incident, `paged ${prefix} ${id} not recorded: the marker could not be read: ${formatErr(e)}`)
    return
  }
  if (startedAt === null) {
    reportRecordError(incident, `paged ${prefix} ${id} not recorded: no open incident to page about`)
    return
  }
  await writeIncidentEvent(kv, { type: 'paged', signal: prefix, subject: id, startedAt }, incident, now)
}

/**
 * Record that an alert delivered, so a later healthy check knows to announce the
 * recovery.
 *
 * Keeps the first-alert time: a long outage re-alerts each time the cooldown
 * lapses, and overwriting the value would reset the clock, so the all-clear would
 * report a minutes-long blip after hours of downtime. But it REFRESHES the TTL on
 * every page, so an outage longer than one TTL does not lose the marker mid-way
 * and with it the all-clear (#1343); the value stays the original start.
 */
export async function markAlerted(
  kv: RecoveryKv,
  prefix: IncidentSignal,
  id: string,
  incident: IncidentContext,
  now: number,
): Promise<void> {
  const key = recoveryKey(prefix, id)
  const existing = await kv.get(key)
  const startedAt = existing ?? new Date(now).toISOString()
  await kv.put(key, startedAt, { expirationTtl: RECOVERY_TTL_SECONDS })
  // Opened only on the transition; a repeat page continues the same incident.
  if (existing === null) await writeIncidentEvent(kv, { type: 'opened', signal: prefix, subject: id, startedAt }, incident, now)
}

/**
 * Call on every check where the condition is TRUE, whether or not it paged.
 *
 * Overwrites deliberately: this is the incident's running end, so the all-clear
 * can report how long the outage lasted rather than how long ago we last spoke
 * about it. Recording it only when we PAGE would collapse to the cooldown's
 * cadence and lose the last hour of an outage.
 */
export async function markSpikeSeen(
  kv: RecoveryKv,
  prefix: IncidentSignal,
  id: string,
  now: number,
): Promise<void> {
  await kv.put(activeKey(prefix, id), new Date(now).toISOString(), {
    expirationTtl: RECOVERY_TTL_SECONDS,
  })
}

/** What an all-clear has to say: when the incident was first paged and when it was last seen. */
export interface RecoveryDue {
  alertedAt: string
  endedAt: string | null
}

/**
 * Whether an all-clear is OWED for `id` right now, and if so what it says.
 *
 * Null when nothing was paged, or while the condition is still inside its
 * re-arm window: one quiet tick is not an ended incident (#814). Reads only,
 * never writes, because the caller has not delivered anything yet. It is one
 * half of `announceRecovery`, split out (#1267) so a check that sends ONE
 * all-clear covering several ids can ask this per id and settle them together
 * once that one message lands.
 */
export async function recoveryDue(
  kv: RecoveryKv,
  prefix: IncidentSignal,
  id: string,
  opts: { now?: number; rearmMinutes?: number } = {},
): Promise<RecoveryDue | null> {
  const alertedAt = await kv.get(recoveryKey(prefix, id))
  if (!alertedAt) return null

  const now = opts.now ?? Date.now()
  const rearmMs = (opts.rearmMinutes ?? RECOVERY_REARM_MINUTES) * 60 * 1000
  const active = await kv.get(activeKey(prefix, id))
  const lastSpike = active ? Date.parse(active) : NaN

  // Still inside the re-arm window: the condition is quiet, not over. Hold BOTH
  // keys, so a relapse continues this incident instead of opening a new one, and
  // keep the cooldown so the relapse stays deduped against the same page.
  if (Number.isFinite(lastSpike) && now - lastSpike < rearmMs) return null

  // An unparseable or absent running end must not hold the all-clear forever
  // (a marker written by an older deploy has no companion key), and must not be
  // guessed at either: say nothing about when it cleared (LESSONS L11).
  const endedAt = Number.isFinite(lastSpike) ? new Date(lastSpike).toISOString() : null
  return { alertedAt, endedAt }
}

/**
 * Close the incident for `id` once its all-clear has DELIVERED: the marker, the
 * running end and the cooldown all go, so the next genuine spike pages at once.
 * The other half of `announceRecovery` (#1267). Never call it on a failed send.
 *
 * `end` says why it ended (#2099). The ended event goes to the outbox BEFORE the
 * markers are deleted, carrying the start and the last sighting, because the
 * markers are the only other copy of either: deleting first would leave nothing
 * to record. A recorder fault does not stop the settle, since the all-clear has
 * already gone out; the record's open row then closes as lapsed.
 */
export async function settleRecovery(
  kv: RecoveryKv,
  prefix: IncidentSignal,
  id: string,
  cooldownKey: string | null,
  end: IncidentEnd,
  now: number,
): Promise<void> {
  try {
    const startedAt = await kv.get(recoveryKey(prefix, id))
    if (startedAt !== null) {
      const active = await kv.get(activeKey(prefix, id))
      const lastSeen = active ? Date.parse(active) : NaN
      await writeIncidentEvent(kv, {
        type: 'ended',
        signal: prefix,
        subject: id,
        startedAt,
        // The last sighting, or null when none was recorded: never a guess (L11).
        endedAt: Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : null,
        reason: end.reason,
        ...(end.successor ? { successor: end.successor } : {}),
      }, end, now)
    }
  } catch (e) {
    reportRecordError(end, `ended ${prefix} ${id} not recorded: the markers could not be read: ${formatErr(e)}`)
  }
  await kv.delete(recoveryKey(prefix, id))
  await kv.delete(activeKey(prefix, id))
  // Null for a check with no per-id cooldown to clear (the schedule watch's is
  // keyed on a whole signature, and lets a relapse through by this marker instead).
  if (cooldownKey !== null) await kv.delete(cooldownKey)
}

/**
 * Call on a HEALTHY check. If we previously paged for `id`, send the all-clear
 * and clear both keys. Returns whether an all-clear was delivered.
 *
 * `send` receives the ISO time of the first page and the ISO time of the last
 * observed failure (null when that was never recorded), so the message can say
 * how long the OUTAGE lasted rather than how long ago we last spoke about it. It
 * returns whether it actually reached Slack.
 *
 * Returns false without sending while the condition is inside its re-arm window:
 * one quiet tick is not an ended incident (#814).
 *
 * On a failed or throwing send BOTH keys are left alone, so the next tick tries
 * again. This is the mirror of "only start the cooldown once the alert
 * delivered": a kicked bot during recovery must not swallow the all-clear and
 * leave the page as the last word.
 */
export async function announceRecovery(
  kv: RecoveryKv,
  prefix: IncidentSignal,
  id: string,
  cooldownKey: string | null,
  incident: IncidentContext,
  send: (alertedAt: string, endedAt: string | null) => Promise<boolean>,
  opts: { now?: number; rearmMinutes?: number; hasEvidence?: () => boolean | Promise<boolean> } = {},
): Promise<boolean> {
  // One reading for the whole all-clear: judging it due and recording its end.
  const now = opts.now ?? Date.now()
  const due = await recoveryDue(kv, prefix, id, { ...opts, now })
  if (!due) return false

  // #817: a check that recovers on the ABSENCE of its condition (the three rate
  // checks) cannot tell a genuine recovery from a workflow that stopped getting
  // traffic: both read as zero matching failures. When the caller supplies an
  // evidence check, the all-clear is HELD until the pipe is observably alive
  // again, so silence never reads as "back to normal" over a dead pipe (L98).
  // Checked only once a recovery is actually owed, so the cost (a failure-rate
  // succeeding-run query) is paid on the rare recovering tick, not every tick.
  // On a throw the incident is held, not cleared: erring toward still-alarmed is
  // the safe side, since a false all-clear is the failure this exists to stop
  // (L345).
  if (opts.hasEvidence) {
    let evident: boolean
    try {
      evident = await opts.hasEvidence()
    } catch (err) {
      console.error(`[alert-recovery] ${prefix} evidence check threw for ${id}, holding the all-clear:`, err)
      return false
    }
    if (!evident) return false
  }

  let delivered: boolean
  try {
    delivered = await send(due.alertedAt, due.endedAt)
  } catch (err) {
    console.error(`[alert-recovery] ${prefix} all-clear failed for ${id}:`, err)
    return false
  }
  if (!delivered) return false

  await settleRecovery(kv, prefix, id, cooldownKey, { ...incident, reason: 'all_clear' }, now)
  return true
}
