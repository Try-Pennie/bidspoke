/**
 * The Engine Bidding run whose timed out bid patch the read-back resent without
 * Collections_Bid_Discount__c (#2492), on 2026-10-28 (3:27 AM ET). Measured the
 * same day and kept as it was read:
 *
 *  - step times and the bid patch's field names from execution_steps (Supabase,
 *    project xvrmivmpfykwwtriqwpg): create_prospect, then prospect_trades (whose
 *    Apex update writes the Prospect) finishing 13 ms before patch_prospect
 *    began, which timed out three times. BidStatus__c "Bid" and
 *    Collections_Bid_Discount__c true are the run's own values; the two bid
 *    amounts and the landing page are stand ins, since only their names matter.
 *  - the read-back tick that resent it from job_runs (job salesforce-read-back):
 *    resent=1 conflicts=1 history_reads=2 history_cleared=1, and
 *    Collections_Bid_Discount__c 1 conflict of 1 candidate. So the record read
 *    called two fields moved (BidStatus__c at "No Bid" and the checkbox at false)
 *    and the history cleared one, BidStatus__c.
 *  - Prospect__History and FieldDefinition from Salesforce, read through the read
 *    only connector. Collections_Bid_Discount__c is a Checkbox Salesforce keeps no
 *    history of; the only history rows on the Prospect are its "created" row and
 *    the resend's own BidStatus__c and BidAmount__c changes at 07:27:31 UTC.
 *
 * LastModifiedDate as the resend read it is DERIVED, not read, as in the #2264
 * fixture: the second in which prospect_trades' Apex update finished, the last
 * write to the record before the patch.
 *
 * No value here identifies a person: ids, times, field names and types only.
 */
export const UNTRACKED_CHECKBOX_RUN = {
  executionId: '01a18164-9a71-7064-a23f-a47f32324453',
  workflowId: 'da82a183-1a4a-417e-b0b8-5f3fe5e14840',
  prospectId: 'a06Ui00002to49PIAQ',
  createProspect: { startedAt: '2026-10-28T07:23:36.448Z', completedAt: '2026-10-28T07:23:36.866Z' },
  prospectTrades: { startedAt: '2026-10-28T07:24:00.151Z', completedAt: '2026-10-28T07:24:15.519Z' },
  patchProspect: {
    startedAt: '2026-10-28T07:24:15.532Z',
    body: {
      Base_Bid__c: 120,
      BidAmount__c: 120,
      BidStatus__c: 'Bid',
      OfferLandingPage__c: 'https://offer.example/landing',
      Collections_Bid_Discount__c: true,
      Bidspoke_Write__c: '01a18164-9a71-7064-a23f-a47f32324453:patch_prospect:0',
    } as Record<string, unknown>,
    error: 'Step timed out after 1750ms (in-flight upstream call canceled via abort signal)',
  },
  /** The record as the resend read it: every field as created, the checkbox at its default false. */
  readAtResend: {
    Bidspoke_Write__c: null,
    LastModifiedDate: '2026-10-28T07:24:15.000+0000',
    Base_Bid__c: null,
    BidAmount__c: null,
    BidStatus__c: 'No Bid',
    OfferLandingPage__c: null,
    Collections_Bid_Discount__c: false,
  } as Record<string, unknown>,
  /** Prospect__History for the record as it stood when the resend ran. */
  historyAtResend: [{ Field: 'created', CreatedDate: '2026-10-28T07:23:36.000+0000' }],
  resendTickStartedAt: '2026-10-28T07:27:28.605Z',
}

/** FieldDefinition of the bid patch's fields on Prospect__c, read 2026-10-28. */
export const BID_PATCH_FIELDS: Record<string, { type: string; tracked: boolean }> = {
  Base_Bid__c: { type: 'Currency(16, 2)', tracked: false },
  BidAmount__c: { type: 'Currency(16, 2)', tracked: true },
  BidStatus__c: { type: 'Picklist', tracked: true },
  OfferLandingPage__c: { type: 'URL(255)', tracked: false },
  Collections_Bid_Discount__c: { type: 'Checkbox', tracked: false },
}
