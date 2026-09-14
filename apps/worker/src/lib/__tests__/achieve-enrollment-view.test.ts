import { describe, it, expect, vi } from 'vitest'
import { SUBMISSION_VIEW_FIELDS, buildSubmissionViewSoql, readSubmissionView } from '../achieve-enrollment-view'

// Geoff's Equifax figures on Submission__c are the ENROLLMENT view: revolving debt that could
// actually be enrolled, after excluding credit unions, student loans, cross collateralised and
// excluded creditors. Ours are the whole credit profile. Measured 2026-09-14 on 12 leads sent
// to Achieve, the two disagreed on 9: on one, the report held three open revolving accounts
// totalling 6,091 of 7,500 and Salesforce held 0 of 1,400, which was exactly one of the three.
// Both are correct about different questions, so these are stored BESIDE ours, never instead.
describe('the enrollment view read from Salesforce', () => {
  it('asks only for the submissions in hand, by id', () => {
    const soql = buildSubmissionViewSoql(['a04Ui00000MSNppIAH', 'a04Ui00000MSQqvIAH'])
    expect(soql).toContain("Id IN ('a04Ui00000MSNppIAH','a04Ui00000MSQqvIAH')")
    expect(soql).toContain('FROM Submission__c')
  })

  // The field list is the contract with the stored column. Asserting it here means a field
  // added to one and not the other cannot pass quietly.
  it('asks for every field the stored view declares', () => {
    const soql = buildSubmissionViewSoql(['a04Ui00000MSNppIAH'])
    for (const field of SUBMISSION_VIEW_FIELDS) expect(soql).toContain(field)
  })

  // An id is user-adjacent data reaching a query string, so it is refused rather than escaped:
  // Salesforce ids are a known shape and anything else is a defect upstream, not input to
  // sanitise.
  it('refuses an id that is not a Salesforce id', () => {
    expect(() => buildSubmissionViewSoql(["a04' OR Id != '"])).toThrow(/Salesforce id/)
  })

  // The list is what Salesforce actually fills at this stage. Measured 2026-09-14 across 8,209
  // submissions created in two days: every exclusion field was populated on ZERO of them, while
  // the six kept sat between roughly 6,000 and 6,800. Asking for the empty ones would have made
  // the stored column 10 parts null out of 16, where null already means the record could not be
  // read, and would have stopped meaning anything.
  it('asks for nothing that Salesforce leaves empty at submission stage', () => {
    const soql = buildSubmissionViewSoql(['a04Ui00000MSNppIAH'])
    for (const empty of [
      'EquifaxDebt__c',
      'EquifaxEnrollableBalance__c',
      'EquifaxCreditUnionBalance__c',
      'EquifaxStudentLoanExclusionBalance__c',
      'EquifaxExcludedCreditorBalance__c',
      'EligibleCollectionTotalBalance__c',
    ]) {
      expect(soql).not.toContain(empty)
    }
  })

  it('returns a view per submission, keyed by id', async () => {
    const query = vi.fn().mockResolvedValue([
      { Id: 'a04Ui00000MSNppIAH', RevolvingTotalBalance__c: 6370, RevolvingUtilization__c: 50.36 },
    ])
    const views = await readSubmissionView(['a04Ui00000MSNppIAH'], query)
    expect(views.get('a04Ui00000MSNppIAH')).toMatchObject({
      RevolvingTotalBalance__c: 6370,
      RevolvingUtilization__c: 50.36,
    })
  })

  // A submission Salesforce does not return is absent rather than an empty object, so a row
  // whose record could not be read stays distinguishable from one whose record held nothing.
  it('omits a submission Salesforce did not return', async () => {
    const query = vi.fn().mockResolvedValue([])
    const views = await readSubmissionView(['a04Ui00000MSNppIAH'], query)
    expect(views.has('a04Ui00000MSNppIAH')).toBe(false)
  })

  it('asks for nothing when there are no submissions', async () => {
    const query = vi.fn()
    expect((await readSubmissionView([], query)).size).toBe(0)
    expect(query).not.toHaveBeenCalled()
  })
})
