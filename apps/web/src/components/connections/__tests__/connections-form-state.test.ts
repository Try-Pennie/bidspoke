/**
 * The Connections page's reducer, part 2 (#2338, build PR 10): the Add
 * connection form (open in place of the details with nothing chosen, its
 * saving, stalled and failed states, the saved connection chosen), and the
 * Reconnect, Replace and Remove dialogs. Time moves only by the tick event.
 */
import { describe, expect, it } from 'vitest'
import type { ConnectionView } from '../connection-model'
import { EMPTY_ADD_DRAFT } from '../add-form-model'
import {
  chosenConnection, connectionsReducer, initialConnectionsState, unsavedWork, type ConnectionsEvent, type ConnectionsState, type LoadedList,
} from '../connections-state'

const T0 = Date.parse('2026-10-20T16:00:00Z')
const SAVE_DEADLINE = 75_000
const REMOVE_DEADLINE = 30_000

const conn = (over: Partial<ConnectionView>): ConnectionView => ({
  id: 'c1', name: 'Pennie Salesforce', service: 'salesforce', serviceName: 'Salesforce', actsAs: 'integration@trypennie.com', status: 'ok',
  org: 'trypennie.my.salesforce.com', target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'cid' },
  workflows: [{ id: 'w1', name: 'Lead Completed sync', deleted: false }], lastCheckedAt: null, problemSince: null, problemCause: null, alertLogin: false, ...over,
})

const LIST: LoadedList = {
  connections: [
    conn({}),
    conn({ id: 'c2', name: 'Achieve Salesforce', status: 'reauth', problemSince: '2026-10-20T13:52:00Z', problemCause: 'login_refused: invalid_client' }),
    conn({ id: 'c3', name: 'Spare Salesforce', workflows: [] }),
  ],
  statuses: { stale: false, asOf: '2026-10-20T16:00:00Z' },
}

const SAVED = conn({ id: 'new1', name: 'Achieve Salesforce 2', workflows: [], lastCheckedAt: '2026-10-20T16:00:06.000Z' })
const STALLED = 'The login check with Salesforce did not answer within 75 seconds, so Bidspoke cannot tell whether the connection was saved. Reload the page to see before saving again.'

function run(events: ConnectionsEvent[], from?: ConnectionsState): ConnectionsState {
  const start = from ?? initialConnectionsState(T0, 45_000, undefined, { saveDeadlineMs: SAVE_DEADLINE, removeDeadlineMs: REMOVE_DEADLINE })
  return events.reduce(connectionsReducer, start)
}

const loaded = (): ConnectionsState => run([{ type: 'list_answered', attempt: 1, data: LIST }, { type: 'choose', chosen: { kind: 'connection', id: 'c1' } }])
const filled: ConnectionsEvent[] = [
  { type: 'add_opened' },
  { type: 'add_service', service: 'salesforce' },
  { type: 'add_name', text: 'Achieve Salesforce 2' },
  { type: 'add_field', field: 'instance_url', text: 'https://achieve.my.salesforce.com' },
  { type: 'add_field', field: 'client_id', text: '3MVG9xk2Q7R1s0p0Lm' },
  { type: 'add_field', field: 'client_secret', text: 'plainsecrets' },
]
const saving = (): ConnectionsState => run([...filled, { type: 'save_requested', attempt: 1, at: T0, stalled: STALLED }], loaded())

describe('the Add connection form (R11, D11)', () => {
  it('opens in place of the details with nothing chosen in the list, and only once the list has loaded', () => {
    expect(run([{ type: 'add_opened' }]).add).toBeNull()
    const s = run([{ type: 'add_opened' }], loaded())
    expect(s.chosen).toEqual({ kind: 'add' })
    expect(chosenConnection(s)).toBeNull()
    expect(s.add).toEqual({ draft: EMPTY_ADD_DRAFT, save: { kind: 'editing' }, before: { kind: 'connection', id: 'c1' } })
  })

  it('keeps what each service was given when the service is changed, and Cancel goes back to what was chosen', () => {
    const s = run([...filled, { type: 'add_service', service: 'snowflake' }, { type: 'add_field', field: 'account', text: 'ab1' }, { type: 'add_service', service: 'salesforce' }], loaded())
    expect(s.add!.draft.values).toEqual({ salesforce: { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm', client_secret: 'plainsecrets' }, snowflake: { account: 'ab1' } })
    const closed = run([{ type: 'add_closed' }], s)
    expect(closed.add).toBeNull()
    expect(closed.chosen).toEqual({ kind: 'connection', id: 'c1' })
  })

  it('records an org typed as a new one, so the box opens as the box it was typed into', () => {
    const s = run([{ type: 'add_opened' }, { type: 'add_service', service: 'salesforce' }, { type: 'add_field', field: 'instance_url', text: 'lendco.my.salesforce.com', typedNew: true }], loaded())
    expect(s.add!.draft.typedNew).toEqual({ salesforce: { instance_url: true } })
  })

  it('keeps the form open over a list that loads again', () => {
    const s = run([{ type: 'add_opened' }, { type: 'list_requested', at: T0, attempt: 2 }, { type: 'list_answered', attempt: 2, data: LIST }], loaded())
    expect(s.chosen).toEqual({ kind: 'add' })
  })
})

describe('a save (R13, R14, R18)', () => {
  it('while it checks the login only Save is held: the line says when it began, and an edit changes nothing already sent', () => {
    const s = saving()
    expect(s.add!.save).toEqual({ kind: 'saving', attempt: 1, startedAt: T0, stalled: STALLED })
    const edited = run([{ type: 'add_name', text: 'Other' }], s)
    expect(edited.add!.draft.name).toBe('Other')
    expect(edited.add!.save).toEqual(s.add!.save)
    // A second press while one is running starts nothing.
    expect(run([{ type: 'save_requested', attempt: 2, at: T0 + 1_000, stalled: STALLED }], s).add!.save).toMatchObject({ attempt: 1 })
  })

  it('needs a service chosen before it can start', () => {
    expect(run([{ type: 'add_opened' }, { type: 'add_name', text: 'x' }, { type: 'save_requested', attempt: 1, at: T0, stalled: STALLED }], loaded()).add!.save.kind).toBe('editing')
  })

  it('a saved connection is chosen in the list and opens in the panel, with the form gone and no message', () => {
    const s = run([{ type: 'save_answered', attempt: 1, connection: SAVED }], saving())
    expect(s.add).toBeNull()
    expect(s.chosen).toEqual({ kind: 'connection', id: 'new1' })
    expect(s.tab).toBe('connection')
    expect(chosenConnection(s)).toEqual(SAVED)
    expect(s.list.kind === 'loaded' && s.list.data.connections.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'new1'])
  })

  it('a refusal turns the line into the failed one with its sentence, and Save is ready again', () => {
    const s = run([{ type: 'save_refused', attempt: 1, sentence: 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.' }], saving())
    expect(s.add!.save).toEqual({ kind: 'failed', sentence: 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.', unconfirmed: false })
    expect(run([{ type: 'save_requested', attempt: 2, at: T0 + 9_000, stalled: STALLED }], s).add!.save.kind).toBe('saving')
    // Typing again clears the failed line.
    expect(run([{ type: 'add_field', field: 'client_secret', text: 'another' }], s).add!.save.kind).toBe('editing')
  })

  it('stalls into the failed state at its deadline, saying whether it saved is not known', () => {
    const before = run([{ type: 'tick', at: T0 + SAVE_DEADLINE - 1 }], saving())
    expect(before.add!.save.kind).toBe('saving')
    const s = run([{ type: 'tick', at: T0 + SAVE_DEADLINE }], before)
    expect(s.add!.save).toEqual({ kind: 'failed', sentence: STALLED, unconfirmed: true })
  })

  it('a late answer to a stalled save is still the truth: the connection is listed and chosen', () => {
    const stalled = run([{ type: 'tick', at: T0 + SAVE_DEADLINE }], saving())
    const s = run([{ type: 'save_answered', attempt: 1, connection: SAVED }], stalled)
    expect(s.chosen).toEqual({ kind: 'connection', id: 'new1' })
    expect(s.add).toBeNull()
    // So is a late refusal, which says what happened in place of "not known".
    expect(run([{ type: 'save_refused', attempt: 1, sentence: 'Another Salesforce connection already has that name. Nothing was saved. Choose another name and save again.' }], stalled).add!.save).toMatchObject({ kind: 'failed', unconfirmed: false })
  })

  it("ignores an earlier save's answer once a later one has started", () => {
    const refused = run([{ type: 'save_refused', attempt: 1, sentence: 'x. Nothing was saved. y.' }, { type: 'save_requested', attempt: 2, at: T0 + 5_000, stalled: STALLED }], saving())
    const s = run([{ type: 'save_answered', attempt: 1, connection: SAVED }], refused)
    expect(s.add!.save).toMatchObject({ kind: 'saving', attempt: 2 })
    expect(s.list.kind === 'loaded' && s.list.data.connections.some((c) => c.id === 'new1')).toBe(false)
  })

  it('a save that answers after the form was left is still listed, without taking the panel', () => {
    const left = run([{ type: 'choose', chosen: { kind: 'connection', id: 'c3' } }], saving())
    expect(left.add).toBeNull()
    const s = run([{ type: 'save_answered', attempt: 1, connection: SAVED }], left)
    expect(s.chosen).toEqual({ kind: 'connection', id: 'c3' })
    expect(s.list.kind === 'loaded' && s.list.data.connections.some((c) => c.id === 'new1')).toBe(true)
    // Cancel while it checks closes the form too (only Save is held), and the answer is still listed.
    const cancelled = run([{ type: 'add_closed' }], saving())
    expect([cancelled.add, cancelled.chosen]).toEqual([null, { kind: 'connection', id: 'c1' }])
    expect(run([{ type: 'save_answered', attempt: 1, connection: SAVED }], cancelled).list).toMatchObject({ data: { connections: expect.arrayContaining([expect.objectContaining({ id: 'new1' })]) } })
  })
})

describe('unsaved work, which the leave guard asks about (L608)', () => {
  it('is a form with something typed, a save running, a Reconnect with a secret typed, or a change running', () => {
    expect(unsavedWork(loaded())).toBe(false)
    expect(unsavedWork(run([{ type: 'add_opened' }, { type: 'add_service', service: 'salesforce' }], loaded()))).toBe(false)
    expect(unsavedWork(run(filled, loaded()))).toBe(true)
    expect(unsavedWork(saving())).toBe(true)
    const reconnect = run([{ type: 'dialog_opened', dialog: 'reconnect', id: 'c2' }], loaded())
    expect(unsavedWork(reconnect)).toBe(false)
    expect(unsavedWork(run([{ type: 'dialog_field', field: 'client_secret', text: 'x' }], reconnect))).toBe(true)
    expect(unsavedWork(run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }], loaded()))).toBe(true)
  })
})

describe('Reconnect (R19)', () => {
  const open = (): ConnectionsState => run([{ type: 'dialog_opened', dialog: 'reconnect', id: 'c2' }], loaded())

  it('opens for an ops connection, never for the Slack alert login, whose routes refuse it', () => {
    expect(open().dialog).toEqual({ kind: 'reconnect', id: 'c2', values: {}, save: { kind: 'editing' } })
    const alert = run([{ type: 'list_answered', attempt: 1, data: { ...LIST, connections: [conn({ id: 'a1', alertLogin: true })] } }, { type: 'dialog_opened', dialog: 'reconnect', id: 'a1' }])
    expect(alert.dialog).toBeNull()
  })

  it('a reconnected login reads working, its problem gone, checked now, acting as who the check measured', () => {
    const s = run([{ type: 'dialog_field', field: 'client_secret', text: 'plainsecrets' }, { type: 'reconnect_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'reconnect_answered', attempt: 1, id: 'c2', actsAs: 'pennie.api@achieve.example', at: T0 + 4_000 }], open())
    expect(s.dialog).toBeNull()
    const c = s.list.kind === 'loaded' ? s.list.data.connections.find((x) => x.id === 'c2') : undefined
    expect(c).toMatchObject({ status: 'ok', problemSince: null, problemCause: null, actsAs: 'pennie.api@achieve.example', lastCheckedAt: '2026-10-20T16:00:04.000Z' })
  })

  it("keeps who it acted as when the answer measured nobody, and reads the connection's history again", () => {
    const withHistory = run([{ type: 'history_answered', id: 'c2', entries: [] }], open())
    const s = run([{ type: 'reconnect_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'reconnect_answered', attempt: 1, id: 'c2', actsAs: null, at: T0 }], withHistory)
    expect(s.list.kind === 'loaded' && s.list.data.connections.find((x) => x.id === 'c2')?.actsAs).toBe('integration@trypennie.com')
    expect(s.history.c2).toBeUndefined()
  })

  it('a refusal keeps the dialog open with its sentence; a stall says it is not known; Cancel closes it while it checks', () => {
    const running = run([{ type: 'reconnect_requested', attempt: 1, at: T0, stalled: 'stalled sentence' }], open())
    const closed = run([{ type: 'dialog_closed' }], running)
    expect(closed.dialog).toBeNull()
    // Its answer still lands on the list.
    expect(run([{ type: 'reconnect_answered', attempt: 1, id: 'c2', actsAs: null, at: T0 }], closed).list).toMatchObject({ data: { connections: expect.arrayContaining([expect.objectContaining({ id: 'c2', status: 'ok' })]) } })
    expect(run([{ type: 'reconnect_refused', attempt: 1, sentence: 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.' }], running).dialog)
      .toMatchObject({ kind: 'reconnect', save: { kind: 'failed', unconfirmed: false } })
    expect(run([{ type: 'tick', at: T0 + SAVE_DEADLINE }], running).dialog).toMatchObject({ save: { kind: 'failed', sentence: 'stalled sentence', unconfirmed: true } })
  })
})

describe('Remove (R21)', () => {
  it('opens only for a connection no workflow uses', () => {
    expect(run([{ type: 'dialog_opened', dialog: 'remove', id: 'c1' }], loaded()).dialog).toBeNull()
    expect(run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }], loaded()).dialog).toEqual({ kind: 'remove', id: 'c3', values: {}, save: { kind: 'editing' } })
  })

  it('a removed connection leaves the list, and the panel opens the first one as the list reads', () => {
    const s = run([{ type: 'choose', chosen: { kind: 'connection', id: 'c3' } }, { type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'connection_remove_answered', attempt: 1, id: 'c3', notice: null }], loaded())
    expect(s.dialog).toBeNull()
    expect(s.list.kind === 'loaded' && s.list.data.connections.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(s.chosen).toEqual({ kind: 'connection', id: 'c2' })
  })

  it("says so when the workflows server could not be told, since the removal stands", () => {
    const s = run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'connection_remove_answered', attempt: 1, id: 'c3', notice: 'The connection is removed. The workflows server could not be told straight away.' }], loaded())
    expect(s.dialog).toEqual({ kind: 'removed', name: 'Spare Salesforce', notice: 'The connection is removed. The workflows server could not be told straight away.' })
    expect(run([{ type: 'dialog_closed' }], s).dialog).toBeNull()
  })

  it('refused because a workflow now uses it: the sentence stays, and the panel learns which workflows', () => {
    const s = run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'connection_remove_refused', attempt: 1, sentence: 'Daily cleanup uses this connection, so it cannot be removed. Nothing was removed. Take it out of that workflow first.', workflows: [{ id: 'w9', name: 'Daily cleanup', deleted: false }] }], loaded())
    expect(s.dialog).toMatchObject({ kind: 'remove', save: { kind: 'failed', unconfirmed: false } })
    expect(s.list.kind === 'loaded' && s.list.data.connections.find((c) => c.id === 'c3')?.workflows).toEqual([{ id: 'w9', name: 'Daily cleanup', deleted: false }])
  })

  it('stalls at its own deadline', () => {
    const s = run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 'not known' }, { type: 'tick', at: T0 + REMOVE_DEADLINE }], loaded())
    expect(s.dialog).toMatchObject({ save: { kind: 'failed', sentence: 'not known', unconfirmed: true } })
  })
})

describe('Replace, drawn and inert until build PR 12 (R20)', () => {
  it('opens with the first other working connection of the service and every using workflow ticked; a tick can be taken off', () => {
    const s = run([{ type: 'dialog_opened', dialog: 'replace', id: 'c1' }], loaded())
    // Spare Salesforce works; Achieve Salesforce needs reconnecting, so it is not offered first.
    expect(s.dialog).toEqual({ kind: 'replace', id: 'c1', with: 'c3', ticked: ['w1'] })
    expect(run([{ type: 'replace_tick', workflow: 'w1' }], s).dialog).toMatchObject({ ticked: [] })
    expect(run([{ type: 'replace_tick', workflow: 'w1' }, { type: 'replace_tick', workflow: 'w1' }], s).dialog).toMatchObject({ ticked: ['w1'] })
    expect(run([{ type: 'replace_with', id: 'c2' }], s).dialog).toMatchObject({ with: 'c2' })
  })
})
