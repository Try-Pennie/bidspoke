/**
 * One Salesforce record update outside the engine (#1659): the credentials of
 * the organization acting, the cached token, a PATCH, and the local dev guard
 * that keeps a wrangler dev session from writing to the one production org.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'
import { salesforceUpdate, SalesforceUpdateError } from '../salesforce-write'

const CREDS = { instanceUrl: 'https://pennie.my.salesforce.com', clientId: 'cid', clientSecret: 'sec' }
const supabase = {} as SupabaseClient

function deps(res: Response | Error) {
  const fetch = vi.fn(async () => {
    if (res instanceof Error) throw res
    return res
  })
  return {
    fetch,
    creds: vi.fn(async () => CREDS),
    token: vi.fn(async () => 'tok'),
  }
}

describe('salesforceUpdate', () => {
  it('PATCHes the record under the versioned data API with the token, and a 204 is success', async () => {
    const d = deps(new Response(null, { status: 204 }))
    await salesforceUpdate({} as Env, supabase, 'org-1', 'Submission__c', 'a0C000000000001AAA', { A: 1 }, 'held click mark sent', d)
    expect(d.creds).toHaveBeenCalledWith(expect.anything(), supabase, 'org-1', 'held click mark sent')
    expect(d.fetch).toHaveBeenCalledWith(
      'https://pennie.my.salesforce.com/services/data/v60.0/sobjects/Submission__c/a0C000000000001AAA',
      expect.objectContaining({ method: 'PATCH', body: '{"A":1}', headers: expect.objectContaining({ Authorization: 'Bearer tok', 'Content-Type': 'application/json' }) }),
    )
  })

  it('a refusal throws with the status and Salesforce\'s own error, never read as success (L520)', async () => {
    const d = deps(new Response(JSON.stringify([{ errorCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }]), { status: 404 }))
    const err = await salesforceUpdate({} as Env, supabase, 'org-1', 'Lead', '00Q000000000001AAA', {}, 'p', d).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SalesforceUpdateError)
    expect((err as Error).message).toBe('Salesforce refused the Lead update (404): ENTITY_IS_DELETED: entity is deleted')
    expect((err as SalesforceUpdateError).status).toBe(404)
  })

  it('a refusal that is not Salesforce\'s error list is passed on as it came, bounded', async () => {
    const d = deps(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    await expect(salesforceUpdate({} as Env, supabase, 'org-1', 'Lead', '00Q000000000001AAA', {}, 'p', d)).rejects.toThrow('Salesforce refused the Lead update (502): <html>502 Bad Gateway</html>')
  })

  it('a 401 clears the cached token and tries once more with a fresh one, as the engine step does', async () => {
    const answers = [new Response('[{"errorCode":"INVALID_SESSION_ID","message":"Session expired or invalid"}]', { status: 401 }), new Response(null, { status: 204 })]
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => answers.shift() as Response)
    const token = vi.fn().mockResolvedValueOnce('stale').mockResolvedValueOnce('fresh')
    const evictToken = vi.fn(async () => undefined)
    await salesforceUpdate({} as Env, supabase, 'org-1', 'Lead', '00Q000000000001AAA', {}, 'p', { fetch, creds: vi.fn(async () => CREDS), token, evictToken })
    expect(evictToken).toHaveBeenCalledWith(expect.anything(), 'org-1')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][1]).toEqual(expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fresh' }) }))
  })

  it('a second 401 after a fresh token is a refusal, not a loop', async () => {
    const fetch = vi.fn(async () => new Response('[{"errorCode":"INVALID_SESSION_ID","message":"Session expired or invalid"}]', { status: 401 }))
    const evictToken = vi.fn(async () => undefined)
    const err = await salesforceUpdate({} as Env, supabase, 'org-1', 'Lead', '00Q000000000001AAA', {}, 'p', { fetch, creds: vi.fn(async () => CREDS), token: vi.fn(async () => 'tok'), evictToken }).catch((e: unknown) => e)
    expect((err as SalesforceUpdateError).status).toBe(401)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(evictToken).toHaveBeenCalledTimes(2)
  })

  it('a network failure throws by name', async () => {
    const d = deps(new TypeError('fetch failed'))
    await expect(salesforceUpdate({} as Env, supabase, 'org-1', 'Lead', '00Q000000000001AAA', {}, 'p', d)).rejects.toThrow(/fetch failed/)
  })

  it('refuses an id that is not a Salesforce id before any call, since it goes into the URL', async () => {
    const d = deps(new Response(null, { status: 204 }))
    await expect(salesforceUpdate({} as Env, supabase, 'org-1', 'Lead', '../query?q=x', {}, 'p', d)).rejects.toThrow(/not a Salesforce id/)
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('local dev is refused unless ALLOW_PROD_WRITES is set: Salesforce has no local copy', async () => {
    const d = deps(new Response(null, { status: 204 }))
    await expect(salesforceUpdate({ LOCAL_DEV: 'true' } as Env, supabase, 'org-1', 'Lead', '00Q000000000001AAA', {}, 'p', d)).rejects.toThrow(/ALLOW_PROD_WRITES/)
    expect(d.fetch).not.toHaveBeenCalled()
    expect(d.token).not.toHaveBeenCalled()

    await salesforceUpdate({ LOCAL_DEV: 'true', ALLOW_PROD_WRITES: 'true' } as Env, supabase, 'org-1', 'Lead', '00Q000000000001AAA', {}, 'p', d)
    expect(d.fetch).toHaveBeenCalledTimes(1)
  })
})
