/**
 * The reseal's live ports and its trigger (#2333; the rules are reseal.ts's).
 *
 * THE PORTS. The bidding Worker through the OPS_GATEWAY binding (the served
 * connection list and the compare and set), each person bound connection's
 * ConnectionTokenObject through the CONNECTION_TOKENS binding, and this
 * Worker's own keys (opsSealKeys: both private keys mid rotation). Every call
 * across a binding is raced against a deadline (L110), and a missing binding is
 * refused by name rather than read as an empty list.
 *
 * THE TRIGGER. A reseal is wanted only during a rotation of the ops key
 * (docs/disaster-recovery.md, rotating the ops private key, step 3), so it is
 * off unless OPS_RESEAL is set on this Worker, in wrangler.ops.toml [vars] by a
 * reviewed pull request: "preview" says each minute what it would reseal and
 * writes nothing, "apply" reseals. While it is set, the minute cron
 * (index.ts scheduledTick) calls OpsInternal.resealConnections through the SELF
 * binding after the tick, so the reseal runs on its own CPU budget (spike P4)
 * and is repeated every minute until a run reports nothing_left, which the
 * operator reads from the `ops_reseal` log line before removing OPS_RESEAL and
 * the old key (step 4). Unset, nothing runs and nothing is logged, so the
 * minute costs nothing outside a rotation.
 *
 * The log line carries the report: counts, kids, connection ids and outcome
 * names, never a login, and an error by its kind only (L658).
 *
 * EACH RUN IS KEPT (#2486). After every run in a mode, whatever came of it,
 * its result goes to the ops database (record_ops_reseal_run): whether it left
 * nothing, and how many it left. A refused, failed or unreadable run is kept as
 * one that did not finish, with no count, never as finished (L50). The tick's
 * reseal watch (reseal-watch.ts) judges from it how long logins have been left
 * behind, or how long the switch has been on since nothing was left, and the
 * bidding Worker pages. A result that could not be kept is said in the run's
 * own line (recorded false, record_error), never thrown: the run already
 * happened, and a watch that never hears a run that finished pages as logins
 * left, the side that tells someone.
 */
import { raceDeadline } from '../lib/alert-claim'
import type { ReplaceConnectionEnvelopeRequest } from '../lib/ops-gateway-contract'
import { opsSealKeys, type SealRegistryOf } from './connection-token-object'
import type { ResealLoginRequest } from './connections/token-object-contract'
import type { OpsEnv } from './index'
import type { ResealDeps } from './reseal'
import { GATEWAY_DEADLINE_MS, opsDatabaseClient } from './tick-live'
import { recordOpsResealRun, type OpsResealMode } from './ops-writes'
import { RESEAL_RESTART_AFTER_MS, resealSwitchFrom } from './reseal-watch'
import { formatErr } from '../lib/format-error'

/** One object's reseal: a read, an open, a seal and a write in its own storage. */
export const OBJECT_DEADLINE_MS = 10_000
/** A whole run, as the minute cron waits on it: well inside the cron's wall, and past one run's worst case. */
export const RESEAL_DEADLINE_MS = 120_000

/** A binding the reseal needs is missing from this deploy, named. */
export class ResealNotConfigured extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResealNotConfigured'
  }
}

export interface LiveResealOptions {
  delay?: (ms: number) => Promise<void>
  /** For tests: the committed public keys and current kid, in place of packages/connection-seal/src/keys.ts. */
  registry?: SealRegistryOf
}

async function bounded<T>(what: string, work: () => Promise<T>, deadlineMs: number, delay: LiveResealOptions['delay']): Promise<T> {
  const r = await raceDeadline(work, deadlineMs, delay)
  if (r.kind === 'timed_out') throw new Error(`${what} did not answer within ${deadlineMs / 1000} s`)
  if (r.kind === 'threw') throw r.error
  return r.value
}

/** Throws ResealNotConfigured naming the binding that is missing. */
export function liveResealDeps(env: OpsEnv, options: LiveResealOptions = {}): ResealDeps {
  const gateway = env.OPS_GATEWAY
  if (!gateway) throw new ResealNotConfigured('the OPS_GATEWAY binding to the bidding Worker is missing from this deploy')
  const tokens = env.CONNECTION_TOKENS
  if (!tokens) throw new ResealNotConfigured('the CONNECTION_TOKENS binding is missing from this deploy')
  return {
    keys: opsSealKeys(env, options.registry),
    fetchConnections: () => bounded('the bidding Worker\'s connection list', () => gateway.opsConnections(), GATEWAY_DEADLINE_MS, options.delay),
    replaceEnvelope: (request: ReplaceConnectionEnvelopeRequest) =>
      bounded('the bidding Worker\'s replaceConnectionEnvelope', () => gateway.replaceConnectionEnvelope(request), GATEWAY_DEADLINE_MS, options.delay),
    resealObjectLogin: (connectionId: string, request: ResealLoginRequest) =>
      bounded<unknown>('a ConnectionTokenObject\'s resealLogin', async () => tokens.get(tokens.idFromName(connectionId)).resealLogin(request), OBJECT_DEADLINE_MS, options.delay),
  }
}

/** What the minute cron's call came to: off (OPS_RESEAL unset), reported, refused, or failed. */
export type ScheduledResealOutcome = 'off' | 'reported' | 'refused' | 'failed'

/** One run's result, as record_ops_reseal_run keeps it. */
export interface ResealRunResult {
  nothingLeft: boolean
  left: number | null
}

/** Keeps one run's result in its mode. Throws when it cannot. */
export type ResealRunRecorder = (mode: OpsResealMode, run: ResealRunResult) => Promise<unknown>

/** The ops database's record_ops_reseal_run, or a throw naming the setting that keeps it out of reach. */
export function liveResealRecorder(env: OpsEnv): ResealRunRecorder {
  return async (mode, run) => {
    const client = opsDatabaseClient(env)
    if ('notConfigured' in client) throw new ResealNotConfigured(client.notConfigured)
    return recordOpsResealRun(client, mode, run, RESEAL_RESTART_AFTER_MS / 1000)
  }
}

const DID_NOT_FINISH: ResealRunResult = { nothingLeft: false, left: null }

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'ops_reseal', ...fields }))
}

/** The minute cron's reseal, while OPS_RESEAL asks for one. Never throws. */
export async function scheduledReseal(
  env: OpsEnv, options: { delay?: (ms: number) => Promise<void>; record?: ResealRunRecorder } = {},
): Promise<ScheduledResealOutcome> {
  const sw = resealSwitchFrom(env.OPS_RESEAL)
  if (sw.kind === 'off') return 'off'
  if (sw.kind === 'unknown') {
    log({ outcome: 'mode_unknown', detail: 'OPS_RESEAL must be preview or apply' })
    return 'refused'
  }
  const mode = sw.mode
  const record = options.record ?? liveResealRecorder(env)
  // Each run's line ends with whether its result was kept for the reseal watch.
  const finish = async (outcome: ScheduledResealOutcome, run: ResealRunResult, fields: Record<string, unknown>): Promise<ScheduledResealOutcome> => {
    let kept: Record<string, unknown> = { recorded: true }
    try {
      await record(mode, run)
    } catch (err) {
      kept = { recorded: false, record_error: formatErr(err) }
    }
    log({ ...fields, ...kept })
    return outcome
  }
  const self = env.SELF
  if (!self) return finish('refused', DID_NOT_FINISH, { outcome: 'self_missing', asked: mode, detail: 'the SELF binding is missing from this deploy' })
  const r = await raceDeadline(() => self.resealConnections({ apply: mode === 'apply' }), RESEAL_DEADLINE_MS, options.delay)
  if (r.kind === 'timed_out') return finish('failed', DID_NOT_FINISH, { outcome: 'failed', asked: mode, error: `no answer within ${RESEAL_DEADLINE_MS / 1000} s` })
  if (r.kind === 'threw') return finish('failed', DID_NOT_FINISH, { outcome: 'failed', asked: mode, error: r.error instanceof Error ? r.error.name : 'error' })
  const answer = (typeof r.value === 'object' && r.value !== null ? r.value : {}) as Record<string, unknown>
  if (answer.ok === true) {
    const left = answer.left
    // Finished only as the reseal says it: nothing_left, with nothing left; a count that is no count did not finish (L50).
    const run: ResealRunResult = typeof left === 'number' && Number.isInteger(left) && left >= 0
      ? { nothingLeft: answer.nothing_left === true && left === 0, left }
      : DID_NOT_FINISH
    return finish('reported', run, { outcome: 'reported', asked: mode, ...answer })
  }
  return finish('refused', DID_NOT_FINISH, {
    outcome: 'refused', asked: mode, refused: typeof answer.refused === 'string' ? answer.refused : 'unreadable', detail: typeof answer.detail === 'string' ? answer.detail : null,
  })
}
