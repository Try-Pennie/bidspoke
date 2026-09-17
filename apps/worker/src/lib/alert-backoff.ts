/**
 * Backing off the repeat interval on a condition that STANDS (#1334).
 *
 * Every alerting family in this worker held its reminders on a flat cooldown:
 * the cron heartbeat at six hours, the export family at eight. A flat cooldown
 * is right for a condition that comes and goes and wrong for one that stands,
 * because the fourth identical message is indistinguishable from the first and
 * carries no new information, while arriving at exactly the same volume. That
 * is what teaches a person to scroll past the channel, which costs the next
 * real alert rather than this one (L36).
 *
 * Measured 2026-09-13: three identical "Execution archive 13 month expiry is
 * dark" messages in twelve hours, about a job that was in fact running (#1332).
 *
 * The answer is not to suppress. A standing condition still has to be reported,
 * because a suppression with no expiry is how a real outage goes quiet (L523).
 * So the interval GROWS and then HOLDS: six hours, twelve, then once a day for
 * as long as it lasts. The reminder never stops, and the schedule resets the
 * moment the condition clears, so a flapping condition is reported every time it
 * returns rather than being throttled by its own history.
 *
 * WHAT THIS DOES NOT DO. It does not decide whether to alert, only how soon the
 * next reminder may go. Each caller keeps its own predicate, its own claim and
 * its own message, because a shared backoff that also decided WHEN to speak
 * would be one component holding two unrelated rules.
 */

export interface BackoffKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * The gap before each reminder, in seconds, indexed by how many have already
 * been sent. The last entry repeats for ever.
 *
 * Six hours first, because that is the cadence every family used and the first
 * reminder is the one most likely to be acted on. A day at the end, because a
 * condition still standing after a day and a half is one somebody has decided
 * not to fix today, and a daily line is enough to stop it being forgotten.
 */
export const BACKOFF_STEPS_SECONDS = [6 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60]

/**
 * How long a standing-condition record lives without being refreshed.
 *
 * It is deleted when the condition clears, so this only matters when the clear
 * never comes: a check that is removed from the code, a key that is renamed. A
 * month is long enough that no live condition expires under a running reminder
 * schedule, and short enough that an orphan does not sit in KV for ever.
 */
export const CONDITION_TTL_SECONDS = 30 * 24 * 60 * 60

/** A condition that is currently standing, and how often it has been reported. */
export interface StandingCondition {
  /** ISO timestamp of the FIRST report, kept across every reminder. */
  since: string
  /** How many alerts have been posted for this occurrence. */
  alerts: number
}

const conditionKey = (key: string) => `${key}:condition`
const cooldownKeyFor = (key: string) => `${key}:cooldown`

/** The gap before the next reminder, given how many have already gone out. */
export function intervalSecondsFor(alertsAlreadySent: number): number {
  const last = BACKOFF_STEPS_SECONDS.length - 1
  if (!Number.isFinite(alertsAlreadySent)) return BACKOFF_STEPS_SECONDS[0]
  const index = Math.min(Math.max(Math.floor(alertsAlreadySent), 0), last)
  return BACKOFF_STEPS_SECONDS[index]
}

/**
 * The standing condition for this key, or null if none is on record.
 *
 * A record that cannot be read is treated as no record, so the worst a corrupt
 * value can do is restart the schedule at its shortest interval. It must never
 * throw: this is read on the path that decides whether to page.
 */
export async function readCondition(kv: BackoffKv, key: string): Promise<StandingCondition | null> {
  let raw: string | null
  try {
    raw = await kv.get(conditionKey(key))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { since, alerts } = parsed as { since?: unknown; alerts?: unknown }
    if (typeof since !== 'string' || typeof alerts !== 'number') return null
    return { since, alerts }
  } catch {
    return null
  }
}

/**
 * Record that a reminder just went out, and arm the cooldown for the next one.
 *
 * `standing` is what `readCondition` returned BEFORE this alert; passing null
 * starts a fresh occurrence. The first-detected time is carried forward
 * unchanged, so the age in a reminder is the age of the CONDITION rather than
 * the time since the previous message, which is the number a reader needs.
 */
export async function recordAlert(
  kv: BackoffKv,
  key: string,
  standing: StandingCondition | null,
  nowMs: number,
  // A family whose condition is only ever re-observed by a NEW occurrence (a partner block
  // page, #1265) has no probe to clear it, so its record must expire on its own rather
  // than describe a block from weeks ago as still standing. Defaults to the shared TTL.
  opts: { conditionTtlSeconds?: number } = {},
): Promise<StandingCondition> {
  const next: StandingCondition = {
    since: standing?.since ?? new Date(nowMs).toISOString(),
    alerts: (standing?.alerts ?? 0) + 1,
  }
  await kv.put(conditionKey(key), JSON.stringify(next), { expirationTtl: opts.conditionTtlSeconds ?? CONDITION_TTL_SECONDS })
  await kv.put(cooldownKeyFor(key), '1', { expirationTtl: intervalSecondsFor(next.alerts - 1) })
  return next
}

/** Forget a condition, so its next occurrence starts again at the shortest gap. */
export async function clearCondition(kv: BackoffKv, key: string): Promise<void> {
  await kv.delete(conditionKey(key))
  await kv.delete(cooldownKeyFor(key))
}

/** Is a reminder for this key still inside its cooldown? */
export async function inCooldown(kv: BackoffKv, key: string): Promise<boolean> {
  return (await kv.get(cooldownKeyFor(key))) !== null
}

/**
 * The sentence that makes a reminder legible AS a reminder.
 *
 * Without it the second message is a new incident as far as any reader can see,
 * which is the actual complaint: three messages that each read as a fresh
 * discovery. It says only what is measured, which reminder this is and how long
 * the condition has stood, plus when the next one is due so silence can be told
 * from recovery.
 */
export function describeRepeat(standing: StandingCondition | null, nowMs: number): string | null {
  if (!standing || standing.alerts < 1) return null
  const sinceMs = Date.parse(standing.since)
  const hours = Number.isFinite(sinceMs) ? Math.round((nowMs - sinceMs) / 3_600_000) : null
  const nextHours = Math.round(intervalSecondsFor(standing.alerts) / 3600)
  const age = hours === null ? 'This condition has been standing' : `This condition has been standing for ~${hours}h`
  return (
    `${age} and nothing about it has changed: this is reminder ${standing.alerts + 1}. ` +
    `The next one is in ~${nextHours}h unless it clears first, and it stops as soon as it does.`
  )
}
