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
 * Once nothing a slowdown left is still waiting, one summary per org says how
 * many runs it touched, on which workflows, and whether every record landed
 * (#1881), in place of the per run and per write messages a stall used to send.
 * Step rows (tier 1) are read back for that summary only, never dead-lettered.
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
import { getSlackConnection, sendSlowdownSummaryAlert, sendUnconfirmedWritesAlert, type SlackConnection } from './slack'
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
  /** Runs whose step rows a read back found incomplete (tier 1, never dead-lettered). */
  steps_missing: number
  /** Entries left for a later tick: another sweep claimed them, or their lost alert could not be recorded. */
  deferred: number
  /** Slowdown summaries posted this tick. */
  summaries: number
  /** Unreadable entries a could-not-confirm alert has already named. */
  unreadable_named: number
}

/**
 * What one slowdown has resolved so far, per org, carried between ticks (#1881).
 * A slowdown's entries come of age over a minute or two, so they resolve across
 * ticks; the summary goes out once none is left.
 */
export interface SlowdownTally {
  /** First seen time of the earliest and latest entry, ISO. */
  from: string
  to: string
  /** Execution id to its run. */
  runs: Record<string, { workflow_id: string; workflow_name: string }>
  records: number
  landed: number
  lost: number
  steps_missing: number
  /**
   * The runs whose outcome records never landed, with which records. The dead
   * letter is claimed once per label and cause, so it names none of them past
   * the first; the summary names them all.
   */
  lost_runs?: Record<string, { workflow_id: string; workflow_name: string; labels: string[] }>
}

/**
 * Where the tallies live. KV, beside the entries: a read modify write by the
 * sweep alone, once a tick. Two overlapping sweeps can overwrite each other's
 * merge, which can make a summary's counts slightly off, never doubled in Slack:
 * the summary itself is posted under an AlertClaim.
 */
export const SLOWDOWN_TALLY_KEY = 'unconfirmed-write-slowdown'
const SLOWDOWN_TALLY_TTL_SECONDS = 24 * 60 * 60
const SUMMARY_CLAIM_TTL_SECONDS = 60 * 60

/**
 * How long after a slowdown's latest timed out write its summary waits: the read
 * back age, plus the minute a KV list may lag a write. Cloudflare delivered every
 * cron tick twice on 2026-10-08, 24 to 36 s apart, so two sweeps routinely meet;
 * the summary's AlertClaim makes one of them post, and this keeps a late entry of
 * the same slowdown from starting a second.
 */
export const SUMMARY_QUIET_MS = READ_BACK_MIN_AGE_MS + 60_000

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
    case 'steps_present':
      return `step rows of execution ${r.execution_id}`
    case 'writeback_deadletter_present':
      return `replay row for ${r.sf_object} ${r.sf_record_id}, execution ${r.execution_id}`
  }
}

function tallyFor(tallies: Map<string, SlowdownTally>, entry: UnconfirmedWrite): SlowdownTally {
  let t = tallies.get(entry.org_id)
  if (!t) {
    t = { from: entry.first_seen_at, to: entry.first_seen_at, runs: {}, records: 0, landed: 0, lost: 0, steps_missing: 0 }
    tallies.set(entry.org_id, t)
  }
  if (entry.first_seen_at < t.from) t.from = entry.first_seen_at
  if (entry.first_seen_at > t.to) t.to = entry.first_seen_at
  if (entry.run) t.runs[entry.run.execution_id] = { workflow_id: entry.run.workflow_id, workflow_name: entry.run.workflow_name }
  t.records++
  return t
}

function mergeTally(into: SlowdownTally | undefined, add: SlowdownTally): SlowdownTally {
  if (!into) return add
  return {
    from: add.from < into.from ? add.from : into.from,
    to: add.to > into.to ? add.to : into.to,
    runs: { ...into.runs, ...add.runs },
    records: into.records + add.records,
    landed: into.landed + add.landed,
    lost: into.lost + add.lost,
    steps_missing: into.steps_missing + add.steps_missing,
    lost_runs: mergeLostRuns(into.lost_runs, add.lost_runs),
  }
}

function mergeLostRuns(a: SlowdownTally['lost_runs'], b: SlowdownTally['lost_runs']): SlowdownTally['lost_runs'] {
  const out: NonNullable<SlowdownTally['lost_runs']> = {}
  for (const src of [a ?? {}, b ?? {}]) {
    for (const [id, run] of Object.entries(src)) {
      const have = out[id]
      out[id] = have ? { ...have, labels: [...new Set([...have.labels, ...run.labels])] } : { ...run, labels: [...run.labels] }
    }
  }
  return out
}

async function readTallies(kv: SweepKv): Promise<Record<string, SlowdownTally>> {
  const raw = await kv.get(SLOWDOWN_TALLY_KEY)
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, SlowdownTally>) : {}
  } catch {
    console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] slowdown tally unreadable, starting again`)
    return {}
  }
}

export async function runUnconfirmedWriteSweep(deps: UnconfirmedSweepDeps): Promise<UnconfirmedSweepSummary> {
  const now = deps.now ?? Date.now
  const startedAtMs = now()
  const summary: UnconfirmedSweepSummary = {
    listed: 0, young: 0, landed: 0, lost: 0, unreadable: 0, could_not_confirm: 0, skipped: 0, unread: 0, lost_labels: [],
    steps_missing: 0, deferred: 0, summaries: 0, unreadable_named: 0,
  }

  const { keys } = await deps.kv.list({ prefix: UNCONFIRMED_WRITE_PREFIX, limit: SWEEP_LIMIT })
  summary.listed = keys.length
  // What this tick resolved, per org, for the slowdown summary (#1881).
  const resolved = new Map<string, SlowdownTally>()
  // Entries still unreadable this tick, per org: a summary posted beside them
  // must say so rather than read as every record saved.
  const stillUnconfirmed = new Map<string, number>()

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
      tallyFor(resolved, entry).landed++
      continue
    }

    if (verdict.verdict === 'missing') {
      // Claimed first, so two overlapping sweeps act on this record once. The
      // loser leaves the entry for the claimant to delete.
      if (deps.claims && !(await deps.claims.claim(`unconfirmed-write:${entry.id}`, ENTRY_CLAIM_TTL_SECONDS))) {
        summary.deferred++
        continue
      }
      if (entry.read_back.kind === 'steps_present') {
        // Step rows are tier 1: an incomplete trace is told in the summary, and
        // no Outcome Record Lost alert is sent for it.
        await deps.kv.delete(name)
        summary.steps_missing++
        tallyFor(resolved, entry).steps_missing++
        continue
      }
      const minutes = Math.round((startedAtMs - Date.parse(entry.first_seen_at)) / 60_000)
      const recorded = await recordOutcomeDeadLetter(
        entry.label,
        lossOf(entry, verdict, minutes),
        { kv: deps.kv, supabase: deps.supabase, orgId: entry.org_id, appUrl: deps.appUrl, claims: deps.claims },
        entry.run ? { ...entry.run, at: entry.first_seen_at } : undefined,
        { cause: 'read-back' },
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
        summary.deferred++
        continue
      }
      await deps.kv.delete(name)
      summary.lost++
      summary.lost_labels.push(entry.label)
      const lostIn = tallyFor(resolved, entry)
      lostIn.lost++
      if (entry.run) {
        const runs = (lostIn.lost_runs ??= {})
        const have = runs[entry.run.execution_id]
        runs[entry.run.execution_id] = {
          workflow_id: entry.run.workflow_id,
          workflow_name: entry.run.workflow_name,
          labels: [...new Set([...(have?.labels ?? []), entry.label])],
        }
      }
      continue
    }

    // A database that is not answering will not answer the next read either, so
    // the tick stops reading. A read refused for good is about that entry alone.
    if (!verdict.permanent) databaseAnswering = false
    summary.unreadable++
    // Named by the could-not-confirm alert already: it has its own message, so it
    // no longer holds the slowdown summary back (it would, until it expired, for
    // an entry whose read is refused for good).
    if (entry.could_not_confirm_alerted_at) summary.unreadable_named++
    stillUnconfirmed.set(entry.org_id, (stillUnconfirmed.get(entry.org_id) ?? 0) + 1)
    if (startedAtMs - Date.parse(entry.first_seen_at) >= COULD_NOT_CONFIRM_AFTER_MS && !entry.could_not_confirm_alerted_at) {
      const list = unconfirmable.get(entry.org_id) ?? []
      list.push({ key: name, entry })
      unconfirmable.set(entry.org_id, list)
    }
  }

  for (const [orgId, items] of unconfirmable) {
    summary.could_not_confirm += await reportUnconfirmable(deps, orgId, items, startedAtMs)
  }

  // A slowdown is over once nothing is left to read: no entry too young, none
  // unreadable, none another sweep holds, and the list was not cut short.
  const settled =
    summary.young === 0 && summary.unreadable - summary.unreadable_named - summary.could_not_confirm === 0 && summary.unread === 0 && summary.deferred === 0 && keys.length < SWEEP_LIMIT
  summary.summaries = await carrySlowdownTallies(deps, resolved, settled, startedAtMs, stillUnconfirmed)

  if (deps.recordRun && summary.listed > summary.young) {
    await deps.recordRun(startedAtMs, {
      outcome: summary.lost > 0 ? 'lost-found' : summary.unreadable > 0 ? 'unreadable' : 'resolved',
      detail: `landed=${summary.landed} lost=${summary.lost} unreadable=${summary.unreadable} unread=${summary.unread} young=${summary.young}`,
      summary: { ...summary },
    })
  }
  return summary
}

/**
 * Merges this tick's resolved entries into the stored tallies and, once the
 * slowdown is settled, posts one summary per org (#1881). Keyed on the cause:
 * only writes that timed out are in it, so a write that returned an error still
 * pages through the dead letter on its own (L707). Returns summaries posted.
 */
async function carrySlowdownTallies(
  deps: UnconfirmedSweepDeps,
  resolved: Map<string, SlowdownTally>,
  settled: boolean,
  nowMs: number,
  stillUnconfirmed: Map<string, number> = new Map(),
): Promise<number> {
  const stored = await readTallies(deps.kv)
  const hadStored = Object.keys(stored).length > 0
  if (!hadStored && resolved.size === 0) return 0
  for (const [orgId, t] of resolved) stored[orgId] = mergeTally(stored[orgId], t)

  let posted = 0
  if (settled) {
    for (const [orgId, tally] of Object.entries(stored)) {
      // Quiet first: a KV list can miss an entry written in the last minute, so
      // a slowdown is summarised only once its latest record is old enough that
      // any straggler from it would already be listed (as young). Otherwise the
      // straggler would start a second summary for the same slowdown.
      if (nowMs - Date.parse(tally.to) < SUMMARY_QUIET_MS) continue
      const claimKey = `unconfirmed-write-summary:${orgId}:${tally.from}`
      if (deps.claims && !(await deps.claims.claim(claimKey, SUMMARY_CLAIM_TTL_SECONDS))) {
        // Another sweep is posting this slowdown's summary.
        delete stored[orgId]
        continue
      }
      const done = await postSummary(deps, orgId, tally, stillUnconfirmed.get(orgId) ?? 0)
      if (done) {
        delete stored[orgId]
        posted++
      } else {
        await deps.claims?.release(claimKey)
      }
    }
  }

  try {
    if (Object.keys(stored).length === 0) await deps.kv.delete(SLOWDOWN_TALLY_KEY)
    else await deps.kv.put(SLOWDOWN_TALLY_KEY, JSON.stringify(stored), { expirationTtl: SLOWDOWN_TALLY_TTL_SECONDS })
  } catch (e) {
    console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] could not store the slowdown tally:`, formatErr(e))
  }
  return posted
}

/** True when the summary is delivered, or there is nobody to deliver it to by choice. */
async function postSummary(deps: UnconfirmedSweepDeps, orgId: string, tally: SlowdownTally, unconfirmed: number): Promise<boolean> {
  try {
    const slack = await deps.slackFor(orgId)
    if (!slack) {
      console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] slowdown summary for org ${orgId} has no Slack connection to go to`)
      return false
    }
    if (!slack.config_alerts_enabled) return true
    const byWorkflow = new Map<string, number>()
    for (const run of Object.values(tally.runs)) byWorkflow.set(run.workflow_name, (byWorkflow.get(run.workflow_name) ?? 0) + 1)
    return await sendSlowdownSummaryAlert(
      slack,
      {
        runs: Object.keys(tally.runs).length,
        workflows: [...byWorkflow.entries()].map(([name, runs]) => ({ name, runs })).sort((a, b) => b.runs - a.runs),
        records: tally.records,
        landed: tally.landed,
        lost: tally.lost,
        lost_runs: Object.entries(tally.lost_runs ?? {}).map(([execution_id, r]) => ({ execution_id, ...r })),
        steps_missing: tally.steps_missing,
        unconfirmed,
        from: tally.from,
        to: tally.to,
      },
      deps.appUrl,
    )
  } catch (e) {
    console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] slowdown summary failed for org ${orgId}:`, formatErr(e))
    return false
  }
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

/** How long the sweep waits for the live Slack connection before using the last-good copy. */
export const SLACK_READ_DEADLINE_MS = 3_000

type SweepSlack = Pick<SlackConnection, 'bot_token' | 'default_channel' | 'config_alerts_enabled'>

/**
 * The org's Slack connection for the sweep's alerts, which go out exactly while
 * the database may not be answering. The live read retries on real timers with
 * no deadline of its own (L110), so it is raced against SLACK_READ_DEADLINE_MS,
 * and the volume check's last-good copy answers when it fails or runs out.
 */
export function boundedSlackFor(
  live: (orgId: string) => Promise<SweepSlack | null>,
  lastGood: () => Promise<Map<string, SweepSlack>>,
  // Resolves when the read has waited long enough; stopped through the signal
  // once the read answers, so no timer outlives it.
  deadline: (signal: AbortSignal) => Promise<void> = (signal) =>
    new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, SLACK_READ_DEADLINE_MS)
      signal.addEventListener('abort', () => {
        clearTimeout(handle)
        resolve()
      }, { once: true })
    }),
): (orgId: string) => Promise<SweepSlack | null> {
  return async (orgId) => {
    try {
      const stop = new AbortController()
      const timedOut = deadline(stop.signal).then(() => 'timed_out' as const)
      const answer = await Promise.race([live(orgId), timedOut]).finally(() => stop.abort())
      if (answer === 'timed_out') {
        console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] Slack connection read for org ${orgId} did not answer in ${SLACK_READ_DEADLINE_MS} ms, trying the last-good copy`)
      } else if (answer) {
        return answer
      }
    } catch (e) {
      console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] Slack connection read failed for org ${orgId}, trying the last-good copy: ${formatErr(e)}`)
    }
    try {
      return (await lastGood()).get(orgId) ?? null
    } catch (e) {
      console.error(`[${UNCONFIRMED_WRITE_SWEEP_JOB}] last-good Slack copy unreadable for org ${orgId}: ${formatErr(e)}`)
      return null
    }
  }
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
    slackFor: boundedSlackFor(
      (orgId) => getSlackConnection(supabase, orgId),
      () => readLastGoodSlackConnections(env.IDEMPOTENCY, secretKeys(env)),
    ),
    recordRun: (startedAtMs, ending) => recordFinishedJobRun(supabase, UNCONFIRMED_WRITE_SWEEP_JOB, startedAtMs, ending),
  })
}
