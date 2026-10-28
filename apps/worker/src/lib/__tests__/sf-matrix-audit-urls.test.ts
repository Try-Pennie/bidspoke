/**
 * The bid matrix audit's Salesforce reads ask for exactly the urls the hand built
 * template asked for before the url moved to the shared salesforce-api module
 * (#2394). The expected value is that old template written out, so a change of
 * one byte (the version, the endpoint, the encoding) fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { querySalesforce } from '../sf-matrix-audit'

afterEach(() => { vi.unstubAllGlobals() })

const SOQL = [
  'SELECT Id, RowId__c FROM BidRangeRow__c ORDER BY RowId__c, RangeLow__c, Id',
  "SELECT Id FROM BidRangeRow__c WHERE IsDeleted = TRUE AND LastModifiedDate > 2027-09-21T18:00:00Z AND Name = 'a&b?c=d #e/f'",
]

function recordUrls(pages: Array<{ records: unknown[]; done: boolean; nextRecordsUrl?: string }>): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 })
  }))
  return urls
}

describe('querySalesforce urls', () => {
  for (const endpoint of ['query', 'queryAll'] as const) {
    for (const soql of SOQL) {
      it(`asks ${endpoint} for ${soql.slice(0, 40)} at the url the hand built template sent`, async () => {
        const instanceUrl = 'https://pennie.my.salesforce.com'
        const urls = recordUrls([{ records: [], done: true }])
        await querySalesforce(instanceUrl, 'tok', soql, endpoint)
        expect(urls).toEqual([`${instanceUrl}/services/data/v60.0/${endpoint}?q=${encodeURIComponent(soql)}`])
      })
    }
  }

  it('reads query when no endpoint is named, and follows the next page as it did', async () => {
    const urls = recordUrls([
      { records: [{ Id: 'a' }], done: false, nextRecordsUrl: '/services/data/v60.0/query/01gXX-2000' },
      { records: [{ Id: 'b' }], done: true },
    ])
    const rows = await querySalesforce<{ Id: string }>('https://x.my.salesforce.com', 'tok', SOQL[0])
    expect(rows.map((r) => r.Id)).toEqual(['a', 'b'])
    expect(urls).toEqual([
      `https://x.my.salesforce.com/services/data/v60.0/query?q=${encodeURIComponent(SOQL[0])}`,
      'https://x.my.salesforce.com/services/data/v60.0/query/01gXX-2000',
    ])
  })
})
