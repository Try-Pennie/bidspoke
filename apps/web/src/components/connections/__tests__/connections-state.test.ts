/**
 * The Connections page's reducer (#2338, build PR 9): the list's load with its
 * deadline and Try again, the stale strip's Try again over a list still shown,
 * the chosen connection, each connection's history, and the Google list's adds
 * and removes. Time moves only by the tick event, by hand.
 */
import { describe, expect, it } from 'vitest'
import type { ConnectionView, DelegationEntry } from '../connection-model'
import { chosenConnection, connectionsReducer, initialConnectionsState, LIST_NO_ANSWER, type ConnectionsEvent, type ConnectionsState, type LoadedList } from '../connections-state'

const T0 = Date.parse('2026-10-20T16:00:00Z')
const DEADLINE = 45_000

const conn = (over: Partial<ConnectionView>): ConnectionView => ({
  id: 'c1', name: 'Pennie Salesforce', service: 'salesforce', serviceName: 'Salesforce', actsAs: 'integration@trypennie.com', status: 'ok', org: null,
  workflows: [], lastCheckedAt: null, problemSince: null, problemCause: null, alertLogin: false, ...over,
})

const LIST: LoadedList = {
  connections: [conn({ id: 'c1', name: 'Pennie Salesforce' }), conn({ id: 'c2', name: 'Achieve Salesforce', status: 'reauth' })],
  statuses: { stale: false, asOf: '2026-10-20T16:00:00Z' },
}

const entry = (subject: string, kind: DelegationEntry['kind'] = 'mailbox'): DelegationEntry => ({ kind, subject, display_name: null, added_by: 'Dan Wright', added_at: '2026-10-18T14:00:00Z' })

function run(events: ConnectionsEvent[], from = initialConnectionsState(T0, DEADLINE)): ConnectionsState {
  return events.reduce(connectionsReducer, from)
}

describe('the list load', () => {
  it('starts loading at once, saying when it began, so the page can count the seconds', () => {
    const s = run([{ type: 'tick', at: T0 + 4_000 }])
    expect(s.list).toEqual({ kind: 'loading', attempt: 1, startedAt: T0 })
    expect(s.now - (s.list.kind === 'loading' ? s.list.startedAt : 0)).toBe(4_000)
  })

  it('shows the list when its answer comes, choosing the first connection as the list reads (Needs attention first)', () => {
    const s = run([{ type: 'list_answered', attempt: 1, data: LIST }])
    expect(s.list.kind).toBe('loaded')
    expect(chosenConnection(s)?.id).toBe('c2')
  })

  it('turns into the could not load card at the deadline, and ignores the answer that comes after it', () => {
    const late = run([{ type: 'tick', at: T0 + DEADLINE - 1 }])
    expect(late.list.kind).toBe('loading')
    const s = run([{ type: 'tick', at: T0 + DEADLINE }], late)
    expect(s.list).toEqual({ kind: 'failed', attempt: 1, cause: LIST_NO_ANSWER })
    expect(run([{ type: 'list_answered', attempt: 1, data: LIST }], s).list.kind).toBe('failed')
  })

  it('a refused load is the card with its own cause, and Try again loads afresh and can then succeed', () => {
    const failed = run([{ type: 'list_refused', attempt: 1, cause: 'The connections could not be read: the use counts read failed.' }])
    expect(failed.list).toMatchObject({ kind: 'failed', cause: 'The connections could not be read: the use counts read failed.' })
    const again = run([{ type: 'list_requested', at: T0 + 10_000, attempt: 2 }], failed)
    expect(again.list).toEqual({ kind: 'loading', attempt: 2, startedAt: T0 + 10_000 })
    // The first load's answer, arriving now, is not this load's.
    expect(run([{ type: 'list_answered', attempt: 1, data: LIST }], again).list.kind).toBe('loading')
    expect(run([{ type: 'list_answered', attempt: 2, data: LIST }], again).list.kind).toBe('loaded')
  })
})

describe("the stale strip's Try again", () => {
  const stale: LoadedList = { ...LIST, statuses: { stale: true, asOf: '2026-10-20T15:52:00Z' } }
  const shown = () => run([{ type: 'list_answered', attempt: 1, data: stale }, { type: 'choose', chosen: { kind: 'connection', id: 'c1' } }])

  it('loads again while the last known list stays shown, then shows the fresh one, keeping the chosen connection', () => {
    const retrying = run([{ type: 'list_requested', at: T0 + 5_000, attempt: 2 }], shown())
    expect(retrying.list).toMatchObject({ kind: 'loaded', data: stale, refresh: { kind: 'loading', attempt: 2, startedAt: T0 + 5_000 } })
    const fresh = run([{ type: 'list_answered', attempt: 2, data: LIST }], retrying)
    expect(fresh.list).toMatchObject({ kind: 'loaded', data: LIST, refresh: { kind: 'idle' } })
    expect(chosenConnection(fresh)?.id).toBe('c1')
  })

  it('a Try again that fails or passes the deadline says so and keeps the list it had', () => {
    const retrying = run([{ type: 'list_requested', at: T0 + 5_000, attempt: 2 }], shown())
    expect(run([{ type: 'list_refused', attempt: 2, cause: 'x' }], retrying).list).toMatchObject({ kind: 'loaded', data: stale, refresh: { kind: 'failed', cause: 'x' } })
    expect(run([{ type: 'tick', at: T0 + 5_000 + DEADLINE }], retrying).list).toMatchObject({ kind: 'loaded', data: stale, refresh: { kind: 'failed', cause: LIST_NO_ANSWER } })
  })

  it('a second Try again after a failed one gets a number of its own, so the failed one answering late counts for nothing', () => {
    const failed = run([{ type: 'list_requested', at: T0 + 5_000, attempt: 2 }, { type: 'list_refused', attempt: 2, cause: 'x' }], shown())
    const again = run([{ type: 'list_requested', at: T0 + 9_000, attempt: 3 }], failed)
    expect(again.list).toMatchObject({ refresh: { kind: 'loading', attempt: 3 } })
    expect(run([{ type: 'list_answered', attempt: 2, data: LIST }], again).list).toMatchObject({ data: stale, refresh: { kind: 'loading', attempt: 3 } })
  })

  it('ignores a request numbered no higher than an earlier one, so no two loads share a number', () => {
    const retrying = run([{ type: 'list_requested', at: T0 + 5_000, attempt: 2 }], shown())
    expect(run([{ type: 'list_requested', at: T0 + 6_000, attempt: 2 }], retrying)).toBe(retrying)
  })

  it('a chosen connection gone from the fresh list gives way to the first one', () => {
    const retrying = run([{ type: 'list_requested', at: T0 + 5_000, attempt: 2 }], shown())
    const fresh = run([{ type: 'list_answered', attempt: 2, data: { ...LIST, connections: [LIST.connections[1]] } }], retrying)
    expect(chosenConnection(fresh)?.id).toBe('c2')
  })
})

describe('choosing and tabs', () => {
  it('choosing a connection opens its Connection tab', () => {
    const s = run([{ type: 'list_answered', attempt: 1, data: LIST }, { type: 'tab', tab: 'history' }, { type: 'choose', chosen: { kind: 'connection', id: 'c1' } }])
    expect(s.tab).toBe('connection')
    expect(chosenConnection(s)?.id).toBe('c1')
  })

  it('an empty list chooses the Google list rather than nothing', () => {
    const s = run([{ type: 'list_answered', attempt: 1, data: { ...LIST, connections: [] } }])
    expect(s.chosen).toEqual({ kind: 'google' })
  })

  it('keeps each connection history apart, with its loading, answered and failed states', () => {
    const s = run([
      { type: 'history_requested', id: 'c1', at: T0 },
      { type: 'history_requested', id: 'c2', at: T0 },
      { type: 'history_answered', id: 'c1', entries: [] },
      { type: 'history_refused', id: 'c2', sentence: "The connection's history could not be read." },
    ])
    expect(s.history.c1).toEqual({ kind: 'loaded', entries: [] })
    expect(s.history.c2).toEqual({ kind: 'failed', sentence: "The connection's history could not be read." })
  })
})

describe('the Google list', () => {
  const loaded = () => run([{ type: 'google_requested', at: T0 }, { type: 'google_answered', subjects: [entry('ops@trypennie.com')], reachedLimit: false }])

  it('loads, then shows its entries; a list that could not be read is said, never an empty list', () => {
    expect(run([{ type: 'google_requested', at: T0 }]).google).toEqual({ kind: 'loading', startedAt: T0 })
    expect(loaded().google).toMatchObject({ kind: 'loaded', subjects: [entry('ops@trypennie.com')] })
    expect(run([{ type: 'google_requested', at: T0 }, { type: 'google_refused', sentence: 'The list could not be read.' }]).google).toEqual({ kind: 'failed', sentence: 'The list could not be read.' })
  })

  it('adds what was typed: adding with its start, then the entry listed and the box cleared', () => {
    const adding = run([{ type: 'draft', text: '  reports@trypennie.com ' }, { type: 'add_requested', at: T0 + 1_000 }], loaded())
    expect(adding.edit).toEqual({ kind: 'adding', text: 'reports@trypennie.com', startedAt: T0 + 1_000 })
    const added = run([{ type: 'add_answered', entry: entry('reports@trypennie.com') }], adding)
    expect(added.edit).toEqual({ kind: 'idle' })
    expect(added.draft).toBe('')
    expect(added.google).toMatchObject({ subjects: [entry('ops@trypennie.com'), entry('reports@trypennie.com')] })
  })

  it('an entry already listed is not listed twice', () => {
    const s = run([{ type: 'draft', text: 'ops@trypennie.com' }, { type: 'add_requested', at: T0 }, { type: 'add_answered', entry: entry('ops@trypennie.com') }], loaded())
    expect(s.google).toMatchObject({ subjects: [entry('ops@trypennie.com')] })
  })

  it('a refused add keeps what was typed and says why; typing again clears the sentence', () => {
    const refused = run([{ type: 'draft', text: 'Partner reports' }, { type: 'add_requested', at: T0 }, { type: 'add_refused', sentence: 'That is not a mailbox address or a shared drive id.' }], loaded())
    expect(refused.edit).toEqual({ kind: 'failed', sentence: 'That is not a mailbox address or a shared drive id.' })
    expect(refused.draft).toBe('Partner reports')
    expect(run([{ type: 'draft', text: 'Partner reports 2' }], refused).edit).toEqual({ kind: 'idle' })
  })

  it('adds nothing for an empty box, or while another change is in flight', () => {
    expect(run([{ type: 'draft', text: '   ' }, { type: 'add_requested', at: T0 }], loaded()).edit).toEqual({ kind: 'idle' })
    const removing = run([{ type: 'remove_requested', entry: { kind: 'mailbox', subject: 'ops@trypennie.com' }, shown: 'ops@trypennie.com', at: T0 }], loaded())
    expect(run([{ type: 'draft', text: 'x@y.z' }, { type: 'add_requested', at: T0 }], removing).edit.kind).toBe('removing')
  })

  it('removes an entry only once the server says so, and a refusal (one a connection names) is said by its sentence and removes nothing', () => {
    const removing = run([{ type: 'remove_requested', entry: { kind: 'mailbox', subject: 'ops@trypennie.com' }, shown: 'ops@trypennie.com', at: T0 }], loaded())
    expect(removing.google).toMatchObject({ subjects: [entry('ops@trypennie.com')] })
    expect(run([{ type: 'remove_answered', entry: { kind: 'mailbox', subject: 'ops@trypennie.com' } }], removing).google).toMatchObject({ subjects: [] })
    const refused = run([{ type: 'remove_refused', sentence: 'ops@trypennie.com cannot be removed while Ops mailbox acts as it.' }], removing)
    expect(refused.edit).toEqual({ kind: 'failed', sentence: 'ops@trypennie.com cannot be removed while Ops mailbox acts as it.' })
    expect(refused.google).toMatchObject({ subjects: [entry('ops@trypennie.com')] })
  })
})
