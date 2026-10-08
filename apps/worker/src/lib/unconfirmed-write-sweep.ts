/**
 * The minute sweep that reads back post-response writes which only timed out
 * (#1880).
 *
 * A must-not-lose write that does not answer inside the post-response budget is
 * recorded as unconfirmed (engine/unconfirmed-writes.ts) instead of being
 * dead-lettered as lost, because on 2026-10-08 every write a 90 second stall
 * timed out had in fact landed. This sweep decides each one:
 *
 *  - landed: the write's EFFECT is in the database (the row alone is not enough
 *    for an UPDATE: a finalized sighting, an execution no longer 'running').
 *    The entry is dropped, counted, and nobody is paged.
 *  - missing: the effect is not there. Dead-lettered through the same handler,
 *    with the same lost wording, as a write that returned an error.
 *  - unreadable: the database still does not answer. The entry is kept and read
 *    again next minute. Once the oldest unreadable entry is 15 minutes old, one
 *    "could not confirm" alert names them, and never says lost.
 *
 * An entry is read only once it is READ_BACK_MIN_AGE_MS old: a request still
 * queued in the database could otherwise land after a read that found nothing.
 * Two minutes is past the service role's 30 second statement timeout plus
 * PostgREST's 10 second wait for a connection, so by then any request the run
 * sent has committed or been refused.
 *
 * Assumed to run twice (the cron can overlap itself, and Cloudflare retries a
 * killed one). Deleting an entry only ever deletes that entry, since each timed
 * out write has its own key, so nothing written after the list is touched. The
 * landed path is idempotent. The paging paths (lost, could not confirm) take an
 * AlertClaim first, so two sweeps reading the same missing record page once.
 * A tick handles at most SWEEP_LIMIT entries, oldest first, and stops reading
 * at the first unreadable answer, so a dead database costs one bounded read.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeAlertClaims, type AlertClaims } from './alert-claim'
import { formatErr } from './format-error'
import { NO_ROW_MATCHED_CODE, READ_BACK_MISSING_CODE } from './db-retry'
import { getSlackConnection, sendUnconfirmedWritesAlert, type SlackConnection } from './slack'
import { recordFinishedJobRun, type JobRunEnding } from './job-run-record'
import { readLastGoodSlackConnections } from './volume-cliff'
import { secretKeys } from './secret-crypto'
import type { Env } from '../env'
import { recordOutcomeDeadLetter } from '../engine/durability'
import {
  UNCONFIRMED_WRITE_PREFIX,
  firstSeenOfKey,
  parseUnconfirmedWrite,
  putUnconfirmedWrite,
  readBack,
  unconfirmedWriteKey,
  type ReadBackVerdict,
  type UnconfirmedWrite,
} from '../engine/unconfirmed-writes'

export const UNCONFIRMED_WRITE_SWEEP_JOB = 'unconfirmed-write-sweep'

/** An entry is read back only once it is this old. See the header. */
export const READ_BACK_MIN_AGE_MS = 2 * 60 * 1000

/** Unreadable this long after the write timed out, the sweep says so. */
export const COULD_NOT_CONFIRM_AFTER_MS = 15 * 60 * 1000

/** Entries one tick looks at. The 2026-10-08 stall left about 60. */
export const SWEEP_LIMIT = 50

/** How long one read back may take before it counts as unreadable. */
export const READ_BACK_DEADLINE_MS = 5_000

/**
 * How long one tick spends reading back (L704). A slow database answers every
 * read just inside its deadline, so the first-unreadable stop never fires and
 * 50 reads could take minutes; past this, the rest wait for the next tick.
 * Well inside the heartbeat's maxRunMs for this job.
 */
export const READ_PHASE_BUDGET_MS = 30_000

/** How long a claim on one entry's lost alert holds: past KV's minute of propagation. */
const ENTRY_CLAIM_TTL_SECONDS = 60 * 60

/** One "could not confirm" alert per org per this long. */
const COULD_NOT_CONFIRM_CLAIM_TTL_SECONDS = 30 * 60

export interface SweepKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expiration?: number; expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string; limit: number }): Promise<{ keys: Array<{ name: string }> }>
}

export interface UnconfirmedSweepDeps {
  kv: SweepKv
  supabase: SupabaseClient
  appUrl: string
  /** Wall clock, ms. */
  now?: () => number
  /** The atomic claim (#1298). Absent, the sweep acts without one. */
  claims?: AlertClaims
  /**
   * The org's Slack connection for the could-not-confirm alert, which is sent
   * while the database is down: the live row when it answers, the last-good
   * copy when it does not.
   */
  slackFor: (orgId: string) => Promise<Pick<SlackConnection, 'bot_token' | 'default_channel' | 'config_alerts_enabled'> | null>
  /** Resolves when a read back has waited long enough. A test passes one that resolves at once. */
  readDeadline?: () => Promise<void>
  /** Records a tick that did something in job_runs. */
  recordRun?: (startedAtMs: number, ending: JobRunEnding) => Promise<void>
}

export interface UnconfirmedSweepSummary {
  /** Entries the list returned. */
  listed: number
  /** Too young to read. */
  young: number
  landed: number
  lost: number
  unreadable: number
  /** Entries a could-not-confirm alert named this tick. */
  could_not_confirm: number
  /** Entries whose stored value was gone or unparseable. */
  skipped: number
  /** Entries left unread because the tick spent its read budget. */
  unread: number
  /** The lost entries' labels, for the run record. */
  lost_labels: string[]
}

/** A read that never answers is given up on (L110); the timer is cleared once the read wins. */
async function readWithin(deps: UnconfirmedSweepDeps, entry: UnconfirmedWrite): Promise<ReadBackVerdict> {
  let cancel = () => {}
  const wait = deps.readDeadline
    ? deps.readDeadline()
    : new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, READ_BACK_DEADLINE_MS)
        cancel = () => clearTimeout(handle)
      })
  const deadline = wait.then(
    (): ReadBackVerdict => ({ verdict: 'unreadable', error: `no answer within ${READ_BACK_DEADLINE_MS / 1000} s` }),
  )
  try {
    return await Promise.race([readBack(deps.supabase, entry.read_back), deadline])
  } finally {
    cancel()
  }
}

/** The error a missing record is dead-lettered with. */
function lossOf(entry: UnconfirmedWrite, missing: Extract<ReadBackVerdict, { verdict: 'missing' }>, minutes: number) {
  // An execution row that is not there at all is a served lead with no audit
  // record; the alert says so for NO_ROW_MATCHED. Every other miss carries the
  // read back's own code, which keeps an execution row left at 'running' on the
  // strand drain wording.
  const code = entry.label === 'execution_finalize' && missing.row_absent ? NO_ROW_MATCHED_CODE : READ_BACK_MISSING_CODE
  return {
    code,
    message: `${entry.label}: the write timed out at ${entry.first_seen_at} and a read back ${minutes} minutes later found ${missing.detail} (${describeReadBack(entry)})`,
  }
}

function describeReadBack(entry: UnconfirmedWrite): string {
  const r = entry.read_back
  switch (r.kind) {
    case 'execution_finalized':
      return `execution ${r.execution_id}`
    case 'sighting_present':
    case 'sighting_finalized':
      return `lead sighting ${r.sighting_id}${entry.run ? `, execution ${entry.run.execution_id}` : ''}`
    case 'bid_present':
    case 'bid_winner':
      return `bid by ${r.partner_slug}, execution ${r.execution_id}`
  }
}

export async function runUnconfirmedWriteSweep(deps: UnconfirmedSweepDeps): Promise<UnconfirmedSweepSummary> {
  const now = deps.now ?? Date.now
  const startedAtMs = now()
  const summary: UnconfirmedSweepSummary = {
    listed: 0, young: 0, landed: 0, lost: 0, unreadable: 0, could_not_confirm: 0, skipped: 0, unread: 0, lost_labels: [],
  }

  const { keys } = await deps.kv.list({ prefix: UNCONFIRMED_WRITE_PREFIX, limit: SWEEP_LIMIT })
  summary.listed = keys.length
  if (keys.length === 0) return summary

  // Unreadable entries old enough to be reported, by org.
  const unconfirmable = new Map<string, Array<{ key: string; entry: UnconfirmedWrite }>>()
  let databaseAnswering = true

  for (const { name } of keys) {
    const firstSeen = firstSeenOfKey(name)
    // Sorted oldest first, so everything after a young entry is young too.
    if (!Number.isFinite(firstSeen)) {
      // Not a key this module writes, so it can never be read back, and left it
      // would hold one of the tick's list slots until it expired.
      console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] dropping ${name}: not a key this sweep writes`)
      await deps.kv.delete(name)
      summary.skipped++
      continue
    }
    if (startedAtMs - firstSeen < READ_BACK_MIN_AGE_MS) {
      summary.young++
      continue
    }
    if (now() - startedAtMs >= READ_PHASE_BUDGET_MS) {
      summary.unread++
      continue
    }
    const raw = await deps.kv.get(name)
    const entry = parseUnconfirmedWrite(raw)
    if (!entry) {
      // Gone (another sweep deleted it after the list), or not an entry this
      // module wrote, which can never be read back and would hold one of the
      // tick's list slots until it expired: dropped, and said so.
      if (raw !== null) {
        console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] dropping ${name}: not a readable entry`)
        await deps.kv.delete(name)
      }
      summary.skipped++
      continue
    }

    const verdict: ReadBackVerdict = databaseAnswering
      ? await readWithin(deps, entry)
      : { verdict: 'unreadable', error: 'not read: an earlier read this tick found the database not answering' }

    if (verdict.verdict === 'landed') {
      await deps.kv.delete(name)
      summary.landed++
      continue
    }

    if (verdict.verdict === 'missing') {
      // Claimed first, so two overlapping sweeps page this record once. The
      // loser leaves the entry for the claimant to delete.
      if (deps.claims && !(await deps.claims.claim(`unconfirmed-write:${entry.id}`, ENTRY_CLAIM_TTL_SECONDS))) continue
      const minutes = Math.round((startedAtMs - Date.parse(entry.first_seen_at)) / 60_000)
      const recorded = await recordOutcomeDeadLetter(
        entry.label,
        lossOf(entry, verdict, minutes),
        { kv: deps.kv, supabase: deps.supabase, orgId: entry.org_id, appUrl: deps.appUrl },
        entry.run ? { ...entry.run, at: entry.first_seen_at } : undefined,
      ).then(
        () => true,
        (e: unknown) => {
          console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] lost alert for ${entry.label} failed, keeping the entry:`, formatErr(e))
          return false
        },
      )
      // A dead letter that threw recorded nothing, not even its count: the entry
      // stays, and its claim is freed, so the next tick tries again. One that ran
      // has counted the loss, whether or not its alert was the one that posted.
      if (!recorded) {
        await deps.claims?.release(`unconfirmed-write:${entry.id}`)
        continue
      }
      await deps.kv.delete(name)
      summary.lost++
      summary.lost_labels.push(entry.label)
      continue
    }

    databaseAnswering = false
    summary.unreadable++
    if (startedAtMs - Date.parse(entry.first_seen_at) >= COULD_NOT_CONFIRM_AFTER_MS && !entry.could_not_confirm_alerted_at) {
      const list = unconfirmable.get(entry.org_id) ?? []
      list.push({ key: name, entry })
      unconfirmable.set(entry.org_id, list)
    }
  }

  for (const [orgId, items] of unconfirmable) {
    summary.could_not_confirm += await reportUnconfirmable(deps, orgId, items, startedAtMs)
  }

  if (deps.recordRun && summary.listed > summary.young) {
    await deps.recordRun(startedAtMs, {
      outcome: summary.lost > 0 ? 'lost-found' : summary.unreadable > 0 ? 'unreadable' : 'resolved',
      detail: `landed=${summary.landed} lost=${summary.lost} unreadable=${summary.unreadable} unread=${summary.unread} young=${summary.young}`,
      summary: { ...summary },
    })
  }
  return summary
}

/** One could-not-confirm alert for an org's entries; returns how many it named. */
async function reportUnconfirmable(
  deps: UnconfirmedSweepDeps,
  orgId: string,
  items: Array<{ key: string; entry: UnconfirmedWrite }>,
  nowMs: number,
): Promise<number> {
  const claimKey = `unconfirmed-write-could-not-confirm:${orgId}`
  if (deps.claims && !(await deps.claims.claim(claimKey, COULD_NOT_CONFIRM_CLAIM_TTL_SECONDS))) return 0
  let sent = false
  try {
    const slack = await deps.slackFor(orgId)
    if (!slack) {
      console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] ${items.length} records unconfirmed for org ${orgId}, and no Slack connection to say so`)
    } else if (slack.config_alerts_enabled) {
      const oldest = items.map((i) => i.entry.first_seen_at).sort()[0]
      const runs = new Map<string, { workflow_id: string; workflow_name: string; execution_id: string }>()
      for (const { entry } of items) if (entry.run) runs.set(entry.run.execution_id, entry.run)
      sent = await sendUnconfirmedWritesAlert(
        slack,
        {
          count: items.length,
          labels: items.map((i) => i.entry.label),
          oldest_at: oldest,
          minutes: Math.floor((nowMs - Date.parse(oldest)) / 60_000),
          runs: [...runs.values()],
        },
        deps.appUrl,
      )
    } else {
      // Alerts are switched off for this org: nothing to send, and nothing to retry.
      sent = true
    }
  } catch (e) {
    console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] could-not-confirm alert failed for org ${orgId}:`, formatErr(e))
  }
  if (!sent) {
    // Free the claim so the next tick tries again; the entries stay unflagged.
    await deps.claims?.release(claimKey)
    return 0
  }
  // Flag each entry so a later tick does not name it again, while keeping it to
  // read back once the database returns. The key is recomputed from the entry,
  // so a flagged rewrite lands on the same key.
  const stamped = new Date(nowMs).toISOString()
  for (const { key, entry } of items) {
    const flagged = { ...entry, could_not_confirm_alerted_at: stamped }
    if (unconfirmedWriteKey(flagged) !== key) continue
    await putUnconfirmedWrite(deps.kv, flagged, nowMs).catch((e) =>
      console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] could not flag ${key}:`, formatErr(e)),
    )
  }
  return items.length
}

/**
 * The production wiring. The Slack connection comes from the database when it
 * answers and from the volume check's last-good copy when it does not, because
 * the could-not-confirm alert is sent exactly while the database is down (L682).
 */
export async function runUnconfirmedWriteSweepForEnv(supabase: SupabaseClient, env: Env): Promise<UnconfirmedSweepSummary> {
  return runUnconfirmedWriteSweep({
    kv: env.IDEMPOTENCY,
    supabase,
    appUrl: env.APP_URL,
    claims: env.ALERT_CLAIM ? makeAlertClaims(env.ALERT_CLAIM) : undefined,
    slackFor: async (orgId) => {
      try {
        const live = await getSlackConnection(supabase, orgId)
        if (live) return live
      } catch (e) {
        console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] Slack connection read failed for org ${orgId}, trying the last-good copy: ${formatErr(e)}`)
      }
      try {
        return (await readLastGoodSlackConnections(env.IDEMPOTENCY, secretKeys(env))).get(orgId) ?? null
      } catch (e) {
        console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] last-good Slack copy unreadable for org ${orgId}: ${formatErr(e)}`)
        return null
      }
    },
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, UNCONFIRMED_WRITE_SWEEP_JOB, startedAtMs, ending),
  })
}
