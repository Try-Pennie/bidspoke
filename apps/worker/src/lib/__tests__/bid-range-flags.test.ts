import { describe, it, expect, vi } from 'vitest'
import { partnerFlagsFromDescribe, fetchPartnerFlags, defaultMatrixWhere } from '../bid-range-flags'
import { BID_RANGE_ROW_DESCRIBE } from './fixtures/bid-range-row-describe'

// #1864: the partner list was hard coded at 8 while Salesforce had grown to 11,
// so Borrow Better and Lead Economy rows read as the default matrix.
describe('partnerFlagsFromDescribe', () => {
  it('takes every partner checkbox Salesforce has, including ones added after the code was written', () => {
    const flags = partnerFlagsFromDescribe(BID_RANGE_ROW_DESCRIBE)
    expect(flags.map((f) => f.field)).toEqual([
      'IsAmOneDirect__c', 'IsAmOne__c', 'IsBorrowBetter__c', 'IsBrainsome__c', 'IsDot818__c',
      'IsEPCVIP__c', 'IsLendingTree__c', 'IsNerdWallet__c', 'IsSoFi__c', 'IsTLG__c', 'Is_Lead_Economy__c',
    ])
  })

  it('names each matrix from the field label, not the API name', () => {
    const byField = new Map(partnerFlagsFromDescribe(BID_RANGE_ROW_DESCRIBE).map((f) => [f.field, f.label]))
    expect(byField.get('IsBorrowBetter__c')).toBe('Borrow Better')
    expect(byField.get('IsEPCVIP__c')).toBe('EPC VIP')
    expect(byField.get('IsBrainsome__c')).toBe('Brainsome')
    expect(byField.get('Is_Lead_Economy__c')).toBe('Lead Economy')
  })

  it('keeps a partner name that merely starts with the letters Is', () => {
    const flags = partnerFlagsFromDescribe({ fields: [{ name: 'IsIslandLending__c', type: 'boolean', label: 'Island Lending' }] })
    expect(flags[0].label).toBe('Island Lending')
  })

  it('leaves out the sell-off checkbox, which splits a matrix rather than naming a partner', () => {
    const fields = partnerFlagsFromDescribe(BID_RANGE_ROW_DESCRIBE).map((f) => f.field)
    expect(fields).not.toContain('IsSellOff__c')
    expect(fields).not.toContain('IsDeleted')
  })

  it('refuses a describe with no partner checkboxes rather than treating every row as the default matrix', () => {
    expect(() => partnerFlagsFromDescribe({ fields: [{ name: 'Id', type: 'id', label: 'Record ID' }] }))
      .toThrow(/no partner checkbox fields/)
  })
})

describe('fetchPartnerFlags', () => {
  it('reads the describe of BidRangeRow__c with the bearer token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(BID_RANGE_ROW_DESCRIBE), { status: 200 }))
    const flags = await fetchPartnerFlags('https://x.my.salesforce.com', 'tok', fetchImpl)
    expect(flags).toHaveLength(11)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://x.my.salesforce.com/services/data/v60.0/sobjects/BidRangeRow__c/describe',
      { headers: { Authorization: 'Bearer tok' } },
    )
  })

  it('reads the object it is told to, so a matrix kept elsewhere is filtered by its own checkboxes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(BID_RANGE_ROW_DESCRIBE), { status: 200 }))
    await fetchPartnerFlags('https://x.my.salesforce.com', 'tok', fetchImpl, 'OtherMatrix__c')
    expect(fetchImpl.mock.calls[0][0]).toBe('https://x.my.salesforce.com/services/data/v60.0/sobjects/OtherMatrix__c/describe')
  })

  // #2394: the describe url is built by the shared salesforce-api module now, and
  // must be byte for byte the url the hand built template sent before it. The
  // template encoded the name; for an API name encoding changes nothing, which
  // is why salesforceSobjectUrl, which puts it in as it is, sends the same bytes.
  it.each([
    ['https://x.my.salesforce.com', 'BidRangeRow__c'],
    ['https://pennie.my.salesforce.com', 'Other_Matrix_Rows__c'],
    ['https://sandbox--dev.sandbox.my.salesforce.com', 'Matrix2__c'],
  ])('asks %s for the describe of %s at exactly the url the hand built template sent', async (instanceUrl, sobject) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(BID_RANGE_ROW_DESCRIBE), { status: 200 }))
    await fetchPartnerFlags(instanceUrl, 'tok', fetchImpl, sobject)
    expect(fetchImpl.mock.calls[0][0]).toBe(`${instanceUrl}/services/data/v60.0/sobjects/${encodeURIComponent(sobject)}/describe`)
  })

  // The object comes from a partner bid config a person typed (sf_object), which
  // nothing checks on save. A name that is not an API name names no object, so it
  // is refused before any call rather than sent, which keeps it from reaching the
  // URL as more than one path segment now that the name goes in unencoded.
  it.each(['Other Matrix/Rows__c', 'Ünïcode&Matrix?__c', '../limits', 'BidRangeRow__c/', ''])('refuses %j before any call, since it is not a Salesforce API name', async (sobject) => {
    const fetchImpl = vi.fn()
    await expect(fetchPartnerFlags('https://x.my.salesforce.com', 'tok', fetchImpl, sobject))
      .rejects.toThrow(/is not a Salesforce API name/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws with the status and body when Salesforce refuses, never falling back to a fixed list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('INVALID_SESSION_ID', { status: 401 }))
    await expect(fetchPartnerFlags('https://x.my.salesforce.com', 'tok', fetchImpl))
      .rejects.toThrow(/describe of BidRangeRow__c failed \(401\): INVALID_SESSION_ID/)
  })
})

describe('defaultMatrixWhere', () => {
  it('excludes every partner, so the default matrix never picks up a newer partner\'s rows', () => {
    const where = defaultMatrixWhere(partnerFlagsFromDescribe(BID_RANGE_ROW_DESCRIBE))
    expect(where).toContain('IsBorrowBetter__c = FALSE')
    expect(where).toContain('Is_Lead_Economy__c = FALSE')
    expect(where.split(' AND ')).toHaveLength(11)
  })
})
