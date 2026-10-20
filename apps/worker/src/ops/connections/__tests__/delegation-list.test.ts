/**
 * The Google mailboxes and drives list's OpsConnections methods (#2338, PR 2;
 * requirement R10, finding F129), with the ops database as a double. The
 * functions themselves are proven against a real Postgres in
 * supabase-ops/supabase/tests/google_delegation_list.test.sql; this proves the
 * half here: each database outcome becomes its own answer by name, and a call
 * the database did not answer is surfaced as a refusal, never as done or empty.
 */
import { describe, expect, it } from 'vitest'
import { organizationIdFrom, type OrganizationId } from '../../ops-db'
import type { AddDelegationResult, DelegationActor, DelegationEntry, DelegationSubject } from '../../ops-writes'
import { addDelegationSubject, listDelegationSubjects, removeDelegationSubject, type DelegationListDeps } from '../delegation-list'
import { DELEGATION_LIST_LIMIT } from '../../../lib/ops-connections-contract'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const ACTOR = { user_id: 'cccccccc-0000-4000-8000-000000002338', email: 'dan@example.invalid', name: 'Dan Wright' }
const DRIVE: DelegationSubject = { kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', displayName: 'Partner reports', addedBy: 'Dan Wright', addedAt: '2026-10-19T14:00:00+00:00' }

interface Calls {
  add: Array<{ org: OrganizationId; entry: DelegationEntry & { displayName: string | null }; actor: DelegationActor }>
  remove: Array<{ org: OrganizationId; entry: DelegationEntry; actor: DelegationActor }>
  list: Array<{ org: OrganizationId; limit: number }>
}

function deps(answers: { add?: AddDelegationResult | Error; remove?: 'removed' | 'not_listed' | Error; list?: { subjects: DelegationSubject[]; reachedLimit: boolean } | Error }) {
  const calls: Calls = { add: [], remove: [], list: [] }
  const d: DelegationListDeps = {
    add: async (org, entry, actor) => {
      calls.add.push({ org, entry, actor })
      if (answers.add instanceof Error || answers.add === undefined) throw answers.add ?? new Error('no add answer')
      return answers.add
    },
    remove: async (org, entry, actor) => {
      calls.remove.push({ org, entry, actor })
      if (answers.remove instanceof Error || answers.remove === undefined) throw answers.remove ?? new Error('no remove answer')
      return answers.remove
    },
    list: async (org, limit) => {
      calls.list.push({ org, limit })
      if (answers.list instanceof Error || answers.list === undefined) throw answers.list ?? new Error('no list answer')
      return answers.list
    },
  }
  return { d, calls }
}

const addRequest = { organization_id: ORG, actor: ACTOR, kind: 'drive' as const, subject: '0AbCdEfGhIjKlMnOpQ', display_name: 'Partner reports' }
const removeRequest = { organization_id: ORG, actor: ACTOR, kind: 'mailbox' as const, subject: 'ops@example.invalid' }
const ROW = { kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', display_name: 'Partner reports', added_by: 'Dan Wright', added_at: '2026-10-19T14:00:00+00:00' }

describe('addDelegationSubject', () => {
  it('adds for the one organization, as the person asking, and answers the entry', async () => {
    const { d, calls } = deps({ add: { outcome: 'added', entry: DRIVE } })
    expect(await addDelegationSubject(d, addRequest)).toEqual({ ok: true, outcome: 'added', entry: ROW })
    expect(calls.add).toEqual([{
      org: organizationIdFrom(ORG),
      entry: { kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', displayName: 'Partner reports' },
      actor: { id: ACTOR.user_id, email: 'dan@example.invalid', name: 'Dan Wright' },
    }])
  })

  it('an entry already on the list is answered as such, with the entry as it stands', async () => {
    const { d } = deps({ add: { outcome: 'already_listed', entry: DRIVE } })
    expect(await addDelegationSubject(d, addRequest)).toEqual({ ok: true, outcome: 'already_listed', entry: ROW })
  })

  it.each([
    ['subject_invalid', 'delegation_subject_invalid'],
    ['display_name_invalid', 'delegation_display_name_invalid'],
    ['listed_by_another_organization', 'delegation_subject_listed_elsewhere'],
  ] as const)('the database\'s %s is refused by name as %s, writing nothing', async (outcome, code) => {
    const { d } = deps({ add: { outcome, entry: null } })
    expect(await addDelegationSubject(d, addRequest)).toMatchObject({ ok: false, refused: code, retry_at: null })
  })

  it('a database that did not answer is surfaced as a change it could not confirm, never as added', async () => {
    const { d } = deps({ add: new Error('add_google_delegation_subject failed (XX000): boom') })
    const answer = await addDelegationSubject(d, addRequest)
    expect(answer).toMatchObject({ ok: false, refused: 'delegation_change_failed' })
    // Its detail names the step, never the database's message.
    expect(JSON.stringify(answer)).not.toContain('boom')
  })
})

describe('removeDelegationSubject', () => {
  it('removes the organization\'s own entry, as the person asking', async () => {
    const { d, calls } = deps({ remove: 'removed' })
    expect(await removeDelegationSubject(d, removeRequest)).toEqual({ ok: true, outcome: 'removed' })
    expect(calls.remove).toEqual([{
      org: organizationIdFrom(ORG), entry: { kind: 'mailbox', subject: 'ops@example.invalid' }, actor: { id: ACTOR.user_id, email: 'dan@example.invalid', name: 'Dan Wright' },
    }])
  })

  it('an entry the organization does not hold is refused by name, never a silent success', async () => {
    const { d } = deps({ remove: 'not_listed' })
    expect(await removeDelegationSubject(d, removeRequest)).toMatchObject({ ok: false, refused: 'delegation_subject_not_listed' })
  })

  it('a database that did not answer is surfaced, never answered as removed', async () => {
    const { d } = deps({ remove: new Error('remove_google_delegation_subject passed its 8500 ms deadline and may still have committed') })
    expect(await removeDelegationSubject(d, removeRequest)).toMatchObject({ ok: false, refused: 'delegation_change_failed' })
  })
})

describe('listDelegationSubjects', () => {
  it('reads the one organization\'s entries up to the list limit, and says when the page was full', async () => {
    const mailbox: DelegationSubject = { kind: 'mailbox', subject: 'ops@example.invalid', displayName: null, addedBy: 'Dan Wright', addedAt: '2026-10-18T14:00:00+00:00' }
    const { d, calls } = deps({ list: { subjects: [mailbox, DRIVE], reachedLimit: false } })
    expect(await listDelegationSubjects(d, { organization_id: ORG })).toEqual({
      ok: true, reached_limit: false,
      subjects: [{ kind: 'mailbox', subject: 'ops@example.invalid', display_name: null, added_by: 'Dan Wright', added_at: '2026-10-18T14:00:00+00:00' }, ROW],
    })
    expect(calls.list).toEqual([{ org: organizationIdFrom(ORG), limit: DELEGATION_LIST_LIMIT }])
  })

  it('a list that could not be read is refused by name, never answered as an empty list', async () => {
    const { d } = deps({ list: new Error('list_google_delegation_subjects failed (XX000): boom') })
    expect(await listDelegationSubjects(d, { organization_id: ORG })).toMatchObject({ ok: false, refused: 'delegation_list_unavailable' })
  })
})
