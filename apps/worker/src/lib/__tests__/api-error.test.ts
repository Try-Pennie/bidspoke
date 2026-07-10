import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { dbError, dbErrorUnlessNotFound, isNotFoundError, requireRowOr404, rowsTouched } from '../api-error'

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

  it('falls back to formatErr(err) when the error is a plain string', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const local = new Hono()
    local.get('/x', (c) => dbError(c, 'plain string failure'))
    const res = await local.request('/x')
    expect(res.status).toBe(500)
    const logged = JSON.parse(spy.mock.calls[0][0] as string)
    expect(logged.message).toBe('plain string failure')
  })

  // #606: a plain-object error with no `message` field used to log "[object
  // Object]" (the old String(err) fallback); formatErr renders its content so the
  // cause survives the log.
  it('renders a message-less object error as its content, not [object Object]', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const local = new Hono()
    local.get('/x', (c) => dbError(c, { code: 'CUSTOM', details: 'boom detail' }))
    await local.request('/x')
    const logged = JSON.parse(spy.mock.calls[0][0] as string)
    expect(logged.message).not.toContain('[object Object]')
    expect(logged.message).toContain('boom detail')
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

describe('requireRowOr404', () => {
  // PostgREST answers an UPDATE/DELETE that matched nothing with
  // `{ data: [], error: null }`, so a route that only checks `error` tells the
  // dashboard an edit landed when nothing changed (#588). The write must end in
  // `.select(...)` for the rowcount to be visible at all.
  const routeFor = (result: { data: unknown[] | null; error: { code?: string; message: string } | null }) => {
    const local = new Hono()
    local.patch('/thing/:id', async (c) => {
      const blocked = await requireRowOr404(c, 'Thing not found', async () => result)
      if (blocked) return blocked
      return c.json({ ok: true })
    })
    return local
  }

  it('returns null when the write touched a row, so the caller proceeds', async () => {
    const res = await routeFor({ data: [{ id: 'a' }], error: null }).request('/thing/a', { method: 'PATCH' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('returns 404 with the caller message when the write matched zero rows', async () => {
    const res = await routeFor({ data: [], error: null }).request('/thing/a', { method: 'PATCH' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Thing not found' })
  })

  it('treats a null data payload as zero rows, not as success', async () => {
    const res = await routeFor({ data: null, error: null }).request('/thing/a', { method: 'PATCH' })
    expect(res.status).toBe(404)
  })

  // The failure path that matters: a transient DB error must never be reported
  // as a 404. Conflating the two is the #303 bug (a caller reads 404 as "gone"
  // and stops retrying) pointed at the write side.
  it('returns a generic 500 for a real DB error, never a 404', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await routeFor({ data: null, error: { code: '42P01', message: 'relation missing' } }).request(
      '/thing/a',
      { method: 'PATCH' }
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body).toEqual({ error: 'Internal error' })
    expect(body.error).not.toBe('Thing not found')
  })

  it('logs a real DB error server-side but stays quiet on a plain zero-row miss', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await routeFor({ data: [], error: null }).request('/thing/a', { method: 'PATCH' })
    expect(spy).not.toHaveBeenCalled()

    await routeFor({ data: null, error: { code: '42P01', message: 'relation missing' } }).request('/thing/a', {
      method: 'PATCH',
    })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({ event: 'api_error', code: '42P01' })
  })
})

// The write-side twin of requireRowOr404 for endpoints where a zero-row match is
// EXPECTED, not an error: clearing a setting that was never set, disconnecting a
// Slack that was never connected. Those stay 200, but must not record an audit
// row for an action that did not happen (#588, consolidated in #590).
describe('rowsTouched', () => {
  const routeFor = (result: { data: unknown[] | null; error: { code?: string; message: string } | null }) => {
    const audited: string[] = []
    const local = new Hono()
    local.delete('/thing', async (c) => {
      const { rows, blocked } = await rowsTouched(c, 'thing.clear', async () => result)
      if (blocked) return blocked
      if (rows.length > 0) audited.push('cleared')
      return c.json({ cleared: rows.length })
    })
    return { local, audited }
  }

  it('reports the rows a landed write touched', async () => {
    const { local, audited } = routeFor({ data: [{ id: 'a' }], error: null })
    const res = await local.request('/thing', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cleared: 1 })
    expect(audited).toEqual(['cleared'])
  })

  it('stays 200 with zero rows and does not invent an error, so the side effect is skipped', async () => {
    const { local, audited } = routeFor({ data: [], error: null })
    const res = await local.request('/thing', { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cleared: 0 })
    expect(audited).toEqual([])
  })

  // A missing row is normal here. A broken database is not.
  it('blocks with a generic 500 on a real database error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { local, audited } = routeFor({ data: null, error: { code: '42P01', message: 'relation missing' } })
    const res = await local.request('/thing', { method: 'DELETE' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal error' })
    expect(audited).toEqual([])
  })

  it('says nothing on a zero-row miss, and logs once on a real error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await routeFor({ data: [], error: null }).local.request('/thing', { method: 'DELETE' })
    expect(spy).not.toHaveBeenCalled()
    await routeFor({ data: null, error: { code: '42P01', message: 'x' } }).local.request('/thing', { method: 'DELETE' })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
