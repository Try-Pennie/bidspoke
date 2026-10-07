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
