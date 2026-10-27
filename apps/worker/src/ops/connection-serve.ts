/**
 * The ops tick's half of the serve (#2335, PR 6 of phase 5 of #1689; plan:
 * discussion #2329, part 2): the ops connections the bidding Worker served
 * through OpsGateway.opsConnections, kept as last good copies in the ops
 * database, so ops keeps running from them while the bidding Worker is down
 * (Dan's decision 4) and stops within 6 hours of a removal even then (decision
 * 3, L625).
 *
 * In order, each inside its own failure boundary:
 *  1. Fetch and parse (ops-gateway-contract.ts, L50). A row that is not a well
 *     formed ops connection is refused by name and the list is then not
 *     complete, so it withdraws nothing. A failed fetch saves NOTHING: each copy
 *     keeps the serve_until it was last served with, and connectionFetch
 *     refuses it as connection_copy_expired once that passes, on the database's
 *     clock (connection_copy).
 *  2. The removals, through record_connection_tombstone, before the copies, so
 *     a copy a removal covers is gone before anything else is saved.
 *  3. The copies, through save_connection_copies, which refuses a lower
 *     generation, a copy already past its serve_until and one a tombstone
 *     covers, and, for a complete list, withdraws every copy it does not name.
 *  4. Only after a complete list was saved in one save: the measured
 *     identities of connections bidding never stored, through
 *     remove_unserved_measured_identities (#2573). A Salesforce verify of a new
 *     connection records one before bidding inserts the row; when the insert
 *     fails and its revoke fails too, nothing else ever removes it. The list
 *     not naming the connection, served more than an hour after the
 *     measurement, is the proof bidding never stored it. The record is used by
 *     nothing, so its removal is counted and logged, and pages only if the
 *     removal itself keeps failing.
 *
 * What is saved is ciphertext and public config only: the ops Worker opens an
 * envelope only inside connectionFetch, under the organization it is filed under.
 */
import { formatErr } from '../lib/format-error'
import { parseServedOpsConnections, tickProblem, type TickProblem } from '../lib/ops-gateway-contract'
import { organizationIdFrom, type OrganizationId } from './ops-db'
import { MAX_COPIES_PER_SAVE, type ConnectionCopyInput, type SaveConnectionCopiesResult, type UnservedIdentityRemoved } from './ops-writes'

/** The ops database, as this step uses it. The live one is ops-writes.ts through tick-live.ts. */
export interface ConnectionServeDb {
  saveConnectionCopies(servedAt: string, complete: boolean, copies: readonly ConnectionCopyInput[]): Promise<SaveConnectionCopiesResult>
  recordConnectionTombstone(organizationId: OrganizationId, connectionId: string, generation: number, removedAt: Date): Promise<{ outcome: 'recorded' | 'already_recorded'; copiesRemoved: number }>
  removeUnservedMeasuredIdentities(servedAt: string, named: readonly string[]): Promise<UnservedIdentityRemoved[]>
}

export interface ConnectionServeOutcome {
  /** Each a sentence a person can act on, keyed by its kind (#2506). */
  problems: TickProblem[]
  counts: Record<string, number>
  /** Each measured identity of a connection bidding never stored that this serve removed (#2573), for the tick to log by id. */
  unservedIdentitiesRemoved: UnservedIdentityRemoved[]
}

export async function saveServedConnections(db: ConnectionServeDb, fetchConnections: () => Promise<unknown>): Promise<ConnectionServeOutcome> {
  const problems: TickProblem[] = []
  const counts: Record<string, number> = {}
  const unservedIdentitiesRemoved: UnservedIdentityRemoved[] = []
  const bump = (key: string, by = 1) => { counts[key] = (counts[key] ?? 0) + by }

  let raw: unknown
  try {
    raw = await fetchConnections()
  } catch (err) {
    problems.push(tickProblem('connections_fetch_failed', `The ops tick could not fetch the ops connections from the bidding Worker (${formatErr(err)}), so it saved none: each saved copy stays usable until its serve_until, at most 6 hours after it was last served.`))
    return { problems, counts, unservedIdentitiesRemoved }
  }
  let parsed: ReturnType<typeof parseServedOpsConnections>
  try {
    parsed = parseServedOpsConnections(raw)
  } catch (err) {
    problems.push(tickProblem('connections_list_unreadable', `The bidding Worker's connection list could not be read (${formatErr(err)}), so no connection copy was saved.`))
    return { problems, counts, unservedIdentitiesRemoved }
  }
  const { list, refused } = parsed
  problems.push(...refused.map((text) => tickProblem('connection_refused', text)))
  bump('connections_served', list.connections.length)

  for (const t of list.tombstones) {
    try {
      const r = await db.recordConnectionTombstone(organizationIdFrom(t.organization_id), t.connection_id, t.generation, new Date(t.removed_at))
      if (r.outcome === 'recorded') bump('connection_removals_recorded')
      bump('connection_copies_removed', r.copiesRemoved)
    } catch (err) {
      problems.push(tickProblem('tombstone_record_failed', `The removal of connection ${t.connection_id} could not be recorded (${formatErr(err)}); the next tick records it, and its copy is withdrawn by a complete list or expires at its serve_until.`, t.connection_id))
    }
  }

  const copies: ConnectionCopyInput[] = list.connections.map((c) => ({
    connectionId: c.id, organizationId: c.organization_id, service: c.service, generation: c.generation,
    envelope: c.envelope, publicConfig: c.public_config, target: c.target, ownerUserId: c.owner_user_id, serveUntil: c.serve_until,
  }))
  // A list too long for one save is saved in parts and withdraws nothing, since no one part is the whole list.
  const oneSave = copies.length <= MAX_COPIES_PER_SAVE
  if (!oneSave) problems.push(tickProblem('connections_too_many', `The bidding Worker served ${copies.length} ops connections, more than one save carries, so connections it no longer names were not withdrawn.`))
  let savedWhole = false
  for (let at = 0; at < copies.length || at === 0; at += MAX_COPIES_PER_SAVE) {
    try {
      const saved = await db.saveConnectionCopies(list.served_at, list.complete && oneSave, copies.slice(at, at + MAX_COPIES_PER_SAVE))
      bump('connection_copies_saved', saved.inserted + saved.updated + saved.confirmed)
      bump('connection_copies_refused_older', saved.refusedOlder)
      bump('connection_copies_refused_removed', saved.refusedRemoved)
      bump('connection_copies_withdrawn', saved.withdrawn)
      savedWhole = list.complete && oneSave
      if (saved.refusedExpired > 0) {
        bump('connection_copies_refused_expired', saved.refusedExpired)
        problems.push(tickProblem('connection_copies_expired', saved.refusedExpired === 1
          ? '1 served connection copy arrived already past its serve_until and was refused: the list was served more than 6 hours before the ops database\'s clock.'
          : `${saved.refusedExpired} served connection copies arrived already past their serve_until and were refused: the list was served more than 6 hours before the ops database's clock.`))
      }
    } catch (err) {
      problems.push(tickProblem('connections_save_failed', `The ops tick could not save the connections it fetched (${formatErr(err)}); the saved copies stay as they were, each until its serve_until.`))
    }
  }

  // 4. Only a complete list saved whole proves which connections bidding holds.
  if (savedWhole) {
    try {
      const removed = await db.removeUnservedMeasuredIdentities(list.served_at, copies.map((c) => c.connectionId))
      unservedIdentitiesRemoved.push(...removed)
      if (removed.length > 0) bump('connection_unserved_identities_removed', removed.length)
    } catch (err) {
      problems.push(tickProblem('unserved_identities_remove_failed', `The ops tick could not remove the Salesforce identities measured for connections Bidspoke never saved (${formatErr(err)}). Nothing uses them, and the next tick tries again.`))
    }
  }
  return { problems, counts, unservedIdentitiesRemoved }
}
