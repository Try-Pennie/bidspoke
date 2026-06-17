/**
 * Global onError handler (#107): return a generic 500 message, never echoing
 * the raw err.message (which can leak internal/DB details) to callers.
 */
import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { genericOnError } from '../index'

describe('genericOnError (#107)', () => {
  it('returns a generic 500 and never echoes the raw error message', async () => {
    const app = new Hono()
    app.onError(genericOnError)
    app.get('/boom', () => { throw new Error('secret: pg connection string at db-host:5432') })

    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Internal server error')
    expect(body.error).not.toContain('pg connection')
    expect(body.error).not.toContain('db-host')
  })
})
