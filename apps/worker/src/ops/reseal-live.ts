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
 */
import { raceDeadline } from '../lib/alert-claim'
import type { ReplaceConnectionEnvelopeRequest } from '../lib/ops-gateway-contract'
import { opsSealKeys, type SealRegistryOf } from './connection-token-object'
import type { ResealLoginRequest } from './connections/token-object-contract'
import type { OpsEnv } from './index'
import type { ResealDeps } from './reseal'
import { GATEWAY_DEADLINE_MS } from './tick-live'

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

const RESEAL_MODES: Readonly<Record<string, boolean>> = { preview: false, apply: true }

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'ops_reseal', ...fields }))
}

/** The minute cron's reseal, while OPS_RESEAL asks for one. Never throws. */
export async function scheduledReseal(env: OpsEnv, options: { delay?: (ms: number) => Promise<void> } = {}): Promise<ScheduledResealOutcome> {
  const mode = typeof env.OPS_RESEAL === 'string' ? env.OPS_RESEAL.trim() : ''
  if (mode === '') return 'off'
  if (!Object.hasOwn(RESEAL_MODES, mode)) {
    log({ outcome: 'mode_unknown', detail: 'OPS_RESEAL must be preview or apply' })
    return 'refused'
  }
  const self = env.SELF
  if (!self) {
    log({ outcome: 'self_missing', detail: 'the SELF binding is missing from this deploy' })
    return 'refused'
  }
  const r = await raceDeadline(() => self.resealConnections({ apply: RESEAL_MODES[mode] }), RESEAL_DEADLINE_MS, options.delay)
  if (r.kind === 'timed_out') {
    log({ outcome: 'failed', asked: mode, error: `no answer within ${RESEAL_DEADLINE_MS / 1000} s` })
    return 'failed'
  }
  if (r.kind === 'threw') {
    log({ outcome: 'failed', asked: mode, error: r.error instanceof Error ? r.error.name : 'error' })
    return 'failed'
  }
  const answer = (typeof r.value === 'object' && r.value !== null ? r.value : {}) as Record<string, unknown>
  if (answer.ok === true) {
    log({ outcome: 'reported', asked: mode, ...answer })
    return 'reported'
  }
  log({ outcome: 'refused', asked: mode, refused: typeof answer.refused === 'string' ? answer.refused : 'unreadable', detail: typeof answer.detail === 'string' ? answer.detail : null })
  return 'refused'
}
