import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { dbError } from '../api-error'

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
