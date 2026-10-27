/**
 * The Connections page's state (#2338, build PRs 9 and 10): one pure reducer the
 * page only sends events to, tested on its own (connections-state.test.ts and
 * connections-form-state.test.ts), because the pieces change together: the
 * list's load, its deadline and Try again, the stale strip's Try again over a
 * list still shown, the chosen connection and tab, each connection's history,
 * the Google list with its adds and removes, the Add connection form with its
 * save, and the Reconnect, Replace and Remove dialogs (CLAUDE.md, interlocking
 * screen state).
 *
 * Every wait is told apart (Dan, 2026-06-28): started and still alive carry
 * the moment they began, so the page shows the seconds counting from `now`,
 * and the list's load turns into the could not load card at its deadline. An
 * answer to a load that is no longer the current one is ignored, so a late
 * answer cannot replace the card or a newer list. The clock is the `tick`
 * event's, never the machine's, so tests move time by hand.
 */
import { addRequestOf, draftReady, EMPTY_DRAFT, firstConnection, LIST_NO_ANSWER, listGroups, type ConnectionView, type DelegationDraft, type DelegationEntry, type HistoryEntry, type UsingWorkflow } from './connection-model'
import { draftDirty, EMPTY_ADD_DRAFT, pickedList, withoutDrive, workflowsCount, type AddDraft, type GoogleWay } from './add-form-model'
import { alertsReducer, alertsUnsaved, initialAlertsState, type AlertsEvent, type AlertsState } from './alert-settings-state'
import { SLACK_ALERT_LOGIN_LINK_ID } from '@bidspoke/service-catalogue/schema'
import type { ConnectionReplaceAnswer } from '@/lib/api'

/** What the could not load card says when Bidspoke's server gave no answer (D23); one copy, in connection-model. */
export { LIST_NO_ANSWER }

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

/** What the right panel shows: a connection, the Google list, or the Add connection form, with nothing chosen in the list (D11). */
export type Chosen = { kind: 'none' } | { kind: 'connection'; id: string } | { kind: 'google' } | { kind: 'add' }
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

/**
 * A save, a Reconnect or a Remove: being edited, running (since when, and what
 * its line says if it stalls), or failed with its sentence. `unconfirmed` is a
 * stall, whose outcome is not known, so a late answer to it is still taken.
 */
export type SaveState =
  | { kind: 'editing' }
  /** `label`: the working line's own words, when not the service's login check (a Google sign in, #2338). */
  | { kind: 'saving'; attempt: number; startedAt: number; stalled: string; label?: string }
  | { kind: 'failed'; sentence: string; unconfirmed: boolean }

/** The Add connection form: what it holds, its save, and what was chosen before it opened, for Cancel. */
export interface AddState {
  draft: AddDraft
  save: SaveState
  before: Chosen
  /** The save this form started last: only that one's answer may take the panel or fail the form. */
  started: number | null
}

export type DialogState =
  | null
  /** `started`: the change this dialog started last, the only one whose answer may close or fail it. */
  | { kind: 'reconnect'; id: string; values: Readonly<Record<string, string>>; save: SaveState; started: number | null }
  | { kind: 'remove'; id: string; values: Readonly<Record<string, string>>; save: SaveState; started: number | null }
  /**
   * A change that stands, with something to say after it, until closed: a removal the workflows
   * server could not be told of at once, or a Replace whose stored copy could not be refreshed.
   */
  | { kind: 'notice'; name: string; notice: string }
  /**
   * Replace (R20, build PR 12): the connection to use instead, `listed` the workflows it opened with
   * (never a deleted one), `moved` those a Replace has moved off it since, `ticked` those the next
   * press sends, and its change.
   */
  | { kind: 'replace'; id: string; with: string | null; listed: UsingWorkflow[]; moved: string[]; ticked: string[]; save: SaveState; started: number | null }

/** How long a save or a Reconnect may check its login, and a Remove or a Replace take, before its line says it stalled: the client's own ceilings (api.ts). */
export interface ChangeDeadlines {
  saveDeadlineMs: number
  removeDeadlineMs: number
  replaceDeadlineMs: number
}

export const CHANGE_DEADLINES: ChangeDeadlines = { saveDeadlineMs: 120_000, removeDeadlineMs: 50_000, replaceDeadlineMs: 120_000 }

/** What one ticked workflow came to, as the Replace route answers it. */
export type ReplaceResult = Pick<ConnectionReplaceAnswer['workflows'][number], 'id' | 'name' | 'outcome'>

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
  deadlines: ChangeDeadlines
  /** The Add connection form while it is open. */
  add: AddState | null
  dialog: DialogState
  /** The last save, Reconnect, Remove and Replace started, each numbered by the caller; only the latest one's answer counts. */
  lastChange: { save: number; reconnect: number; remove: number; replace: number }
  /** The Slack alerts login's alert settings (build PR 14): their own reducer, alert-settings-state.ts. */
  alerts: AlertsState
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
  // ── The Add connection form (build PR 10) ──
  | { type: 'add_opened' }
  | { type: 'add_service'; service: string | null }
  | { type: 'add_name'; text: string }
  /** A field of the chosen service; `typedNew` when an org was typed as a new one rather than chosen. */
  | { type: 'add_field'; field: string; text: string; typedNew?: boolean }
  /** One value of a list field of the chosen service ticked or unticked: a Google connection's shared drive, by id (#2572). */
  | { type: 'add_pick'; field: string; value: string; picked: boolean }
  | { type: 'add_google'; way: GoogleWay }
  | { type: 'add_closed' }
  /** A save, numbered by the caller above every earlier one, with the sentence its line says if it stalls. */
  | { type: 'save_requested'; attempt: number; at: number; stalled: string; label?: string }
  | { type: 'save_answered'; attempt: number; connection: ConnectionView }
  | { type: 'save_refused'; attempt: number; sentence: string }
  // ── The dialogs ──
  | { type: 'dialog_opened'; dialog: 'reconnect' | 'remove' | 'replace'; id: string }
  | { type: 'dialog_field'; field: string; text: string }
  | { type: 'dialog_closed' }
  | { type: 'replace_with'; id: string }
  | { type: 'replace_tick'; workflow: string }
  | { type: 'reconnect_requested'; attempt: number; at: number; stalled: string; label?: string }
  | { type: 'reconnect_answered'; attempt: number; id: string; actsAs: string | null; at: number }
  | { type: 'reconnect_refused'; attempt: number; sentence: string }
  | { type: 'connection_remove_requested'; attempt: number; at: number; stalled: string }
  /** `notice` when the removal stands and the workflows server could not be told at once. */
  | { type: 'connection_remove_answered'; attempt: number; id: string; notice: string | null }
  /** `workflows` when it was refused because workflows use it, naming them. */
  | { type: 'connection_remove_refused'; attempt: number; sentence: string; workflows?: UsingWorkflow[] }
  // ── Replace (build PR 12; R20) ──
  /** `label`: its working line's words, fixed at the press (decision 1: Moving <n> workflows to <replacement>). */
  | { type: 'connection_replace_requested'; attempt: number; at: number; stalled: string; label: string }
  /**
   * What each ticked workflow came to, moved off `id` and onto `withId` where it was replaced.
   * `sentence` when some workflow still names `id` (the dialog stays, saying it), null when every
   * one moved; `warning` the route's stored copy warning, said after either.
   */
  | { type: 'connection_replace_answered'; attempt: number; id: string; withId: string; withName: string; workflows: ReplaceResult[]; sentence: string | null; warning: string | null }
  | { type: 'connection_replace_refused'; attempt: number; sentence: string }
  // ── The Slack alerts login's alert settings (build PR 14), handed to alertsReducer ──
  | AlertsEvent

function isAlertsEvent(e: ConnectionsEvent): e is AlertsEvent {
  return e.type.startsWith('alerts_')
}

export function initialConnectionsState(now: number, deadlineMs: number, chosen: Chosen = { kind: 'none' }, deadlines: ChangeDeadlines = CHANGE_DEADLINES): ConnectionsState {
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
    deadlines,
    add: null,
    dialog: null,
    lastChange: { save: 0, reconnect: 0, remove: 0, replace: 0 },
    alerts: initialAlertsState(now),
  }
}

/** The attempt the list's current load carries, the one an answer must name to count. */
export function currentListAttempt(s: ConnectionsState): number | null {
  if (s.list.kind === 'loading') return s.list.attempt
  if (s.list.kind === 'loaded' && s.list.refresh.kind === 'loading') return s.list.refresh.attempt
  return null
}

/**
 * A chosen connection that is still in the list, else the first one (nothing
 * chosen when the list is empty). SLACK_ALERT_LOGIN_LINK_ID names the Slack
 * alerts login without its id (an alert's link, the /integrations redirect).
 */
function keepChosen(chosen: Chosen, data: LoadedList): Chosen {
  if (chosen.kind === 'google' || chosen.kind === 'add') return chosen
  if (chosen.kind === 'connection' && data.connections.some((c) => c.id === chosen.id)) return chosen
  const alertLogin = chosen.kind === 'connection' && chosen.id === SLACK_ALERT_LOGIN_LINK_ID ? data.connections.find((c) => c.alertLogin) : undefined
  if (alertLogin) return { kind: 'connection', id: alertLogin.id }
  const first = firstConnection(listGroups(data.connections))
  return first ? { kind: 'connection', id: first.id } : { kind: 'google' }
}

const sameEntry = (a: Pick<DelegationEntry, 'kind' | 'subject'>, b: Pick<DelegationEntry, 'kind' | 'subject'>) => a.kind === b.kind && a.subject === b.subject

export function connectionsReducer(s: ConnectionsState, e: ConnectionsEvent): ConnectionsState {
  if (isAlertsEvent(e)) {
    // A change that starts sets the clock, so its seconds count from nought.
    const now = 'at' in e ? e.at : s.now
    return { ...s, now, alerts: alertsReducer(s.alerts, e) }
  }
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
      // A save, a Reconnect or a Remove that has not answered by its deadline stalls: its outcome is not known (R13).
      if (s.add && stalls(s.add.save, e.at, s.deadlines.saveDeadlineMs)) next = { ...next, add: { ...s.add, save: stalledOf(s.add.save) } }
      const d = s.dialog
      if (d && (d.kind === 'reconnect' || d.kind === 'remove' || d.kind === 'replace')) {
        const deadline = d.kind === 'remove' ? s.deadlines.removeDeadlineMs : d.kind === 'replace' ? s.deadlines.replaceDeadlineMs : s.deadlines.saveDeadlineMs
        if (stalls(d.save, e.at, deadline)) next = { ...next, dialog: { ...d, save: stalledOf(d.save) } }
      }
      return next
    }
    case 'choose':
      // Leaving the form or the channel editor discards it; the page asks first while it holds something (unsavedWork).
      return {
        ...s, chosen: e.chosen, tab: 'connection', edit: s.edit.kind === 'failed' ? { kind: 'idle' } : s.edit, add: e.chosen.kind === 'add' ? s.add : null,
        alerts: alertsReducer(s.alerts, { type: 'alerts_channel_closed' }),
      }
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
      // A drive taken off the list leaves the add form's ticked drives too, where it is no longer drawn, so it is never sent unseen (#2572).
      const add = s.add && e.entry.kind === 'drive' ? { ...s.add, draft: withoutDrive(s.add.draft, e.entry.subject) } : s.add
      return { ...s, add, edit: { kind: 'idle' }, google: { ...s.google, subjects: s.google.subjects.filter((x) => !sameEntry(x, e.entry)) } }
    }
    case 'remove_refused':
      return s.edit.kind === 'removing' ? { ...s, edit: { kind: 'failed', sentence: e.sentence } } : s

    // ── The Add connection form (R11 to R16, R18) ──
    case 'add_opened': {
      if (s.list.kind !== 'loaded' || s.dialog) return s
      if (s.add) return { ...s, chosen: { kind: 'add' } }
      return { ...s, chosen: { kind: 'add' }, add: { draft: EMPTY_ADD_DRAFT, save: { kind: 'editing' }, before: s.chosen, started: null } }
    }
    case 'add_service':
      return editDraft(s, (d) => ({ ...d, service: e.service }))
    case 'add_name':
      return editDraft(s, (d) => ({ ...d, name: e.text }))
    case 'add_field':
      return editDraft(s, (d) => {
        if (!d.service) return d
        const values = { ...d.values, [d.service]: { ...(d.values[d.service] ?? {}), [e.field]: e.text } }
        const typedNew = e.typedNew === undefined ? d.typedNew : { ...d.typedNew, [d.service]: { ...(d.typedNew[d.service] ?? {}), [e.field]: e.typedNew } }
        return { ...d, values, typedNew }
      })
    case 'add_pick':
      return editDraft(s, (d) => {
        if (!d.service) return d
        const fields = d.lists[d.service] ?? {}
        return { ...d, lists: { ...d.lists, [d.service]: { ...fields, [e.field]: pickedList(fields[e.field] ?? [], e.value, e.picked) } } }
      })
    case 'add_google':
      return editDraft(s, (d) => ({ ...d, google: e.way }))
    case 'add_closed': {
      // Cancel closes the form even while its save checks (D13: only Save is held); the save's answer still lists what it made.
      if (!s.add || s.list.kind !== 'loaded') return s
      return { ...s, add: null, chosen: keepChosen(s.add.before, s.list.data) }
    }
    case 'save_requested': {
      if (!s.add || !s.add.draft.service || s.add.save.kind === 'saving' || e.attempt <= s.lastChange.save || s.list.kind !== 'loaded') return s
      return { ...s, now: e.at, lastChange: { ...s.lastChange, save: e.attempt }, add: { ...s.add, started: e.attempt, save: { kind: 'saving', attempt: e.attempt, startedAt: e.at, stalled: e.stalled, ...(e.label ? { label: e.label } : {}) } } }
    }
    case 'save_answered': {
      // The connection exists once any save answered, however late or superseded (R18), so it is listed;
      // it takes the panel only from the form that started it, never from one opened since a Cancel.
      if (s.list.kind !== 'loaded') return s
      const connections = [...s.list.data.connections.filter((c) => c.id !== e.connection.id), e.connection]
      const list = { ...s.list, data: { ...s.list.data, connections } }
      if (!s.add || s.add.started !== e.attempt) return { ...s, list }
      return { ...s, list, add: null, chosen: { kind: 'connection', id: e.connection.id }, tab: 'connection' }
    }
    case 'save_refused': {
      // Only the latest save's refusal counts, and only while a form still waits for it.
      if (e.attempt !== s.lastChange.save || !s.add || !awaiting(s.add.save)) return s
      return { ...s, add: { ...s.add, save: { kind: 'failed', sentence: e.sentence, unconfirmed: false } } }
    }

    // ── The dialogs (R19 to R21) ──
    case 'dialog_opened': {
      if (s.list.kind !== 'loaded' || s.dialog) return s
      const c = s.list.data.connections.find((x) => x.id === e.id)
      // The Slack alert login is reconnected here like every other (build PR 14); its routes refuse Remove and Replace.
      if (!c || (c.alertLogin && e.dialog !== 'reconnect')) return s
      if (e.dialog === 'remove' && c.workflows.length > 0) return s
      if (e.dialog === 'replace') {
        const others = s.list.data.connections
          .filter((x) => x.service === c.service && x.id !== c.id && !x.alertLogin)
          .sort((a, b) => Number(a.status !== 'ok') - Number(b.status !== 'ok') || a.name.localeCompare(b.name))
        // A soft deleted workflow cannot get a new version (no route writes one), so it is left out, with nothing said (decision 3).
        const listed = replaceable(c)
        return { ...s, dialog: { kind: 'replace', id: c.id, with: others[0]?.id ?? null, listed, moved: [], ticked: listed.map((w) => w.id), save: { kind: 'editing' }, started: null } }
      }
      return { ...s, dialog: { kind: e.dialog, id: c.id, values: {}, save: { kind: 'editing' }, started: null } }
    }
    case 'dialog_field': {
      const d = s.dialog
      if (!d || d.kind !== 'reconnect') return s
      return { ...s, dialog: { ...d, values: { ...d.values, [e.field]: e.text }, save: d.save.kind === 'failed' ? { kind: 'editing' } : d.save } }
    }
    case 'dialog_closed': {
      // Cancel closes a dialog even while its change runs; the change's answer still lands on the list.
      if (!s.dialog) return s
      return { ...s, dialog: null }
    }
    // A change of what Replace would do clears a failed line, since what failed is being changed. While
    // one runs, a change is for the next press: the running one's working line keeps the words it began
    // with. A workflow it moved cannot be ticked again.
    case 'replace_with': {
      const d = s.dialog
      if (d?.kind !== 'replace') return s
      return { ...s, dialog: { ...d, with: e.id, save: clearedOf(d.save) } }
    }
    case 'replace_tick': {
      const d = s.dialog
      if (d?.kind !== 'replace' || d.moved.includes(e.workflow) || !d.listed.some((w) => w.id === e.workflow)) return s
      return { ...s, dialog: { ...d, ticked: d.ticked.includes(e.workflow) ? d.ticked.filter((w) => w !== e.workflow) : [...d.ticked, e.workflow], save: clearedOf(d.save) } }
    }
    case 'connection_replace_requested': {
      const d = s.dialog
      if (d?.kind !== 'replace' || d.save.kind === 'saving' || !d.with || d.ticked.length === 0 || e.attempt <= s.lastChange.replace) return s
      return { ...s, now: e.at, lastChange: { ...s.lastChange, replace: e.attempt }, dialog: { ...d, started: e.attempt, save: { kind: 'saving', attempt: e.attempt, startedAt: e.at, stalled: e.stalled, label: e.label } } }
    }
    case 'connection_replace_answered': {
      // The workflows moved once any Replace answered, however late or superseded, so the list says so.
      if (s.list.kind !== 'loaded') return s
      const off = new Set(e.workflows.filter((w) => movedOff(w.outcome)).map((w) => w.id))
      const gone = new Set(e.workflows.filter((w) => w.outcome === 'deleted').map((w) => w.id))
      const moved: UsingWorkflow[] = e.workflows.filter((w) => w.outcome === 'replaced').map((w) => ({ id: w.id, name: w.name ?? '', deleted: false }))
      const connections = s.list.data.connections.map((c) => {
        // One deleted while it ran still names it, so it stays in Used by, now marked deleted.
        if (c.id === e.id) return { ...c, workflows: usingOrder(c.workflows.filter((w) => !off.has(w.id)).map((w) => (gone.has(w.id) ? { ...w, deleted: true } : w))) }
        if (c.id === e.withId) return { ...c, workflows: usingOrder([...c.workflows.filter((w) => !moved.some((m) => m.id === w.id)), ...moved]) }
        return c
      })
      const list = { ...s.list, data: { ...s.list.data, connections } }
      const d = s.dialog
      // Only the press that started the open dialog may close it or say how it ended.
      if (d?.kind !== 'replace' || d.id !== e.id || d.started !== e.attempt) return { ...s, list }
      if (e.sentence === null) {
        // Every ticked workflow moved: it closes, and a notice over the page says so (decision 4).
        const source = connections.find((c) => c.id === e.id)
        const name = source?.name ?? 'The connection'
        const notice = replacedNotice(moved.length, e.withName, name, source?.workflows.length ?? 0, e.warning)
        return { ...s, list, dialog: notice ? { kind: 'notice', name, notice } : null }
      }
      // Some were left: it stays open with every workflow it opened with, the moved ones marked and
      // unticked, the ones left still ticked, and the route's red line naming each left and why (decision 2).
      const nowMoved = [...d.moved, ...d.listed.filter((w) => off.has(w.id) && !d.moved.includes(w.id)).map((w) => w.id)]
      const sentence = e.warning ? `${e.sentence} ${e.warning}` : e.sentence
      return { ...s, list, dialog: { ...d, moved: nowMoved, ticked: d.ticked.filter((w) => !off.has(w) && !gone.has(w)), save: { kind: 'failed', sentence, unconfirmed: false } } }
    }
    case 'connection_replace_refused': {
      const d = s.dialog
      if (e.attempt !== s.lastChange.replace || d?.kind !== 'replace' || !awaiting(d.save)) return s
      return { ...s, dialog: { ...d, save: { kind: 'failed', sentence: e.sentence, unconfirmed: false } } }
    }
    case 'reconnect_requested': {
      const d = s.dialog
      if (d?.kind !== 'reconnect' || d.save.kind === 'saving' || e.attempt <= s.lastChange.reconnect) return s
      return { ...s, now: e.at, lastChange: { ...s.lastChange, reconnect: e.attempt }, dialog: { ...d, started: e.attempt, save: { kind: 'saving', attempt: e.attempt, startedAt: e.at, stalled: e.stalled, ...(e.label ? { label: e.label } : {}) } } }
    }
    case 'reconnect_answered': {
      // The new login is saved once any check answers, however late: the connection reads working, checked now.
      if (s.list.kind !== 'loaded') return s
      const connections = s.list.data.connections.map((c) => (c.id === e.id
        ? { ...c, status: 'ok' as const, problemSince: null, problemCause: null, actsAs: e.actsAs ?? c.actsAs, lastCheckedAt: new Date(e.at).toISOString() }
        : c))
      // Its history has a new entry now, so it is read again when its tab next opens.
      const history = Object.fromEntries(Object.entries(s.history).filter(([id]) => id !== e.id))
      const dialog = s.dialog?.kind === 'reconnect' && s.dialog.id === e.id && s.dialog.started === e.attempt ? null : s.dialog
      return { ...s, list: { ...s.list, data: { ...s.list.data, connections } }, history, dialog }
    }
    case 'reconnect_refused': {
      const d = s.dialog
      if (e.attempt !== s.lastChange.reconnect || d?.kind !== 'reconnect' || !awaiting(d.save)) return s
      return { ...s, dialog: { ...d, save: { kind: 'failed', sentence: e.sentence, unconfirmed: false } } }
    }
    case 'connection_remove_requested': {
      const d = s.dialog
      if (d?.kind !== 'remove' || d.save.kind === 'saving' || e.attempt <= s.lastChange.remove) return s
      return { ...s, now: e.at, lastChange: { ...s.lastChange, remove: e.attempt }, dialog: { ...d, started: e.attempt, save: { kind: 'saving', attempt: e.attempt, startedAt: e.at, stalled: e.stalled } } }
    }
    case 'connection_remove_answered': {
      // The connection is gone once any removal answered, however late.
      if (s.list.kind !== 'loaded') return s
      const gone = s.list.data.connections.find((c) => c.id === e.id)
      const data = { ...s.list.data, connections: s.list.data.connections.filter((c) => c.id !== e.id) }
      const history = Object.fromEntries(Object.entries(s.history).filter(([id]) => id !== e.id))
      // A Remove of the connection that is gone closes, whichever press started it; only its own press shows the notice.
      const open = s.dialog?.kind === 'remove' && s.dialog.id === e.id
      const own = open && s.dialog?.kind === 'remove' && s.dialog.started === e.attempt
      const dialog: DialogState = open ? (own && e.notice ? { kind: 'notice', name: gone?.name ?? 'The connection', notice: e.notice } : null) : s.dialog
      return { ...s, list: { ...s.list, data }, history, dialog, chosen: keepChosen(s.chosen, data) }
    }
    case 'connection_remove_refused': {
      const d = s.dialog
      if (e.attempt !== s.lastChange.remove || d?.kind !== 'remove' || !awaiting(d.save) || s.list.kind !== 'loaded') return s
      const workflows = e.workflows
      const list = workflows
        ? { ...s.list, data: { ...s.list.data, connections: s.list.data.connections.map((c) => (c.id === d.id ? { ...c, workflows } : c)) } }
        : s.list
      return { ...s, list, dialog: { ...d, save: { kind: 'failed', sentence: e.sentence, unconfirmed: false } } }
    }
  }
}

/** Whether a change is still waiting for its answer: running, or stalled with its outcome not known. */
function awaiting(save: SaveState): boolean {
  return save.kind === 'saving' || (save.kind === 'failed' && save.unconfirmed)
}

/** A failed line cleared, since what failed is being changed; any other state as it is. */
function clearedOf(save: SaveState): SaveState {
  return save.kind === 'failed' ? { kind: 'editing' } : save
}

/** Whether a workflow's Replace outcome took it off the connection: given a new version, or found no longer naming it. */
function movedOff(outcome: ReplaceResult['outcome']): boolean {
  return outcome === 'replaced' || outcome === 'not_using'
}

/**
 * What the notice over the page says once a Replace moved every ticked workflow (decision 4, Dan
 * 2026-10-27): how many moved where, that nothing uses the connection now only when its Used by is 0,
 * and the route's stored copy warning as a sentence of its own. Null when there is nothing to say.
 */
export function replacedNotice(moved: number, withName: string, name: string, usedBy: number, warning: string | null): string | null {
  const parts = [
    ...(moved > 0 ? [`Moved ${workflowsCount(moved)} to ${withName}.`] : []),
    ...(usedBy === 0 ? [`Nothing uses ${name} now.`] : []),
    ...(warning ? [warning] : []),
  ]
  return parts.length > 0 ? parts.join(' ') : null
}

/** The workflows using a connection that Replace can give a new version: every one not soft deleted. */
export function replaceable(c: Pick<ConnectionView, 'workflows'> | undefined): UsingWorkflow[] {
  return (c?.workflows ?? []).filter((w) => !w.deleted)
}

/** Workflows in the order the route lists them (connection_references): live ones first, then by name. */
function usingOrder(workflows: UsingWorkflow[]): UsingWorkflow[] {
  return [...workflows].sort((a, b) => Number(a.deleted) - Number(b.deleted) || a.name.localeCompare(b.name))
}

function stalls(save: SaveState, at: number, deadlineMs: number): boolean {
  return save.kind === 'saving' && at - save.startedAt >= deadlineMs
}

function stalledOf(save: SaveState): SaveState {
  return save.kind === 'saving' ? { kind: 'failed', sentence: save.stalled, unconfirmed: true } : save
}

/**
 * An edit of the form, taken while its save checks too (D13 holds only Save),
 * since it changes nothing already sent; it clears a failed line, since what
 * failed is being changed.
 */
function editDraft(s: ConnectionsState, change: (d: AddDraft) => AddDraft): ConnectionsState {
  if (!s.add) return s
  return { ...s, add: { ...s.add, draft: change(s.add.draft), save: s.add.save.kind === 'failed' ? { kind: 'editing' } : s.add.save } }
}

/** What leaving now would lose, so the leave question can name it (L608). */
export type UnsavedWork = 'form' | 'form_checking' | 'login' | 'login_checking' | 'removing' | 'replacing' | 'alert_channel' | 'alert_channel_saving'

/**
 * What leaving now would lose (L608): the form with something typed or its
 * save running, a Reconnect with a login typed or its check running, or a
 * Remove running; null when nothing. The leave guard asks first while it is
 * not null, and the question names which.
 */
export function unsavedWork(s: ConnectionsState): UnsavedWork | null {
  const d = s.dialog
  if (d?.kind === 'remove' && d.save.kind === 'saving') return 'removing'
  if (d?.kind === 'replace' && d.save.kind === 'saving') return 'replacing'
  if (d?.kind === 'reconnect') {
    if (d.save.kind === 'saving') return 'login_checking'
    if (Object.values(d.values).some((v) => v.trim() !== '')) return 'login'
  }
  if (s.add?.save.kind === 'saving') return 'form_checking'
  if (s.add && draftDirty(s.add.draft)) return 'form'
  const alerts = alertsUnsaved(s.alerts)
  if (alerts === 'channel_saving') return 'alert_channel_saving'
  if (alerts === 'channel') return 'alert_channel'
  return null
}

/** The chosen connection, when one is chosen and the list holds it. */
export function chosenConnection(s: ConnectionsState): ConnectionView | null {
  if (s.list.kind !== 'loaded' || s.chosen.kind !== 'connection') return null
  const id = s.chosen.id
  return s.list.data.connections.find((c) => c.id === id) ?? null
}
