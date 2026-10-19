/**
 * The services the ops Worker serves connections for (#2335, PR 8 of phase 5 of
 * #1689): the one registry OpsConnections and connectionFetch read their rules
 * from (ops-connections.ts passes its rules to connectionFetch, so the two
 * cannot disagree).
 *
 * EMPTY in this deploy, by the plan's order: each service's entry arrives with
 * its catalogue runtime entry and its actions (Phase 7), built from its minter
 * (./minters), its declared hosts, its identity measurement (./identity.ts) and,
 * where it has lookups, its schema target. Salesforce's is ready
 * (salesforce-service.ts) and is registered by its Phase 7 pull request; until
 * then, and while the ops pool has no approved cap (Decision 11), every ops
 * connection call is refused by name (connection_service_unknown), and verify
 * never passes one.
 */
import type { OpsServiceEntry } from './ops-connections'

const REGISTERED: Readonly<Record<string, OpsServiceEntry>> = {}

/** The registered entry for a service key, or undefined. An own key only: a 'constructor' must not reach Object.prototype. */
export function opsServiceEntry(service: string): OpsServiceEntry | undefined {
  return Object.hasOwn(REGISTERED, service) ? REGISTERED[service] : undefined
}

/** The registered service keys, for tests and the status of this deploy. */
export function registeredOpsServices(): string[] {
  return Object.keys(REGISTERED)
}
