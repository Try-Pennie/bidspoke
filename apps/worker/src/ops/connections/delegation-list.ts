/**
 * The Google mailboxes and drives list's OpsConnections methods (#2338, PR 2 of
 * its build plan; requirement R10, finding F129): add, remove and list the
 * entries of an organization's google_delegation_subjects, the allowlist the
 * Google minter checks on every mint (minters/google.ts).
 *
 * Dan's decision on #2411 (2026-10-18): any signed in user of the organization
 * adds to the list from the Connections page, not an approval migration, and
 * every change is audited with who made it and when. The audit is the ops
 * database's: add_google_delegation_subject and remove_google_delegation_subject
 * write the change record in ops_audit_log in the same transaction as the change
 * (ops migration 20261020190000), so a change whose record fails is rolled back.
 *
 * WHO CALLS THEM. Only the OpsConnections entrypoint (../ops-connections-entrypoint.ts),
 * so only the bidding Worker through its binding, from the routes PR 6 adds,
 * which take the organization and the actor from the caller's verified JWT.
 * WHOSE DATA. Each call names one OrganizationId and acts on that organization's
 * entries alone: the functions match the organization they are given, and a
 * mailbox another organization lists is refused by name, never shown.
 *
 * Every answer is a value. A database outcome becomes its own answer by name; a
 * call the database did not confirm (an error, a timeout, an answer of the wrong
 * shape) is surfaced as a refusal, never as done, and a list that could not be
 * read is never answered as an empty list (L10). A refusal's detail names the
 * step, never the database's message.
 */
import {
  DELEGATION_LIST_LIMIT, type AddDelegationSubjectAnswer, type AddDelegationSubjectRequest, type DelegationActorShape, type DelegationSubjectRow,
  type ListDelegationSubjectsAnswer, type ListDelegationSubjectsRequest, type OpsConnectionsRefusalCode, type OpsConnectionsRefused,
  type RemoveDelegationSubjectAnswer, type RemoveDelegationSubjectRequest,
} from '../../lib/ops-connections-contract'
import { organizationIdFrom, type OrganizationId } from '../ops-db'
import type { AddDelegationResult, DelegationActor, DelegationEntry, DelegationSubject } from '../ops-writes'
import type { DelegationRemoveOutcome } from '../run-vocabulary'

/** The ops database's half, as ops-writes.ts wraps it (ops-connections-live.ts wires it). */
export interface DelegationListDeps {
  add(organizationId: OrganizationId, entry: DelegationEntry & { displayName: string | null }, actor: DelegationActor): Promise<AddDelegationResult>
  remove(organizationId: OrganizationId, entry: DelegationEntry, actor: DelegationActor): Promise<DelegationRemoveOutcome>
  list(organizationId: OrganizationId, limit: number): Promise<{ subjects: DelegationSubject[]; reachedLimit: boolean }>
}

function refuse(code: OpsConnectionsRefusalCode, detail: string): OpsConnectionsRefused {
  return { ok: false, refused: code, detail, retry_at: null }
}

function organizationOf(organizationId: string): OrganizationId | OpsConnectionsRefused {
  try {
    return organizationIdFrom(organizationId)
  } catch {
    return refuse('ops_connections_request_invalid', 'the organization is not a uuid')
  }
}

const isRefused = (v: unknown): v is OpsConnectionsRefused => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false

const actorOf = (a: DelegationActorShape): DelegationActor => ({ id: a.user_id, email: a.email, name: a.name })

const rowOf = (s: DelegationSubject): DelegationSubjectRow => ({ kind: s.kind, subject: s.subject, display_name: s.displayName, added_by: s.addedBy, added_at: s.addedAt })

/** A change the database did not confirm. One transaction holds the change and its record, so either both landed or neither did; which, only a read says. */
const unconfirmed = (what: string) =>
  refuse('delegation_change_failed', `the ops database did not confirm the ${what}, so read the list again to see whether it was made`)

const ADD_REFUSALS = {
  subject_invalid: ['delegation_subject_invalid', 'the entry is not one mailbox address or one shared drive id, so nothing was added'],
  display_name_invalid: ['delegation_display_name_invalid', 'a drive\'s name must be 1 to 200 characters, and a mailbox takes none, so nothing was added'],
  listed_by_another_organization: ['delegation_subject_listed_elsewhere', 'another organization\'s list holds this entry, so nothing was added'],
} as const satisfies Record<Exclude<AddDelegationResult['outcome'], 'added' | 'already_listed'>, readonly [OpsConnectionsRefusalCode, string]>

export async function addDelegationSubject(deps: DelegationListDeps, request: AddDelegationSubjectRequest): Promise<AddDelegationSubjectAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  let result: AddDelegationResult
  try {
    result = await deps.add(organizationId, { kind: request.kind, subject: request.subject, displayName: request.display_name }, actorOf(request.actor))
  } catch {
    return unconfirmed('addition')
  }
  if (result.outcome === 'added' || result.outcome === 'already_listed') return { ok: true, outcome: result.outcome, entry: rowOf(result.entry) }
  const [code, detail] = ADD_REFUSALS[result.outcome]
  return refuse(code, detail)
}

export async function removeDelegationSubject(deps: DelegationListDeps, request: RemoveDelegationSubjectRequest): Promise<RemoveDelegationSubjectAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  let outcome: DelegationRemoveOutcome
  try {
    outcome = await deps.remove(organizationId, { kind: request.kind, subject: request.subject }, actorOf(request.actor))
  } catch {
    return unconfirmed('removal')
  }
  if (outcome === 'not_listed') return refuse('delegation_subject_not_listed', 'the organization\'s list holds no such entry, so nothing was removed')
  return { ok: true, outcome }
}

export async function listDelegationSubjects(deps: DelegationListDeps, request: ListDelegationSubjectsRequest): Promise<ListDelegationSubjectsAnswer> {
  const organizationId = organizationOf(request.organization_id)
  if (isRefused(organizationId)) return organizationId
  let read: { subjects: DelegationSubject[]; reachedLimit: boolean }
  try {
    read = await deps.list(organizationId, DELEGATION_LIST_LIMIT)
  } catch {
    return refuse('delegation_list_unavailable', 'the ops database did not answer the organization\'s mailboxes and drives')
  }
  return { ok: true, subjects: read.subjects.map(rowOf), reached_limit: read.reachedLimit }
}
