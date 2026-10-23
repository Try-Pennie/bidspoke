import { describe, expect, it } from 'vitest'
import { catalogueActions, CATALOGUE } from '../../../schema'
import { resolveRuntimeAction } from '../..'
import { ActionFailure } from '../../failure'
import type { ActionArgs, RuntimeAction } from '../../types'
import { fakeSupabase, pgError, REST, rows } from './fake-supabase'

/**
 * The Supabase actions the Pipedream workflows use (#2337; counted in the
 * export of 2026-09-30, the duplicate project folder left out, steps inside
 * if/else branches counted): supabase-insert-row 21 steps, supabase-select-row
 * 5, supabase-update-row 2, in 21 workflows, every one against one project
 * (blicjwldjfjubbukxatn, not the bidding project). Each is one PostgREST
 * request, as Pipedream's supabase-js call was.
 *
 * Fixtures every service PR carries: a refused key, a 429 with Retry-After, a
 * timeout after send, and the page cap on a read.
 */

function action(key: string): RuntimeAction {
  const resolved = resolveRuntimeAction(key, 1)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.action
}

const INSERT = action('supabase.insert-row')
const SELECT = action('supabase.select-row')
const UPDATE = action('supabase.update-row')

/** The arguments without one, as a step that left it blank sends them. */
const without = (args: ActionArgs, key: string): ActionArgs => Object.fromEntries(Object.entries(args).filter(([k]) => k !== key))

async function failure(promise: Promise<unknown>): Promise<ActionFailure> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(ActionFailure)
    return err as ActionFailure
  }
  throw new Error('expected an ActionFailure')
}

describe('the Supabase actions decide their own traits', () => {
  it('are insert, select and update row, and nothing else', () => {
    expect(catalogueActions(CATALOGUE).map((a) => `${a.key}@${a.version}`).filter((id) => id.startsWith('supabase.')))
      .toEqual(['supabase.insert-row@1', 'supabase.select-row@1', 'supabase.update-row@1'])
  })

  it('insert writes a row again on a repeat, so it is never repeated after an uncertain outcome', () => {
    expect([INSERT.sideEffect, INSERT.idempotent]).toEqual([true, false])
    expect(INSERT.idempotentBecause).toMatch(/second row/)
  })

  it('select reads and changes nothing, so it is retried', () => {
    expect([SELECT.sideEffect, SELECT.idempotent]).toEqual([false, true])
  })

  it('update fires the table\'s triggers on every run, so it is never repeated after an uncertain outcome', () => {
    expect([UPDATE.sideEffect, UPDATE.idempotent]).toEqual([true, false])
    expect(UPDATE.idempotentBecause).toMatch(/trigger/)
  })

  it('take what Pipedream offered, by these names', () => {
    const shape = (a: RuntimeAction) => Object.fromEntries(a.arguments.map((x) => [x.key, [x.type, x.required, x.allowsVariables, x.parseJson]]))
    expect(shape(INSERT)).toEqual({ table: ['text', true, false, false], data: ['text', true, true, true] })
    expect(shape(SELECT)).toEqual({
      table: ['text', true, false, false],
      column: ['text', false, false, false],
      filter: ['text', false, false, false],
      value: ['text', false, true, false],
      order_by: ['text', true, false, false],
      sort_order: ['text', false, false, false],
      max: ['text', false, true, true],
    })
    expect(shape(UPDATE)).toEqual({
      table: ['text', true, false, false],
      column: ['text', true, false, false],
      value: ['text', true, true, false],
      data: ['text', true, true, true],
    })
  })
})

describe('supabase.insert-row@1', () => {
  it('posts the row to the table on the declared project, asks for it back, and answers as supabase-js did', async () => {
    const f = fakeSupabase()
    f.respond(rows([{ id: 7, email: 'sam@example.com' }], 201))
    const out = await INSERT.run(f.ctx, { table: 'leads', data: { email: 'sam@example.com' } })
    expect(out).toEqual({ error: null, data: [{ id: 7, email: 'sam@example.com' }], count: null, status: 201, statusText: 'Created' })
    expect(f.sent).toHaveLength(1)
    expect([f.sent[0].method, `${f.sent[0].url.origin}${f.sent[0].url.pathname}`]).toEqual(['POST', `${REST}/leads`])
    expect(f.sent[0].url.searchParams.get('select')).toBe('*')
    expect(f.sent[0].headers.get('prefer')).toBe('return=representation')
    expect(f.sent[0].headers.get('content-type')).toBe('application/json')
    expect(f.sent[0].body).toEqual({ email: 'sam@example.com' })
    // connectionFetch puts the key on the request: the action never holds it.
    expect(f.sent[0].headers.get('apikey')).toBeNull()
    expect(f.sent[0].headers.get('authorization')).toBeNull()
  })

  it('inserts a list of rows in one statement, so they land whole or not at all', async () => {
    const f = fakeSupabase()
    f.respond(pgError(409, '23505', 'duplicate key value for Sam Lee'))
    const failed = await failure(INSERT.run(f.ctx, { table: 'leads', data: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }))
    expect([failed.code, failed.outcome]).toEqual(['supabase_23505', 'not_applied'])
    expect(failed.message).not.toContain('Sam Lee')
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0].body).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }])
  })

  it('a refused key: what the connection bound fetch throws passes through unchanged, and nothing more is sent', async () => {
    const expired = new Error('connection_needs_reauth: request_refused_after_renew')
    const f = fakeSupabase()
    f.respond({ throws: expired })
    await expect(INSERT.run(f.ctx, { table: 'leads', data: { a: 1 } })).rejects.toBe(expired)
    expect(f.sent).toHaveLength(1)
  })

  it('a 429 with Retry-After: the requeue passes through unchanged, and nothing waits in the request', async () => {
    const requeue = { kind: 'requeue_at', notBefore: new Date('2026-10-23T15:00:20Z') }
    const f = fakeSupabase()
    f.respond({ throws: requeue })
    await expect(INSERT.run(f.ctx, { table: 'leads', data: { a: 1 } })).rejects.toBe(requeue)
    expect(f.sent).toHaveLength(1)
  })

  it('a timeout after send passes through unchanged, for the executor to record as outcome unknown and never retry', async () => {
    const timeout = new DOMException('The operation timed out.', 'TimeoutError')
    const f = fakeSupabase()
    f.respond({ throws: timeout })
    await expect(INSERT.run(f.ctx, { table: 'leads', data: { a: 1 } })).rejects.toBe(timeout)
    expect(f.sent).toHaveLength(1)
    expect(INSERT.idempotent).toBe(false)
  })

  it('a server error may have written, so its outcome is unknown; a 2xx it cannot read wrote, so it is applied', async () => {
    const f = fakeSupabase()
    f.respond(pgError(500, 'XX000'))
    const failed = await failure(INSERT.run(f.ctx, { table: 'leads', data: { a: 1 } }))
    expect([failed.code, failed.outcome]).toEqual(['supabase_XX000', 'unknown'])
    const g = fakeSupabase()
    g.respond(new Response('<html>edge</html>', { status: 201 }))
    const unread = await failure(INSERT.run(g.ctx, { table: 'leads', data: { a: 1 } }))
    expect([unread.code, unread.outcome]).toEqual(['supabase_answer_unreadable', 'applied'])
  })

  it('refuses a step it cannot send before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [{ data: { a: 1 } }, 'supabase_table_missing'],
      [{ table: 'leads; drop table x', data: { a: 1 } }, 'supabase_argument_invalid'],
      [{ table: 'leads' }, 'supabase_data_missing'],
      [{ table: 'leads', data: 'a=1' }, 'supabase_argument_invalid'],
      [{ table: 'leads', data: [] }, 'supabase_argument_invalid'],
      [{ table: 'leads', data: [{ a: 1 }, 2] }, 'supabase_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeSupabase()
      const refused = await failure(INSERT.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })

  it('refuses a connection whose target names no project, before anything is sent', async () => {
    for (const target of [{}, { project_url: 'https://api.example.com' }, null]) {
      const f = fakeSupabase(target)
      const refused = await failure(INSERT.run(f.ctx, { table: 'leads', data: { a: 1 } }))
      expect([refused.code, refused.outcome]).toEqual(['supabase_target_invalid', 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})

describe('supabase.select-row@1', () => {
  const ARGS: ActionArgs = { table: 'leads', column: 'status', filter: 'equalTo', value: 'open', order_by: 'created_at', sort_order: 'ascending', max: 20 }

  it('reads with the filter, order and limit Pipedream built, counting the matches, and answers as supabase-js did', async () => {
    const f = fakeSupabase()
    f.respond(rows([{ id: 1 }, { id: 2 }], 200, { 'content-range': '0-1/2' }))
    expect(await SELECT.run(f.ctx, ARGS)).toEqual({ error: null, data: [{ id: 1 }, { id: 2 }], count: 2, status: 200, statusText: 'OK' })
    const url = f.sent[0].url
    expect([f.sent[0].method, `${url.origin}${url.pathname}`]).toEqual(['GET', `${REST}/leads`])
    expect(Object.fromEntries(url.searchParams)).toEqual({ select: '*', status: 'eq.open', order: 'created_at.asc', limit: '20' })
    expect(f.sent[0].headers.get('prefer')).toBe('count=exact')
  })

  it.each([
    ['notEqualTo', 'neq.open'], ['greaterThan', 'gt.open'], ['greaterThanOrEqualTo', 'gte.open'], ['lessThan', 'lt.open'],
    ['lessThanOrEqualTo', 'lte.open'], ['patternMatch', 'like.*open*'], ['patternMatchCaseInsensitive', 'ilike.*open*'],
  ])('maps the %s filter as Pipedream did', async (filter, expected) => {
    const f = fakeSupabase()
    f.respond(rows([], 200, { 'content-range': '*/0' }))
    await SELECT.run(f.ctx, { ...ARGS, filter })
    expect(f.sent[0].url.searchParams.get('status')).toBe(expected)
  })

  it('reads with no filter, descending when no sort order is given, and 20 rows when no max is given, as Pipedream did', async () => {
    const f = fakeSupabase()
    f.respond(rows([], 200, { 'content-range': '*/0' }))
    await SELECT.run(f.ctx, { table: 'leads', order_by: 'id' })
    expect(Object.fromEntries(f.sent[0].url.searchParams)).toEqual({ select: '*', order: 'id.desc', limit: '20' })
  })

  it('returns max rows when more match, as Pipedream did, and says how many matched', async () => {
    const f = fakeSupabase()
    f.respond(rows([{ id: 1 }, { id: 2 }], 200, { 'content-range': '0-1/40' }))
    expect(await SELECT.run(f.ctx, { ...ARGS, max: 2 })).toMatchObject({ data: [{ id: 1 }, { id: 2 }], count: 40 })
  })

  it('fails by name, never answering a short list, when the project\'s own row cap cut the read below max', async () => {
    const f = fakeSupabase()
    f.respond(rows([{ id: 1 }, { id: 2 }], 200, { 'content-range': '0-1/40' }))
    const capped = await failure(SELECT.run(f.ctx, { ...ARGS, max: 20 }))
    expect([capped.code, capped.outcome]).toEqual(['supabase_rows_capped', 'not_applied'])
  })

  it('fails by name when the answer does not say how many matched, so a cut cannot be told from a whole read', async () => {
    const f = fakeSupabase()
    f.respond(rows([{ id: 1 }], 200))
    const unread = await failure(SELECT.run(f.ctx, ARGS))
    expect([unread.code, unread.outcome]).toEqual(['supabase_count_unreadable', 'not_applied'])
  })

  it('a server error on a read changed nothing, so it is not applied', async () => {
    const f = fakeSupabase()
    f.respond(pgError(503, 'PGRST000'))
    const failed = await failure(SELECT.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['supabase_PGRST000', 'not_applied'])
  })

  it('refuses a step it cannot send before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [without(ARGS, 'table'), 'supabase_table_missing'],
      [without(ARGS, 'order_by'), 'supabase_order_by_missing'],
      [without(ARGS, 'value'), 'supabase_argument_invalid'],
      [{ ...ARGS, filter: 'contains' }, 'supabase_argument_invalid'],
      [{ ...ARGS, column: 'status)' }, 'supabase_argument_invalid'],
      [{ ...ARGS, sort_order: 'up' }, 'supabase_argument_invalid'],
      [{ ...ARGS, max: 0 }, 'supabase_argument_invalid'],
      [{ ...ARGS, max: 1001 }, 'supabase_argument_invalid'],
      [{ ...ARGS, max: 2.5 }, 'supabase_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeSupabase()
      const refused = await failure(SELECT.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})

describe('supabase.update-row@1', () => {
  const ARGS: ActionArgs = { table: 'leads', column: 'email', value: 'sam@example.com', data: { status: 'won' } }

  it('patches the rows whose column equals the value, asks for them back, and answers as supabase-js did', async () => {
    const f = fakeSupabase()
    f.respond(rows([{ id: 7, status: 'won' }]))
    expect(await UPDATE.run(f.ctx, ARGS)).toEqual({ error: null, data: [{ id: 7, status: 'won' }], count: null, status: 200, statusText: 'OK' })
    const url = f.sent[0].url
    expect([f.sent[0].method, `${url.origin}${url.pathname}`]).toEqual(['PATCH', `${REST}/leads`])
    expect(Object.fromEntries(url.searchParams)).toEqual({ select: '*', email: 'eq.sam@example.com' })
    expect(f.sent[0].headers.get('prefer')).toBe('return=representation')
    expect(f.sent[0].body).toEqual({ status: 'won' })
  })

  it('an update that matched no row answers an empty list, as Pipedream did', async () => {
    const f = fakeSupabase()
    f.respond(rows([]))
    expect(await UPDATE.run(f.ctx, ARGS)).toMatchObject({ data: [] })
  })

  it('a server error may have updated, so its outcome is unknown', async () => {
    const f = fakeSupabase()
    f.respond(new Response('bad gateway', { status: 502 }))
    const failed = await failure(UPDATE.run(f.ctx, ARGS))
    expect([failed.code, failed.outcome]).toEqual(['supabase_http_502', 'unknown'])
  })

  it('refuses a step it cannot send, never an update of every row, before anything is sent', async () => {
    const cases: Array<[ActionArgs, string]> = [
      [without(ARGS, 'column'), 'supabase_column_missing'],
      [without(ARGS, 'value'), 'supabase_value_missing'],
      [without(ARGS, 'data'), 'supabase_data_missing'],
      [{ ...ARGS, data: [{ status: 'won' }] }, 'supabase_argument_invalid'],
      [{ ...ARGS, data: {} }, 'supabase_argument_invalid'],
    ]
    for (const [args, code] of cases) {
      const f = fakeSupabase()
      const refused = await failure(UPDATE.run(f.ctx, args))
      expect([refused.code, refused.outcome], JSON.stringify(args)).toEqual([code, 'not_applied'])
      expect(f.sent).toEqual([])
    }
  })
})
