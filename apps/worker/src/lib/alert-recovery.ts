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
 * it appears (opened), a page about it reaches Slack (paged) or does not
 * (undelivered, #3056), both recorded by the caller at each delivery site with
 * recordPageOutcome, and it is settled (ended). Each
 * is written to the KV outbox (incident-outbox.ts) on the transition only, never
 * per sighting, and never in the way of a page or an all-clear: a recorder fault
 * is reported and the alert carries on. Every function here takes the signal as
 * `RecoveryMarkerSignal`, so a check arming a prefix the registry does not name,
 * or one whose registry entry keeps its marker elsewhere (the cron heartbeat,
 * #2103), fails to compile.
 */
import type { IncidentSignal, RecoveryMarkerSignal } from './incident-signals'
import { reportRecordError, writeIncidentEvent, type IncidentContext, type IncidentEnd } from './incident-outbox'
import { formatErr } from './format-error'
import { releaseClaimQuietly, type AlertClaims } from './alert-claim'

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
export function recoveryKey(prefix: RecoveryMarkerSignal, id: string): string {
  return `${prefix}-recovery:${id}`
}

/**
 * Key holding the last time the condition was observed TRUE.
 *
 * Its own key, not a second use of the recovery marker: that one pins the START
 * of the incident and must never move, this one pins its running END and moves
 * on every failing tick (LESSONS L53).
 */
export function activeKey(prefix: RecoveryMarkerSignal, id: string): string {
  return `${prefix}-active:${id}`
}

/**
 * Key holding the first HEALTHY observation after the last sighting (#2580).
 *
 * The running end is the last time the condition was seen, which is not when it
 * cleared: for a check that runs every five minutes, a one run incident's last
 * sighting is the very tick that paged. The first check after it to find the
 * condition gone is the other side of the end, and the only time anything was
 * observed clear. It is stored with the sighting it came after, so a relapse
 * (which moves the running end) makes it stale without anyone deleting it.
 */
export function healthyKey(prefix: RecoveryMarkerSignal, id: string): string {
  return `${prefix}-healthy:${id}`
}

/** The stored first healthy observation: the sighting it followed and when it was made. */
interface HealthyRecord {
  after: string
  at: string
}

function readHealthyRecord(raw: string | null): HealthyRecord | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { after, at } = parsed as Record<string, unknown>
    if (typeof after !== 'string' || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null
    return { after, at }
  } catch {
    return null
  }
}

/**
 * The first healthy observation after the running end `active`, recording `now`
 * as that observation when none is stored for it yet (#2580). Called only from
 * recoveryDue, which every check calls on a HEALTHY tick and only there, so the
 * first call after a sighting is the first healthy check after it.
 *
 * Null when there is no running end to come after, when `now` is not after it
 * (the same tick, or another isolate's clock behind: no healthy observation), or
 * when the record cannot be read or written. Never throws: an all-clear that
 * cannot name its first healthy check says it had cleared by the announcing tick
 * instead, and must never be held for want of this (L345).
 */
async function firstHealthyAfter(
  kv: RecoveryKv,
  prefix: RecoveryMarkerSignal,
  id: string,
  active: string | null,
  lastSpike: number,
  now: number,
): Promise<string | null> {
  if (active === null || !Number.isFinite(lastSpike) || now <= lastSpike) return null
  const key = healthyKey(prefix, id)
  try {
    const stored = readHealthyRecord(await kv.get(key))
    if (stored && stored.after === active && Date.parse(stored.at) > lastSpike) return stored.at
    const at = new Date(now).toISOString()
    await kv.put(key, JSON.stringify({ after: active, at } satisfies HealthyRecord), { expirationTtl: RECOVERY_TTL_SECONDS })
    return at
  } catch (err) {
    console.error(`[alert-recovery] ${prefix} first healthy check for ${id} could not be read or recorded, so the all-clear will say only when it had cleared by: ${formatErr(err)}`)
    return null
  }
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
  prefix: RecoveryMarkerSignal,
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
export async function refreshAlerted(kv: RecoveryKv, prefix: RecoveryMarkerSignal, id: string): Promise<void> {
  const key = recoveryKey(prefix, id)
  const existing = await kv.get(key)
  if (existing !== null) await kv.put(key, existing, { expirationTtl: RECOVERY_TTL_SECONDS })
}

/**
 * Key holding the start of an incident whose pages were due and reached nobody
 * (#3056), and when the last of them was refused: `{ startedAt, lastAt }`.
 *
 * Its own key, never the recovery marker: the marker means somebody was told.
 * Pages read it to say "first reported at" or to word a repeat, and the
 * all-clear is owed for it, so arming it for a page nobody received would make
 * the next page claim an earlier report and end the incident with an all-clear
 * about an alert nobody saw (the rule standing-connection-incidents.ts and
 * pg-cron-watch.ts record). This key is read only on the rare refused page, and
 * only to keep one stretch of refusals as one incident in the record.
 */
export function dueKey(signal: IncidentSignal, id: string): string {
  return `${signal}-due:${id}`
}

/** What dueKey holds. */
interface DueRecord {
  startedAt: string
  lastAt: string
}

function readDueRecord(raw: string | null): DueRecord | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { startedAt, lastAt } = parsed as Record<string, unknown>
    if (typeof startedAt !== 'string' || typeof lastAt !== 'string') return null
    if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(lastAt))) return null
    return { startedAt, lastAt }
  } catch {
    return null
  }
}

/**
 * What a post under a cooldown and a claim came to (postMinutePage,
 * postStandingOutcome): delivered, tried and not delivered, or not tried by
 * this tick at all.
 */
export type PostAttempt = 'sent' | 'not_sent' | 'in_cooldown' | 'claimed_elsewhere'

/**
 * Whether this tick tried a page at all (#3056): a page held by the cooldown,
 * or left to the tick that holds the claim, was never due from this one, so it
 * has no outcome to record.
 */
export function pageTried(attempt: PostAttempt): boolean {
  return attempt === 'sent' || attempt === 'not_sent'
}

/**
 * The least time between two refused pages recorded about an incident nobody
 * was told of (#3056). Every scheduled check runs at most once a minute, so for
 * them each refused page is recorded; a check paged from the engine's runs
 * (lead-validation-config-alert.ts) retries on every lead, and is recorded at
 * most once a minute.
 */
export const UNDELIVERED_RECORD_GAP_MS = 60_000

export interface PageOutcomeOptions {
  /**
   * How long after a refused page the next one still belongs to the same
   * incident, when no page about it reached anybody. RECOVERY_REARM_MINUTES,
   * the gap an all-clear waits for, unless the check passes more: a check that
   * runs hourly or daily passes about two of its intervals, so the refused
   * pages of consecutive runs that each find the condition are one incident.
   */
  sameIncidentWithinMinutes?: number
}

/**
 * Record what became of a page about an incident (#2099, #3056). THE one
 * place a delivery site records its page, whatever the send answered: call it
 * after every page the check tried to send, with whether it reached Slack, and
 * never inside the branch that runs only on a delivered send.
 * `__guards__/worker/page-outcomes-recorded.test.ts` fails on a site that
 * arms a marker without calling it, or that hands it a literal true.
 *
 * Delivered: a `paged` event against the open incident (its marker), so the
 * record counts pages where they were sent rather than inferring them from the
 * marker (several signals arm with keepAlerted on sightings and page
 * separately). Call it after the marker is armed.
 *
 * Not delivered: an `undelivered` event. Against the open incident when one is
 * (a repeat page somebody's earlier page announced). When none is, nobody has
 * been told: the marker is left alone (dueKey says why) and the record keeps
 * the incident that was due as its own row, from the first refused page of
 * the stretch, closed, since no all-clear is owed for it. Refused pages no
 * further apart than `sameIncidentWithinMinutes` are one stretch.
 *
 * Never throws: a recorder fault is reported and the alert carries on.
 */
export async function recordPageOutcome(
  kv: RecoveryKv,
  prefix: RecoveryMarkerSignal,
  id: string,
  incident: IncidentContext,
  now: number,
  delivered: boolean,
  opts: PageOutcomeOptions = {},
): Promise<void> {
  let openStart: string | null
  try {
    openStart = await kv.get(recoveryKey(prefix, id))
  } catch (e) {
    reportRecordError(incident, `${delivered ? 'paged' : 'undelivered'} ${prefix} ${id} not recorded: the marker could not be read: ${formatErr(e)}`)
    return
  }
  await recordPageOutcomeOn(kv, prefix, id, openStart, incident, now, delivered, opts)
}

/**
 * recordPageOutcome for a check that keeps its open incident in its own state
 * (the cron heartbeat, #2103): the caller passes the open incident's start,
 * or null when none is open. Never throws.
 */
export async function recordPageOutcomeOn(
  kv: RecoveryKv,
  signal: IncidentSignal,
  id: string,
  openStart: string | null,
  incident: IncidentContext,
  now: number,
  delivered: boolean,
  opts: PageOutcomeOptions = {},
): Promise<void> {
  if (delivered) {
    if (openStart === null) {
      reportRecordError(incident, `paged ${signal} ${id} not recorded: no open incident to page about`)
    } else {
      await writeIncidentEvent(kv, { type: 'paged', signal, subject: id, startedAt: openStart }, incident, now)
    }
    // Somebody has been told: a refusal after this is about the open incident,
    // or, once it has ended, the start of a new stretch.
    try {
      await kv.delete(dueKey(signal, id))
    } catch (e) {
      reportRecordError(incident, `${signal} ${id}: the record of earlier refused pages could not be cleared: ${formatErr(e)}`)
    }
    return
  }

  if (openStart !== null) {
    await writeIncidentEvent(kv, { type: 'undelivered', signal, subject: id, startedAt: openStart, unannounced: false }, incident, now)
    return
  }

  const at = new Date(now).toISOString()
  const withinMs = (opts.sameIncidentWithinMinutes ?? RECOVERY_REARM_MINUTES) * 60 * 1000
  let startedAt = at
  try {
    const due = readDueRecord(await kv.get(dueKey(signal, id)))
    if (due && now - Date.parse(due.lastAt) <= withinMs && Date.parse(due.startedAt) <= now) {
      // A check paged from every lead retries on every lead while Slack refuses
      // it: one record a minute is enough, and KV takes one write a second to a key.
      if (now - Date.parse(due.lastAt) < UNDELIVERED_RECORD_GAP_MS) return
      startedAt = due.startedAt
    }
  } catch (e) {
    reportRecordError(incident, `${signal} ${id}: the record of earlier refused pages could not be read, so this one starts its own incident: ${formatErr(e)}`)
  }
  try {
    const ttl = Math.max(RECOVERY_TTL_SECONDS, Math.ceil(withinMs / 1000) + 3_600)
    await kv.put(dueKey(signal, id), JSON.stringify({ startedAt, lastAt: at } satisfies DueRecord), { expirationTtl: ttl })
  } catch (e) {
    reportRecordError(incident, `${signal} ${id}: the record of this refused page could not be kept, so the next one starts its own incident: ${formatErr(e)}`)
  }
  await writeIncidentEvent(kv, { type: 'undelivered', signal, subject: id, startedAt, unannounced: true }, incident, now)
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
  prefix: RecoveryMarkerSignal,
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
  prefix: RecoveryMarkerSignal,
  id: string,
  now: number,
): Promise<void> {
  await kv.put(activeKey(prefix, id), new Date(now).toISOString(), {
    expirationTtl: RECOVERY_TTL_SECONDS,
  })
}

/**
 * The claim an all-clear is sent under (#2062): only a minute alert passes one
 * (minuteAllClearClaim in alert-fanout.ts, which says why only those). Typed
 * here so this module needs nothing from the fan-out.
 */
export interface AllClearClaim {
  claims: AlertClaims | undefined
  key: string
  ttlSeconds: number
}

/**
 * What an all-clear has to say: when the incident was first paged, when it was
 * last seen, and the first healthy check after that (#2580), each null when it
 * was not recorded.
 */
export interface RecoveryDue {
  alertedAt: string
  endedAt: string | null
  firstHealthyAt: string | null
}

/**
 * Whether an all-clear is OWED for `id` right now, and if so what it says.
 *
 * Null when nothing was paged, or while the condition is still inside its
 * re-arm window: one quiet tick is not an ended incident (#814). It settles
 * nothing, because the caller has not delivered anything yet: its one write is
 * the first healthy observation after the last sighting (#2580), made on the
 * first healthy tick that asks, so CALL IT ONLY ON A HEALTHY TICK. It is one
 * half of `announceRecovery`, split out (#1267) so a check that sends ONE
 * all-clear covering several ids can ask this per id and settle them together
 * once that one message lands.
 */
export async function recoveryDue(
  kv: RecoveryKv,
  prefix: RecoveryMarkerSignal,
  id: string,
  opts: { now?: number; rearmMinutes?: number; recordFirstHealthy?: boolean } = {},
): Promise<RecoveryDue | null> {
  const alertedAt = await kv.get(recoveryKey(prefix, id))
  if (!alertedAt) return null

  const now = opts.now ?? Date.now()
  const rearmMs = (opts.rearmMinutes ?? RECOVERY_REARM_MINUTES) * 60 * 1000
  const active = await kv.get(activeKey(prefix, id))
  const lastSpike = active ? Date.parse(active) : NaN

  // This tick is healthy: if it is the first since the last sighting, it is the
  // first check to find the condition clear, which the all-clear names (#2580).
  // Not for a caller whose quiet tick is not yet evidence of health (the
  // hasEvidence checks of announceRecovery, #817): a tick with no traffic reads
  // as quiet too, and must not be named as the first one to find it clear.
  const firstHealthyAt = opts.recordFirstHealthy === false ? null : await firstHealthyAfter(kv, prefix, id, active, lastSpike, now)

  // Still inside the re-arm window: the condition is quiet, not over. Hold BOTH
  // keys, so a relapse continues this incident instead of opening a new one, and
  // keep the cooldown so the relapse stays deduped against the same page.
  if (Number.isFinite(lastSpike) && now - lastSpike < rearmMs) return null

  // An unparseable or absent running end must not hold the all-clear forever
  // (a marker written by an older deploy has no companion key), and must not be
  // guessed at either: say nothing about when it cleared (LESSONS L11).
  const endedAt = Number.isFinite(lastSpike) ? new Date(lastSpike).toISOString() : null
  return { alertedAt, endedAt, firstHealthyAt }
}

/**
 * Close the incident for `id` once its all-clear has DELIVERED: the marker, the
 * running end, the first healthy check (#2580) and the cooldown all go, so the
 * next genuine spike pages at once.
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
  prefix: RecoveryMarkerSignal,
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
  await kv.delete(healthyKey(prefix, id))
  // Null for a check with no per-id cooldown to clear (the schedule watch's is
  // keyed on a whole signature, and lets a relapse through by this marker instead).
  if (cooldownKey !== null) await kv.delete(cooldownKey)
}

/**
 * Call on a HEALTHY check. If we previously paged for `id`, send the all-clear
 * and clear its keys (settleRecovery). Returns whether an all-clear was delivered.
 *
 * `send` receives the ISO time of the first page, the ISO time of the last
 * observed failure (null when that was never recorded), so the message can say
 * how long the OUTAGE lasted rather than how long ago we last spoke about it,
 * and the first healthy check after that failure (null when not recorded), so it
 * can say when the condition was first seen clear rather than presenting the
 * last failure as the clearing time (#2580). It returns whether it actually
 * reached Slack.
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
  prefix: RecoveryMarkerSignal,
  id: string,
  cooldownKey: string | null,
  incident: IncidentContext,
  send: (alertedAt: string, endedAt: string | null, firstHealthyAt: string | null) => Promise<boolean>,
  opts: { now?: number; rearmMinutes?: number; hasEvidence?: () => boolean | Promise<boolean>; claim?: AllClearClaim } = {},
): Promise<boolean> {
  // One reading for the whole all-clear: judging it due and recording its end.
  // A check that needs evidence of recovery records no first healthy check: its
  // quiet ticks are not judged for evidence until the all-clear is owed, so the
  // first one may be a dead pipe (#817). Its all-clear says it had cleared by the
  // tick that found the evidence, which is what was observed (#2580).
  const now = opts.now ?? Date.now()
  const due = await recoveryDue(kv, prefix, id, { now, rearmMinutes: opts.rearmMinutes, recordFirstHealthy: !opts.hasEvidence })
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

  // #2062: a minute alert claims its all-clear here, once it is owed and
  // evident, so a quiet minute makes no call to the claim object for each
  // workflow. A stalled tick overlapping the next minute's then sends it once.
  // The claim fails open (makeAlertClaims). The marker is read again AFTER the
  // claim (L157): a tick that judged it owed before another tick's claim lapsed
  // must not send an all-clear that tick already settled.
  const claim = opts.claim
  // Never throws: a failed release must not replace the send's own failure or
  // turn a held all-clear into a throw (the claim then lapses at its TTL).
  const release = () => (claim ? releaseClaimQuietly(claim.claims, claim.key) : Promise.resolve())
  if (claim?.claims) {
    if (!(await claim.claims.claim(claim.key, claim.ttlSeconds))) {
      console.log(`[alert-recovery] ${prefix} all-clear for ${id} claimed by another tick`)
      return false
    }
    if (!(await kv.get(recoveryKey(prefix, id)))) {
      await release()
      return false
    }
  }

  let delivered: boolean
  try {
    delivered = await send(due.alertedAt, due.endedAt, due.firstHealthyAt)
  } catch (err) {
    console.error(`[alert-recovery] ${prefix} all-clear failed for ${id}:`, err)
    // A throw cannot say whether Slack took it (a timeout, a connection lost
    // after the request went out), so a claim is KEPT for its TTL: at worst the
    // all-clear is late, never sent twice by the next tick. The marker stays,
    // so it is tried again once the claim lapses.
    if (claim?.claims) console.error(`[alert-recovery] ${claim.key}: the all-clear threw, so it may have reached Slack; the claim is kept for ${claim.ttlSeconds} s rather than freed`)
    return false
  }
  // False is an answer: Slack refused it, or no request went out. Freed so the next tick retries.
  if (!delivered) {
    await release()
    return false
  }

  await settleRecovery(kv, prefix, id, cooldownKey, { ...incident, reason: 'all_clear' }, now)
  return true
}
