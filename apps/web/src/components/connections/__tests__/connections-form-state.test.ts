/**
 * The Connections page's reducer, part 2 (#2338, build PR 10): the Add
 * connection form (open in place of the details with nothing chosen, its
 * saving, stalled and failed states, the saved connection chosen), and the
 * Reconnect, Replace and Remove dialogs. Time moves only by the tick event.
 */
import { describe, expect, it } from 'vitest'
import type { ConnectionView } from '../connection-model'
import { EMPTY_ADD_DRAFT } from '../add-form-model'
import { CONNECTION_REPLACE_MOST } from '@/lib/api'
import {
  chosenConnection, connectionsReducer, initialConnectionsState, unsavedWork, type ConnectionsEvent, type ConnectionsState, type LoadedList,
} from '../connections-state'

const T0 = Date.parse('2026-10-20T16:00:00Z')
const SAVE_DEADLINE = 75_000
const REMOVE_DEADLINE = 30_000
const REPLACE_DEADLINE = 90_000

const conn = (over: Partial<ConnectionView>): ConnectionView => ({
  id: 'c1', name: 'Pennie Salesforce', service: 'salesforce', serviceName: 'Salesforce', actsAs: 'integration@trypennie.com', status: 'ok',
  org: 'trypennie.my.salesforce.com', target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'cid' },
  workflows: [{ id: 'w1', name: 'Lead Completed sync', deleted: false }], lastCheckedAt: null, problemSince: null, problemCause: null, alertLogin: false, ownAccount: false, ...over,
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
  const start = from ?? initialConnectionsState(T0, 45_000, undefined, { saveDeadlineMs: SAVE_DEADLINE, removeDeadlineMs: REMOVE_DEADLINE, replaceDeadlineMs: REPLACE_DEADLINE })
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
    expect(s.add).toEqual({ draft: EMPTY_ADD_DRAFT, save: { kind: 'editing' }, before: { kind: 'connection', id: 'c1' }, started: null })
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

  it("an earlier save's answer, arriving while a later one runs, is listed but never takes the form from the later one", () => {
    // The first save stalled, and Save was pressed again: the first may still land, and if it does the connection exists.
    const again = run([{ type: 'tick', at: T0 + SAVE_DEADLINE }, { type: 'save_requested', attempt: 2, at: T0 + SAVE_DEADLINE + 1_000, stalled: STALLED }], saving())
    const s = run([{ type: 'save_answered', attempt: 1, connection: SAVED }], again)
    expect(s.add!.save).toMatchObject({ kind: 'saving', attempt: 2 })
    expect(s.chosen).toEqual({ kind: 'add' })
    expect(s.list.kind === 'loaded' && s.list.data.connections.some((c) => c.id === 'new1')).toBe(true)
    // An earlier refusal says nothing about the later save.
    expect(run([{ type: 'save_refused', attempt: 1, sentence: 'x. Nothing was saved. y.' }], again).add!.save).toMatchObject({ kind: 'saving', attempt: 2 })
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

  it("a cancelled save's late answer never takes a form opened since: it is listed, and the new draft stays", () => {
    const reopened = run([{ type: 'add_closed' }, { type: 'add_opened' }, { type: 'add_service', service: 'snowflake' }, { type: 'add_name', text: 'Warehouse 2' }], saving())
    const s = run([{ type: 'save_answered', attempt: 1, connection: SAVED }], reopened)
    expect(s.chosen).toEqual({ kind: 'add' })
    expect(s.add!.draft.name).toBe('Warehouse 2')
    expect(s.list.kind === 'loaded' && s.list.data.connections.some((c) => c.id === 'new1')).toBe(true)
    // Nor does its late refusal touch the new form.
    expect(run([{ type: 'save_refused', attempt: 1, sentence: 'x. Nothing was saved. y.' }], reopened).add!.save).toEqual({ kind: 'editing' })
  })
})

describe('unsaved work, which the leave guard asks about (L608)', () => {
  it('names what leaving would lose: a form with something typed or its save running, a login typed into Reconnect or its check running, a removal running', () => {
    expect(unsavedWork(loaded())).toBeNull()
    expect(unsavedWork(run([{ type: 'add_opened' }, { type: 'add_service', service: 'salesforce' }], loaded()))).toBeNull()
    expect(unsavedWork(run(filled, loaded()))).toBe('form')
    expect(unsavedWork(saving())).toBe('form_checking')
    const reconnect = run([{ type: 'dialog_opened', dialog: 'reconnect', id: 'c2' }], loaded())
    expect(unsavedWork(reconnect)).toBeNull()
    const typed = run([{ type: 'dialog_field', field: 'client_secret', text: 'x' }], reconnect)
    expect(unsavedWork(typed)).toBe('login')
    expect(unsavedWork(run([{ type: 'reconnect_requested', attempt: 1, at: T0, stalled: 's' }], reconnect))).toBe('login_checking')
    expect(unsavedWork(run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }], loaded()))).toBe('removing')
  })
})

describe('Reconnect (R19)', () => {
  const open = (): ConnectionsState => run([{ type: 'dialog_opened', dialog: 'reconnect', id: 'c2' }], loaded())

  // Build PR 14 (Dan's decision 4): the Slack alerts login has Reconnect like every other login; its
  // routes still refuse Remove and Replace, so neither dialog opens for it.
  it('opens for an ops connection and for the Slack alerts login; Remove and Replace never open for the alert login', () => {
    expect(open().dialog).toEqual({ kind: 'reconnect', id: 'c2', values: {}, save: { kind: 'editing' }, started: null })
    const listed: ConnectionsEvent = { type: 'list_answered', attempt: 1, data: { ...LIST, connections: [conn({ id: 'a1', alertLogin: true, workflows: [] })] } }
    expect(run([listed, { type: 'dialog_opened', dialog: 'reconnect', id: 'a1' }]).dialog).toEqual({ kind: 'reconnect', id: 'a1', values: {}, save: { kind: 'editing' }, started: null })
    expect(run([listed, { type: 'dialog_opened', dialog: 'remove', id: 'a1' }]).dialog).toBeNull()
    expect(run([listed, { type: 'dialog_opened', dialog: 'replace', id: 'a1' }]).dialog).toBeNull()
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

  it("a cancelled check's late answer lands on the list but never closes a Reconnect opened since", () => {
    const reopened = run([{ type: 'reconnect_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'dialog_closed' }, { type: 'dialog_opened', dialog: 'reconnect', id: 'c2' }, { type: 'dialog_field', field: 'client_secret', text: 'again' }], open())
    const s = run([{ type: 'reconnect_answered', attempt: 1, id: 'c2', actsAs: null, at: T0 }], reopened)
    expect(s.dialog).toMatchObject({ kind: 'reconnect', values: { client_secret: 'again' } })
    expect(s.list.kind === 'loaded' && s.list.data.connections.find((c) => c.id === 'c2')?.status).toBe('ok')
    expect(run([{ type: 'reconnect_refused', attempt: 1, sentence: 'x. Nothing was saved. y.' }], reopened).dialog).toMatchObject({ save: { kind: 'editing' } })
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

// #2727 (Dan, 2026-10-28): a Google company mailbox has nothing to re-enter, so its Reconnect is a one click
// check with no dialog. Its running, failed and stalled line belongs to that connection, in its panel.
describe('the one click check of a company mailbox (#2727)', () => {
  const MAILBOX = conn({ id: 'm1', name: 'Ops mailbox', service: 'google', serviceName: 'Google', actsAs: 'ops@trypennie.com', target: { subject: 'ops@trypennie.com' }, org: null, status: 'reauth', problemSince: '2026-10-28T13:12:00Z', problemCause: 'login_refused: unauthorized_client' })
  const withMailbox = (): ConnectionsState => run([{ type: 'list_answered', attempt: 1, data: { ...LIST, connections: [...LIST.connections, MAILBOX, conn({ id: 'own', name: 'My Google', service: 'google', serviceName: 'Google', target: { own_account: true }, ownAccount: true })] } }, { type: 'choose', chosen: { kind: 'connection', id: 'm1' } }])
  const running = (): ConnectionsState => run([{ type: 'recheck_requested', id: 'm1', attempt: 1, at: T0, stalled: 'stalled sentence' }], withMailbox())

  it('starts for a company mailbox only, opening no dialog, and holds a second press while it runs', () => {
    const s = running()
    expect(s.dialog).toBeNull()
    expect(s.recheck).toEqual({ id: 'm1', started: 1, save: { kind: 'saving', attempt: 1, startedAt: T0, stalled: 'stalled sentence' } })
    expect(run([{ type: 'recheck_requested', id: 'm1', attempt: 2, at: T0 + 1, stalled: 's' }], s).recheck).toEqual(s.recheck)
    // A connection with something to enter, or a person's own Google, reconnects in its dialog instead.
    expect(run([{ type: 'recheck_requested', id: 'c2', attempt: 1, at: T0, stalled: 's' }], withMailbox()).recheck).toBeNull()
    expect(run([{ type: 'recheck_requested', id: 'own', attempt: 1, at: T0, stalled: 's' }], withMailbox()).recheck).toBeNull()
  })

  it('a check that passes clears the needs reconnecting mark, checked now, and the line goes', () => {
    const s = run([{ type: 'reconnect_answered', attempt: 1, id: 'm1', actsAs: null, at: T0 + 3_000 }], running())
    expect(s.recheck).toBeNull()
    expect(chosenConnection(s)).toMatchObject({ status: 'ok', problemSince: null, problemCause: null, actsAs: 'ops@trypennie.com', lastCheckedAt: '2026-10-20T16:00:03.000Z' })
  })

  it("a refusal says its sentence; a stall says it is not known; an earlier press's late answer changes neither", () => {
    expect(run([{ type: 'recheck_refused', attempt: 1, sentence: 'Google refused the login.' }], running()).recheck).toEqual({ id: 'm1', started: 1, save: { kind: 'failed', sentence: 'Google refused the login.', unconfirmed: false } })
    const stalled = run([{ type: 'tick', at: T0 + SAVE_DEADLINE }], running())
    expect(stalled.recheck).toEqual({ id: 'm1', started: 1, save: { kind: 'failed', sentence: 'stalled sentence', unconfirmed: true } })
    // A stalled check's late answer is still the truth: the mark clears and the line goes.
    expect(run([{ type: 'reconnect_answered', attempt: 1, id: 'm1', actsAs: null, at: T0 + SAVE_DEADLINE + 1 }], stalled).recheck).toBeNull()
    expect(run([{ type: 'recheck_refused', attempt: 0, sentence: 'old' }], running()).recheck?.save.kind).toBe('saving')
  })

  it('a failed line goes when another connection is opened; a running one stays with its connection', () => {
    const failed = run([{ type: 'recheck_refused', attempt: 1, sentence: 'x' }], running())
    expect(run([{ type: 'choose', chosen: { kind: 'connection', id: 'c1' } }], failed).recheck).toBeNull()
    expect(run([{ type: 'choose', chosen: { kind: 'connection', id: 'c1' } }], running()).recheck?.id).toBe('m1')
  })
})

describe('Remove (R21)', () => {
  it("a cancelled removal's late answer takes the connection off and closes a Remove opened since, its notice shown only to its own press", () => {
    const reopened = run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'dialog_closed' }, { type: 'dialog_opened', dialog: 'remove', id: 'c3' }], loaded())
    const s = run([{ type: 'connection_remove_answered', attempt: 1, id: 'c3', notice: 'The connection is removed. The workflows server could not be told straight away.' }], reopened)
    expect(s.dialog).toBeNull()
    expect(s.list.kind === 'loaded' && s.list.data.connections.some((c) => c.id === 'c3')).toBe(false)
    // Its late refusal does not fail the Remove opened since.
    expect(run([{ type: 'connection_remove_refused', attempt: 1, sentence: 'x. Nothing was removed. y.' }], reopened).dialog).toMatchObject({ kind: 'remove', save: { kind: 'editing' } })
  })

  it('opens only for a connection no workflow uses', () => {
    expect(run([{ type: 'dialog_opened', dialog: 'remove', id: 'c1' }], loaded()).dialog).toBeNull()
    expect(run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }], loaded()).dialog).toEqual({ kind: 'remove', id: 'c3', values: {}, save: { kind: 'editing' }, started: null })
  })

  it('a removed connection leaves the list, and the panel opens the first one as the list reads', () => {
    const s = run([{ type: 'choose', chosen: { kind: 'connection', id: 'c3' } }, { type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'connection_remove_answered', attempt: 1, id: 'c3', notice: null }], loaded())
    expect(s.dialog).toBeNull()
    expect(s.list.kind === 'loaded' && s.list.data.connections.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(s.chosen).toEqual({ kind: 'connection', id: 'c2' })
  })

  it("says so when the workflows server could not be told, since the removal stands", () => {
    const s = run([{ type: 'dialog_opened', dialog: 'remove', id: 'c3' }, { type: 'connection_remove_requested', attempt: 1, at: T0, stalled: 's' }, { type: 'connection_remove_answered', attempt: 1, id: 'c3', notice: 'The connection is removed. The workflows server could not be told straight away.' }], loaded())
    expect(s.dialog).toEqual({ kind: 'notice', name: 'Spare Salesforce', notice: 'The connection is removed. The workflows server could not be told straight away.' })
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

describe('Replace (R20, build PR 12)', () => {
  it('opens with the first other working connection of the service and every using workflow ticked; a tick can be taken off', () => {
    const s = run([{ type: 'dialog_opened', dialog: 'replace', id: 'c1' }], loaded())
    // Spare Salesforce works; Achieve Salesforce needs reconnecting, so it is not offered first.
    expect(s.dialog).toEqual({
      kind: 'replace', id: 'c1', with: 'c3', listed: [{ id: 'w1', name: 'Lead Completed sync', deleted: false }], moved: [], ticked: ['w1'], save: { kind: 'editing' }, started: null,
    })
    expect(run([{ type: 'replace_tick', workflow: 'w1' }], s).dialog).toMatchObject({ ticked: [] })
    expect(run([{ type: 'replace_tick', workflow: 'w1' }, { type: 'replace_tick', workflow: 'w1' }], s).dialog).toMatchObject({ ticked: ['w1'] })
    expect(run([{ type: 'replace_with', id: 'c2' }], s).dialog).toMatchObject({ with: 'c2' })
  })

  // Six workflows on Pennie Salesforce, as the settled design draws it, and one soft deleted, which no route can give a new version.
  const SIX = ['Achieve report import', 'Daily Salesforce cleanup', 'Lead Completed sync', 'Partner report email', 'Reserve My Loan intake', 'Tripoint submission']
  const idOfName = (name: string) => `w-${SIX.indexOf(name)}`
  const live = SIX.map((name) => ({ id: idOfName(name), name, deleted: false }))
  const withDeleted = (): ConnectionsState => run([
    { type: 'list_answered', attempt: 1, data: { ...LIST, connections: LIST.connections.map((c) => (c.id === 'c1' ? { ...c, workflows: [...live, { id: 'w9', name: 'Old lead import', deleted: true }] } : c)) } },
    { type: 'choose', chosen: { kind: 'connection', id: 'c1' } },
    { type: 'dialog_opened', dialog: 'replace', id: 'c1' },
  ])
  const listOf = (s: ConnectionsState) => (s.list.kind === 'loaded' ? s.list.data.connections : [])
  const answered = (over: Partial<Extract<ConnectionsEvent, { type: 'connection_replace_answered' }>> = {}): ConnectionsEvent => ({
    type: 'connection_replace_answered', attempt: 1, id: 'c1', withId: 'c3', withName: 'Spare Salesforce', sentence: null, warning: null,
    workflows: live.map((w) => ({ id: w.id, name: w.name, outcome: 'replaced' as const })),
    ...over,
  })

  it('leaves a deleted workflow out of the list entirely, and ticks every other one (decision 3)', () => {
    const d = withDeleted().dialog
    expect(d).toMatchObject({ listed: live, ticked: live.map((w) => w.id), moved: [] })
    // It still counts in Used by.
    expect(listOf(withDeleted()).find((c) => c.id === 'c1')?.workflows).toHaveLength(7)
  })

  it(`ticks at most ${CONNECTION_REPLACE_MOST}, the most one Replace moves, in the order listed`, () => {
    const many = Array.from({ length: CONNECTION_REPLACE_MOST + 2 }, (_, i) => ({ id: `m${i}`, name: `Workflow ${String(i).padStart(2, '0')}`, deleted: false }))
    const at = (n: number) => run([
      { type: 'list_answered', attempt: 1, data: { ...LIST, connections: LIST.connections.map((c) => (c.id === 'c1' ? { ...c, workflows: many.slice(0, n) } : c)) } },
      { type: 'choose', chosen: { kind: 'connection', id: 'c1' } },
      { type: 'dialog_opened', dialog: 'replace', id: 'c1' },
    ]).dialog
    expect(at(CONNECTION_REPLACE_MOST)).toMatchObject({ ticked: many.slice(0, CONNECTION_REPLACE_MOST).map((w) => w.id) })
    const over = at(CONNECTION_REPLACE_MOST + 2)
    expect(over).toMatchObject({ listed: many, ticked: many.slice(0, CONNECTION_REPLACE_MOST).map((w) => w.id) })
  })

  const MOVING = 'Moving 6 workflows to Spare Salesforce'
  const replacing = (): ConnectionsState => run([{ type: 'connection_replace_requested', attempt: 1, at: T0, stalled: 'not known', label: MOVING }], withDeleted())

  it('says it started in its own words, holds a second press, and is the work the leave question names', () => {
    const s = replacing()
    expect(s.dialog).toMatchObject({ save: { kind: 'saving', attempt: 1, startedAt: T0, label: MOVING }, started: 1 })
    expect(run([{ type: 'connection_replace_requested', attempt: 2, at: T0 + 1, stalled: 'x', label: 'y' }], s)).toBe(s)
    expect(unsavedWork(s)).toBe('replacing')
    // A tick changed while it runs is for the next press: the running one keeps its words.
    expect(run([{ type: 'replace_tick', workflow: 'w-0' }], s).dialog).toMatchObject({ ticked: live.slice(1).map((w) => w.id), save: { kind: 'saving', label: MOVING } })
  })

  it('moved every ticked workflow: closes, and a notice over the page says how many moved where, and that nothing uses it now only when Used by is 0 (decision 4)', () => {
    // The deleted one stays on it, so Used by is still 1 and the second sentence is not said.
    const kept = run([answered()], replacing())
    expect(kept.dialog).toEqual({ kind: 'notice', name: 'Pennie Salesforce', notice: 'Moved 6 workflows to Spare Salesforce.' })
    expect(listOf(kept).find((c) => c.id === 'c1')?.workflows).toEqual([{ id: 'w9', name: 'Old lead import', deleted: true }])
    expect(listOf(kept).find((c) => c.id === 'c3')?.workflows.map((w) => w.name)).toEqual(SIX)
    expect(unsavedWork(kept)).toBeNull()

    const none = run([
      { type: 'list_answered', attempt: 1, data: { ...LIST, connections: LIST.connections.map((c) => (c.id === 'c1' ? { ...c, workflows: live } : c)) } },
      { type: 'choose', chosen: { kind: 'connection', id: 'c1' } },
      { type: 'dialog_opened', dialog: 'replace', id: 'c1' },
      { type: 'connection_replace_requested', attempt: 1, at: T0, stalled: 'not known', label: MOVING },
      answered(),
    ])
    expect(none.dialog).toEqual({ kind: 'notice', name: 'Pennie Salesforce', notice: 'Moved 6 workflows to Spare Salesforce. Nothing uses Pennie Salesforce now.' })
    expect(run([{ type: 'dialog_closed' }], none).dialog).toBeNull()
  })

  it('says one workflow in the singular', () => {
    const one = run([{ type: 'dialog_opened', dialog: 'replace', id: 'c1' }, { type: 'connection_replace_requested', attempt: 1, at: T0, stalled: '', label: 'Moving 1 workflow to Spare Salesforce' }, answered({ workflows: [{ id: 'w1', name: 'Lead Completed sync', outcome: 'replaced' }] })], loaded())
    expect(one.dialog).toEqual({ kind: 'notice', name: 'Pennie Salesforce', notice: 'Moved 1 workflow to Spare Salesforce. Nothing uses Pennie Salesforce now.' })
  })

  it("appends the route's stored copy warning to the same notice, as its own sentence", () => {
    const s = run([answered({ warning: 'A stored copy could not be refreshed.' })], replacing())
    expect(s.dialog).toEqual({ kind: 'notice', name: 'Pennie Salesforce', notice: 'Moved 6 workflows to Spare Salesforce. A stored copy could not be refreshed.' })
  })

  it('a workflow found no longer using it leaves its list, and is not claimed for the replacement', () => {
    const s = run([answered({ workflows: live.map((w, i) => ({ id: w.id, name: i === 1 ? null : w.name, outcome: i === 1 ? 'not_using' as const : 'replaced' as const })) })], replacing())
    expect(listOf(s).find((c) => c.id === 'c1')?.workflows.map((w) => w.id)).toEqual(['w9'])
    expect(listOf(s).find((c) => c.id === 'c3')?.workflows.map((w) => w.id)).not.toContain('w-1')
    expect(s.dialog).toMatchObject({ notice: 'Moved 5 workflows to Spare Salesforce.' })
  })

  const LEFT_WHY = 'Lead Completed sync was saved by someone else while this ran, so it still uses Pennie Salesforce. Replace again to move it.'
  const partial = (): ConnectionsState => run([answered({
    sentence: LEFT_WHY,
    workflows: live.map((w) => ({ id: w.id, name: w.name, outcome: w.name === 'Lead Completed sync' ? 'changed' as const : 'replaced' as const })),
  })], replacing())

  it('moved only some: stays open with every workflow it opened with, the moved ones marked and unticked, the one left ticked, and the red line naming it (decision 2)', () => {
    const s = partial()
    expect(s.dialog).toMatchObject({
      kind: 'replace', listed: live, moved: live.filter((w) => w.name !== 'Lead Completed sync').map((w) => w.id), ticked: [idOfName('Lead Completed sync')],
      save: { kind: 'failed', sentence: LEFT_WHY, unconfirmed: false },
    })
    expect(listOf(s).find((c) => c.id === 'c1')?.workflows.map((w) => w.name)).toEqual(['Lead Completed sync', 'Old lead import'])
    // A moved workflow cannot be ticked again; a tick of the one left clears the line, since what failed is being changed.
    expect(run([{ type: 'replace_tick', workflow: 'w-0' }], s)).toBe(s)
    expect(run([{ type: 'replace_tick', workflow: idOfName('Lead Completed sync') }], s).dialog).toMatchObject({ ticked: [], save: { kind: 'editing' } })
  })

  it('a second Replace from the partial state moves the one left, and its notice counts only what that press moved', () => {
    const s = run([
      { type: 'connection_replace_requested', attempt: 2, at: T0 + 5_000, stalled: '', label: 'Moving 1 workflow to Spare Salesforce' },
      answered({ attempt: 2, workflows: [{ id: idOfName('Lead Completed sync'), name: 'Lead Completed sync', outcome: 'replaced' }] }),
    ], partial())
    expect(s.dialog).toEqual({ kind: 'notice', name: 'Pennie Salesforce', notice: 'Moved 1 workflow to Spare Salesforce.' })
  })

  it('a workflow deleted while it ran stays listed, unticked, and still counts in Used by', () => {
    const s = run([answered({
      sentence: 'Lead Completed sync was deleted, so it cannot get a new version.',
      workflows: live.map((w) => ({ id: w.id, name: w.name, outcome: w.name === 'Lead Completed sync' ? 'deleted' as const : 'replaced' as const })),
    })], replacing())
    expect(s.dialog).toMatchObject({ ticked: [], listed: live })
    expect(listOf(s).find((c) => c.id === 'c1')?.workflows).toEqual([{ id: idOfName('Lead Completed sync'), name: 'Lead Completed sync', deleted: true }, { id: 'w9', name: 'Old lead import', deleted: true }])
  })

  it("an incomplete answer's stored copy warning follows its red line, so it is not lost", () => {
    const s = run([answered({ sentence: LEFT_WHY, warning: 'A stored copy could not be refreshed.', workflows: [{ id: idOfName('Lead Completed sync'), name: 'Lead Completed sync', outcome: 'changed' }] })], replacing())
    expect(s.dialog).toMatchObject({ save: { kind: 'failed', sentence: `${LEFT_WHY} A stored copy could not be refreshed.` } })
  })

  it('refused: says the sentence and changes nothing', () => {
    const s = run([{ type: 'connection_replace_refused', attempt: 1, sentence: 'Nothing was changed.' }], replacing())
    expect(s.dialog).toMatchObject({ kind: 'replace', ticked: live.map((w) => w.id), moved: [], save: { kind: 'failed', sentence: 'Nothing was changed.', unconfirmed: false } })
    expect(s.list).toEqual(withDeleted().list)
  })

  it('stalls at its own deadline, and an answer arriving after still lands', () => {
    const stalled = run([{ type: 'tick', at: T0 + REPLACE_DEADLINE }], replacing())
    expect(stalled.dialog).toMatchObject({ save: { kind: 'failed', sentence: 'not known', unconfirmed: true } })
    expect(run([{ type: 'tick', at: T0 + REPLACE_DEADLINE - 1 }], replacing()).dialog).toMatchObject({ save: { kind: 'saving' } })
    expect(run([answered()], stalled).dialog).toMatchObject({ kind: 'notice' })
  })

  it('an answer to an earlier press is ignored by a dialog opened since, but its workflows still move', () => {
    const reopened = run([{ type: 'dialog_closed' }, { type: 'dialog_opened', dialog: 'replace', id: 'c1' }], replacing())
    const s = run([answered({ workflows: [{ id: 'w-0', name: SIX[0], outcome: 'replaced' }] })], reopened)
    expect(s.dialog).toMatchObject({ kind: 'replace', save: { kind: 'editing' } })
    expect(listOf(s).find((c) => c.id === 'c3')?.workflows.map((w) => w.id)).toEqual(['w-0'])
  })
})

describe("a Google connection's shared drives on the add form (#2572)", () => {
  const drive = (subject: string, display_name: string | null = null) => ({ kind: 'drive' as const, subject, display_name, added_by: 'Dan Wright', added_at: '2026-10-18T16:00:00Z' })
  const google = (): ConnectionsState => run([
    { type: 'google_answered', subjects: [drive('0AFinanceDrive', 'Finance'), drive('0AReportsDrive')], reachedLimit: false },
    { type: 'add_opened' }, { type: 'add_service', service: 'google' },
  ], loaded())

  it('ticks and unticks each drive by its id, in the order ticked, under the chosen service', () => {
    const s = run([{ type: 'add_pick', field: 'drives', value: '0AReportsDrive', picked: true }, { type: 'add_pick', field: 'drives', value: '0AFinanceDrive', picked: true }], google())
    expect(s.add!.draft.lists).toEqual({ google: { drives: ['0AReportsDrive', '0AFinanceDrive'] } })
    expect(run([{ type: 'add_pick', field: 'drives', value: '0AReportsDrive', picked: false }], s).add!.draft.lists).toEqual({ google: { drives: ['0AFinanceDrive'] } })
    // Ticking one already ticked keeps it once.
    expect(run([{ type: 'add_pick', field: 'drives', value: '0AFinanceDrive', picked: true }], s).add!.draft.lists.google.drives).toEqual(['0AReportsDrive', '0AFinanceDrive'])
  })

  it('counts a ticked drive as unsaved work', () => {
    expect(unsavedWork(google())).toBeNull()
    expect(unsavedWork(run([{ type: 'add_pick', field: 'drives', value: '0AFinanceDrive', picked: true }], google()))).toBe('form')
  })

  it('drops a drive taken off the company list from the form, so nothing unseen is sent', () => {
    const ticked = run([{ type: 'add_pick', field: 'drives', value: '0AFinanceDrive', picked: true }, { type: 'add_pick', field: 'drives', value: '0AReportsDrive', picked: true }], google())
    const removed = run([
      { type: 'remove_requested', entry: { kind: 'drive', subject: '0AFinanceDrive' }, shown: 'Finance', at: T0 },
      { type: 'remove_answered', entry: { kind: 'drive', subject: '0AFinanceDrive' } },
    ], ticked)
    expect(removed.add!.draft.lists).toEqual({ google: { drives: ['0AReportsDrive'] } })
  })
})
