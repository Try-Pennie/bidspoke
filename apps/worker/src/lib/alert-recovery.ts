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
 */

/** KV surface these checks share. Canonical here so the three copies converge. */
export interface RecoveryKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * How long we remember that we owe an all-clear. Deliberately far longer than
 * the 30 minute cooldown, so a multi-hour outage still gets announced when it
 * ends. It is a backstop, not a schedule: the marker is normally cleared by the
 * recovery itself.
 */
export const RECOVERY_TTL_SECONDS = 24 * 60 * 60

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
export function recoveryKey(prefix: string, id: string): string {
  return `${prefix}-recovery:${id}`
}

/**
 * Key holding the last time the condition was observed TRUE.
 *
 * Its own key, not a second use of the recovery marker: that one pins the START
 * of the incident and must never move, this one pins its running END and moves
 * on every failing tick (LESSONS L53).
 */
export function activeKey(prefix: string, id: string): string {
  return `${prefix}-active:${id}`
}

/**
 * Keep the recovery marker alive from a KNOWN start, on every sighting (#1274).
 *
 * `markAlerted` pins the start of an incident by never overwriting, but its marker
 * expires after a day and a partner block has lasted five. A condition that is
 * re-observed keeps re-writing the same start time with a fresh TTL, so the marker
 * outlives the block without the start moving. An existing EARLIER start wins, so
 * a caller holding a later time cannot move it forward either.
 */
export async function keepAlerted(
  kv: RecoveryKv,
  prefix: string,
  id: string,
  alertedAtIso: string,
): Promise<void> {
  const key = recoveryKey(prefix, id)
  const existing = await kv.get(key)
  const existingMs = existing ? Date.parse(existing) : NaN
  const givenMs = Date.parse(alertedAtIso)
  const keep = Number.isFinite(existingMs) && (!Number.isFinite(givenMs) || existingMs <= givenMs) ? existing! : alertedAtIso
  await kv.put(key, keep, { expirationTtl: RECOVERY_TTL_SECONDS })
}

/**
 * Record that an alert delivered, so a later healthy check knows to announce the
 * recovery.
 *
 * Does NOT overwrite an existing marker. A long outage re-alerts each time the
 * cooldown lapses, and overwriting would reset the clock, so the all-clear would
 * report a minutes-long blip after hours of downtime.
 */
export async function markAlerted(
  kv: RecoveryKv,
  prefix: string,
  id: string,
  now: number = Date.now(),
): Promise<void> {
  const key = recoveryKey(prefix, id)
  if (await kv.get(key)) return
  await kv.put(key, new Date(now).toISOString(), { expirationTtl: RECOVERY_TTL_SECONDS })
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
  prefix: string,
  id: string,
  now: number = Date.now(),
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
  prefix: string,
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
 */
export async function settleRecovery(
  kv: RecoveryKv,
  prefix: string,
  id: string,
  cooldownKey: string,
): Promise<void> {
  await kv.delete(recoveryKey(prefix, id))
  await kv.delete(activeKey(prefix, id))
  await kv.delete(cooldownKey)
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
  prefix: string,
  id: string,
  cooldownKey: string,
  send: (alertedAt: string, endedAt: string | null) => Promise<boolean>,
  opts: { now?: number; rearmMinutes?: number } = {},
): Promise<boolean> {
  const due = await recoveryDue(kv, prefix, id, opts)
  if (!due) return false

  let delivered: boolean
  try {
    delivered = await send(due.alertedAt, due.endedAt)
  } catch (err) {
    console.error(`[alert-recovery] ${prefix} all-clear failed for ${id}:`, err)
    return false
  }
  if (!delivered) return false

  await settleRecovery(kv, prefix, id, cooldownKey)
  return true
}
