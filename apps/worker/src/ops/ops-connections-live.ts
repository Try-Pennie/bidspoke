/**
 * The OpsConnections entrypoint's live dependencies (#2335, PR 8 of phase 5 of
 * #1689): the ops database through ops-writes.ts, the ops private key, the
 * service registry, the bidding Worker's moneyIdentities through OPS_GATEWAY,
 * and the person bound logins' token objects. ops-connections.ts holds the
 * rules; this only connects them.
 *
 * It is the one place OpsConnections reaches the platform's fetch, and it hands
 * it only to connectionFetch, which sends every connection bound request (the
 * guard apps/web/src/lib/__guards__/worker/ops-connection-requests-through-fetch.test.ts
 * holds every other ops module to that).
 *
 * WHOSE DATA: an ops database client acting as service_role, so every call
 * below is one of the organization scoped functions in ops-writes.ts, each
 * handed the organization of the request.
 */
import { raceDeadline } from '../lib/alert-claim'
import { opsSealKeys, type SealRegistryOf } from './connection-token-object'
import { tokenObjectsOf, type TokenObjects } from './connections/minters/oauth-user'
import { recordSfBudgetReadingFor, SfBudgetMemory } from './connections/sf-budget-reading'
import type { OpsConnectionsDeps } from './connections/ops-connections'
import { opsServiceEntry } from './connections/services'
import type { OpsEnv } from './index'
import { createOpsSupabaseClient } from './ops-db'
import {
  acquireSfLease, readConnectionCopy, readConnectionStatus, readMeasuredSfOrg, recordConnectionNeedsReauth, recordConnectionReauthCleared, recordConnectionRefresh,
  recordConnectionTombstone, recordMeasuredIdentity, recordSfBudgetReading, releaseSfLease, takeLookupAllowance,
} from './ops-writes'
import { GATEWAY_DEADLINE_MS } from './tick-live'

/** A secret OpsConnections needs is unset on bidspoke-worker-ops, named. */
export class OpsConnectionsNotConfigured extends Error {
  constructor(readonly secret: string, message: string) {
    super(message)
    this.name = 'OpsConnectionsNotConfigured'
  }
}

export interface LiveOpsConnectionsOptions {
  /** For tests: the ops database client's fetch. */
  opsFetch?: typeof fetch
  /** Whether the method opens a sealed login (verify, clearReauth, lookup), and so needs the ops private key. */
  opensLogins: boolean
  /** For tests: the committed public keys and current kid, in place of packages/connection-seal/src/keys.ts. */
  sealRegistry?: SealRegistryOf
  /** For tests: the budget reading's memory, in place of this isolate's. */
  sfBudgetMemory?: SfBudgetMemory
}

/**
 * What this isolate remembers between requests about Salesforce budget readings
 * (#2336): each connection generation's measured org, and when each org's
 * reading was last written. Module scope, so it outlives one request; losing it
 * costs one read and one write, never a wrong reading.
 */
const SF_BUDGET_MEMORY = new SfBudgetMemory()

const noTokenObjects: TokenObjects = {
  get: () => { throw new Error('the CONNECTION_TOKENS binding is missing from this deploy') },
}

/** Throws OpsDatabaseConfigError or OpsConnectionsNotConfigured, each naming its secret. */
export function liveOpsConnectionsDeps(env: OpsEnv, options: LiveOpsConnectionsOptions): OpsConnectionsDeps {
  const client = createOpsSupabaseClient(env, options.opsFetch ? { fetch: options.opsFetch } : {})
  const privateKeys = opsSealKeys(env, options.sealRegistry).privateKeys
  if (options.opensLogins && Object.keys(privateKeys).length === 0) {
    // Empty when the key is unset, or set and the private half of no committed kid (#2333, opsSealKeys).
    throw new OpsConnectionsNotConfigured('OPS_CONNECTIONS_PRIVATE_KEY', 'OPS_CONNECTIONS_PRIVATE_KEY is not set on bidspoke-worker-ops, or is not the private half of any committed public key, so no ops connection login can be opened')
  }
  const gateway = env.OPS_GATEWAY
  return {
    connection: {
      privateKeys,
      readCopy: (organizationId, connectionId) => readConnectionCopy(client, organizationId, connectionId),
      acquireSfLease: (organizationId, ask) => acquireSfLease(client, organizationId, ask),
      releaseSfLease: (organizationId, holder) => releaseSfLease(client, organizationId, holder),
      recordNeedsReauth: (organizationId, connectionId, cause) => recordConnectionNeedsReauth(client, organizationId, connectionId, cause),
      recordRefresh: (organizationId, connectionId, result) => recordConnectionRefresh(client, organizationId, connectionId, result),
      // The platform's fetch, to connectionFetch alone.
      fetch: (input, init) => fetch(input, init),
      recordSfBudget: (organizationId, connectionId, generation, reading, at) => recordSfBudgetReadingFor({
        memory: options.sfBudgetMemory ?? SF_BUDGET_MEMORY,
        readMeasuredSfOrg: (org, conn, gen) => readMeasuredSfOrg(client, org, conn, gen),
        recordSfBudgetReading: (sfOrgId, r) => recordSfBudgetReading(client, sfOrgId, { ...r, source: 'sforce_limit_info' }),
      }, organizationId, connectionId, generation, reading, at),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      newHolder: () => `ops-connections-${crypto.randomUUID()}`,
      // connectionFetch's events carry names only (an event, a connection id, a purpose).
      report: (event) => console.log(JSON.stringify({ ...event, source: 'ops_connections' })),
    },
    services: opsServiceEntry,
    moneyIdentities: async (organizationId) => {
      if (!gateway) throw new Error('the OPS_GATEWAY binding to the bidding Worker is missing from this deploy')
      const r = await raceDeadline(() => gateway.moneyIdentities(organizationId), GATEWAY_DEADLINE_MS)
      if (r.kind === 'timed_out') throw new Error(`the bidding Worker's moneyIdentities did not answer within ${GATEWAY_DEADLINE_MS / 1000} s`)
      if (r.kind === 'threw') throw r.error
      return r.value
    },
    recordMeasuredIdentity: (organizationId, connectionId, generation, identity) => recordMeasuredIdentity(client, organizationId, connectionId, generation, identity),
    recordReauthCleared: (organizationId, connectionId) => recordConnectionReauthCleared(client, organizationId, connectionId),
    recordTombstone: (organizationId, connectionId, generation, removedAt) => recordConnectionTombstone(client, organizationId, connectionId, generation, removedAt),
    readStatus: (organizationId, limit) => readConnectionStatus(client, organizationId, limit),
    takeLookupAllowance: (organizationId, perMinute) => takeLookupAllowance(client, organizationId, perMinute),
    tokens: env.CONNECTION_TOKENS ? tokenObjectsOf(env.CONNECTION_TOKENS) : noTokenObjects,
    now: () => Date.now(),
  }
}
