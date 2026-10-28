/**
 * The reseal watch (#2486): the minute tick's judgement of an ops key reseal
 * that keeps leaving logins on the old key, or of a switch left on after the
 * reseal finished (L13, L523).
 *
 * WHY. During a rotation of the ops key (docs/disaster-recovery.md, rotating
 * the ops private key) OPS_RESEAL makes the minute cron run the reseal
 * (reseal-live.ts), and the operator reads its ops_reseal line until a run says
 * nothing_left, then removes the switch and the old key. Before this nothing
 * paged: a login that will not open, or will not seal to the current kid,
 * stayed on the old key without anyone being told, and removing the old key
 * then locked that connection out. And a switch nobody removed had no expiry:
 * the cron asked every token object for nothing every minute for ever.
 *
 * THE BOUNDS (settled for #2486 on 2026-10-27).
 *  - RESEAL_LEFT_BEHIND_PAGE_MS, 2 hours. The reseal runs every minute, so a
 *    login still left after about 120 attempts is stuck, not slow: each run
 *    takes up to RESEAL_LIMITS (100 rows and 100 objects), far past any ops
 *    connection count, so only a login that keeps failing is still there.
 *    apply on that long with no run since saying nothing is left is
 *    logins_left; a run that failed, was refused or never recorded counts as
 *    leaving logins, since none said every login moved.
 *  - preview, the same 2 hours (chosen while building #2486). A preview
 *    writes nothing, so it is harmless, but it is a manual switch with no
 *    expiry like any other (L523), and a rotation left on preview never
 *    finishes: the logins stay on the old key. A preview is read in a few
 *    minutes, so 2 hours of it is a forgotten switch: preview_left_on, while it
 *    still has logins to move. A preview with nothing to move is
 *    finished_left_on, below, like apply.
 *  - RESEAL_LEFT_ON_PAGE_MS, 2 hours after the first of an unbroken line of
 *    runs that left nothing: removing the switch is a reviewed pull request and
 *    a deploy, well under 2 hours, so a switch still on then is forgotten:
 *    finished_left_on.
 *  - OPS_RESEAL naming neither mode runs nothing (reseal-live.ts refuses it),
 *    so it is switch_unknown at once, needing no database.
 *
 * SINCE WHEN. The switch is a var, so the Worker cannot say since when it has
 * been set: module memory dies with each isolate and deploy. The ops database
 * keeps it (ops_reseal_state, migration 20261027160000): this tick stamps the
 * switch seen in its mode every minute (observe_ops_reseal), and the reseal
 * keeps each run's result (record_ops_reseal_run). The clock starts afresh on a
 * change of mode, and when the switch went unseen for RESEAL_RESTART_AFTER_MS,
 * because nothing sees it while it is unset, so a gap means it was off and a
 * rotation months later must not inherit the last one's clock. A tick or
 * database down that long restarts it too, costing at most that gap of the
 * bound; each is paged on its own (the ops-tick heartbeat, the database
 * problems). Every time is the database's, the clock the tick plans by.
 *
 * WHAT IT REPORTS. A verdict (OpsResealReport) in the tick's report, which the
 * bidding Worker pages and stands down (lib/ops-key-reseal.ts), never a tick
 * problem: the tick's problems page through the export alerter, which sends no
 * all clear, and this must. Unjudged (no database, or the state could not be
 * read) is null, never off, so an open page is kept open; a read that failed is
 * the tick problem reseal_state_failed, held for three ticks like every read
 * the next tick repeats.
 */
import { formatErr } from '../lib/format-error'
import { tickProblem, type OpsResealReport, type TickProblem } from '../lib/ops-gateway-contract'
import { OPS_RESEAL_MODES, type OpsResealMode, type OpsResealState } from './ops-writes'

/** apply (or preview with logins to move) on this long with no run saying nothing is left pages. */
export const RESEAL_LEFT_BEHIND_PAGE_MS = 2 * 60 * 60_000
/** A switch still on this long after a run said nothing is left pages. */
export const RESEAL_LEFT_ON_PAGE_MS = 2 * 60 * 60_000
/** The switch unseen this long is read as having been off, so its clock starts afresh (observe_ops_reseal). */
export const RESEAL_RESTART_AFTER_MS = 10 * 60_000

/** What OPS_RESEAL says. */
export type ResealSwitch = { kind: 'off' } | { kind: 'on'; mode: OpsResealMode } | { kind: 'unknown' }

/** Unset or blank is off; preview and apply, trimmed, are on; anything else names no mode. The one reading of the switch, for the tick and the reseal alike. */
export function resealSwitchFrom(raw: string | undefined): ResealSwitch {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === '') return { kind: 'off' }
  return (OPS_RESEAL_MODES as readonly string[]).includes(value) ? { kind: 'on', mode: value as OpsResealMode } : { kind: 'unknown' }
}

const NOTHING = { mode: null, since: null, nothing_left_since: null, last_run_at: null, last_run_left: null, db_now: null } as const

/** The verdict on the switch and, while it is on, the state the database answered for it. */
export function judgeReseal(sw: { kind: 'off' } | { kind: 'unknown' }, state: null): OpsResealReport
export function judgeReseal(sw: ResealSwitch, state: OpsResealState): OpsResealReport
export function judgeReseal(sw: ResealSwitch, state: OpsResealState | null): OpsResealReport {
  if (sw.kind === 'off') return { verdict: 'off', ...NOTHING }
  if (sw.kind === 'unknown') return { verdict: 'switch_unknown', ...NOTHING }
  if (state === null) throw new Error('a reseal switch that is on is judged from its state')
  const nowMs = Date.parse(state.dbNow)
  const facts = {
    mode: state.mode, since: state.modeSince, nothing_left_since: state.nothingLeftSince, last_run_at: state.lastRunAt, last_run_left: state.lastRunLeft, db_now: state.dbNow,
  }
  if (state.nothingLeftSince !== null) {
    return { verdict: nowMs - Date.parse(state.nothingLeftSince) >= RESEAL_LEFT_ON_PAGE_MS ? 'finished_left_on' : 'running', ...facts }
  }
  if (nowMs - Date.parse(state.modeSince) < RESEAL_LEFT_BEHIND_PAGE_MS) return { verdict: 'running', ...facts }
  return { verdict: state.mode === 'apply' ? 'logins_left' : 'preview_left_on', ...facts }
}

/**
 * The tick's step. `observe` is the database's observe_ops_reseal, or null
 * when the tick has no database. Never throws.
 */
export async function watchReseal(
  sw: ResealSwitch, observe: ((mode: OpsResealMode, restartAfterSeconds: number) => Promise<OpsResealState>) | null,
): Promise<{ report: OpsResealReport | null; problem: TickProblem | null }> {
  if (sw.kind !== 'on') return { report: judgeReseal(sw, null), problem: null }
  if (observe === null) return { report: null, problem: null }
  try {
    return { report: judgeReseal(sw, await observe(sw.mode, RESEAL_RESTART_AFTER_MS / 1000)), problem: null }
  } catch (err) {
    return {
      report: null,
      problem: tickProblem('reseal_state_failed', `The ops tick could not read how long the ops key reseal has been switched on (${formatErr(err)}), so whether it is leaving logins on the old key is not known.`),
    }
  }
}
