import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { controlWordFromQuery } from '../control-word'

/**
 * The one way code a sender reaches may read its query string (#1815): it
 * answers only with a word from the list the caller names, never with the
 * sender's own text.
 */
async function wordFor(address: string, words: readonly string[]) {
  const app = new Hono()
  let seen: string | undefined = 'unset'
  app.post('/x', (c) => {
    seen = controlWordFromQuery(c.req, 'mode', words)
    return c.body(null, 204)
  })
  await app.request(address, { method: 'POST' })
  return seen
}

describe('controlWordFromQuery (#1815)', () => {
  it('answers with the listed word the address names', async () => {
    expect(await wordFor('/x?mode=stand_in', ['stand_in', 'dry_run'])).toBe('stand_in')
  })

  it('answers undefined for any word not on the list, so no sender text comes back', async () => {
    expect(await wordFor('/x?mode=someone%40example.com', ['stand_in'])).toBeUndefined()
    expect(await wordFor('/x?mode=STAND_IN', ['stand_in'])).toBeUndefined()
  })

  it('answers undefined when the address names no word', async () => {
    expect(await wordFor('/x', ['stand_in'])).toBeUndefined()
    expect(await wordFor('/x?mode=', ['stand_in'])).toBeUndefined()
  })
})
