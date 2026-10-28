/**
 * The Engine Bidding run of 2026-10-27 whose bid patch lost the race to the
 * person converting (#2895), measured from the run's steps and the Prospect's
 * Salesforce field history. The patch body is the one the run recorded, less
 * the offer link (it carries a signed token) and the Tripoint lead id, which are
 * replaced; the Prospect holds nothing else of the lead's here.
 */

export const CONVERTED_RUN = {
  executionId: '01a17e5e-e883-7678-b74e-e47135b1c9fd',
  prospectId: 'a06Ui00002tjzOPIAY',
  /** patch_prospect: began here, timed out after 1,750 ms, never confirmed. */
  patchProspect: {
    startedAt: '2026-10-27T17:18:36.423Z',
    body: {
      Bidspoke_Write__c: '01a17e5e-e883-7678-b74e-e47135b1c9fd:patch_prospect:0',
      Base_Bid__c: 6.6,
      BidAmount__c: 6.6,
      BidStatus__c: 'Bid',
      TripointLeadID__c: '00000000-0000-4000-8000-000000002895',
      OfferLandingPage__c: 'https://trypennie.com/portal/tpl/a06Ui00002tjzOPIAY?t=redacted',
      Tripoint_Response__c: 'Success',
      ExternalDebtAmount__c: 18059,
      ExternalPartnerName__c: 'Tripoint',
      ExternalRoutingCode__c: 2,
      ExternalExchangeStatus__c: 'Bid',
    } as Record<string, unknown>,
  },
  /** The Prospect when the read-back read it at 17:22:32 UTC: the patch had not landed, and the person had converted. */
  readAtResend: {
    LastModifiedDate: '2026-10-27T17:18:47.000+0000',
    Bidspoke_Write__c: null,
    Base_Bid__c: null,
    BidAmount__c: null,
    BidStatus__c: 'Converted',
    TripointLeadID__c: null,
    OfferLandingPage__c: null,
    Tripoint_Response__c: null,
    ExternalDebtAmount__c: null,
    ExternalPartnerName__c: null,
    ExternalRoutingCode__c: null,
    ExternalExchangeStatus__c: null,
  } as Record<string, unknown>,
  /** Prospect__History from the patch's start: the click, then the conversion, both by integration halo. */
  historyAtResend: [
    { Field: 'IsClicked__c', CreatedDate: '2026-10-27T17:18:45.000+0000' },
    { Field: 'ConvertedToLead__c', CreatedDate: '2026-10-27T17:18:47.000+0000' },
    { Field: 'BidStatus__c', CreatedDate: '2026-10-27T17:18:47.000+0000' },
  ],
  resendTickStartedAt: '2026-10-27T17:22:31.000Z',
}
