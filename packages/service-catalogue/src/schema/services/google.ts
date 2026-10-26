import type { ActionArgument, ActionSchema, ServiceSchema } from '../types'

/**
 * Google (#2337, phase 7 of #1689): a company mailbox on the organization's
 * list, acted as by the ops service account through domain wide delegation
 * (minters/google.ts; Dan's decision 11 granted the four scopes once). One
 * service with one tile, as the settled Connections design draws it (D16): the
 * Sheets, Gmail, Drive and Calendar actions all act as the connection's mailbox,
 * and each declares the delegation scope it needs, which is all the minter asks
 * Google for.
 *
 * WHAT THE PIPEDREAM WORKFLOWS USE, counted in the export of 2026-09-30 (the
 * duplicate project folder left out; steps inside an if/else branch counted):
 *   registry steps, 61
 *     google_sheets-add-single-row       9 (1 disabled)    sheets-add-row
 *     google_sheets-add-multiple-rows   10 (2 disabled)    sheets-add-rows
 *     google_sheets-update-cell          7                 sheets-update-cell
 *     google_sheets-get-values-in-range  6                 sheets-get-values
 *     google_sheets-find-row             4                 sheets-find-row
 *     google_sheets-create-worksheet     3                 sheets-create-worksheet
 *     google_sheets-get-cell             2                 sheets-get-cell
 *     google_sheets-delete-rows          2                 sheets-delete-rows
 *     google_sheets-clear-rows           2                 sheets-clear-rows
 *     google_sheets-get-spreadsheet-by-id 1                sheets-get-spreadsheet
 *     gmail-send-email                   9 (1 disabled)    gmail-send-email
 *     google_calendar-create-event       3 (2 disabled)    calendar-create-event
 *     google_calendar-delete-event       3                 calendar-delete-event
 *   code steps reaching Google, 55 (1 disabled); a step is counted once for
 *   each kind of call it makes, so the rows below add up to more than 55
 *     Drive files.list                  20                 drive-list-files
 *     Drive files.get (alt=media)       20                 drive-download-file
 *     Sheets values append, get, update 17                 the Sheets actions above
 *     Gmail messages.send                5                 gmail-send-email
 *     Calendar events.insert             5                 calendar-create-event
 *     Calendar events.list               2                 calendar-list-events
 * Not built: the Admin Directory calls (group members, a user's suspension; 6
 * steps) and Gmail's sendAs signature settings (1 step), whose scopes are not
 * in the delegation grant; a Drive upload (1 step); Sheets structural
 * batchUpdate in code (3 steps) beyond adding a worksheet and deleting rows.
 *
 * Every write is not idempotent except where it says why: an append, a sent
 * message and a created event are made again by a repeat.
 */

type Scope = NonNullable<ActionSchema['googleScopes']>[number]
const SHEETS: readonly Scope[] = ['https://www.googleapis.com/auth/spreadsheets']
const GMAIL: readonly Scope[] = ['https://www.googleapis.com/auth/gmail.modify']
const DRIVE: readonly Scope[] = ['https://www.googleapis.com/auth/drive']
const CALENDAR: readonly Scope[] = ['https://www.googleapis.com/auth/calendar']

const value = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: false })
const json = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: true })
/** The step's own text, never another step's value: a column, a cell, a range, a query with binds. */
const fixed = (key: string, required = true): ActionArgument => ({ key, type: 'text', required, allowsVariables: false, parseJson: false })

const spreadsheet = value('spreadsheet_id', true)
const worksheet = value('worksheet_id', true)

const read = (key: string, name: string, args: ActionArgument[], googleScopes: readonly Scope[]): ActionSchema => ({
  key, name, version: 1, arguments: args, sideEffect: false, idempotent: true, idempotentBecause: 'It reads and changes nothing.', googleScopes,
})

export const GOOGLE_SHEETS_ADD_ROW_V1: ActionSchema = {
  key: 'google.sheets-add-row', name: 'Sheets: add a row', version: 1,
  arguments: [spreadsheet, worksheet, json('values', true)],
  realSend: 'adds a real row to the sheet',
  sideEffect: true, idempotent: false,
  idempotentBecause: 'An append adds the row again on a repeat; Sheets takes no key to deduplicate it on.',
  googleScopes: SHEETS,
}

export const GOOGLE_SHEETS_ADD_ROWS_V1: ActionSchema = {
  key: 'google.sheets-add-rows', name: 'Sheets: add rows', version: 1,
  arguments: [spreadsheet, worksheet, json('rows', true)],
  realSend: 'adds real rows to the sheet',
  sideEffect: true, idempotent: false,
  idempotentBecause: 'An append adds every row again on a repeat; Sheets takes no key to deduplicate it on.',
  googleScopes: SHEETS,
}

export const GOOGLE_SHEETS_UPDATE_CELL_V1: ActionSchema = {
  key: 'google.sheets-update-cell', name: 'Sheets: update a cell', version: 1,
  arguments: [spreadsheet, worksheet, fixed('cell'), json('value', true)],
  realSend: 'changes a real cell in the sheet',
  sideEffect: true, idempotent: true,
  idempotentBecause: 'It writes the given value into one named cell, so a repeat leaves the cell as one write does.',
  googleScopes: SHEETS,
}

export const GOOGLE_SHEETS_GET_VALUES_V1 = read('google.sheets-get-values', 'Sheets: get values', [spreadsheet, worksheet, fixed('range', false)], SHEETS)
export const GOOGLE_SHEETS_FIND_ROW_V1 = read('google.sheets-find-row', 'Sheets: find rows', [spreadsheet, worksheet, fixed('column'), value('value', true), json('export_row')], SHEETS)
export const GOOGLE_SHEETS_GET_CELL_V1 = read('google.sheets-get-cell', 'Sheets: get a cell', [spreadsheet, worksheet, fixed('cell')], SHEETS)
export const GOOGLE_SHEETS_GET_SPREADSHEET_V1 = read('google.sheets-get-spreadsheet', 'Sheets: get a spreadsheet', [spreadsheet], SHEETS)

export const GOOGLE_SHEETS_CREATE_WORKSHEET_V1: ActionSchema = {
  key: 'google.sheets-create-worksheet', name: 'Sheets: create a worksheet', version: 1,
  arguments: [spreadsheet, value('title', true)],
  realSend: 'creates a real worksheet',
  sideEffect: true, idempotent: false,
  idempotentBecause: 'A repeat asks for a second worksheet of the same title, which Sheets refuses, so after an uncertain outcome a person decides.',
  googleScopes: SHEETS,
}

export const GOOGLE_SHEETS_DELETE_ROWS_V1: ActionSchema = {
  key: 'google.sheets-delete-rows', name: 'Sheets: delete rows', version: 1,
  arguments: [spreadsheet, worksheet, json('start_row', true), json('end_row')],
  realSend: 'deletes real rows from the sheet',
  sideEffect: true, idempotent: false,
  idempotentBecause: 'The rows below move up after a delete, so a repeat deletes different rows.',
  googleScopes: SHEETS,
}

export const GOOGLE_SHEETS_CLEAR_ROWS_V1: ActionSchema = {
  key: 'google.sheets-clear-rows', name: 'Sheets: clear rows', version: 1,
  arguments: [spreadsheet, worksheet, json('start_row', true), json('end_row')],
  realSend: 'clears real rows in the sheet',
  sideEffect: true, idempotent: true,
  idempotentBecause: 'Clearing empties the same rows in place and moves nothing, so a repeat leaves them as one clear does.',
  googleScopes: SHEETS,
}

export const GOOGLE_GMAIL_SEND_EMAIL_V1: ActionSchema = {
  key: 'google.gmail-send-email', name: 'Gmail: send an email', version: 1,
  arguments: [
    json('to'), json('cc'), json('bcc'), value('subject'), { ...value('body', true), multiline: true }, fixed('body_type', false), value('from_name'), value('from_email'), value('reply_to'),
    value('in_reply_to_message_id'), json('attachments'),
  ],
  realSend: 'sends a real email',
  sideEffect: true, idempotent: false,
  idempotentBecause: 'A repeat sends the message again; Gmail takes no key to deduplicate a send on.',
  googleScopes: GMAIL,
}

export const GOOGLE_DRIVE_LIST_FILES_V1 = read('google.drive-list-files', 'Drive: list files', [fixed('query', false), json('binds'), value('drive_id')], DRIVE)
export const GOOGLE_DRIVE_DOWNLOAD_FILE_V1 = read('google.drive-download-file', 'Drive: download a file', [value('file_id', true), fixed('export_mime_type', false), fixed('as', false)], DRIVE)

/**
 * Version 2 of the two Drive actions (#2805, Dan's decision of 2026-10-26):
 * the connection's own drive list holds in the action, not only at save and
 * mint. A list with no drive searches the mailbox's own files and each
 * declared drive, never every drive the mailbox can reach; a download reads
 * which drive the file is in and refuses one the connection does not declare.
 * The mailbox's own files are always allowed. Same arguments as version 1,
 * which stays for the steps pinned to it.
 */
export const GOOGLE_DRIVE_LIST_FILES_V2: ActionSchema = {
  ...GOOGLE_DRIVE_LIST_FILES_V1,
  version: 2,
  idempotentBecause: 'It reads and changes nothing, so a repeat answers the same files as one run, less any changed since.',
}
export const GOOGLE_DRIVE_DOWNLOAD_FILE_V2: ActionSchema = {
  ...GOOGLE_DRIVE_DOWNLOAD_FILE_V1,
  version: 2,
  idempotentBecause: 'It reads the file and changes nothing, so a repeat reads it again as one run does.',
}

export const GOOGLE_CALENDAR_CREATE_EVENT_V1: ActionSchema = {
  key: 'google.calendar-create-event', name: 'Calendar: create an event', version: 1,
  arguments: [
    value('calendar_id'), value('summary'), value('description'), value('location'), value('start', true), value('end', true), value('time_zone'),
    json('attendees'), fixed('send_updates', false), fixed('visibility', false), json('create_meet_room'),
  ],
  realSend: 'creates a real calendar event',
  sideEffect: true, idempotent: false,
  idempotentBecause: 'A repeat creates a second event, and invites its attendees again.',
  googleScopes: CALENDAR,
}

export const GOOGLE_CALENDAR_DELETE_EVENT_V1: ActionSchema = {
  key: 'google.calendar-delete-event', name: 'Calendar: delete an event', version: 1,
  arguments: [value('calendar_id'), value('event_id', true), fixed('send_updates', false)],
  realSend: 'deletes a real calendar event',
  sideEffect: true, idempotent: true,
  idempotentBecause: 'A repeat finds the event already deleted (HTTP 410), which it answers as deleted, and sends no second cancellation.',
  googleScopes: CALENDAR,
}

export const GOOGLE_CALENDAR_LIST_EVENTS_V1 = read(
  'google.calendar-list-events', 'Calendar: list events', [value('calendar_id'), value('time_min'), value('time_max'), value('query')], CALENDAR,
)

export const GOOGLE_SERVICE: ServiceSchema = {
  key: 'google',
  name: 'Google',
  actions: [
    GOOGLE_SHEETS_ADD_ROW_V1, GOOGLE_SHEETS_ADD_ROWS_V1, GOOGLE_SHEETS_UPDATE_CELL_V1, GOOGLE_SHEETS_GET_VALUES_V1, GOOGLE_SHEETS_FIND_ROW_V1, GOOGLE_SHEETS_GET_CELL_V1,
    GOOGLE_SHEETS_GET_SPREADSHEET_V1, GOOGLE_SHEETS_CREATE_WORKSHEET_V1, GOOGLE_SHEETS_DELETE_ROWS_V1, GOOGLE_SHEETS_CLEAR_ROWS_V1, GOOGLE_GMAIL_SEND_EMAIL_V1,
    GOOGLE_DRIVE_LIST_FILES_V1, GOOGLE_DRIVE_DOWNLOAD_FILE_V1, GOOGLE_DRIVE_LIST_FILES_V2, GOOGLE_DRIVE_DOWNLOAD_FILE_V2, GOOGLE_CALENDAR_CREATE_EVENT_V1, GOOGLE_CALENDAR_DELETE_EVENT_V1, GOOGLE_CALENDAR_LIST_EVENTS_V1,
  ],
  // The settled design's fields (D16): the connection's name, then the mailbox it acts as, from the
  // organization's list. The service account's key is the ops Worker's own secret, never a field: it can
  // act as anyone in the Workspace, so it is not handed to whoever adds a connection (minters/google.ts).
  connection: {
    tile: 'A mailbox or shared drive on the company list, or your own login',
    auth: 'service_account_delegation',
    fields: [{ key: 'subject', label: 'Acts as', input: 'google_subject', required: true, target: 'subject' }],
  },
}
