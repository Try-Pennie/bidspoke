/**
 * The services the ops Worker serves connections for (#2335, PR 8 of phase 5 of
 * #1689): the one registry OpsConnections and connectionFetch read their rules
 * from (ops-connections.ts passes its rules to connectionFetch, so the two
 * cannot disagree).
 *
 * Each service's entry arrives with its catalogue runtime entry and its actions
 * (Phase 7, #2337), built from its minter (./minters), its declared hosts, its
 * identity measurement (./identity.ts) and, where it has lookups, its schema
 * target. Snowflake was the first (snowflake-service.ts). Salesforce
 * (salesforce-service.ts) is registered ahead of its actions, so verify and
 * lookups reach the ops pool, which grants them only within the caps Dan
 * approved for the org (Decision 11, ops migration 20261020010000: the
 * trypennie org alone so far) and refuses every other one by name
 * (sf_cap_unset, or sf_org_unmeasured before verify has measured the org).
 * Every service not listed here is refused by
 * name (connection_service_unknown).
 *
 * No entry holds a fetch: a minter that asks a token endpoint asks it through
 * connectionFetch (AuthorizeInput.fetch), so registering a service adds no
 * path to the platform's fetch.
 */
import type { OpsServiceEntry } from './ops-connections'
import { salesforceServiceEntry } from './salesforce-service'
import { snowflakeServiceEntry } from './snowflake-service'

const REGISTERED: Readonly<Record<string, OpsServiceEntry>> = {
  // Each minter's memo is per isolate, keyed on connection, generation and user.
  snowflake: snowflakeServiceEntry({ now: () => Date.now() }),
  salesforce: salesforceServiceEntry({ now: () => Date.now() }),
}

/** The registered entry for a service key, or undefined. An own key only: a 'constructor' must not reach Object.prototype. */
export function opsServiceEntry(service: string): OpsServiceEntry | undefined {
  return Object.hasOwn(REGISTERED, service) ? REGISTERED[service] : undefined
}

/** The registered service keys, for tests and the status of this deploy. */
export function registeredOpsServices(): string[] {
  return Object.keys(REGISTERED)
}
