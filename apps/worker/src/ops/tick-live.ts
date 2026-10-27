/**
 * The minute cron's live ports (#1949): the ops database through ops-writes.ts,
 * the bidding Worker's OpsGateway through the OPS_GATEWAY binding, and
 * OpsInternal through the SELF binding, and since #2336 the sf_limits sweep's
 * /limits read through connectionFetch with the OpsConnections live
 * dependencies, and since #2340 the connection_check sweep's identity probe the
 * same way, and each connection's ConnectionTokenObject through the
 * CONNECTION_TOKENS binding for the write back check (#2340 phase 10 item 4),
 * the way the reseal reaches them (reseal-live.ts). tick.ts holds the rules; this only
 * connects them, and turns every missing piece into a refusal by name.
 *
 * Not configured is loud, never a quiet fallback: while OPS_SUPABASE_URL or
 * OPS_SUPABASE_SECRET_KEY is unset, or OPS_CONNECTIONS_PRIVATE_KEY is unset,
 * will not import, or does not match the committed public key (#2333,
 * connection-key.ts), the tick reports `not_configured`
 * naming each one, every minute, and the bidding Worker pages on it with that
 * secret's remedy (lib/ops-gateway.ts).
 *
 * Every call across a binding is raced against a deadline (L110), because the
 * tick awaits everything it starts and a call that never answers would hold the
 * tick, and every dispatched call with it, until the 15 minute wall.
 */
import type { OpsTickMode, OpsTickReport } from '../lib/ops-gateway-contract'
import type { RunInvocationReport } from './run-invocation'
import { raceDeadline } from '../lib/alert-claim'
import { opsConnectionKeyProblems, type SealRegistry } from './connection-key'
import { createOpsSupabaseClient, OpsDatabaseConfigError, type OpsSupabaseClient } from './ops-db'
import {
  claimOpsSweep, dueQueueDepth, expireOverdueRunRequests, opsNow, purgeExpiredConnectionTombstones, purgeOpsStepRecords, purgeScheduleObservations, purgeStepTestResults, readConnectionCheckTargets,
  readMissingWorkflowDefinitions, saveWorkflowDefinition, recordScheduleFire, claimRunRequests, completeRunRequest, type ClaimedRun, readSfLimitsTargets,
  readWorkflowCopies, recordConnectionCheck, recordConnectionTombstone, recordScheduleObservation, recordSfBudgetReading, runQueueDisagreements,
  removeUnservedMeasuredIdentities, saveConnectionCopies, saveWorkflowCopies, sweepExpiredLeases, sweepSfLeases, type OpsRpcOptions, observeOpsReseal,
} from './ops-writes'
import { connectionFetch, type ConnectionCall, type ConnectionFetchDeps } from './connections/connection-fetch'
import { boundFetch, type OpsServiceEntry } from './connections/ops-connections'
import { ConnectionRefusal } from './connections/refusals'
import { liveOpsConnectionsDeps } from './ops-connections-live'
import { SF_LIMITS_READ_DEADLINE_MS } from './sf-limits'
import { CONNECTION_CHECK_PROBE_DEADLINE_MS } from './connection-check'
import { continuationModeFrom } from './checkpoint'
import { dispatchKey, signDispatch } from './dispatch-auth'
import type { OpsEnv } from './index'
import type { DispatchItem, OpsTickDb, OpsTickPorts } from './tick'

/** A gateway call: the bidding Worker's read is one bounded database read. */
export const GATEWAY_DEADLINE_MS = 15_000
/** An observe dispatch: a verify and a log line. */
export const DISPATCH_DEADLINE_MS = 10_000
/**
 * A run dispatch (#1950): a whole run, whose lease extend_run_lease caps at 15
 * minutes from its claim, the wall clock of the tick that dispatched it (spike
 * P1, P4). Just inside that, so the tick reports the run lost rather than being
 * cut off with it. Counted from when the tick began, not from the dispatch,
 * since the sweeps, copies and connections before it spend the same wall clock.
 */
export const RUN_DISPATCH_DEADLINE_MS = 14 * 60_000 + 30_000

/** The modes OPS_TICK_MODE may name. Unset is observe, as deployed; anything else is observe too, and named as not configured. */
export function tickModeFrom(value: string | undefined): { mode: OpsTickMode; unknown: string | null } {
  if (value === undefined || value.trim() === '' || value.trim() === 'observe') return { mode: 'observe', unknown: null }
  if (value.trim() === 'live') return { mode: 'live', unknown: null }
  return { mode: 'observe', unknown: value }
}

/**
 * Time sliced continuation's configuration (#1951), reported every tick so
 * neither fault is silent: an OPS_CONTINUATION this build does not run (runs
 * then write no checkpoint), and observe without the OPS_CHECKPOINTS bucket
 * (each run then says store_missing once and writes none).
 */
export function continuationProblems(env: OpsEnv): Array<{ secret: string; problem: string }> {
  const c = continuationModeFrom(env.OPS_CONTINUATION)
  if (c.unknown !== null) {
    return [{ secret: 'OPS_CONTINUATION', problem: `OPS_CONTINUATION is ${JSON.stringify(c.unknown)}, which this build does not run (it runs off or observe), so runs write no checkpoint.` }]
  }
  if (c.mode !== 'off' && env.OPS_CHECKPOINTS === undefined) {
    return [{ secret: 'OPS_CHECKPOINTS', problem: `OPS_CONTINUATION is ${c.mode}, and the OPS_CHECKPOINTS R2 binding is missing from this deploy, so no run checkpoint can be written.` }]
  }
  return []
}

export interface LiveTickOptions {
  now?: () => number
  tickId?: string
  delay?: (ms: number) => Promise<void>
  rpc?: OpsRpcOptions
  /** For tests: the ops client's fetch. */
  fetch?: typeof fetch
  /** For tests: the public keys the private key must match, in place of the committed ones. */
  sealRegistry?: SealRegistry
}

function databaseFor(client: OpsSupabaseClient, rpc: OpsRpcOptions | undefined): OpsTickDb {
  return {
    now: () => opsNow(client, rpc),
    claimSweep: (sweep, owner, every) => claimOpsSweep(client, sweep, owner, every, rpc),
    sweepLeases: (limit) => sweepExpiredLeases(client, limit, rpc),
    expireRuns: (limit) => expireOverdueRunRequests(client, limit, rpc),
    purgeTombstones: (limit) => purgeExpiredConnectionTombstones(client, limit, rpc),
    purgeObservations: (limit) => purgeScheduleObservations(client, limit, rpc),
    purgeStepTests: (limit) => purgeStepTestResults(client, limit, rpc),
    purgeStepRecords: (limit) => purgeOpsStepRecords(client, limit, rpc),
    recordFire: (org, fire) => recordScheduleFire(client, org, fire, rpc),
    claimRuns: (claim) => claimRunRequests(client, claim, rpc),
    completeRun: (run, end) => completeRunRequest(client, run.organizationId, run.runRequestId, run.claimToken, end, rpc),
    missingDefinitions: (limit) => readMissingWorkflowDefinitions(client, limit, rpc),
    saveDefinition: (org, workflowId, versionNumber, definition) => saveWorkflowDefinition(client, org, workflowId, versionNumber, definition, rpc),
    sweepSfLeases: (limit) => sweepSfLeases(client, limit, rpc),
    queueDisagreements: (limit) => runQueueDisagreements(client, limit, rpc),
    saveCopies: (servedAt, complete, copies) => saveWorkflowCopies(client, servedAt, complete, copies, rpc),
    readCopies: (limit) => readWorkflowCopies(client, limit, rpc),
    recordObservation: (org, obs) => recordScheduleObservation(client, org, obs, rpc),
    dueQueueDepth: () => dueQueueDepth(client, rpc),
    saveConnectionCopies: (servedAt, complete, copies) => saveConnectionCopies(client, servedAt, complete, copies, rpc),
    recordConnectionTombstone: (org, connectionId, generation, removedAt) => recordConnectionTombstone(client, org, connectionId, generation, removedAt, rpc),
    removeUnservedMeasuredIdentities: (servedAt, named) => removeUnservedMeasuredIdentities(client, servedAt, named, rpc),
    sfLimitsTargets: (limit) => readSfLimitsTargets(client, limit, rpc),
    recordSfLimitsReading: (sfOrgId, reading) => recordSfBudgetReading(client, sfOrgId, { ...reading, source: 'limits' }, rpc),
    connectionCheckTargets: (limit) => readConnectionCheckTargets(client, limit, rpc),
    recordConnectionCheck: (org, connectionId, result) => recordConnectionCheck(client, org, connectionId, result, rpc),
    observeReseal: (mode, restartAfterSeconds) => observeOpsReseal(client, mode, restartAfterSeconds, rpc),
  }
}

/**
 * The sf_limits sweep's read of one org (#2336): connectionFetch with the
 * OpsConnections live dependencies (ops-connections-live.ts, the one place an
 * ops module hands the platform fetch on), purpose sf_limits, the committed
 * copy only. Its dependencies are built on the first read, so a tick with no
 * measured org never needs the ops private key, and a key that is missing
 * fails the read by name (OpsConnectionsNotConfigured) rather than the tick.
 */
function sfLimitsRead(env: OpsEnv, options: LiveTickOptions): OpsTickPorts['sfLimits']['read'] {
  let deps: ConnectionFetchDeps | null = null
  return async (target, url) => {
    if (deps === null) {
      const live = liveOpsConnectionsDeps(env, { opensLogins: true, ...(options.fetch ? { opsFetch: options.fetch } : {}), ...(options.sealRegistry ? { sealRegistry: options.sealRegistry } : {}) })
      deps = { ...live.connection, rulesFor: (service) => live.services(service)?.rules, deadlineMs: SF_LIMITS_READ_DEADLINE_MS }
    }
    return connectionFetch(deps, {
      organizationId: target.organizationId,
      connectionId: target.connectionId,
      source: { kind: 'copy' },
      purpose: 'sf_limits',
      record: { recordsNothing: 'the sf_limits read is a GET of the org\'s own limits, made by the tick and no step, so there is no send ledger to record it in' },
    }, url, { method: 'GET', headers: { accept: 'application/json' } })
  }
}

/**
 * The connection_check sweep's probe of one connection (#2340): the service's
 * registered identity probe (verify's: Salesforce userinfo, Snowflake
 * CURRENT_USER), every request through connectionFetch with the OpsConnections
 * live dependencies, purpose connection_check, the committed copy only,
 * recording nothing. A Salesforce request takes a lease under the
 * connection_check purpose (connectionFetch's takeLease, which no caller can
 * omit). Its dependencies are built on the first probe, as the sf_limits read's
 * are, so a tick with no connection never needs the ops private key. `seen`
 * gets each response's status, so the sweep can tell a 5xx from a 4xx.
 */
function connectionCheckProbe(env: OpsEnv, options: LiveTickOptions): OpsTickPorts['connectionCheck']['probe'] {
  let live: { deps: ConnectionFetchDeps; services: (service: string) => OpsServiceEntry | undefined } | null = null
  return async (target, seen) => {
    if (live === null) {
      const built = liveOpsConnectionsDeps(env, { opensLogins: true, ...(options.fetch ? { opsFetch: options.fetch } : {}), ...(options.sealRegistry ? { sealRegistry: options.sealRegistry } : {}) })
      live = { deps: { ...built.connection, rulesFor: (service) => built.services(service)?.rules, deadlineMs: CONNECTION_CHECK_PROBE_DEADLINE_MS }, services: (service) => built.services(service) }
    }
    const entry = live.services(target.service)
    if (entry === undefined) throw new ConnectionRefusal('connection_service_unknown', `no rules for the ${target.service} service on this Worker`)
    if (entry.identity === undefined) return { kind: 'unprobed' }
    const call: ConnectionCall = {
      organizationId: target.organizationId,
      connectionId: target.connectionId,
      source: { kind: 'copy' },
      purpose: 'connection_check',
      record: { recordsNothing: 'the connection check reads only who the credential is, made by the tick and no step, so there is no send ledger to record it in' },
    }
    const fetchThrough = boundFetch(live.deps, call)
    const watched: typeof fetchThrough = async (url, init) => {
      const response = await fetchThrough(url, init)
      seen.lastStatus = response.status
      return response
    }
    return { kind: 'measured', identity: await entry.identity.measure(watched, target.target, target.publicConfig) }
  }
}

/** The ops database client, or each setting that keeps it out of reach, by name: the tick's, and the reseal's (reseal-live.ts). */
export function opsDatabaseClient(env: OpsEnv, options: Pick<LiveTickOptions, 'fetch'> = {}): OpsSupabaseClient | { notConfigured: string; secrets: string[] } {
  const missing = (['OPS_SUPABASE_URL', 'OPS_SUPABASE_SECRET_KEY'] as const).filter((k) => typeof env[k] !== 'string' || env[k].trim() === '')
  if (missing.length > 0) {
    return { notConfigured: `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set on bidspoke-worker-ops`, secrets: [...missing] }
  }
  try {
    return createOpsSupabaseClient(env, options.fetch ? { fetch: options.fetch } : {})
  } catch (err) {
    if (err instanceof OpsDatabaseConfigError) return { notConfigured: err.message, secrets: [err.secret] }
    throw err
  }
}

/** The ops database, or each setting that keeps it out of reach, by name. */
export function opsTickDatabase(env: OpsEnv, options: LiveTickOptions = {}): OpsTickPorts['db'] {
  const client = opsDatabaseClient(env, options)
  return 'notConfigured' in client ? client : databaseFor(client, options.rpc)
}

async function bounded<T>(what: string, work: () => Promise<T>, deadlineMs: number, delay: LiveTickOptions['delay']): Promise<T> {
  const r = await raceDeadline(work, deadlineMs, delay)
  if (r.kind === 'timed_out') throw new Error(`${what} did not answer within ${deadlineMs / 1000} s`)
  if (r.kind === 'threw') throw r.error
  return r.value
}

export function liveTickPorts(env: OpsEnv, scheduledTime: number | null, options: LiveTickOptions = {}): OpsTickPorts {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const tickId = options.tickId ?? `ops-tick-${crypto.randomUUID()}`
  const gateway = env.OPS_GATEWAY
  const self = env.SELF
  const noGateway = () => new Error('the OPS_GATEWAY binding to the bidding Worker is missing from this deploy')
  const mode = tickModeFrom(env.OPS_TICK_MODE)
  return {
    mode: mode.mode,
    dispatchRun: async (run: ClaimedRun): Promise<RunInvocationReport> => {
      if (!self) throw new Error('the SELF binding is missing from this deploy')
      const signed = await signDispatch(await dispatchKey(env.PORTING_CAPTURE_MASTER), {
        v: 1, tick_id: tickId, signed_at: new Date(now()).toISOString(), item: { kind: 'run', run },
      })
      const left = startedAt + RUN_DISPATCH_DEADLINE_MS - now()
      if (left <= 0) throw new Error('the tick had no time left to run it, so it was not dispatched; its lease lapses and the sweep returns it')
      const answer = await bounded('OpsInternal.run', () => self.run(signed), left, options.delay)
      const a = (typeof answer === 'object' && answer !== null ? answer : {}) as { refused?: unknown; outcome?: unknown; error?: unknown }
      if (typeof a.refused === 'string') throw new Error(`OpsInternal refused the run: ${a.refused}`)
      // Returned to the queue for want of its definition: counted as requeued.
      if (a.outcome === 'definition_unavailable') return { outcome: 'completed', end: { outcome: 'retry', error: String(a.error) }, runStatus: 'queued' }
      if (a.outcome !== 'completed' && a.outcome !== 'claim_lost' && a.outcome !== 'start_failed' && a.outcome !== 'complete_failed') {
        throw new Error('OpsInternal.run answered without saying how the run ended')
      }
      return answer as RunInvocationReport
    },
    tickId,
    resealSwitch: env.OPS_RESEAL,
    scheduledTime,
    now,
    db: opsTickDatabase(env, options),
    // An OPS_TICK_MODE that names no mode is not configured, by name: the tick runs in observe mode meanwhile.
    checkSecrets: async () => [
      ...(mode.unknown === null ? [] : [{ secret: 'OPS_TICK_MODE', problem: `OPS_TICK_MODE is ${JSON.stringify(mode.unknown)}, which is neither observe nor live, so the tick ran in observe mode.` }]),
      ...continuationProblems(env),
      ...(await opsConnectionKeyProblems(env, options.sealRegistry)),
    ],
    gateway: {
      fetchWorkflows: () => {
        if (!gateway) throw noGateway()
        return bounded('the bidding Worker\'s workflow list', () => gateway.opsWorkflows(), GATEWAY_DEADLINE_MS, options.delay)
      },
      fetchConnections: () => {
        if (!gateway) throw noGateway()
        return bounded('the bidding Worker\'s connection list', () => gateway.opsConnections(), GATEWAY_DEADLINE_MS, options.delay)
      },
      fetchDefinitions: (request) => {
        if (!gateway) throw noGateway()
        return bounded('the bidding Worker\'s workflow definitions', () => gateway.opsWorkflowDefinitions(request), GATEWAY_DEADLINE_MS, options.delay)
      },
      started: async () => {
        if (!gateway) throw noGateway()
        await bounded('the bidding Worker\'s heartbeat', () => gateway.opsTickStarted(), GATEWAY_DEADLINE_MS, options.delay)
      },
      completed: async (report: OpsTickReport) => {
        if (!gateway) throw noGateway()
        await bounded('the bidding Worker\'s heartbeat', () => gateway.opsTickCompleted(report), GATEWAY_DEADLINE_MS, options.delay)
      },
      jobStarted: async (job) => {
        if (!gateway) throw noGateway()
        await bounded(`the bidding Worker's heartbeat for ${job}`, () => gateway.opsJobStarted(job), GATEWAY_DEADLINE_MS, options.delay)
      },
      jobCompleted: async (job, report) => {
        if (!gateway) throw noGateway()
        await bounded(`the bidding Worker's heartbeat for ${job}`, () => gateway.opsJobCompleted(job, report), GATEWAY_DEADLINE_MS, options.delay)
      },
    },
    sfLimits: {
      read: sfLimitsRead(env, options),
      sleep: options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      log: (fields) => console.log(JSON.stringify(fields)),
    },
    connectionCheck: {
      probe: connectionCheckProbe(env, options),
      sleep: options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      log: (fields) => console.log(JSON.stringify(fields)),
    },
    writeBacks: {
      // The binding is read on the first read, so a tick with no connection never needs it; its deadline is the check's (write-back-check.ts).
      read: async (target) => {
        const tokens = env.CONNECTION_TOKENS
        if (!tokens) throw new Error('the CONNECTION_TOKENS binding is missing from this deploy')
        return tokens.get(tokens.idFromName(target.connectionId)).writeBackState({
          organizationId: target.organizationId, connectionId: target.connectionId, service: target.service,
        })
      },
      sleep: options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
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
