/**
 * Posting a standing condition to every org's Slack, under the shared backoff, with a claim.
 *
 * Lifted out of the partner reachability probe (#1274) when the database memory check (#1928)
 * needed the same sequence, so the two cannot drift apart: quiet inside the cooldown, one
 * poster across isolates, the condition recorded only once something delivered, and the
 * record re-armed on every tick the condition stands.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { readEverySlackConnection, type SlackListUse } from './alert-fanout'
import { describeCopyAge } from './scheduled-slack'
import { describeRepeat, fingerprintAlert, inCooldown, nextFingerprint, readCondition, recordAlert, recurrenceOf, touchCondition, type BackoffKv } from './alert-backoff'

export type SlackTarget = { bot_token: string; default_channel: string }

/**
 * Every org's Slack connection, for a worker level check that belongs to no org, the way
 * the daily secrets check fans out. One read of every connection, which on the scheduled
 * client is bounded and answered from the saved copy when the database does not answer
 * (readEverySlackConnection, #1303; L682): a partner block has nothing to do with
 * Supabase, so that alert must not go quiet during a database wobble, and the database
 * memory alert (#1928) is needed most exactly when the database is struggling. A database
 * that answered "no org has Slack" is an answer, never a reason to post from the copy.
 * Never throws: an empty list with the reason logged is the honest answer, and the runner
 * reports it in its summary.
 */
export async function resolveSlackForEveryOrg(deps: {
  supabase: SupabaseClient
  /** What the caller does with the connections (alert-fanout.ts SlackListUse); required so none can leave it out. */
  use: SlackListUse
  log: (line: string) => void
  /** Names the calling check in the log, so a fallback is traced to the right one. */
  logPrefix: string
}): Promise<SlackTarget[]> {
  try {
    const read = await readEverySlackConnection(deps.supabase, deps.logPrefix.replace(/^\[|\]$/g, ''), deps.use)
    if (read.kind === 'unreachable') {
      deps.log(`${deps.logPrefix} nobody can be told: the Slack connections could not be read (${read.reason})`)
      return []
    }
    if (read.kind === 'stored') deps.log(`${deps.logPrefix} Slack connections answered from the saved copy (${describeCopyAge(read.ageMs)}) because the database did not answer`)
    return [...read.connections.values()]
  } catch (e) {
    deps.log(`${deps.logPrefix} Slack connections read failed: ${formatErr(e)}`)
    return []
  }
}

/** Deliver one message to every connection; true if any accepted it. */
export async function deliverAll(targets: SlackTarget[], send: (s: SlackTarget) => Promise<string | boolean | null>): Promise<boolean> {
  let delivered = false
  for (const s of targets) {
    try {
      const r = await send(s)
      if (r !== null && r !== false) delivered = true
    } catch {
      // A throwing send counts as not delivered; the caller keeps its state and retries next tick.
    }
  }
  return delivered
}

/** What one standing post is about (#1768): the problem, and the details it shows beside it. */
export interface StandingAlert {
  /** Names the problem. A key that carries two problems posts the second at once as new. */
  problem: string
  /** What the post shows about it; a reminder says nothing changed only when these match. */
  details: readonly string[]
}

export interface StandingPost {
  kv: BackoffKv
  key: string
  claim: (key: string) => Promise<boolean>
  release: (key: string) => Promise<void>
  /** The connections, or a way to read them that runs only once a post is going out. */
  targets: SlackTarget[] | (() => Promise<SlackTarget[]>)
  nowMs: number
  alert: StandingAlert
  conditionTtlSeconds: number
  /** Prefix for the one log line written when there is nowhere to post. */
  logPrefix: string
  log: (line: string) => void
  send: (s: SlackTarget, repeat: string | null) => Promise<string | null>
}

/**
 * Post under the standing-condition backoff with a claim. A problem not posted while the
 * condition stood is posted at once as new, never as a reminder of the first (#1768).
 * Returns whether a post went out.
 */
export async function postStanding(p: StandingPost): Promise<boolean> {
  const standing = await readCondition(p.kv, p.key)
  if (standing) await touchCondition(p.kv, p.key, standing, p.conditionTtlSeconds)
  const print = await fingerprintAlert({ title: p.key, findings: [p.alert.problem], alsoShown: p.alert.details })
  const recurrence = recurrenceOf(standing, print)
  const different = recurrence.kind === 'new' && standing !== null
  if (!different && (await inCooldown(p.kv, p.key))) return false
  if (!(await p.claim(p.key))) return false
  const targets = typeof p.targets === 'function' ? await p.targets() : p.targets
  if (targets.length === 0) {
    p.log(`${p.logPrefix} no Slack connection, so ${p.key} was logged but not posted`)
    await p.release(p.key)
    return false
  }
  const reminderOf = recurrence.kind === 'reminder' ? recurrence.standing : null
  const repeat = describeRepeat(reminderOf, p.nowMs, recurrence.kind === 'reminder' && recurrence.unchanged)
  const delivered = await deliverAll(targets, (s) => p.send(s, repeat))
  if (!delivered) {
    await p.release(p.key)
    return false
  }
  await recordAlert(p.kv, p.key, reminderOf, p.nowMs, {
    conditionTtlSeconds: p.conditionTtlSeconds,
    fingerprint: nextFingerprint(standing, print),
  })
  return true
}
