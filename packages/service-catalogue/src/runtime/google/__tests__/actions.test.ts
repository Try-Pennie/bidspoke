import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE, GOOGLE_DELEGATION_GRANTED_SCOPES } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, RuntimeAction } from '../../types'
import { DRIVE_LIST_MAX_PAGES, DRIVE_DOWNLOAD_MAX_BYTES, SHEETS_APPEND_MAX_ROWS } from '../limits'
import { CALENDAR_LIST_MAX_PAGES } from '../limits'
import { fakeGoogle, gAnswer, gError, MAILBOX, SHEET, worksheets } from './fake-google'

/**
 * The Google actions the Pipedream workflows use (#2337; counted in the export
 * of 2026-09-30, the duplicate project folder left out, steps inside if/else
 * branches counted; the counts are in schema/services/google.ts). Each has the
 * fixtures every service PR carries: an expired login, revoked consent, a 429
 * with Retry-After, a timeout after send for every side effecting action, and a
 * partial batch where a request carries several rows.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const ADD_ROW = action('google.sheets-add-row')
const ADD_ROWS = action('google.sheets-add-rows')
const UPDATE_CELL = action('google.sheets-update-cell')
const GET_VALUES = action('google.sheets-get-values')
const FIND_ROW = action('google.sheets-find-row')
const GET_CELL = action('google.sheets-get-cell')
const GET_SPREADSHEET = action('google.sheets-get-spreadsheet')
const CREATE_WORKSHEET = action('google.sheets-create-worksheet')
const DELETE_ROWS = action('google.sheets-delete-rows')
const CLEAR_ROWS = action('google.sheets-clear-rows')
const SEND = action('google.gmail-send-email')
const LIST_FILES = action('google.drive-list-files')
const DOWNLOAD = action('google.drive-download-file')
const CREATE_EVENT = action('google.calendar-create-event')
const DELETE_EVENT = action('google.calendar-delete-event')
const LIST_EVENTS = action('google.calendar-list-events')

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const S = 'https://sheets.googleapis.com/v4/spreadsheets'
const TITLES = `${S}/${SHEET}?fields=sheets.properties(sheetId%2Ctitle)`
const ws = { spreadsheet_id: SHEET, worksheet_id: 7 }
const lookup = () => worksheets([0, 'Sheet1'], [7, "Bids Oct '26"])
const RANGE = (a1: string) => encodeURIComponent(`'Bids Oct ''26'!${a1}`)

/**
 * One valid step per action: the answers to what it reads first (a worksheet's
 * title, a replied to message), then the answer to the request that does the
 * work, which every shared fixture below fails in turn.
 */
const CASES: Array<{ a: RuntimeAction; args: ActionArgs; pre: () => Response[]; ok: () => Response }> = [
  { a: ADD_ROW, args: { ...ws, values: ['Sam', 42, true, null] }, pre: () => [lookup()], ok: () => gAnswer({ updates: { updatedRange: "'Bids Oct ''26'!A5:D5", updatedRows: 1 } }) },
  { a: ADD_ROWS, args: { ...ws, rows: [['a'], ['b']] }, pre: () => [lookup()], ok: () => gAnswer({ updates: { updatedRows: 2 } }) },
  { a: UPDATE_CELL, args: { ...ws, cell: 'B2', value: 'x' }, pre: () => [lookup()], ok: () => gAnswer({ updatedCells: 1 }) },
  { a: GET_VALUES, args: { ...ws }, pre: () => [lookup()], ok: () => gAnswer({ values: [['a']] }) },
  { a: FIND_ROW, args: { ...ws, column: 'A', value: 'a' }, pre: () => [lookup()], ok: () => gAnswer({ values: [['a']] }) },
  { a: GET_CELL, args: { ...ws, cell: 'A1' }, pre: () => [lookup()], ok: () => gAnswer({ values: [['a']] }) },
  { a: GET_SPREADSHEET, args: { spreadsheet_id: SHEET }, pre: () => [], ok: () => gAnswer({ spreadsheetId: SHEET }) },
  { a: CREATE_WORKSHEET, args: { spreadsheet_id: SHEET, title: 'Week 43' }, pre: () => [], ok: () => gAnswer({ replies: [{ addSheet: { properties: { sheetId: 9 } } }] }) },
  { a: DELETE_ROWS, args: { ...ws, start_row: 2, end_row: 4 }, pre: () => [], ok: () => gAnswer({ replies: [{}] }) },
  { a: CLEAR_ROWS, args: { ...ws, start_row: 2 }, pre: () => [lookup()], ok: () => gAnswer({ clearedRange: "'Bids Oct ''26'!A2:Z2" }) },
  { a: SEND, args: { to: ['partner@lender.example'], subject: 'Report', body: 'Hello' }, pre: () => [], ok: () => gAnswer({ id: 'm1', threadId: 't1', labelIds: ['SENT'] }) },
  { a: LIST_FILES, args: { query: 'name contains ?', binds: ['report'] }, pre: () => [], ok: () => gAnswer({ files: [] }) },
  { a: DOWNLOAD, args: { file_id: '1FileId' }, pre: () => [], ok: () => gAnswer({ id: '1FileId', name: 'r.csv', mimeType: 'text/csv', size: '5' }) },
  { a: CREATE_EVENT, args: { summary: 'Call', start: '2026-10-23T15:00:00-04:00', end: '2026-10-23T15:30:00-04:00', time_zone: 'America/New_York' }, pre: () => [], ok: () => gAnswer({ id: 'e1', status: 'confirmed' }) },
  { a: DELETE_EVENT, args: { event_id: 'e1' }, pre: () => [], ok: () => new Response(null, { status: 204 }) },
  { a: LIST_EVENTS, args: { time_min: '2026-10-23T00:00:00Z' }, pre: () => [], ok: () => gAnswer({ items: [] }) },
]

describe('the Google actions decide their own traits', () => {
  it('are the sixteen the workflows need, each declaring its one delegation scope, all within the grant', () => {
    const google = catalogueActions(CATALOGUE).filter((a) => a.key.startsWith('google.'))
    expect(google.map((a) => `${a.key}@${a.version}`).sort()).toEqual(CASES.map(({ a }) => `${a.key}@1`).sort())
    for (const a of google) {
      expect(a.googleScopes, a.key).toHaveLength(1)
      expect(GOOGLE_DELEGATION_GRANTED_SCOPES as readonly string[], a.key).toContain(a.googleScopes![0])
    }
    const scopeOf = (prefix: string) => [...new Set(google.filter((a) => a.key.startsWith(`google.${prefix}`)).map((a) => a.googleScopes![0]))]
    expect(scopeOf('sheets')).toEqual(['https://www.googleapis.com/auth/spreadsheets'])
    expect(scopeOf('gmail')).toEqual(['https://www.googleapis.com/auth/gmail.modify'])
    expect(scopeOf('drive')).toEqual(['https://www.googleapis.com/auth/drive'])
    expect(scopeOf('calendar')).toEqual(['https://www.googleapis.com/auth/calendar'])
  })

  it('decide idempotency per action: an append, a send, a created event, a new worksheet and a row delete are never repeated', () => {
    const traits = Object.fromEntries(CASES.map(({ a }) => [a.key, [a.sideEffect, a.idempotent]]))
    expect(traits).toEqual({
      'google.sheets-add-row': [true, false],
      'google.sheets-add-rows': [true, false],
      'google.sheets-update-cell': [true, true],
      'google.sheets-get-values': [false, true],
      'google.sheets-find-row': [false, true],
      'google.sheets-get-cell': [false, true],
      'google.sheets-get-spreadsheet': [false, true],
      'google.sheets-create-worksheet': [true, false],
      'google.sheets-delete-rows': [true, false],
      'google.sheets-clear-rows': [true, true],
      'google.gmail-send-email': [true, false],
      'google.drive-list-files': [false, true],
      'google.drive-download-file': [false, true],
      'google.calendar-create-event': [true, false],
      'google.calendar-delete-event': [true, true],
      'google.calendar-list-events': [false, true],
    })
  })
})

describe('what every Google action shares', () => {
  it('sends through the connection bound fetch with no token of its own', async () => {
    for (const { a, args, pre, ok } of CASES) {
      const f = fakeGoogle()
      f.respond(...pre(), ok(), new Response('id,bid\n', { status: 200 }))
      await a.run(f.ctx, args)
      for (const s of f.sent) expect(s.headers.get('authorization'), a.key).toBeNull()
    }
  })

  it('an expired or revoked login, or a mailbox taken off the list: what the connection bound fetch throws passes through unchanged', async () => {
    for (const { a, args } of CASES) {
      const refused = new Error('connection_not_allowed: mailbox_not_allowed')
      const f = fakeGoogle()
      f.respond({ throws: refused })
      await expect(a.run(f.ctx, args), a.key).rejects.toBe(refused)
      expect(f.sent, a.key).toHaveLength(1)
    }
  })

  it('a 429 with Retry-After: the requeue passes through unchanged, and nothing waits in the request', async () => {
    for (const { a, args, pre } of CASES) {
      const requeue = { kind: 'requeue_at', notBefore: new Date('2026-10-22T15:00:20Z') }
      const f = fakeGoogle()
      f.respond(...pre(), { throws: requeue })
      await expect(a.run(f.ctx, args), a.key).rejects.toBe(requeue)
    }
  })

  it('a timeout after the work was sent passes through unchanged, and every side effecting action that is not idempotent is never retried', async () => {
    for (const { a, args, pre } of CASES) {
      const timeout = new DOMException('The operation timed out.', 'TimeoutError')
      const f = fakeGoogle()
      f.respond(...pre(), { throws: timeout })
      await expect(a.run(f.ctx, args), a.key).rejects.toBe(timeout)
      expect(f.sent, a.key).toHaveLength(pre().length + 1)
    }
  })

  it('revoked consent: a grant that no longer covers the scope, or a file the mailbox lost access to, is refused by Google\'s status, not applied', async () => {
    for (const { a, args, pre } of CASES) {
      for (const [answer, code] of [
        [() => gError(403, 'PERMISSION_DENIED', 'insufficientPermissions', 'Request had insufficient authentication scopes.'), 'google_permission_denied'],
        [() => gError(401, 'UNAUTHENTICATED', 'authError'), 'google_unauthenticated'],
      ] as Array<[() => Response, string]>) {
        const f = fakeGoogle()
        f.respond(...pre(), answer())
        const failed = await failure(a.run(f.ctx, args))
        expect([failed.code, failed.outcome], `${a.key} ${code}`).toEqual([code, 'not_applied'])
      }
    }
  })

  it('a 429 answered to the action is not applied and names the wait', async () => {
    for (const { a, args, pre } of CASES) {
      const f = fakeGoogle()
      f.respond(...pre(), gError(429, 'RESOURCE_EXHAUSTED', 'rateLimitExceeded', 'Quota exceeded', { 'retry-after': '30' }))
      const limited = await failure(a.run(f.ctx, args))
      expect([limited.code, limited.outcome], a.key).toEqual(['google_resource_exhausted', 'not_applied'])
      expect(limited.message).toContain('30')
      expect(limited.message).toContain('rateLimitExceeded')
    }
  })

  it('a server error may have applied a write, so its outcome is unknown; a read changed nothing', async () => {
    for (const { a, args, pre } of CASES) {
      const f = fakeGoogle()
      f.respond(...pre(), gError(503, 'UNAVAILABLE', 'backendError', 'The service is currently unavailable for Sam Lee.'))
      const failed = await failure(a.run(f.ctx, args))
      expect([failed.code, failed.outcome], a.key).toEqual(['google_unavailable', a.sideEffect ? 'unknown' : 'not_applied'])
      expect(failed.message).not.toContain('Sam Lee')
    }
  })

  it('a refusal with no JSON body is named by its status', async () => {
    const f = fakeGoogle()
    f.respond(new Response('<html>Bad Gateway</html>', { status: 502 }))
    expect((await failure(GET_SPREADSHEET.run(f.ctx, { spreadsheet_id: SHEET }))).code).toBe('google_http_502')
  })

  it('refuses a target that declares no mailbox before anything is sent', async () => {
    const f = fakeGoogle({})
    const failed = await failure(SEND.run(f.ctx, { to: ['a@x.example'], subject: 's', body: 'b' }))
    expect([failed.code, f.sent]).toEqual(['google_target_invalid', []])
  })
})

describe('the Sheets actions', () => {
  it('add a row: finds the worksheet\'s title, then appends with USER_ENTERED and INSERT_ROWS, and returns the update as Pipedream did', async () => {
    const f = fakeGoogle()
    f.respond(lookup(), gAnswer({ spreadsheetId: SHEET, updates: { updatedRange: "'Bids Oct ''26'!A5:D5", updatedRows: 1, updatedCells: 4 } }))
    const out = await ADD_ROW.run(f.ctx, { ...ws, values: ['Sam', 42, true, null] })
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([
      ['GET', TITLES],
      ['POST', `${S}/${SHEET}/values/${RANGE('A:A')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`],
    ])
    expect(f.sent[1].json).toEqual({ values: [['Sam', 42, true, '']] })
    expect(out).toEqual({ updatedRange: "'Bids Oct ''26'!A5:D5", updatedRows: 1, updatedCells: 4 })
  })

  it('add rows sends every row in one append, so they land whole or not at all', async () => {
    const f = fakeGoogle()
    f.respond(lookup(), gAnswer({ updates: { updatedRows: 2 } }))
    await ADD_ROWS.run(f.ctx, { ...ws, rows: [['a', 1], ['b', 2]] })
    expect(f.sent.filter((s) => s.method === 'POST').map((s) => s.json)).toEqual([{ values: [['a', 1], ['b', 2]] }])
  })

  it('a partial batch: an append Sheets reports as fewer rows than were sent fails by name, applied', async () => {
    const f = fakeGoogle()
    f.respond(lookup(), gAnswer({ updates: { updatedRows: 1 } }))
    const failed = await failure(ADD_ROWS.run(f.ctx, { ...ws, rows: [['a'], ['b']] }))
    expect([failed.code, failed.outcome]).toEqual(['google_sheets_partial_append', 'applied'])
  })

  it('refuses rows past the cap, a row that is not a list, and a cell that is an object, before anything is sent', async () => {
    const cases: Array<[RuntimeAction, ActionArgs, string]> = [
      [ADD_ROWS, { ...ws, rows: Array.from({ length: SHEETS_APPEND_MAX_ROWS + 1 }, () => ['x']) }, 'google_sheets_too_many_rows'],
      [ADD_ROWS, { ...ws, rows: ['not a row'] }, 'google_argument_invalid'],
      [ADD_ROWS, { ...ws, rows: [] }, 'google_argument_invalid'],
      [ADD_ROW, { ...ws, values: [{ nested: 1 }] }, 'google_argument_invalid'],
      [ADD_ROW, { ...ws, values: [['nested']] }, 'google_argument_invalid'],
    ]
    for (const [a, args, code] of cases) {
      const f = fakeGoogle()
      const failed = await failure(a.run(f.ctx, args))
      expect([failed.code, failed.outcome, f.sent.length], code).toEqual([code, 'not_applied', 0])
    }
  })

  it('a worksheet id the spreadsheet does not hold is refused by name before anything is written', async () => {
    const f = fakeGoogle()
    f.respond(worksheets([0, 'Sheet1']))
    const failed = await failure(ADD_ROW.run(f.ctx, { ...ws, values: ['x'] }))
    expect([failed.code, failed.outcome, f.sent.length]).toEqual(['google_sheets_worksheet_not_found', 'not_applied', 1])
  })

  it('update a cell writes one value with USER_ENTERED', async () => {
    const f = fakeGoogle()
    f.respond(lookup(), gAnswer({ updatedCells: 1 }))
    expect(await UPDATE_CELL.run(f.ctx, { ...ws, cell: 'b2', value: 'Won' })).toEqual({ updatedCells: 1 })
    expect(f.sent[1].method).toBe('PUT')
    expect(f.sent[1].url).toBe(`${S}/${SHEET}/values/${RANGE('B2:B2')}?valueInputOption=USER_ENTERED`)
    expect(f.sent[1].json).toEqual({ values: [['Won']] })
  })

  it('get values reads the worksheet or a range of it, and an empty one is an empty list', async () => {
    const f = fakeGoogle()
    f.respond(lookup(), gAnswer({ range: 'x' }))
    expect(await GET_VALUES.run(f.ctx, { ...ws, range: 'A1:C10' })).toEqual([])
    expect(f.sent[1].url).toBe(`${S}/${SHEET}/values/${RANGE('A1:C10')}`)
  })

  it('find rows returns each matching row\'s number, and the whole rows when asked, as Pipedream did', async () => {
    const f = fakeGoogle()
    f.respond(lookup(), gAnswer({ values: [['Name'], ['Sam'], ['Lee'], ['Sam']] }))
    expect(await FIND_ROW.run(f.ctx, { ...ws, column: 'A', value: 'Sam' })).toEqual([
      { value: ['Sam'], index: 1, googleSheetsRowNumber: 2 }, { value: ['Sam'], index: 3, googleSheetsRowNumber: 4 },
    ])
    expect(f.sent[1].url).toBe(`${S}/${SHEET}/values/${RANGE('A:A')}`)
    const g = fakeGoogle()
    g.respond(lookup(), gAnswer({ values: [['Name'], ['Sam']] }), gAnswer({ values: [['Name', 'Bid'], ['Sam', '42']] }))
    expect(await FIND_ROW.run(g.ctx, { ...ws, column: 'A', value: 'Sam', export_row: true })).toEqual([{ row: ['Sam', '42'], index: 1, googleSheetsRowNumber: 2 }])
  })

  it('get a cell answers its value, or null when it is empty', async () => {
    const f = fakeGoogle()
    f.respond(lookup(), gAnswer({ range: 'x' }))
    expect(await GET_CELL.run(f.ctx, { ...ws, cell: 'C3' })).toBeNull()
  })

  it('create a worksheet, delete rows (end row exclusive, as Pipedream\'s delete-rows) and clear rows (end row inclusive, as Pipedream\'s clear-rows ran)', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ replies: [] }))
    await CREATE_WORKSHEET.run(f.ctx, { spreadsheet_id: SHEET, title: 'Week 43' })
    expect([f.sent[0].method, f.sent[0].url, f.sent[0].json]).toEqual(['POST', `${S}/${SHEET}:batchUpdate`, { requests: [{ addSheet: { properties: { title: 'Week 43' } } }] }])

    const g = fakeGoogle()
    g.respond(gAnswer({ replies: [{}] }))
    await DELETE_ROWS.run(g.ctx, { ...ws, start_row: 2, end_row: 5 })
    expect(g.sent[0].json).toEqual({ requests: [{ deleteDimension: { range: { sheetId: 7, dimension: 'ROWS', startIndex: 1, endIndex: 4 } } }] })

    const h = fakeGoogle()
    h.respond(lookup(), gAnswer({ clearedRange: 'x' }))
    await CLEAR_ROWS.run(h.ctx, { ...ws, start_row: 2, end_row: 5 })
    expect([h.sent[1].method, h.sent[1].url]).toEqual(['POST', `${S}/${SHEET}/values/${RANGE('2:5')}:clear`])
  })

  it('refuses a cell, a column, a range or a row number that is not one, before anything is sent', async () => {
    const cases: Array<[RuntimeAction, ActionArgs]> = [
      [UPDATE_CELL, { ...ws, cell: 'B2:C3', value: 'x' }],
      [GET_CELL, { ...ws, cell: "A1'!Z" }],
      [FIND_ROW, { ...ws, column: 'A1', value: 'x' }],
      [GET_VALUES, { ...ws, range: "A1:B2'" }],
      [DELETE_ROWS, { ...ws, start_row: 0 }],
      [DELETE_ROWS, { ...ws, start_row: 5, end_row: 5 }],
      [CLEAR_ROWS, { ...ws, start_row: 3, end_row: 2 }],
      [ADD_ROW, { spreadsheet_id: '../drive', worksheet_id: 7, values: ['x'] }],
      [ADD_ROW, { spreadsheet_id: SHEET, worksheet_id: 'Sheet1', values: ['x'] }],
    ]
    for (const [a, args] of cases) {
      const f = fakeGoogle()
      const failed = await failure(a.run(f.ctx, args))
      expect([failed.code, f.sent.length], `${a.key} ${JSON.stringify(args)}`).toEqual(['google_argument_invalid', 0])
    }
  })
})

describe('google.gmail-send-email', () => {
  /** The raw message the action sent, decoded. */
  const rawOf = (json: unknown) => {
    const raw = (json as { raw: string }).raw
    return new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))
  }

  it('sends from the connection\'s mailbox, always with a text/html alternative beside text/plain (L726), and returns Gmail\'s answer', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ id: 'm1', threadId: 't1', labelIds: ['SENT'] }))
    const out = await SEND.run(f.ctx, { to: 'partner@lender.example, me', subject: 'Daily bid report', body: 'Hello,\nsee below.', from_name: 'Pennie Ops' })
    expect([f.sent[0].method, f.sent[0].url]).toEqual(['POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'])
    const raw = rawOf(f.sent[0].json)
    expect(raw).toContain('From: "Pennie Ops" <ops@trypennie.com>')
    expect(raw).toContain(`To: partner@lender.example, ${MAILBOX}`)
    expect(raw).toMatch(/Content-Type: multipart\/alternative/)
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"')
    expect(raw).not.toMatch(/quoted-printable/i)
    expect(out).toEqual({ id: 'm1', threadId: 't1', labelIds: ['SENT'] })
  })

  it('an HTML body gets a text part read out of it', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ id: 'm1', threadId: 't1' }))
    await SEND.run(f.ctx, { to: ['a@x.example'], subject: 's', body: '<p>Bids: <b>3</b></p>', body_type: 'html' })
    const raw = rawOf(f.sent[0].json)
    const plain = /text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(raw)![1]
    expect(atob(plain.replace(/\r\n/g, ''))).toBe('Bids: 3')
  })

  it('a reply reads the replied to message, keeps its thread, and answers its sender', async () => {
    const f = fakeGoogle()
    f.respond(
      gAnswer({ id: 'm0', threadId: 't9', payload: { headers: [{ name: 'Subject', value: 'Bids' }, { name: 'Message-Id', value: '<orig@mail.gmail.com>' }, { name: 'From', value: 'Bea <bea@lender.example>' }] } }),
      gAnswer({ id: 'm1', threadId: 't9' }),
    )
    await SEND.run(f.ctx, { body: 'Thanks', in_reply_to_message_id: 'm0' })
    expect(f.sent[0].url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/m0?format=metadata&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Reply-To&metadataHeaders=From')
    expect((f.sent[1].json as { threadId: string }).threadId).toBe('t9')
    const raw = rawOf(f.sent[1].json)
    expect(raw).toContain('Subject: Re: Bids')
    expect(raw).toContain('In-Reply-To: <orig@mail.gmail.com>')
    expect(raw).toContain('To: "Bea" <bea@lender.example>')
  })

  it('attaches inline content, text or base64', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ id: 'm1', threadId: 't1' }))
    await SEND.run(f.ctx, { to: ['a@x.example'], subject: 's', body: 'b', attachments: [{ filename: 'r.csv', content: 'id,bid\n', content_type: 'text/csv' }, { filename: 'r.pdf', content_base64: 'JVBERi0=' }] })
    const raw = rawOf(f.sent[0].json)
    expect(raw).toContain('Content-Type: multipart/mixed')
    expect(raw).toContain('Content-Disposition: attachment; filename="r.csv"')
    expect(raw).toContain('Content-Type: application/octet-stream; name="r.pdf"')
  })

  it('refuses a send with no recipient, no body, a header injection, or a message over the cap, before anything is sent', async () => {
    const cases: ActionArgs[] = [
      { subject: 's', body: 'b' },
      { to: ['a@x.example'], subject: 's' },
      { to: ['a@x.example'], subject: 'Hi\r\nBcc: evil@x.example', body: 'b' },
      { to: ['not an address'], subject: 's', body: 'b' },
      { to: ['a@x.example'], subject: 's', body: 'b', body_type: 'markdown' },
      { to: ['a@x.example'], subject: 's', body: 'b', attachments: [{ filename: 'big.bin', content: 'x'.repeat(6 * 1024 * 1024) }] },
    ]
    for (const args of cases) {
      const f = fakeGoogle()
      const failed = await failure(SEND.run(f.ctx, args))
      expect([failed.outcome, f.sent.length], JSON.stringify(args).slice(0, 80)).toEqual(['not_applied', 0])
      expect(failed.code).toMatch(/^google_(argument_invalid|gmail_message_too_large)$/)
    }
  })
})

describe('the Drive actions', () => {
  it('list files pages through every result with the query\'s binds quoted, and fails by name at its page cap', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ files: [{ id: '1' }], nextPageToken: 'p2' }), gAnswer({ files: [{ id: '2' }] }))
    expect(await LIST_FILES.run(f.ctx, { query: 'name contains ? and trashed = ?', binds: ["Sam's report", false], drive_id: '0AReportsDrive' })).toEqual({ files: [{ id: '1' }, { id: '2' }] })
    const first = new URL(f.sent[0].url)
    expect(first.origin + first.pathname).toBe('https://www.googleapis.com/drive/v3/files')
    expect(first.searchParams.get('q')).toBe("name contains 'Sam\\'s report' and trashed = false")
    expect(first.searchParams.get('driveId')).toBe('0AReportsDrive')
    expect(first.searchParams.get('corpora')).toBe('drive')
    expect(new URL(f.sent[1].url).searchParams.get('pageToken')).toBe('p2')

    const g = fakeGoogle()
    for (let i = 0; i < DRIVE_LIST_MAX_PAGES; i++) g.respond(gAnswer({ files: [{ id: String(i) }], nextPageToken: `p${i + 1}` }))
    const failed = await failure(LIST_FILES.run(g.ctx, {}))
    expect([failed.code, failed.outcome, g.sent.length]).toEqual(['google_drive_list_page_cap', 'not_applied', DRIVE_LIST_MAX_PAGES])
  })

  it('a shared drive the connection does not declare is refused before anything is sent (F129)', async () => {
    const f = fakeGoogle()
    const failed = await failure(LIST_FILES.run(f.ctx, { drive_id: '0AOtherDrive' }))
    expect([failed.code, f.sent.length]).toEqual(['google_drive_not_declared', 0])
  })

  it('download a file reads its metadata, then its content as text or base64', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ id: '1F', name: 'report.csv', mimeType: 'text/csv', size: '7' }), new Response('id,bid\n'))
    expect(await DOWNLOAD.run(f.ctx, { file_id: '1F' })).toEqual({ id: '1F', name: 'report.csv', mime_type: 'text/csv', size: 7, content: 'id,bid\n' })
    expect(f.sent.map((s) => s.url)).toEqual([
      'https://www.googleapis.com/drive/v3/files/1F?fields=id%2Cname%2CmimeType%2Csize&supportsAllDrives=true',
      'https://www.googleapis.com/drive/v3/files/1F?alt=media&supportsAllDrives=true',
    ])
    const g = fakeGoogle()
    g.respond(gAnswer({ id: '1G', name: 'Report', mimeType: 'application/vnd.google-apps.spreadsheet' }), new Response(new Uint8Array([80, 75, 3, 4])))
    expect(await DOWNLOAD.run(g.ctx, { file_id: '1G', export_mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', as: 'base64' }))
      .toEqual({ id: '1G', name: 'Report', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 4, content_base64: 'UEsDBA==' })
    expect(g.sent[1].url).toBe('https://www.googleapis.com/drive/v3/files/1G/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('a file over the cap, a Google file with no export type, and text that is not UTF-8 are refused by name', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ id: '1F', name: 'big.csv', mimeType: 'text/csv', size: String(DRIVE_DOWNLOAD_MAX_BYTES + 1) }))
    expect((await failure(DOWNLOAD.run(f.ctx, { file_id: '1F' }))).code).toBe('google_drive_file_too_large')
    expect(f.sent).toHaveLength(1)
    const g = fakeGoogle()
    g.respond(gAnswer({ id: '1G', name: 'Doc', mimeType: 'application/vnd.google-apps.document' }))
    expect((await failure(DOWNLOAD.run(g.ctx, { file_id: '1G' }))).code).toBe('google_argument_invalid')
    const h = fakeGoogle()
    h.respond(gAnswer({ id: '1F', name: 'r.bin', mimeType: 'application/octet-stream', size: '2' }), new Response(new Uint8Array([0xff, 0xfe])))
    expect((await failure(DOWNLOAD.run(h.ctx, { file_id: '1F' }))).code).toBe('google_drive_not_text')
    // An export has no size in its metadata: the body is read only up to the cap.
    const k = fakeGoogle()
    k.respond(gAnswer({ id: '1G', name: 'Big', mimeType: 'application/vnd.google-apps.spreadsheet' }), new Response(new Uint8Array(DRIVE_DOWNLOAD_MAX_BYTES + 1)))
    expect((await failure(DOWNLOAD.run(k.ctx, { file_id: '1G', export_mime_type: 'text/csv' }))).code).toBe('google_drive_file_too_large')
  })
})

describe('the Calendar actions', () => {
  const C = 'https://www.googleapis.com/calendar/v3/calendars'

  it('create an event as Pipedream built it: a date for a day, a date time otherwise, the attendees, and a Meet room when asked', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ id: 'e1' }))
    await CREATE_EVENT.run(f.ctx, {
      calendar_id: 'team@trypennie.com', summary: 'Call', start: '2026-10-23T15:00:00', end: '2026-10-23T15:30:00', time_zone: 'America/New_York',
      attendees: 'a@x.example, b@x.example', send_updates: 'all', create_meet_room: true,
    })
    const url = new URL(f.sent[0].url)
    expect(url.origin + url.pathname).toBe(`${C}/team%40trypennie.com/events`)
    expect(url.searchParams.get('sendUpdates')).toBe('all')
    expect(url.searchParams.get('conferenceDataVersion')).toBe('1')
    const body = f.sent[0].json as Record<string, unknown>
    expect(body.start).toEqual({ dateTime: '2026-10-23T15:00:00', timeZone: 'America/New_York' })
    expect(body.attendees).toEqual([{ email: 'a@x.example' }, { email: 'b@x.example' }])
    expect((body.conferenceData as { createRequest: { conferenceSolutionKey: unknown } }).createRequest.conferenceSolutionKey).toEqual({ type: 'hangoutsMeet' })

    const g = fakeGoogle()
    g.respond(gAnswer({ value: 'America/Chicago' }), gAnswer({ id: 'e2' }))
    await CREATE_EVENT.run(g.ctx, { start: '2026-10-23', end: '2026-10-24' })
    expect(g.sent[0].url).toBe('https://www.googleapis.com/calendar/v3/users/me/settings/timezone')
    expect((g.sent[1].json as Record<string, unknown>).start).toEqual({ date: '2026-10-23', timeZone: 'America/Chicago' })
    expect(new URL(g.sent[1].url).pathname).toBe('/calendar/v3/calendars/primary/events')
  })

  it('delete an event: a 204 is deleted, and one already gone (410) is deleted too, which is why a repeat is safe', async () => {
    const f = fakeGoogle()
    f.respond(new Response(null, { status: 204 }))
    expect(await DELETE_EVENT.run(f.ctx, { event_id: 'e1' })).toEqual({ deleted: true, event_id: 'e1', already_deleted: false })
    expect([f.sent[0].method, f.sent[0].url]).toEqual(['DELETE', `${C}/primary/events/e1?sendUpdates=none`])
    const g = fakeGoogle()
    g.respond(gError(410, 'GONE', 'deleted', 'Resource has been deleted'))
    expect(await DELETE_EVENT.run(g.ctx, { event_id: 'e1' })).toEqual({ deleted: true, event_id: 'e1', already_deleted: true })
  })

  it('list events pages through every event and fails by name at its page cap', async () => {
    const f = fakeGoogle()
    f.respond(gAnswer({ items: [{ id: 'a' }], nextPageToken: 'p2' }), gAnswer({ items: [{ id: 'b' }] }))
    expect(await LIST_EVENTS.run(f.ctx, { time_min: '2026-10-23T00:00:00Z', query: 'Call' })).toEqual({ items: [{ id: 'a' }, { id: 'b' }] })
    const url = new URL(f.sent[0].url)
    expect(url.searchParams.get('singleEvents')).toBe('true')
    expect(url.searchParams.get('orderBy')).toBe('startTime')
    expect(url.searchParams.get('timeMin')).toBe('2026-10-23T00:00:00Z')
    expect(url.searchParams.get('q')).toBe('Call')
    const g = fakeGoogle()
    for (let i = 0; i < CALENDAR_LIST_MAX_PAGES; i++) g.respond(gAnswer({ items: [], nextPageToken: `p${i + 1}` }))
    expect((await failure(LIST_EVENTS.run(g.ctx, {}))).code).toBe('google_calendar_list_page_cap')
  })

  it('refuses a start or end that is not a date or date time, and a send_updates it does not know, before anything is sent', async () => {
    const cases: ActionArgs[] = [{ start: 'tomorrow', end: '2026-10-24' }, { start: '2026-10-23', end: '2026-10-24', send_updates: 'everyone', time_zone: 'UTC' }]
    for (const args of cases) {
      const f = fakeGoogle()
      const failed = await failure(CREATE_EVENT.run(f.ctx, args))
      expect([failed.code, f.sent.length]).toEqual(['google_argument_invalid', 0])
    }
  })
})
