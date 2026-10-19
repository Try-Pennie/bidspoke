/**
 * The two Engine Bidding runs whose timed out reject patch the read-back resent
 * without BidStatus__c (#2264). Measured 2026-10-19 and kept as they were read:
 *
 *  - step times and the reject patch's body from execution_steps (Supabase,
 *    project xvrmivmpfykwwtriqwpg). The create body's field NAMES are listed to
 *    show it sends no BidStatus__c; its values are the lead's and are left out.
 *  - the read-back ticks that resent them from job_runs (job salesforce-read-back):
 *    each recorded resent=1 conflicts=1, BidStatus__c 1 conflict of 1 candidate.
 *  - Prospect__History and FieldDefinition from Salesforce, read through the
 *    read only connector. BidStatus__c is history tracked on Prospect__c and
 *    RejectionReason__c is not; when each resend ran, the only history row on
 *    either Prospect was its "created" row. (Both were later corrected by hand,
 *    rows not included here because they came after the resend.)
 *
 * LastModifiedDate as the resend read it is DERIVED, not read: the record has
 * been written since. It is the second in which prospect_trades' Apex update
 * finished (that update writes the Prospect and nothing after it did before the
 * reject patch), which is what the 2026-10-16 issue body recorded (12:53:56).
 *
 * No value here identifies a person: ids, times, field names and the two
 * BidStatus__c and RejectionReason__c values only.
 */
export interface RejectResendRun {
  label: string
  executionId: string
  prospectId: string
  createProspect: { startedAt: string; completedAt: string; bodyFields: string[] }
  prospectTrades: { startedAt: string; completedAt: string }
  patchProspectReject: { startedAt: string; body: Record<string, unknown>; error: string }
  /** The record as the resend read it: the marker, LastModifiedDate (derived, above) and the two fields. */
  readAtResend: Record<string, unknown>
  /** Prospect__History for the record as it stood when the resend ran. */
  historyAtResend: Array<{ Field: string; CreatedDate: string }>
  /** The read-back tick that resent it. */
  resendTickStartedAt: string
}

/** Prospect__c fields Salesforce keeps a history of, FieldDefinition.IsFieldHistoryTracked, read 2026-10-19. */
export const PROSPECT_TRACKED_FIELDS = [
  'Status__c',
  'BidStatus__c',
  'Is_Synced__c',
  'SyncIssues__c',
  'IsClicked__c',
  'ConvertedToLead__c',
  'OfferClicked__c',
  'BidAmount__c',
  'Cometly_Token__c',
  'Cometly_Fingerprint__c',
]

const CREATE_BODY_FIELDS = [
  'Zip__c', 'City__c', 'Email__c', 'Phone__c', 'State__c', 'Source__c', 'Street__c', 'User_IP__c', 'AptSuite__c', 'LeadUUID__c',
  'BirthDate__c', 'Last_Name__c', 'RentOrOwn__c', 'First_Name__c', 'LoanAmount__c', 'User_Agent__c', 'LoanPurpose__c', 'Middle_Name__c',
  'EducationLevel__c', 'SubaccountUUID__c', 'FCRAConsentFlag__c', 'ProspectTraceId__c', 'TCPAConsentFlag__c', 'EmploymentStatus__c',
  'IncomePmtFrequency__c', 'SocialSecurityNumber__c', 'AnnualIncomeBeforeTaxes__c', 'ApproximateCreditRating__c',
]

const TIMED_OUT = 'Step timed out after 1500ms (in-flight upstream call canceled via abort signal)'

export const REJECT_RESEND_RUNS: RejectResendRun[] = [
  {
    label: '2026-10-16, Prospect a06Ui00002saNcJIAU',
    executionId: '01a144c6-a0c1-7783-9721-a9cf17de3f44',
    prospectId: 'a06Ui00002saNcJIAU',
    createProspect: { startedAt: '2026-10-16T12:53:50.457Z', completedAt: '2026-10-16T12:53:52.393Z', bodyFields: CREATE_BODY_FIELDS },
    prospectTrades: { startedAt: '2026-10-16T12:53:52.959Z', completedAt: '2026-10-16T12:53:56.941Z' },
    patchProspectReject: {
      startedAt: '2026-10-16T12:53:56.968Z',
      body: { BidStatus__c: 'Rejected', Bidspoke_Write__c: '01a144c6-a0c1-7783-9721-a9cf17de3f44:patch_prospect_reject:0', RejectionReason__c: 'unqualified_lead' },
      error: TIMED_OUT,
    },
    readAtResend: { Bidspoke_Write__c: null, LastModifiedDate: '2026-10-16T12:53:56.000+0000', BidStatus__c: 'No Bid', RejectionReason__c: null },
    historyAtResend: [{ Field: 'created', CreatedDate: '2026-10-16T12:53:51.000+0000' }],
    resendTickStartedAt: '2026-10-16T12:57:13.598Z',
  },
  {
    label: '2026-10-19, Prospect a06Ui00002srFqSIAU',
    executionId: '01a15463-1e57-75b5-8bee-aeaa34dbaa1c',
    prospectId: 'a06Ui00002srFqSIAU',
    createProspect: { startedAt: '2026-10-19T13:39:04.431Z', completedAt: '2026-10-19T13:39:04.817Z', bodyFields: CREATE_BODY_FIELDS },
    prospectTrades: { startedAt: '2026-10-19T13:39:05.290Z', completedAt: '2026-10-19T13:39:06.346Z' },
    patchProspectReject: {
      startedAt: '2026-10-19T13:39:06.360Z',
      body: { BidStatus__c: 'Rejected', Bidspoke_Write__c: '01a15463-1e57-75b5-8bee-aeaa34dbaa1c:patch_prospect_reject:0', RejectionReason__c: 'unqualified_lead' },
      error: TIMED_OUT,
    },
    readAtResend: { Bidspoke_Write__c: null, LastModifiedDate: '2026-10-19T13:39:06.000+0000', BidStatus__c: 'No Bid', RejectionReason__c: null },
    historyAtResend: [{ Field: 'created', CreatedDate: '2026-10-19T13:39:04.000+0000' }],
    resendTickStartedAt: '2026-10-19T13:42:29.193Z',
  },
]
