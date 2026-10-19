/**
 * One customer's two Main Flow runs 15 minutes apart on 2026-10-18, each writing
 * the same Submission straight to Salesforce with a 204 (#2485). The 2026-10-19
 * 9:03 AM ET invalid state report counted both as not landed.
 *
 * Read on 2026-10-19, read only:
 *  - the two `invalid_state_sf_post` step rows from execution_steps (execution
 *    id, type, status, start, the resolved PATCH and the answer), with the
 *    template the step resolved from left out;
 *  - the Submission and its Lead from Salesforce (SOQL through the read only
 *    connection), in the REST shape the watch reads them.
 * Nothing here names or contacts a person: the bodies carry scores, routing,
 * links and Engine ids only, so nothing was redacted. Ids, timestamps and field
 * shapes are as read.
 *
 * The Submission's Bidspoke_Write__c is not visible to the read only user, so
 * its value is the stamp the 2026-10-19 job run record names ("Another write has
 * stamped the Submission since (run 01a14fcb...)"), which is the second run's
 * own step, attempt 0. Its LastModifiedDate is what Salesforce answered on
 * 2026-10-19, after the report ran; no rule these runs meet reads it.
 */
import type { WatchedStep } from '../../invalid-state-canary-watch'

export const REPEAT_VISIT_APP = 'https://bidspoke.trypennie.dev'
export const REPEAT_RUN_1 = '01a14fbd-04b3-72f7-8cfa-dbae9da39ea5'
export const REPEAT_RUN_2 = '01a14fcb-0ad0-794f-8d5c-c6bf209db39b'
export const REPEAT_SUBMISSION = 'a04Ui00000O0URhIAN'
export const REPEAT_LEAD = '00QUi000011lswjMAA'
/** The report that counted them: its run started 2026-10-19 13:00:42.666 UTC. */
export const REPEAT_REPORT_NOW_MS = Date.parse('2026-10-19T13:00:42.666Z')

const runLink = (run: string) => `${REPEAT_VISIT_APP}/workflows/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09?execution=${run}`

export const REPEAT_STEP_1: WatchedStep = {
  execution_id: REPEAT_RUN_1,
  step_type: 'salesforce',
  status: 'completed',
  started_at: '2026-10-18T15:59:28.328+00:00',
  input: {
    resolved: {
      url: `https://trypennie.my.salesforce.com/services/data/v60.0/sobjects/Submission__c/${REPEAT_SUBMISSION}`,
      body: {
        ADV_SO__c: 2,
        XBC_SO__c: '200',
        PDFlow_1__c: runLink(REPEAT_RUN_1),
        PDFlow_4__c: runLink(REPEAT_RUN_1),
        LeadSaleType__c: 'Offer Wall',
        VantageScore__c: 659,
        Bidspoke_Write__c: `${REPEAT_RUN_1}:invalid_state_sf_post:0`,
        Engine_UUID_SO__c: '00318ec7-835e-49c7-aea0-277b09d580f5',
        External_Timestamp__c: '2026-10-18T15:59:14.187Z',
        EQXCreditPullStatus__c: 'Success',
        Engine_Lead_UUID_SO__c: 'b9b4f901-e1da-4263-8223-962c3dc94b55',
        Credit_Pull_Result_ES__c: 'Success',
        External_Partner_Name__c: 'Engine',
        External_Routing_Code__c: 1,
        PD_Completed_Timestamp__c: '2026-10-18T15:59:14',
        External_Exchange_Status__c: 'Pending',
      },
      method: 'PATCH',
      object: 'Submission__c',
      operation: 'update',
      record_id: REPEAT_SUBMISSION,
    },
  },
  output: { body: null, status: 204 },
}

export const REPEAT_STEP_2: WatchedStep = {
  execution_id: REPEAT_RUN_2,
  step_type: 'salesforce',
  status: 'completed',
  started_at: '2026-10-18T16:14:36.325+00:00',
  input: {
    resolved: {
      url: `https://trypennie.my.salesforce.com/services/data/v60.0/sobjects/Submission__c/${REPEAT_SUBMISSION}`,
      body: {
        ADV_SO__c: 2,
        XBC_SO__c: '200',
        PDFlow_1__c: runLink(REPEAT_RUN_2),
        PDFlow_4__c: runLink(REPEAT_RUN_2),
        LeadSaleType__c: 'Offer Wall',
        VantageScore__c: 659,
        Bidspoke_Write__c: `${REPEAT_RUN_2}:invalid_state_sf_post:0`,
        Engine_UUID_SO__c: '9ff942de-ac0a-453d-8cb3-35972c6a19f1',
        External_Timestamp__c: '2026-10-18T16:14:32.927Z',
        EQXCreditPullStatus__c: 'Success',
        Engine_Lead_UUID_SO__c: 'f5e4c693-0e72-4467-a326-a940c27cf112',
        Credit_Pull_Result_ES__c: 'Success',
        External_Partner_Name__c: 'Engine',
        External_Routing_Code__c: 1,
        PD_Completed_Timestamp__c: '2026-10-18T16:14:32',
        External_Exchange_Status__c: 'Pending',
      },
      method: 'PATCH',
      object: 'Submission__c',
      operation: 'update',
      record_id: REPEAT_SUBMISSION,
    },
  },
  output: { body: null, status: 204 },
}

/** The Submission as Salesforce holds it: the second run's write, completed. */
export const REPEAT_SUBMISSION_RECORD: Record<string, unknown> = {
  attributes: { type: 'Submission__c', url: `/services/data/v60.0/sobjects/Submission__c/${REPEAT_SUBMISSION}` },
  Id: REPEAT_SUBMISSION,
  CreatedDate: '2026-10-18T15:58:12.000+0000',
  LastModifiedDate: '2026-10-19T13:03:25.000+0000',
  Lead__c: REPEAT_LEAD,
  Bidspoke_Write__c: `${REPEAT_RUN_2}:invalid_state_sf_post:0`,
  PDFlow_1__c: runLink(REPEAT_RUN_2),
  PDFlow_4__c: runLink(REPEAT_RUN_2),
  Engine_UUID_SO__c: '9ff942de-ac0a-453d-8cb3-35972c6a19f1',
  Engine_Lead_UUID_SO__c: 'f5e4c693-0e72-4467-a326-a940c27cf112',
  ADV_SO__c: 2,
  XBC_SO__c: '200',
  LeadSaleType__c: 'Offer Wall',
  VantageScore__c: '659',
  External_Timestamp__c: '2026-10-18T16:14:32.000+0000',
  EQXCreditPullStatus__c: 'Success',
  Credit_Pull_Result_ES__c: 'Success',
  External_Partner_Name__c: 'Engine',
  External_Routing_Code__c: '1',
  PD_Completed_Timestamp__c: '2026-10-18T16:14:32.000+0000',
  External_Exchange_Status__c: 'Pending',
  Completed_Submission_SO__c: 'Yes',
}

/** The Lead: the FIRST run's Engine ids, copied when the Submission first completed, and it names this Submission. */
export const REPEAT_LEAD_RECORD: Record<string, unknown> = {
  attributes: { type: 'Lead', url: `/services/data/v60.0/sobjects/Lead/${REPEAT_LEAD}` },
  EngineUUID__c: '00318ec7-835e-49c7-aea0-277b09d580f5',
  EngineLeadUUID__c: 'b9b4f901-e1da-4263-8223-962c3dc94b55',
  Submission_Object_ID__c: REPEAT_SUBMISSION,
}
