import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound, isNotFoundError } from '../api-error'

const app = new Hono()
app.get('/boom', (c) =>
  dbError(c, { message: 'relation "secret_table" does not exist', code: '42P01', details: 'd', hint: 'h' })
)

afterEach(() => vi.restoreAllMocks())

describe('dbError', () => {
  it('returns a generic 500 body, never echoing the raw error message', async () => {
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body).toEqual({ error: 'Internal error' })
    expect(JSON.stringify(body)).not.toContain('secret_table')
  })

  it('logs the real error server-side with request method and path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await app.request('/boom')
    expect(spy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(spy.mock.calls[0][0] as string)
    expect(logged).toMatchObject({
      event: 'api_error',
      method: 'GET',
      path: '/boom',
      message: 'relation "secret_table" does not exist',
      code: '42P01',
    })
  })

  it('falls back to String(err) when the error has no message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const local = new Hono()
    local.get('/x', (c) => dbError(c, 'plain string failure'))
    const res = await local.request('/x')
    expect(res.status).toBe(500)
    const logged = JSON.parse(spy.mock.calls[0][0] as string)
    expect(logged.message).toBe('plain string failure')
  })
})

describe('isNotFoundError', () => {
  it('is true only for the PostgREST zero-rows code (PGRST116)', () => {
    expect(isNotFoundError({ code: 'PGRST116' })).toBe(true)
  })

  it('is false for a real database error', () => {
    expect(isNotFoundError({ code: '42P01', message: 'relation does not exist' })).toBe(false)
  })

  it('is false for null/undefined and for errors without a code', () => {
    expect(isNotFoundError(null)).toBe(false)
    expect(isNotFoundError(undefined)).toBe(false)
    expect(isNotFoundError({ message: 'boom' })).toBe(false)
  })
})

describe('dbErrorUnlessNotFound', () => {
  // A `.single()` lookup returns PGRST116 (data: null) for genuine zero-rows.
  // Any OTHER error is a real DB failure and must become a 500, never a false
  // 404 — a 404 makes a lead source stop retrying and drops the lead (#303).
  const app = new Hono()
  app.get('/lookup', (c) => {
    const err = JSON.parse(c.req.query('err') ?? 'null') as { code?: string } | null
    const blocked = dbErrorUnlessNotFound(c, err)
    if (blocked) return blocked
    return c.json({ error: 'Not found' }, 404)
  })

  it('returns null for no error so the caller can fall through to its own 404', async () => {
    const res = await app.request('/lookup?err=null')
    expect(res.status).toBe(404)
  })

  it('returns null for PGRST116 (genuine not-found) so the caller returns 404', async () => {
    const res = await app.request('/lookup?err=' + encodeURIComponent('{"code":"PGRST116"}'))
    expect(res.status).toBe(404)
  })

  it('returns a generic 500 for a real DB error instead of a false 404', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request('/lookup?err=' + encodeURIComponent('{"code":"42P01"}'))
    expect(res.status).toBe(500)
    expect((await res.json()) as { error: string }).toEqual({ error: 'Internal error' })
  })
})
