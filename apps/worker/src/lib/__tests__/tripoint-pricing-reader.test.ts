/**
 * The real Salesforce reader behind the Tripoint pricing check (#1166): the
 * Tooling API call, with credentials and token resolution replaced by the seams
 * they already are, and the network by a recorded fetch.
 *
 * What this pins is the request the check actually makes, because a wrong URL
 * or a wrong field name fails in one of two silent ways: an empty result set,
 * which must throw rather than read as "no formula", or the data API instead of
 * Tooling, which cannot return a formula at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../salesforce-creds', () => ({
  resolveSalesforceCredentialOrg: vi.fn().mockResolvedValue({ orgId: 'org-1', error: null }),
  requireSalesforceCreds: vi.fn().mockResolvedValue({
    instanceUrl: 'https://example.my.salesforce.com',
    clientId: 'cid',
    clientSecret: 'secret',
  }),
}))
vi.mock('../../engine/nodes/salesforce', () => ({
  getSalesforceToken: vi.fn().mockResolvedValue('tok-123'),
}))

import { salesforceFormulaReader, LEAD_REVENUE_FIELD } from '../tripoint-pricing-check'
import type { Env } from '../../index'
import type { SupabaseClient } from '@supabase/supabase-js'

const env = {} as unknown as Env
const supabase = {} as unknown as SupabaseClient

function fetchAnswering(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fake = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init?.headers ?? {} })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  })
  vi.stubGlobal('fetch', fake)
  return calls
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('salesforceFormulaReader', () => {
  it('asks the Tooling API for the Lead field by developer name, with the token', async () => {
    const calls = fetchAnswering(200, { records: [{ Metadata: { formula: 'IF(1, 2, 3)' } }] })

    const formula = await salesforceFormulaReader(env, supabase)()

    expect(formula).toBe('IF(1, 2, 3)')
    expect(calls).toHaveLength(1)
    const url = new URL(calls[0].url)
    expect(url.origin).toBe('https://example.my.salesforce.com')
    expect(url.pathname).toMatch(/\/services\/data\/v\d+\.\d+\/tooling\/query$/)
    const soql = url.searchParams.get('q') ?? ''
    expect(soql).toContain(`TableEnumOrId='${LEAD_REVENUE_FIELD.object}'`)
    expect(soql).toContain(`DeveloperName='${LEAD_REVENUE_FIELD.developerName}'`)
    expect(calls[0].headers.Authorization).toBe('Bearer tok-123')
  })

  it('throws with the status and body on a non-2xx answer, so a 403 reads as unreadable rather than as agreement', async () => {
    fetchAnswering(403, '[{"errorCode":"INSUFFICIENT_ACCESS"}]')

    await expect(salesforceFormulaReader(env, supabase)()).rejects.toThrow(/403.*INSUFFICIENT_ACCESS/)
  })

  it('throws when the query matched no field, rather than returning an empty formula', async () => {
    // A misspelt developer name returns zero records with a 200, which is the
    // silent shape (L100): the check would compare against nothing.
    fetchAnswering(200, { records: [] })

    await expect(salesforceFormulaReader(env, supabase)()).rejects.toThrow(/0 record\(s\).*no formula text/)
  })

  it('throws when the record carries no formula text', async () => {
    fetchAnswering(200, { records: [{ Metadata: { type: 'Currency' } }] })

    await expect(salesforceFormulaReader(env, supabase)()).rejects.toThrow(/no formula text/)
  })
})
