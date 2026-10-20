/**
 * Finding F120 for the schema lookups (#2335, PR 7 of phase 5): a lookup's
 * error never carries the auth it was given or anything a provider said.
 *
 * Workers Logs and the tail trace record an uncaught exception's name and
 * message, and the lookup route hands the message to the browser, so the
 * message is built from names alone and the error carries no cause. Every
 * failure below has the token in it somewhere: echoed in the response body, in
 * a thrown error's message, cause and stack, in a URL. None of it may reach the
 * SchemaLookupError.
 */
import { describe, it, expect } from 'vitest'
import { describeSalesforceObject, type SalesforceSource } from '../salesforce'
import { listSupabaseTables } from '../supabase-schema'
import { listSnowflakeTables } from '../snowflake'
import { SchemaLookupError } from '../errors'
import type { SchemaFetch } from '../types'
import { fetchSequence, json, text, type Answer } from './_fetch'

const TOKEN = 'canary-token-7f3a9c'

function everythingIn(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const own = Object.getOwnPropertyNames(err).map((k) => {
    const value: unknown = Reflect.get(err, k)
    return `${k}=${typeof value === 'string' ? value : JSON.stringify(value) ?? ''}`
  })
  return [err.name, err.message, err.stack ?? '', ...own].join('\n')
}

async function failureOf(run: () => Promise<unknown>): Promise<SchemaLookupError> {
  try {
    await run()
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaLookupError)
    if (err instanceof SchemaLookupError) return err
  }
  throw new Error('expected the lookup to fail')
}

const ANSWERS: Array<[string, Answer]> = [
  ['a 401 echoing the token', () => json(401, [{ errorCode: 'INVALID_SESSION_ID', message: `Session ${TOKEN} expired` }])],
  ['a 403 echoing the token', () => text(403, `forbidden for Bearer ${TOKEN}`)],
  ['a 500 echoing the token', () => text(500, `upstream said ${TOKEN}`)],
  ['a body that is not JSON and holds the token', () => text(200, `<html>${TOKEN}</html>`)],
  ['a thrown error naming the token in message and cause', () => new Error(`GET https://x/?access_token=${TOKEN} failed`, { cause: new Error(TOKEN) })],
  ['a timeout naming the token', () => new DOMException(`timed out waiting for ${TOKEN}`, 'TimeoutError')],
]

describe('no lookup error carries the token (F120)', () => {
  for (const [label, answer] of ANSWERS) {
    it(`Salesforce describe: ${label}`, async () => {
      const fetch: SchemaFetch = fetchSequence(answer).fetch
      const source: SalesforceSource = { service: 'salesforce', fetch, auth: { Authorization: `Bearer ${TOKEN}` }, instanceUrl: 'https://t.my.salesforce.com' }
      const err = await failureOf(() => describeSalesforceObject(source, 'Lead'))
      expect(everythingIn(err)).not.toContain(TOKEN)
      expect(err.cause).toBeUndefined()
    })

    it(`Supabase: ${label}`, async () => {
      const fetch: SchemaFetch = fetchSequence(answer).fetch
      const err = await failureOf(() => listSupabaseTables({ service: 'supabase', fetch, auth: { apikey: TOKEN }, url: 'https://x.supabase.co' }))
      expect(everythingIn(err)).not.toContain(TOKEN)
      expect(err.cause).toBeUndefined()
    })

    it(`Snowflake: ${label}`, async () => {
      const fetch: SchemaFetch = fetchSequence(answer).fetch
      const err = await failureOf(() => listSnowflakeTables({ service: 'snowflake', fetch, auth: { Authorization: `Bearer ${TOKEN}` }, account: 'xy1', database: 'DB' }))
      expect(everythingIn(err)).not.toContain(TOKEN)
      expect(err.cause).toBeUndefined()
    })
  }
})
