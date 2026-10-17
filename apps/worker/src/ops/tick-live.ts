/**
 * The minute cron's live ports (#1949): the ops database through ops-writes.ts,
 * the bidding Worker's OpsGateway through the OPS_GATEWAY binding, and
 * OpsInternal through the SELF binding. tick.ts holds the rules; this only
 * connects them, and turns every missing piece into a refusal by name.
 *
 * Not configured is loud, never a quiet fallback: while OPS_SUPABASE_URL or
 * OPS_SUPABASE_SECRET_KEY is unset the tick reports `not_configured` naming each
 * one, every minute, and the bidding Worker pages on it (lib/ops-gateway.ts).
 *
 * Every call across a binding is raced against a deadline (L110), because the
 * tick awaits everything it starts and a call that never answers would hold the
 * tick, and every dispatched call with it, until the 15 minute wall.
 */
import type { OpsTickReport } from '../lib/ops-gateway-contract'
import { raceDeadline } from '../lib/alert-claim'
import { createOpsSupabaseClient, OpsDatabaseConfigError, type OpsSupabaseClient } from './ops-db'
import {
  claimOpsSweep, dueQueueDepth, expireOverdueRunRequests, opsNow, readWorkflowCopies, recordScheduleObservation, runQueueDisagreements,
  saveWorkflowCopies, sweepExpiredLeases, type OpsRpcOptions,
} from './ops-writes'
import { dispatchKey, signDispatch } from './dispatch-auth'
import type { OpsEnv } from './index'
import type { DispatchItem, OpsTickDb, OpsTickPorts } from './tick'

/** A gateway call: the bidding Worker's read is one bounded database read. */
export const GATEWAY_DEADLINE_MS = 15_000
/** An observe dispatch: a verify and a log line. */
export const DISPATCH_DEADLINE_MS = 10_000

export interface LiveTickOptions {
  now?: () => number
  tickId?: string
  delay?: (ms: number) => Promise<void>
  rpc?: OpsRpcOptions
  /** For tests: the ops client's fetch. */
  fetch?: typeof fetch
}

function databaseFor(client: OpsSupabaseClient, rpc: OpsRpcOptions | undefined): OpsTickDb {
  return {
    now: () => opsNow(client, rpc),
    claimSweep: (sweep, owner, every) => claimOpsSweep(client, sweep, owner, every, rpc),
    sweepLeases: (limit) => sweepExpiredLeases(client, limit, rpc),
    expireRuns: (limit) => expireOverdueRunRequests(client, limit, rpc),
    queueDisagreements: (limit) => runQueueDisagreements(client, limit, rpc),
    saveCopies: (servedAt, complete, copies) => saveWorkflowCopies(client, servedAt, complete, copies, rpc),
    readCopies: (limit) => readWorkflowCopies(client, limit, rpc),
    recordObservation: (org, obs) => recordScheduleObservation(client, org, obs, rpc),
    dueQueueDepth: () => dueQueueDepth(client, rpc),
  }
}

/** The ops database, or each setting that keeps it out of reach, by name. */
export function opsTickDatabase(env: OpsEnv, options: LiveTickOptions = {}): OpsTickPorts['db'] {
  const missing = (['OPS_SUPABASE_URL', 'OPS_SUPABASE_SECRET_KEY'] as const).filter((k) => typeof env[k] !== 'string' || env[k].trim() === '')
  if (missing.length > 0) {
    return { notConfigured: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set on bidspoke-worker-ops` }
  }
  try {
    return databaseFor(createOpsSupabaseClient(env, options.fetch ? { fetch: options.fetch } : {}), options.rpc)
  } catch (err) {
    if (err instanceof OpsDatabaseConfigError) return { notConfigured: err.message }
    throw err
  }
}

async function bounded<T>(what: string, work: () => Promise<T>, deadlineMs: number, delay: LiveTickOptions['delay']): Promise<T> {
  const r = await raceDeadline(work, deadlineMs, delay)
  if (r.kind === 'timed_out') throw new Error(`${what} did not answer within ${deadlineMs / 1000} s`)
  if (r.kind === 'threw') throw r.error
  return r.value
}

export function liveTickPorts(env: OpsEnv, scheduledTime: number | null, options: LiveTickOptions = {}): OpsTickPorts {
  const now = options.now ?? (() => Date.now())
  const tickId = options.tickId ?? `ops-tick-${crypto.randomUUID()}`
  const gateway = env.OPS_GATEWAY
  const self = env.SELF
  const noGateway = () => new Error('the OPS_GATEWAY binding to the bidding Worker is missing from this deploy')
  return {
    tickId,
    scheduledTime,
    now,
    db: opsTickDatabase(env, options),
    gateway: {
      fetchWorkflows: () => {
        if (!gateway) throw noGateway()
        return bounded('the bidding Worker\'s workflow list', () => gateway.opsWorkflows(), GATEWAY_DEADLINE_MS, options.delay)
      },
      started: async () => {
        if (!gateway) throw noGateway()
        await bounded('the bidding Worker\'s heartbeat', () => gateway.opsTickStarted(), GATEWAY_DEADLINE_MS, options.delay)
      },
      completed: async (report: OpsTickReport) => {
        if (!gateway) throw noGateway()
        await bounded('the bidding Worker\'s heartbeat', () => gateway.opsTickCompleted(report), GATEWAY_DEADLINE_MS, options.delay)
      },
    },
    dispatch: async (item: DispatchItem) => {
      if (!self) throw new Error('the SELF binding is missing from this deploy')
      const signed = await signDispatch(await dispatchKey(env.PORTING_CAPTURE_MASTER), {
        v: 1, tick_id: tickId, signed_at: new Date(now()).toISOString(), item,
      })
      const answer = await bounded('OpsInternal.observe', () => self.observe(signed), DISPATCH_DEADLINE_MS, options.delay)
      const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { observed?: unknown; refused?: unknown }
      if (a.observed === false && typeof a.refused === 'string') throw new Error(`OpsInternal refused: ${a.refused}`)
      if (a.observed !== true) throw new Error('OpsInternal.observe answered without saying it observed the dispatch')
    },
  }
}
