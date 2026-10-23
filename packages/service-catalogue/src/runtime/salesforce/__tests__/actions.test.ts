import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, RuntimeAction } from '../../types'
import { SALESFORCE_BULK_MAX_BYTES, SALESFORCE_QUERY_MAX_PAGES, SALESFORCE_RESULTS_MAX_ROWS } from '../call'
import { csvAnswer, DATA, edgePage, fakeSalesforce, HOST, noContent, queryPage, sfAnswer, sfError } from './fake-salesforce'

/**
 * The Salesforce actions the Pipedream workflows use (#2337; counted in the
 * export of 2026-09-30, the duplicate project folder left out, steps inside
 * if/else branches counted; the counts are in schema/services/salesforce.ts).
 * Each has the fixtures every service PR carries: an expired login, revoked
 * consent, a 429 with Retry-After, a timeout after send for every side
 * effecting action, and a partial batch where a request carries several
 * records.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const SEARCH = action('salesforce.soql-search')
const QUERY = action('salesforce.query')
const CREATE = action('salesforce.create-record')
const UPDATE = action('salesforce.update-record')
const UPSERT = action('salesforce.upsert-record')
const CREATE_MANY = action('salesforce.create-records')
const UPDATE_MANY = action('salesforce.update-records')
const APEX = action('salesforce.apex-rest')
const BULK = action('salesforce.bulk-ingest')
const JOB = action('salesforce.get-ingest-job')

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

const LEAD_ID = '00QDp00000AbCdEMAZ'

/** One valid step per action, and the answer Salesforce gives it, for the fixtures every action shares. */
const CASES: Array<{ a: RuntimeAction; args: ActionArgs; ok: () => Response }> = [
  { a: SEARCH, args: { query: 'SELECT Id FROM Lead' }, ok: () => queryPage([]) },
  { a: QUERY, args: { query: 'SELECT Id FROM Lead' }, ok: () => queryPage([]) },
  { a: CREATE, args: { object: 'Prospect__c', fields: { Name: 'x' } }, ok: () => sfAnswer({ id: 'a0X1', success: true, errors: [] }, 201) },
  { a: UPDATE, args: { object: 'Lead', record_id: LEAD_ID, fields: { Status: 'Open' } }, ok: noContent },
  { a: UPSERT, args: { object: 'Installment__c', external_id_field: 'Ext_Id__c', external_id: 'E-1', fields: { Amount__c: 5 } }, ok: () => sfAnswer({ id: 'a1X1', success: true, errors: [], created: true }, 201) },
  { a: CREATE_MANY, args: { object: 'Commission__c', records: [{ Name: 'a' }] }, ok: () => sfAnswer([{ id: 'a2X1', success: true, errors: [] }]) },
  { a: UPDATE_MANY, args: { object: 'Lead', records: [{ Id: LEAD_ID, Status: 'Open' }] }, ok: () => sfAnswer([{ id: LEAD_ID, success: true, errors: [] }]) },
  { a: APEX, args: { method: 'GET', path: 'custommdt/bid' }, ok: () => sfAnswer({ bid: 1 }) },
  { a: BULK, args: { object: 'Lead', operation: 'update', records: [{ Id: LEAD_ID, Status: 'Open' }] }, ok: () => sfAnswer({ id: '750J1', state: 'Open' }) },
  { a: JOB, args: { job_id: '750Dp00000AbCdEIAV' }, ok: () => sfAnswer({ id: '750Dp00000AbCdEIAV', state: 'JobComplete', numberRecordsProcessed: 1, numberRecordsFailed: 0 }) },
]

describe('the Salesforce actions decide their own traits', () => {
  it('are the ten the workflows need, every write never repeated on an uncertain outcome', () => {
    expect(catalogueActions(CATALOGUE).map((a) => `${a.key}@${a.version}`).filter((id) => id.startsWith('salesforce.')).sort()).toEqual([
      'salesforce.apex-rest@1', 'salesforce.bulk-ingest@1', 'salesforce.create-record@1', 'salesforce.create-records@1', 'salesforce.get-ingest-job@1',
      'salesforce.query@1', 'salesforce.soql-search@1', 'salesforce.update-record@1', 'salesforce.update-records@1', 'salesforce.upsert-record@1',
    ])
    const traits = Object.fromEntries(CASES.map(({ a }) => [a.key, [a.sideEffect, a.idempotent]]))
    expect(traits).toEqual({
      'salesforce.soql-search': [false, true],
      'salesforce.query': [false, true],
      'salesforce.get-ingest-job': [false, true],
      'salesforce.create-record': [true, false],
      'salesforce.update-record': [true, false],
      'salesforce.upsert-record': [true, false],
      'salesforce.create-records': [true, false],
      'salesforce.update-records': [true, false],
      'salesforce.apex-rest': [true, false],
      'salesforce.bulk-ingest': [true, false],
    })
    for (const { a } of CASES.filter(({ a }) => a.sideEffect)) expect(a.idempotentBecause, a.key).toMatch(/automation|record|Apex|job/)
  })

  it('never let a step value into query text or an object or field name: those take no variables', () => {
    for (const { a } of CASES) {
      for (const arg of a.arguments) {
        if (['query', 'object', 'external_id_field', 'operation', 'method'].includes(arg.key)) expect(arg.allowsVariables, `${a.key}.${arg.key}`).toBe(false)
      }
    }
    expect(SEARCH.arguments.find((x) => x.key === 'query')?.type).toBe('code')
  })
})

describe('what every Salesforce action shares', () => {
  it('sends through the connection bound fetch to the declared instance, on API v60.0, with no token of its own', async () => {
    for (const { a, args, ok } of CASES) {
      const f = fakeSalesforce()
      f.respond(ok(), sfAnswer({}, 201), sfAnswer({ id: '750J1', state: 'UploadComplete' }))
      await a.run(f.ctx, args)
      for (const s of f.sent) {
        expect(new URL(s.url).host, a.key).toBe(HOST)
        expect(s.url.includes('/services/data/') ? s.url.includes('/services/data/v60.0/') : true, `${a.key} ${s.url}`).toBe(true)
        expect(s.headers.get('authorization'), a.key).toBeNull()
      }
    }
  })

  it('an expired or revoked login: what the connection bound fetch throws passes through unchanged, and nothing more is sent', async () => {
    for (const { a, args } of CASES) {
      const expired = new Error('needs_reauth: login_refused: invalid_grant')
      const f = fakeSalesforce()
      f.respond({ throws: expired })
      await expect(a.run(f.ctx, args), a.key).rejects.toBe(expired)
      expect(f.sent, a.key).toHaveLength(1)
    }
  })

  it('a 429 with Retry-After: the requeue passes through unchanged, and nothing waits in the request', async () => {
    for (const { a, args } of CASES) {
      const requeue = { kind: 'requeue_at', notBefore: new Date('2026-10-22T15:00:20Z') }
      const f = fakeSalesforce()
      f.respond({ throws: requeue })
      await expect(a.run(f.ctx, args), a.key).rejects.toBe(requeue)
      expect(f.sent, a.key).toHaveLength(1)
    }
  })

  it('a timeout after send passes through unchanged for every action, and every side effecting one is never retried', async () => {
    for (const { a, args } of CASES) {
      const timeout = new DOMException('The operation timed out.', 'TimeoutError')
      const f = fakeSalesforce()
      f.respond({ throws: timeout })
      await expect(a.run(f.ctx, args), a.key).rejects.toBe(timeout)
      if (a.sideEffect) expect(a.idempotent, a.key).toBe(false)
    }
  })

  it('revoked consent: an integration user that lost its access is refused by Salesforce\'s own code, not applied', async () => {
    const answers: Array<[() => Response, string]> = [
      [() => sfError(403, 'INSUFFICIENT_ACCESS_OR_READONLY', 'insufficient access rights on object id'), 'salesforce_insufficient_access_or_readonly'],
      [() => sfError(403, 'API_DISABLED_FOR_ORG', 'API is disabled for this User'), 'salesforce_api_disabled_for_org'],
      [() => sfError(401, 'INVALID_SESSION_ID', 'Session expired or invalid'), 'salesforce_invalid_session_id'],
    ]
    for (const { a, args } of CASES) {
      for (const [answer, code] of answers) {
        const f = fakeSalesforce()
        f.respond(answer())
        const failed = await failure(a.run(f.ctx, args))
        expect([failed.code, failed.outcome], `${a.key} ${code}`).toEqual([code, 'not_applied'])
      }
    }
  })

  it('a 429 answered to the action, and the org\'s daily limit, are refused by name and not applied; the wait is named', async () => {
    for (const { a, args } of CASES) {
      const f = fakeSalesforce()
      f.respond(new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '30' } }))
      const limited = await failure(a.run(f.ctx, args))
      expect([limited.code, limited.outcome], a.key).toEqual(['salesforce_http_429', 'not_applied'])
      expect(limited.message).toContain('30')
      const g = fakeSalesforce()
      g.respond(sfError(403, 'REQUEST_LIMIT_EXCEEDED', 'TotalRequests Limit exceeded.'))
      expect((await failure(a.run(g.ctx, args))).code, a.key).toBe('salesforce_request_limit_exceeded')
    }
  })

  it('a server error or the edge page: unknown for a write, since Salesforce may have run it; not applied for a read, or for opening a bulk job, which runs nothing until it is closed', async () => {
    for (const { a, args } of CASES) {
      for (const answer of [() => sfError(500, 'UNKNOWN_EXCEPTION', 'An unexpected error occurred'), () => edgePage(400), () => edgePage(503)]) {
        const f = fakeSalesforce()
        f.respond(answer())
        const failed = await failure(a.run(f.ctx, args))
        expect(failed.outcome, a.key).toBe(a.sideEffect && a !== BULK ? 'unknown' : 'not_applied')
        expect(failed.message, a.key).not.toContain('Sam Lee')
      }
    }
  })

  it('a refusal is named by Salesforce\'s error code, names the fields it blamed, and never quotes Salesforce\'s message, which can quote a value', async () => {
    const f = fakeSalesforce()
    f.respond(sfError(400, 'INVALID_EMAIL_ADDRESS', 'Email: invalid email address: sam.lee@example', ['Email']))
    const failed = await failure(CREATE.run(f.ctx, { object: 'Lead', fields: { Email: 'sam.lee@example' } }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_invalid_email_address', 'not_applied'])
    expect(failed.message).toContain('Email')
    expect(failed.message).not.toContain('sam.lee')
  })

  it('a refusal with no error code is named by its status', async () => {
    const f = fakeSalesforce()
    f.respond(new Response('Forbidden', { status: 403 }))
    expect((await failure(UPDATE.run(f.ctx, { object: 'Lead', record_id: LEAD_ID, fields: { Status: 'x' } }))).code).toBe('salesforce_http_403')
    // A "code" that is not one of Salesforce's names is never repeated: it could be anything.
    const g = fakeSalesforce()
    g.respond(sfError(400, 'sam.lee@example bounced'))
    const odd = await failure(UPDATE.run(g.ctx, { object: 'Lead', record_id: LEAD_ID, fields: { Status: 'x' } }))
    expect(odd.code).toBe('salesforce_http_400')
    expect(odd.message).not.toContain('sam.lee')
  })

  it('refuses a target with no https instance before anything is sent', async () => {
    for (const target of [{}, { instance_url: 'http://trypennie.my.salesforce.com' }, { instance_url: 'not a url' }]) {
      const f = fakeSalesforce(target)
      const failed = await failure(SEARCH.run(f.ctx, { query: 'SELECT Id FROM Lead' }))
      expect([failed.code, failed.outcome]).toEqual(['salesforce_target_invalid', 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})

describe('salesforce.soql-search@1, at parity with Pipedream\'s SOQL Query (Object Query)', () => {
  it('sends one query and returns Salesforce\'s first batch as Pipedream did, its nextRecordsUrl untouched', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ totalSize: 4100, done: false, nextRecordsUrl: '/services/data/v60.0/query/01gJ-2000', records: [{ Id: LEAD_ID }] }))
    const out = await SEARCH.run(f.ctx, { query: 'SELECT Id FROM Lead WHERE Email = ?', binds: ["o'brien@example.test"] })
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([['GET', `${DATA}/query?q=${encodeURIComponent("SELECT Id FROM Lead WHERE Email = 'o\\'brien@example.test'")}`]])
    expect(out).toEqual({ totalSize: 4100, done: false, nextRecordsUrl: '/services/data/v60.0/query/01gJ-2000', records: [{ Id: LEAD_ID }] })
  })

  it('a malformed query is refused by Salesforce\'s code, not applied', async () => {
    const f = fakeSalesforce()
    f.respond(sfError(400, 'MALFORMED_QUERY', "unexpected token: 'FORM'"))
    expect((await failure(SEARCH.run(f.ctx, { query: 'SELECT Id FORM Lead' }))).code).toBe('salesforce_malformed_query')
  })

  it('an answer that is not a query result is unreadable', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ hello: 1 }))
    expect((await failure(SEARCH.run(f.ctx, { query: 'SELECT Id FROM Lead' }))).code).toBe('salesforce_answer_unreadable')
  })
})

describe('salesforce.query@1, every page', () => {
  it('follows nextRecordsUrl on the declared instance until done, and returns every record', async () => {
    const f = fakeSalesforce()
    f.respond(
      sfAnswer({ totalSize: 3, done: false, nextRecordsUrl: '/services/data/v60.0/query/01gJ-1', records: [{ Id: 'a' }] }),
      sfAnswer({ totalSize: 3, done: false, nextRecordsUrl: '/services/data/v60.0/query/01gJ-2', records: [{ Id: 'b' }] }),
      sfAnswer({ totalSize: 3, done: true, records: [{ Id: 'c' }] }),
    )
    const out = await QUERY.run(f.ctx, { query: 'SELECT Id FROM Lead' })
    expect(f.sent.map((s) => s.url).slice(1)).toEqual([`https://${HOST}/services/data/v60.0/query/01gJ-1`, `https://${HOST}/services/data/v60.0/query/01gJ-2`])
    expect(out).toEqual({ totalSize: 3, done: true, records: [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }] })
  })

  it('fails by name at its page cap rather than return part of the result', async () => {
    const f = fakeSalesforce()
    for (let i = 0; i < SALESFORCE_QUERY_MAX_PAGES; i++) f.respond(sfAnswer({ totalSize: 1e6, done: false, nextRecordsUrl: `/services/data/v60.0/query/01gJ-${i + 1}`, records: [{ Id: String(i) }] }))
    const failed = await failure(QUERY.run(f.ctx, { query: 'SELECT Id FROM Lead' }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_query_page_cap', 'not_applied'])
    expect(f.sent).toHaveLength(SALESFORCE_QUERY_MAX_PAGES)
  })

  it('a later page that fails fails the step, never a prefix', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ totalSize: 2, done: false, nextRecordsUrl: '/services/data/v60.0/query/01gJ-1', records: [{ Id: 'a' }] }), sfError(400, 'INVALID_QUERY_LOCATOR', 'invalid query locator'))
    expect((await failure(QUERY.run(f.ctx, { query: 'SELECT Id FROM Lead' }))).code).toBe('salesforce_invalid_query_locator')
  })

  it('a page saying it is not done with no next page is unreadable, never a short success', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ totalSize: 2, done: false, records: [{ Id: 'a' }] }))
    expect((await failure(QUERY.run(f.ctx, { query: 'SELECT Id FROM Lead' }))).code).toBe('salesforce_answer_unreadable')
  })
})

describe('salesforce.create-record@1', () => {
  it('posts the fields to the object and returns Salesforce\'s id', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: 'a0XDp000001', success: true, errors: [] }, 201))
    const out = await CREATE.run(f.ctx, { object: 'Prospect__c', fields: { LeadUUID__c: 'u-1', Amount__c: 12000 } })
    expect(f.sent.map((s) => [s.method, s.url, s.json])).toEqual([['POST', `${DATA}/sobjects/Prospect__c`, { LeadUUID__c: 'u-1', Amount__c: 12000 }]])
    expect(f.sent[0].headers.get('content-type')).toBe('application/json')
    expect(out).toEqual({ id: 'a0XDp000001', success: true, errors: [] })
  })

  it('a created answer it cannot read is applied: the record exists and its id is unknown', async () => {
    const f = fakeSalesforce()
    f.respond(new Response('created', { status: 201 }))
    const failed = await failure(CREATE.run(f.ctx, { object: 'Lead', fields: { LastName: 'x' } }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_answer_unreadable', 'applied'])
  })
})

describe('salesforce.update-record@1, at parity with Pipedream\'s Update Record', () => {
  it('patches the record and returns what Pipedream returned', async () => {
    const f = fakeSalesforce()
    f.respond(noContent())
    const out = await UPDATE.run(f.ctx, { object: 'Lead', record_id: LEAD_ID, fields: { Status: 'Working' } })
    expect(f.sent.map((s) => [s.method, s.url, s.json])).toEqual([['PATCH', `${DATA}/sobjects/Lead/${LEAD_ID}`, { Status: 'Working' }]])
    expect(out).toEqual({ success: true, objectType: 'Lead', recordId: LEAD_ID })
  })

  it('a record id that is not one is refused before anything is sent', async () => {
    const f = fakeSalesforce()
    const failed = await failure(UPDATE.run(f.ctx, { object: 'Lead', record_id: '../User/005', fields: { Status: 'x' } }))
    expect([failed.code, f.sent]).toEqual(['salesforce_argument_invalid', []])
  })

  it('a record that is not there is refused by name', async () => {
    const f = fakeSalesforce()
    f.respond(sfError(404, 'NOT_FOUND', 'The requested resource does not exist'))
    expect((await failure(UPDATE.run(f.ctx, { object: 'Lead', record_id: LEAD_ID, fields: { Status: 'x' } }))).code).toBe('salesforce_not_found')
  })
})

describe('salesforce.upsert-record@1', () => {
  it('patches by the external id, its value encoded, and says whether it created', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: 'a1X1', success: true, errors: [], created: false }))
    const out = await UPSERT.run(f.ctx, { object: 'Installment__c', external_id_field: 'Ext_Id__c', external_id: 'E 1/2', fields: { Amount__c: 5 } })
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([['PATCH', `${DATA}/sobjects/Installment__c/Ext_Id__c/E%201%2F2`]])
    expect(out).toEqual({ id: 'a1X1', success: true, created: false })
  })

  it('an external id matching several records is refused by name, not applied', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer(['/services/data/v60.0/sobjects/Installment__c/a1X1', '/services/data/v60.0/sobjects/Installment__c/a1X2'], 300))
    const failed = await failure(UPSERT.run(f.ctx, { object: 'Installment__c', external_id_field: 'Ext_Id__c', external_id: 'E-1', fields: {} }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_external_id_ambiguous', 'not_applied'])
  })
})

describe('salesforce.create-records@1 and salesforce.update-records@1, all or none', () => {
  it('sends every record in one sObject Collections request with allOrNone, each typed, and returns each result', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer([{ id: 'a2X1', success: true, errors: [] }, { id: 'a2X2', success: true, errors: [] }]))
    const out = await CREATE_MANY.run(f.ctx, { object: 'Commission__c', records: [{ Name: 'a' }, { Name: 'b' }] })
    expect(f.sent.map((s) => [s.method, s.url, s.json])).toEqual([['POST', `${DATA}/composite/sobjects`, {
      allOrNone: true, records: [{ attributes: { type: 'Commission__c' }, Name: 'a' }, { attributes: { type: 'Commission__c' }, Name: 'b' }],
    }]])
    expect(out).toEqual({ results: [{ id: 'a2X1', success: true, errors: [] }, { id: 'a2X2', success: true, errors: [] }] })

    const g = fakeSalesforce()
    g.respond(sfAnswer([{ id: LEAD_ID, success: true, errors: [] }]))
    await UPDATE_MANY.run(g.ctx, { object: 'Lead', records: [{ Id: LEAD_ID, Lead_State__c: 'Inactive' }] })
    expect(g.sent.map((s) => [s.method, s.url, s.json])).toEqual([['PATCH', `${DATA}/composite/sobjects`, {
      allOrNone: true, records: [{ attributes: { type: 'Lead' }, Id: LEAD_ID, Lead_State__c: 'Inactive' }],
    }]])
  })

  it('a partial batch: one bad record rolls every record back, refused by name naming its place and code, not applied', async () => {
    // Salesforce answers the rolled back batch with its per record results; read them whatever the status.
    for (const status of [200, 400]) {
      const f = fakeSalesforce()
      f.respond(sfAnswer([
        { id: null, success: false, errors: [{ statusCode: 'ALL_OR_NONE_OPERATION_ROLLED_BACK', message: 'Record rolled back', fields: [] }] },
        { id: null, success: false, errors: [{ statusCode: 'INVALID_EMAIL_ADDRESS', message: 'Email: invalid: sam.lee@x', fields: ['Email'] }] },
      ], status))
      const failed = await failure(UPDATE_MANY.run(f.ctx, { object: 'Lead', records: [{ Id: LEAD_ID, Email: 'a@b.co' }, { Id: LEAD_ID, Email: 'sam.lee@x' }] }))
      expect([failed.code, failed.outcome], String(status)).toEqual(['salesforce_batch_rejected', 'not_applied'])
      expect(failed.message).toMatch(/record 2.*INVALID_EMAIL_ADDRESS.*Email/)
      expect(failed.message).not.toContain('sam.lee')
    }
  })

  it('a batch Salesforce applied only in part, which allOrNone should never allow, is applied and fails by name', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer([{ id: LEAD_ID, success: true, errors: [] }, { id: null, success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'x', fields: [] }] }]))
    const failed = await failure(UPDATE_MANY.run(f.ctx, { object: 'Lead', records: [{ Id: LEAD_ID }, { Id: LEAD_ID }] }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_partial_batch', 'applied'])
  })

  it('an answer that does not hold one result per record is unreadable, and its outcome unknown', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer([{ id: 'a2X1', success: true, errors: [] }]))
    const failed = await failure(CREATE_MANY.run(f.ctx, { object: 'Commission__c', records: [{ Name: 'a' }, { Name: 'b' }] }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_answer_unreadable', 'unknown'])
  })

  it('refuses more than 200 records, an empty list, and an update record with no Id, before anything is sent', async () => {
    const cases: Array<[RuntimeAction, ActionArgs]> = [
      [CREATE_MANY, { object: 'Lead', records: Array.from({ length: 201 }, () => ({ LastName: 'x' })) }],
      [CREATE_MANY, { object: 'Lead', records: [] }],
      [UPDATE_MANY, { object: 'Lead', records: [{ Status: 'x' }] }],
      [CREATE_MANY, { object: 'Lead', records: [{ attributes: { type: 'User' }, LastName: 'x' }] }],
    ]
    for (const [a, args] of cases) {
      const f = fakeSalesforce()
      const failed = await failure(a.run(f.ctx, args))
      expect([failed.code, failed.outcome, f.sent.length]).toEqual([failed.code, 'not_applied', 0])
      expect(failed.code).toMatch(/^salesforce_(too_many_records|argument_invalid)$/)
    }
  })
})

describe('salesforce.apex-rest@1', () => {
  it('calls the org\'s own Apex REST path with its parameters encoded and its body, and returns the answer', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ bid: 42 }))
    const out = await APEX.run(f.ctx, { method: 'POST', path: 'prospect-trades', params: { name: 'Lead Economy & Co' }, body: { ssn4: '1234' } })
    expect(f.sent.map((s) => [s.method, s.url, s.json])).toEqual([['POST', `https://${HOST}/services/apexrest/prospect-trades?name=Lead+Economy+%26+Co`, { ssn4: '1234' }]])
    expect(out).toEqual({ status: 200, body: { bid: 42 } })
  })

  it('refuses a path that would leave the Apex REST root, and a method it does not send', async () => {
    for (const args of [{ method: 'GET', path: '../data/v60.0/sobjects/User' }, { method: 'GET', path: 'a?b=c' }, { method: 'GET', path: 'https://evil.example/x' }, { method: 'TRACE', path: 'x' }]) {
      const f = fakeSalesforce()
      const failed = await failure(APEX.run(f.ctx, args))
      expect([failed.code, f.sent]).toEqual(['salesforce_argument_invalid', []])
    }
  })
})

describe('salesforce.bulk-ingest@1, a Bulk API 2.0 job', () => {
  const records = [{ Id: LEAD_ID, Status: 'Open', Note__c: 'a, "b"' }, { Id: '00QDp00000AbCdFMAZ', Status: null, Note__c: 'c' }]

  it('opens a job, uploads every record as one CSV, closes it, and returns the job to check later', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: '750J1', state: 'Open', object: 'Lead', operation: 'update' }), new Response(null, { status: 201 }), sfAnswer({ id: '750J1', state: 'UploadComplete' }))
    const out = await BULK.run(f.ctx, { object: 'Lead', operation: 'update', records })
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([
      ['POST', `${DATA}/jobs/ingest`], ['PUT', `${DATA}/jobs/ingest/750J1/batches`], ['PATCH', `${DATA}/jobs/ingest/750J1`],
    ])
    expect(f.sent[0].json).toEqual({ object: 'Lead', operation: 'update', contentType: 'CSV', lineEnding: 'LF', columnDelimiter: 'COMMA' })
    expect(f.sent[1].headers.get('content-type')).toBe('text/csv')
    expect(f.sent[1].text).toBe(`Id,Status,Note__c\n${LEAD_ID},Open,"a, ""b"""\n00QDp00000AbCdFMAZ,#N/A,c\n`)
    expect(f.sent[2].json).toEqual({ state: 'UploadComplete' })
    expect(out).toEqual({ job_id: '750J1', state: 'UploadComplete', object: 'Lead', operation: 'update', records: 2 })
  })

  it('an upsert names its external id field', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: '750J1', state: 'Open' }), new Response(null, { status: 201 }), sfAnswer({ id: '750J1', state: 'UploadComplete' }))
    await BULK.run(f.ctx, { object: 'Prospect__c', operation: 'upsert', external_id_field: 'LeadUUID__c', records: [{ LeadUUID__c: 'u-1' }] })
    expect(f.sent[0].json).toMatchObject({ operation: 'upsert', externalIdFieldName: 'LeadUUID__c' })
  })

  it('an upload Salesforce refuses aborts the open job, which then runs nothing, and fails not applied', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: '750J1', state: 'Open' }), sfError(400, 'INVALIDJOB', 'bad csv'), sfAnswer({ id: '750J1', state: 'Aborted' }))
    const failed = await failure(BULK.run(f.ctx, { object: 'Lead', operation: 'update', records }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_invalidjob', 'not_applied'])
    expect(f.sent.map((s) => [s.method, s.json])).toEqual([['POST', expect.anything()], ['PUT', null], ['PATCH', { state: 'Aborted' }]])
  })

  it('an upload the connection bound fetch fails aborts the job and passes the failure on unchanged, since nothing ran', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: '750J1', state: 'Open' }), { throws: timeout }, sfAnswer({ id: '750J1', state: 'Aborted' }))
    await expect(BULK.run(f.ctx, { object: 'Lead', operation: 'update', records })).rejects.toBe(timeout)
    expect(f.sent.map((s) => s.method)).toEqual(['POST', 'PUT', 'PATCH'])
  })

  it('a timeout after the close was sent: the job may be running, so the outcome is unknown and never retried', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: '750J1', state: 'Open' }), new Response(null, { status: 201 }), { throws: new DOMException('The operation timed out.', 'TimeoutError') })
    const failed = await failure(BULK.run(f.ctx, { object: 'Lead', operation: 'update', records }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_bulk_close_unknown', 'unknown'])
    expect(failed.message).toContain('750J1')
  })

  it('refuses rows that do not share one set of fields, a value it cannot write, and an upload over its cap, before anything is sent', async () => {
    const big = 'x'.repeat(1024)
    const cases: Array<[ActionArgs, string]> = [
      [{ object: 'Lead', operation: 'update', records: [{ Id: 'a', Status: 'x' }, { Id: 'b' }] }, 'salesforce_bulk_rows_differ'],
      [{ object: 'Lead', operation: 'update', records: [{ Id: 'a', Status: { nested: 1 } }] }, 'salesforce_argument_invalid'],
      [{ object: 'Lead', operation: 'merge', records: [{ Id: 'a' }] }, 'salesforce_argument_invalid'],
      [{ object: 'Lead', operation: 'upsert', records: [{ Id: 'a' }] }, 'salesforce_argument_invalid'],
      [{ object: 'Lead', operation: 'insert', records: [] }, 'salesforce_argument_invalid'],
      [{ object: 'Lead', operation: 'insert', records: Array.from({ length: Math.ceil(SALESFORCE_BULK_MAX_BYTES / 1024) + 1 }, () => ({ Description: big })) }, 'salesforce_bulk_upload_too_large'],
    ]
    for (const [args, code] of cases) {
      const f = fakeSalesforce()
      const failed = await failure(BULK.run(f.ctx, args))
      expect([failed.code, failed.outcome, f.sent.length], code).toEqual([code, 'not_applied', 0])
    }
  })
})

describe('salesforce.get-ingest-job@1', () => {
  const JOB_ID = '750Dp00000AbCdEIAV'

  it('reads the job\'s state, and its failed records as rows when asked', async () => {
    const f = fakeSalesforce()
    f.respond(
      sfAnswer({ id: JOB_ID, state: 'JobComplete', numberRecordsProcessed: 2, numberRecordsFailed: 1 }),
      csvAnswer(`"sf__Id","sf__Error",Id,Status\n"","INVALID_CROSS_REFERENCE_KEY:invalid cross reference id:--","${LEAD_ID}",Open\n`),
    )
    const out = await JOB.run(f.ctx, { job_id: JOB_ID, failed_results: true })
    expect(f.sent.map((s) => [s.method, s.url])).toEqual([['GET', `${DATA}/jobs/ingest/${JOB_ID}`], ['GET', `${DATA}/jobs/ingest/${JOB_ID}/failedResults`]])
    expect(f.sent[1].headers.get('accept')).toBe('text/csv')
    expect(out).toEqual({
      job: { id: JOB_ID, state: 'JobComplete', numberRecordsProcessed: 2, numberRecordsFailed: 1 },
      failed_results: [{ sf__Id: '', sf__Error: 'INVALID_CROSS_REFERENCE_KEY:invalid cross reference id:--', Id: LEAD_ID, Status: 'Open' }],
    })
  })

  it('reads the successful records too when asked, sf__Created and all', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: JOB_ID, state: 'JobComplete' }), csvAnswer(`sf__Id,sf__Created,Id\n${LEAD_ID},false,${LEAD_ID}\n`))
    const out = (await JOB.run(f.ctx, { job_id: JOB_ID, successful_results: true })) as Record<string, unknown>
    expect(out.successful_results).toEqual([{ sf__Id: LEAD_ID, sf__Created: 'false', Id: LEAD_ID }])
  })

  it('fails by name at its row cap rather than return part of the results', async () => {
    const rows = Array.from({ length: SALESFORCE_RESULTS_MAX_ROWS + 1 }, (_, i) => `id${i},x`).join('\n')
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: JOB_ID, state: 'JobComplete' }), csvAnswer(`sf__Id,sf__Error\n${rows}\n`))
    const failed = await failure(JOB.run(f.ctx, { job_id: JOB_ID, failed_results: true }))
    expect([failed.code, failed.outcome]).toEqual(['salesforce_results_over_cap', 'not_applied'])
  })

  it('results it cannot read as CSV are unreadable', async () => {
    const f = fakeSalesforce()
    f.respond(sfAnswer({ id: JOB_ID, state: 'JobComplete' }), csvAnswer('sf__Id,"open\n'))
    expect((await failure(JOB.run(f.ctx, { job_id: JOB_ID, failed_results: true }))).code).toBe('salesforce_answer_unreadable')
  })

  it('a job id that is not one is refused before anything is sent', async () => {
    const f = fakeSalesforce()
    const failed = await failure(JOB.run(f.ctx, { job_id: '750/../../sobjects' }))
    expect([failed.code, f.sent]).toEqual(['salesforce_argument_invalid', []])
  })
})

describe('arguments a step cannot send', () => {
  it('are refused before anything is sent', async () => {
    const cases: Array<[RuntimeAction, ActionArgs]> = [
      [SEARCH, {}],
      [SEARCH, { query: '  ' }],
      [CREATE, { object: 'Lead; DROP', fields: {} }],
      [CREATE, { object: 'Lead', fields: 'Name=x' }],
      [CREATE, { object: 'Lead', fields: ['x'] }],
      [UPDATE, { object: 'Lead', record_id: LEAD_ID }],
      [UPSERT, { object: 'Lead', external_id_field: 'a/b', external_id: 'x', fields: {} }],
      [UPSERT, { object: 'Lead', external_id_field: 'Ext__c', external_id: '', fields: {} }],
    ]
    for (const [a, args] of cases) {
      const f = fakeSalesforce()
      const failed = await failure(a.run(f.ctx, args))
      expect([failed.code, failed.outcome, f.sent.length], `${a.key} ${JSON.stringify(args)}`).toEqual(['salesforce_argument_invalid', 'not_applied', 0])
    }
  })
})
