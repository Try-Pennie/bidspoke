/**
 * The Connections page's state (#2338, build PR 9): one pure reducer the page
 * only sends events to, tested on its own (connections-state.test.ts), because
 * the pieces change together: the list's load, its deadline and Try again, the
 * stale strip's Try again over a list still shown, the chosen connection and
 * tab, each connection's history, and the Google list with its adds and
 * removes (CLAUDE.md, interlocking screen state).
 *
 * Every wait is told apart (Dan, 2026-06-28): started and still alive carry
 * the moment they began, so the page shows the seconds counting from `now`,
 * and the list's load turns into the could not load card at its deadline. An
 * answer to a load that is no longer the current one is ignored, so a late
 * answer cannot replace the card or a newer list. The clock is the `tick`
 * event's, never the machine's, so tests move time by hand.
 */
import { addRequestOf, draftReady, EMPTY_DRAFT, firstConnection, listGroups, type ConnectionView, type DelegationDraft, type DelegationEntry, type HistoryEntry } from './connection-model'

/** What the could not load card says when Bidspoke's server gave no answer (D23). */
export const LIST_NO_ANSWER = "Bidspoke's server did not answer."

export interface LoadedList {
  connections: ConnectionView[]
  /** stale: a login check did not answer; asOf is when the shown statuses are from (null when unknown). */
  statuses: { stale: boolean; asOf: string | null }
}

export type ListState =
  | { kind: 'loading'; attempt: number; startedAt: number }
  | { kind: 'failed'; attempt: number; cause: string }
  | {
      kind: 'loaded'
      attempt: number
      data: LoadedList
      /** The stale strip's Try again: a load in flight over the list still shown, or why it failed. */
      refresh: { kind: 'idle' } | { kind: 'loading'; attempt: number; startedAt: number } | { kind: 'failed'; cause: string }
    }

export type Chosen = { kind: 'none' } | { kind: 'connection'; id: string } | { kind: 'google' }
export type DetailTab = 'connection' | 'used_by' | 'history'

export type HistoryState = { kind: 'loading'; startedAt: number } | { kind: 'loaded'; entries: HistoryEntry[] } | { kind: 'failed'; sentence: string }

export type GoogleState =
  | { kind: 'loading'; startedAt: number }
  | { kind: 'loaded'; subjects: DelegationEntry[]; reachedLimit: boolean }
  | { kind: 'failed'; sentence: string }

export type GoogleEdit =
  | { kind: 'idle' }
  /** The entry being added, by the name it is shown by (a mailbox's address, a drive's name). */
  | { kind: 'adding'; shown: string; startedAt: number }
  | { kind: 'removing'; entry: Pick<DelegationEntry, 'kind' | 'subject'>; shown: string; startedAt: number }
  | { kind: 'failed'; sentence: string }

export interface ConnectionsState {
  now: number
  /** How long a load of the list may take before the card says it did not answer. */
  deadlineMs: number
  /** The last load of the list started, so each new one gets a number no earlier load had. */
  attempts: number
  list: ListState
  chosen: Chosen
  tab: DetailTab
  history: Readonly<Record<string, HistoryState>>
  google: GoogleState | null
  draft: DelegationDraft
  edit: GoogleEdit
}

export type ConnectionsEvent =
  /** A new load of the list, numbered by the caller above every earlier one; a number not above them is ignored. */
  | { type: 'list_requested'; at: number; attempt: number }
  | { type: 'list_answered'; attempt: number; data: LoadedList }
  | { type: 'list_refused'; attempt: number; cause: string }
  | { type: 'tick'; at: number }
  | { type: 'choose'; chosen: Chosen }
  | { type: 'tab'; tab: DetailTab }
  | { type: 'history_requested'; id: string; at: number }
  | { type: 'history_answered'; id: string; entries: HistoryEntry[] }
  | { type: 'history_refused'; id: string; sentence: string }
  | { type: 'google_requested'; at: number }
  | { type: 'google_answered'; subjects: DelegationEntry[]; reachedLimit: boolean }
  | { type: 'google_refused'; sentence: string }
  /** Which kind the add box adds (Mailbox or Shared drive), or one of its boxes typed in. */
  | { type: 'draft_kind'; kind: DelegationDraft['kind'] }
  | { type: 'draft'; field: 'mailbox' | 'driveAddress' | 'driveName'; text: string }
  | { type: 'add_requested'; at: number }
  | { type: 'add_answered'; entry: DelegationEntry }
  | { type: 'add_refused'; sentence: string }
  | { type: 'remove_requested'; entry: Pick<DelegationEntry, 'kind' | 'subject'>; shown: string; at: number }
  | { type: 'remove_answered'; entry: Pick<DelegationEntry, 'kind' | 'subject'> }
  | { type: 'remove_refused'; sentence: string }

export function initialConnectionsState(now: number, deadlineMs: number, chosen: Chosen = { kind: 'none' }): ConnectionsState {
  return {
    now,
    deadlineMs,
    attempts: 1,
    list: { kind: 'loading', attempt: 1, startedAt: now },
    chosen,
    tab: 'connection',
    history: {},
    google: null,
    draft: EMPTY_DRAFT,
    edit: { kind: 'idle' },
  }
}

/** The attempt the list's current load carries, the one an answer must name to count. */
export function currentListAttempt(s: ConnectionsState): number | null {
  if (s.list.kind === 'loading') return s.list.attempt
  if (s.list.kind === 'loaded' && s.list.refresh.kind === 'loading') return s.list.refresh.attempt
  return null
}

/** A chosen connection that is still in the list, else the first one (nothing chosen when the list is empty). */
function keepChosen(chosen: Chosen, data: LoadedList): Chosen {
  if (chosen.kind === 'google') return chosen
  if (chosen.kind === 'connection' && data.connections.some((c) => c.id === chosen.id)) return chosen
  const first = firstConnection(listGroups(data.connections))
  return first ? { kind: 'connection', id: first.id } : { kind: 'google' }
}

const sameEntry = (a: Pick<DelegationEntry, 'kind' | 'subject'>, b: Pick<DelegationEntry, 'kind' | 'subject'>) => a.kind === b.kind && a.subject === b.subject

export function connectionsReducer(s: ConnectionsState, e: ConnectionsEvent): ConnectionsState {
  switch (e.type) {
    case 'list_requested': {
      const attempt = e.attempt
      if (attempt <= s.attempts) return s
      if (s.list.kind === 'loaded') return { ...s, now: e.at, attempts: attempt, list: { ...s.list, refresh: { kind: 'loading', attempt, startedAt: e.at } } }
      return { ...s, now: e.at, attempts: attempt, list: { kind: 'loading', attempt, startedAt: e.at } }
    }
    case 'list_answered': {
      if (currentListAttempt(s) !== e.attempt) return s
      return { ...s, list: { kind: 'loaded', attempt: e.attempt, data: e.data, refresh: { kind: 'idle' } }, chosen: keepChosen(s.chosen, e.data) }
    }
    case 'list_refused': {
      if (currentListAttempt(s) !== e.attempt) return s
      if (s.list.kind === 'loaded') return { ...s, list: { ...s.list, refresh: { kind: 'failed', cause: e.cause } } }
      return { ...s, list: { kind: 'failed', attempt: e.attempt, cause: e.cause } }
    }
    case 'tick': {
      let next: ConnectionsState = { ...s, now: e.at }
      const l = s.list
      if (l.kind === 'loading' && e.at - l.startedAt >= s.deadlineMs) next = { ...next, list: { kind: 'failed', attempt: l.attempt, cause: LIST_NO_ANSWER } }
      if (l.kind === 'loaded' && l.refresh.kind === 'loading' && e.at - l.refresh.startedAt >= s.deadlineMs) {
        next = { ...next, list: { ...l, refresh: { kind: 'failed', cause: LIST_NO_ANSWER } } }
      }
      return next
    }
    case 'choose':
      return { ...s, chosen: e.chosen, tab: 'connection', edit: s.edit.kind === 'failed' ? { kind: 'idle' } : s.edit }
    case 'tab':
      return { ...s, tab: e.tab }
    case 'history_requested':
      return { ...s, history: { ...s.history, [e.id]: { kind: 'loading', startedAt: e.at } } }
    case 'history_answered':
      return { ...s, history: { ...s.history, [e.id]: { kind: 'loaded', entries: e.entries } } }
    case 'history_refused':
      return { ...s, history: { ...s.history, [e.id]: { kind: 'failed', sentence: e.sentence } } }
    case 'google_requested':
      return { ...s, google: { kind: 'loading', startedAt: e.at } }
    case 'google_answered':
      return { ...s, google: { kind: 'loaded', subjects: e.subjects, reachedLimit: e.reachedLimit } }
    case 'google_refused':
      return { ...s, google: { kind: 'failed', sentence: e.sentence } }
    case 'draft_kind':
      return { ...s, draft: { ...s.draft, kind: e.kind }, edit: s.edit.kind === 'failed' ? { kind: 'idle' } : s.edit }
    case 'draft':
      return { ...s, draft: { ...s.draft, [e.field]: e.text }, edit: s.edit.kind === 'failed' ? { kind: 'idle' } : s.edit }
    case 'add_requested': {
      if (!draftReady(s.draft) || s.edit.kind === 'adding' || s.edit.kind === 'removing' || s.google?.kind !== 'loaded') return s
      // A drive address with no drive in it is refused here, before anything is sent (round 30).
      const request = addRequestOf(s.draft)
      if (!request.ok) return { ...s, edit: { kind: 'failed', sentence: request.sentence } }
      return { ...s, edit: { kind: 'adding', shown: request.shown, startedAt: e.at } }
    }
    case 'add_answered': {
      if (s.edit.kind !== 'adding' || s.google?.kind !== 'loaded') return s
      const subjects = s.google.subjects.some((x) => sameEntry(x, e.entry)) ? s.google.subjects : [...s.google.subjects, e.entry]
      // The boxes of the kind just added are emptied; the kind stays chosen.
      const draft: DelegationDraft = s.draft.kind === 'mailbox' ? { ...s.draft, mailbox: '' } : { ...s.draft, driveAddress: '', driveName: '' }
      return { ...s, draft, edit: { kind: 'idle' }, google: { ...s.google, subjects } }
    }
    case 'add_refused':
      return s.edit.kind === 'adding' ? { ...s, edit: { kind: 'failed', sentence: e.sentence } } : s
    case 'remove_requested':
      if (s.edit.kind === 'adding' || s.edit.kind === 'removing' || s.google?.kind !== 'loaded') return s
      return { ...s, edit: { kind: 'removing', entry: e.entry, shown: e.shown, startedAt: e.at } }
    case 'remove_answered': {
      if (s.edit.kind !== 'removing' || s.google?.kind !== 'loaded') return s
      return { ...s, edit: { kind: 'idle' }, google: { ...s.google, subjects: s.google.subjects.filter((x) => !sameEntry(x, e.entry)) } }
    }
    case 'remove_refused':
      return s.edit.kind === 'removing' ? { ...s, edit: { kind: 'failed', sentence: e.sentence } } : s
  }
}

/** The chosen connection, when one is chosen and the list holds it. */
export function chosenConnection(s: ConnectionsState): ConnectionView | null {
  if (s.list.kind !== 'loaded' || s.chosen.kind !== 'connection') return null
  const id = s.chosen.id
  return s.list.data.connections.find((c) => c.id === id) ?? null
}
