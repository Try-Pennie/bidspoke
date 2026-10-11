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

import schedule from './alert-backoff-schedule.json'

export interface BackoffKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * The gap before each reminder, in seconds, indexed by how many have already
 * been sent. The last entry repeats for ever.
 *
 * The values live in alert-backoff-schedule.json, not here, because Deploy Drift
 * backs off on the same schedule from GitHub's side (#1761) and reads that file
 * with jq. It cannot route its alerts through this worker, whose death it exists
 * to report (L71), so one file is the only way the two stay the same (L41).
 *
 * Six hours first, because that is the cadence every family used and the first
 * reminder is the one most likely to be acted on. A day at the end, because a
 * condition still standing after a day and a half is one somebody has decided
 * not to fix today, and a daily line is enough to stop it being forgotten.
 */
export const BACKOFF_STEPS_SECONDS: number[] = schedule.stepsSeconds

/**
 * How long a standing-condition record lives without being refreshed.
 *
 * It is deleted when the condition clears, so this only matters when the clear
 * never comes: a check that is removed from the code, a key that is renamed. A
 * month is long enough that no live condition expires under a running reminder
 * schedule, and short enough that an orphan does not sit in KV for ever.
 */
export const CONDITION_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * What the alerts for a condition have said, hashed (#1768).
 *
 * The condition used to be keyed on the job alone, so a different problem from
 * the same job was posted as a reminder of the old one, "nothing about it has
 * changed" included: the Lead status check posted three different problems on
 * Oct 3, 4 and 5, and the last two said exactly that (L641). So each post now
 * records what it was about, and the next run is compared against it.
 */
export interface AlertFingerprint {
  /**
   * Every problem posted while this condition has stood, each hashed with the
   * title it was posted under. A union rather than the last post alone, so a
   * finding that clears and comes back, or a count whose wording flips between
   * "1 sale" and "2 sales", posts at once at most once per stretch.
   */
  keys: string[]
  /** Exactly what the last post showed, hashed, so a reminder says nothing changed only when nothing did. */
  text: string
}

/** A condition that is currently standing, and how often it has been reported. */
export interface StandingCondition {
  /** ISO timestamp of the FIRST report, kept across every reminder. */
  since: string
  /** How many alerts have been posted for this occurrence. */
  alerts: number
  /**
   * What the last post said (#1768). Absent on a record written before it, of
   * which there are live ones in production KV as this ships, and on a record
   * whose fingerprint is damaged: both are read as unknown, never as the same.
   */
  fingerprint?: AlertFingerprint
}

const conditionKey = (key: string) => `${key}:condition`
const cooldownKeyFor = (key: string) => `${key}:cooldown`

/** The cooldown key for a family key, for a caller that settles a recovery and must name it (#1274). */
export const backoffCooldownKey = cooldownKeyFor

/**
 * The gap before the next reminder, given how many have already gone out.
 *
 * `steps` defaults to the shared schedule. An urgent path (a database unreachable,
 * a volume cliff) passes its own, so its FIRST reminder keeps the short gap that
 * matters when the condition is actively harmful, then it climbs to the same daily
 * tail as everything else (#1337). The last entry repeats for ever either way.
 */
export function intervalSecondsFor(alertsAlreadySent: number, steps: readonly number[] = BACKOFF_STEPS_SECONDS): number {
  const last = steps.length - 1
  if (!Number.isFinite(alertsAlreadySent)) return steps[0]
  const index = Math.min(Math.max(Math.floor(alertsAlreadySent), 0), last)
  return steps[index]
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
    const { since, alerts, fingerprint } = parsed as { since?: unknown; alerts?: unknown; fingerprint?: unknown }
    if (typeof since !== 'string' || typeof alerts !== 'number') return null
    const print = readFingerprint(fingerprint)
    return print ? { since, alerts, fingerprint: print } : { since, alerts }
  } catch {
    return null
  }
}

/** A stored fingerprint, or undefined when there is none or it is not the shape this module writes. */
function readFingerprint(value: unknown): AlertFingerprint | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { keys, text } = value as { keys?: unknown; text?: unknown }
  if (typeof text !== 'string') return undefined
  if (!Array.isArray(keys) || !keys.every((k): k is string => typeof k === 'string')) return undefined
  return { keys, text }
}

/** 64 bits of SHA-256: ample to tell one alert's problems apart, and short enough to keep a union of them in one record. */
async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()

/** An ISO timestamp, read whole: its hour follows the letter T, which NUMBER would otherwise keep as part of a name. */
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** A run of eight or more hex characters holding a digit: a statement handle, a request id, a hash. */
const HEX_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi
/**
 * A number standing on its own, with any thousands separators or decimal point
 * inside it. Digits after a letter are part of a name (Liberty1, Dot818, M1), so
 * they are kept: folded, two numbered partners would read as one problem.
 */
const NUMBER = /(?<![A-Za-z])\d(?:[\d,.]*\d)?/g
const UNIT = '(?:millisecond|second|minute|hour|day|week)s?'
/**
 * A duration once its numbers are folded: as describeDuration words one ("under
 * a minute", "# hour # minutes"), or compactly ("#h", "#m", "#ms"). An age that
 * grows walks through nine of describeDuration's phrasings in its first hours.
 */
const DURATION = new RegExp(`\\bunder a minute\\b|#(?:ms|s|m|h|d)\\b|# ${UNIT}(?: (?:and )?# ${UNIT})*`, 'g')
/** A noun after a count, in the plural: "# entries", "# sales". */
const PLURAL_IES = /# ([a-z]+)ies\b/gi
const PLURAL_S = /# ([a-z]{2,}?)s\b/gi

/**
 * A finding's meaning when its caller names none (#1768): its words, with every
 * number, uuid and hex id read as one placeholder, every duration as one, and a
 * noun after a count in the singular. Most checks that alert through the export
 * alerter put a count, an age, a time or a day of the month in their findings,
 * which moves on every run while the problem stays the same, and eleven of them
 * run every hour or more often, so matching on the raw words would post every
 * run as new. Words are kept, so a partner named in a finding still tells it
 * apart ("Liberty1" and "Dot818" read differently). What is left, such as
 * "is" turning to "are" beside a count, is a phrasing the union of posted
 * problems lets through once per stretch. A caller whose distinct problems
 * differ only in their numbers passes its own keys.
 */
export function meaningOf(finding: string): string {
  return finding
    .replace(ISO_TIME, '#')
    .replace(UUID, '#')
    .replace(HEX_ID, '#')
    .replace(NUMBER, '#')
    .replace(DURATION, '#t')
    .replace(PLURAL_IES, '# $1y')
    .replace(PLURAL_S, '# $1')
}

/**
 * The fingerprint of one alert (#1768). `keys` names each finding's problem by
 * meaning and defaults to meaningOf of each finding; `alsoShown` is any line
 * the alert shows beside its findings (a context or fix line), which counts
 * toward whether the words changed but names no problem. Order and repeats do
 * not count. Hashed, so the record holds no finding text.
 */
export async function fingerprintAlert(alert: {
  title: string
  findings: readonly string[]
  keys?: readonly string[]
  alsoShown?: readonly string[]
}): Promise<AlertFingerprint> {
  const meaning = sortedUnique(alert.keys ?? alert.findings.map(meaningOf))
  return {
    keys: await Promise.all(meaning.map((k) => shortHash(`${alert.title}\n${k}`))),
    text: await shortHash(JSON.stringify([alert.title, sortedUnique(alert.findings), sortedUnique(alert.alsoShown ?? [])])),
  }
}

/** The most problems a standing record remembers beyond the ones in the current post, which it always keeps. */
export const MAX_REMEMBERED_KEYS = 100

/**
 * The fingerprint to store after posting `print` (#1768): this post's words, and
 * its problems added to those already posted while the condition stood. A
 * record with no fingerprint contributes none. The current post's keys are
 * always kept whole, so a large post can never read as new on its next run.
 */
export function nextFingerprint(standing: StandingCondition | null, print: AlertFingerprint): AlertFingerprint {
  const current = new Set(print.keys)
  const older = (standing?.fingerprint?.keys ?? []).filter((k) => !current.has(k))
  return { keys: [...print.keys, ...older.slice(0, MAX_REMEMBERED_KEYS)], text: print.text }
}

/**
 * How a run's alert relates to the condition standing for its key (#1768).
 *
 * new: nothing stands, or some problem in this run was not posted while the
 * condition has stood (a title not used before makes every problem new). It is
 * posted as a first alert, and the reminder schedule restarts.
 *
 * reminder: every problem in this run was posted before. One that cleared does
 * not make it new. `unchanged` is true only when what this alert shows is word
 * for word what the last post showed, the one case where saying nothing
 * changed is measured rather than assumed.
 *
 * unknown: the record was written before fingerprints, or its fingerprint is
 * damaged, so what it was about cannot be read (L50). It is never treated as
 * the same problem.
 */
export type Recurrence =
  | { kind: 'new' }
  | { kind: 'reminder'; standing: StandingCondition; unchanged: boolean }
  | { kind: 'unknown'; standing: StandingCondition }

export function recurrenceOf(standing: StandingCondition | null, print: AlertFingerprint): Recurrence {
  if (!standing) return { kind: 'new' }
  const last = standing.fingerprint
  if (!last) return { kind: 'unknown', standing }
  const posted = new Set(last.keys)
  if (!print.keys.every((k) => posted.has(k))) return { kind: 'new' }
  return { kind: 'reminder', standing, unchanged: last.text === print.text }
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
  // `fingerprint` is what this alert said (#1768), so the next run can tell a reminder from a new problem.
  // `stepsSeconds` lets an urgent path use its own schedule (#1337); it defaults to
  // the shared one. It must be the same schedule on every call for a key, since the
  // cooldown is set from it each time.
  opts: { conditionTtlSeconds?: number; fingerprint?: AlertFingerprint; stepsSeconds?: readonly number[] } = {},
): Promise<StandingCondition> {
  const next: StandingCondition = {
    since: standing?.since ?? new Date(nowMs).toISOString(),
    alerts: (standing?.alerts ?? 0) + 1,
    ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
  }
  await kv.put(conditionKey(key), JSON.stringify(next), { expirationTtl: opts.conditionTtlSeconds ?? CONDITION_TTL_SECONDS })
  await kv.put(cooldownKeyFor(key), '1', { expirationTtl: intervalSecondsFor(next.alerts - 1, opts.stepsSeconds) })
  return next
}

/**
 * Re-arm a standing record's expiry without changing what it says (#1274).
 *
 * A family whose record expires on its own (a partner block, 25h) is refreshed only when a
 * reminder posts, and the third reminder step is 24h, so an hour of Slack trouble at that
 * step let the record lapse mid block and restart the schedule at 6h with the age reset.
 * Now every SIGHTING of the condition re-arms it, and the reminder schedule is untouched.
 */
export async function touchCondition(
  kv: BackoffKv,
  key: string,
  standing: StandingCondition,
  ttlSeconds: number,
): Promise<void> {
  await kv.put(conditionKey(key), JSON.stringify(standing), { expirationTtl: ttlSeconds })
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
 *
 * `unchanged` is required (#1768): "nothing about it has changed" was said on
 * every reminder while nothing had compared what the findings said, so each
 * caller now passes what it measured, true only when the alert is word for word
 * the last one (recurrenceOf). Otherwise the sentence says it is the same
 * problem with the latest details shown, and nothing more.
 */
export function describeRepeat(
  standing: StandingCondition | null,
  nowMs: number,
  unchanged: boolean,
  // Same schedule the caller passes to recordAlert, so "the next one is in ~Xh"
  // names the real gap for an urgent path, not the shared one (#1337).
  steps: readonly number[] = BACKOFF_STEPS_SECONDS,
): string | null {
  if (!standing || standing.alerts < 1) return null
  const sinceMs = Date.parse(standing.since)
  const hours = Number.isFinite(sinceMs) ? Math.round((nowMs - sinceMs) / 3_600_000) : null
  const nextHours = Math.round(intervalSecondsFor(standing.alerts, steps) / 3600)
  const next = `The next one is in ~${nextHours}h unless it clears first, and it stops as soon as it does.`
  if (!unchanged) {
    const stood = hours === null ? '' : `, standing for ~${hours}h`
    return `This is the same problem as before${stood}, and the details shown are the latest: this is reminder ${standing.alerts + 1}. ${next}`
  }
  const age = hours === null ? 'This condition has been standing' : `This condition has been standing for ~${hours}h`
  return `${age} and nothing about it has changed: this is reminder ${standing.alerts + 1}. ${next}`
}
