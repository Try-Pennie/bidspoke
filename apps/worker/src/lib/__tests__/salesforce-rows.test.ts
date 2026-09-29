/**
 * `salesforceRows`: every page of a SOQL query through `nextRecordsUrl`, and a
 * refusal rather than part of the answer when the query outgrows its bound or
 * Salesforce says there is more without saying where (L211, L98).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

vi.mock('../salesforce-creds', () => ({
  resolveSalesforceCredentialOrg: vi.fn(async () => ({ orgId: 'org-1' })),
  requireSalesforceCreds: vi.fn(async () => ({ instanceUrl: 'https://sf.test', clientId: 'id', clientSecret: 'secret' })),
}))
vi.mock('../../engine/nodes/salesforce', () => ({ getSalesforceToken: vi.fn(async () => 'token') }))

import { salesforceRows } from '../salesforce-read'

const env = {} as Env
const supabase = {} as SupabaseClient
const NEXT = '/services/data/v60.0/query/01gXX-2000'

/** Answers each fetch with the next body in turn, recording the URLs asked for. */
function pages(...bodies: unknown[]) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    const body = bodies.shift()
    if (body instanceof Response) return body
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return urls
}

afterEach(() => { vi.unstubAllGlobals() })

describe('salesforceRows', () => {
  it('follows nextRecordsUrl until Salesforce says it is done, and returns every page', async () => {
    const urls = pages(
      { records: [{ Id: 'a' }, { Id: 'b' }], done: false, nextRecordsUrl: NEXT },
      { records: [{ Id: 'c' }], done: true },
    )

    const rows = await salesforceRows(env, supabase, 'SELECT Id FROM Submission__c', 'a test', 10)

    expect(rows.map((r) => r.Id)).toEqual(['a', 'b', 'c'])
    expect(urls).toEqual([
      `https://sf.test/services/data/v60.0/query?q=${encodeURIComponent('SELECT Id FROM Submission__c')}`,
      `https://sf.test${NEXT}`,
    ])
  })

  it('refuses past its bound rather than returning part of the answer', async () => {
    pages({ records: [{ Id: 'a' }, { Id: 'b' }], done: false, nextRecordsUrl: NEXT }, { records: [{ Id: 'c' }], done: true })

    await expect(salesforceRows(env, supabase, 'SELECT Id FROM Submission__c', 'a test', 2)).rejects.toThrow(/more than 2 records/)
  })

  it('refuses when Salesforce says it is not done but gives no next page', async () => {
    pages({ records: [{ Id: 'a' }], done: false })

    await expect(salesforceRows(env, supabase, 'SELECT Id FROM Submission__c', 'a test', 10)).rejects.toThrow(/no next page/)
  })

  it('refuses an answer with no records array, never reading it as empty', async () => {
    pages({ totalSize: 3, done: true })

    await expect(salesforceRows(env, supabase, 'SELECT Id FROM Submission__c', 'a test', 10)).rejects.toThrow(/no records array/)
  })

  it('refuses by status when a page fails', async () => {
    pages({ records: [{ Id: 'a' }], done: false, nextRecordsUrl: NEXT }, new Response('INVALID_SESSION_ID', { status: 401 }))

    await expect(salesforceRows(env, supabase, 'SELECT Id FROM Submission__c', 'a test', 10)).rejects.toThrow(/401.*INVALID_SESSION_ID/)
  })
})
