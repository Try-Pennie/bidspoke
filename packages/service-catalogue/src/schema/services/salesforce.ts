import type { ActionArgument, ActionSchema, ServiceSchema } from '../types'

/**
 * Salesforce (#2337, phase 7 of #1689): an org's ops connected app, signed in
 * by the client credentials flow as the org's integration user.
 *
 * WHAT THE PIPEDREAM WORKFLOWS USE, counted in the export of 2026-09-30 (the
 * duplicate project folder left out; steps inside an if/else branch counted;
 * a code step counted once for each kind of call its code makes):
 *   registry steps, 37
 *     salesforce_rest_api-soql-search   26 (0.2.9 x21, 0.2.13 x3, 0.2.12 x2)  soql-search
 *     salesforce_rest_api-soql-query     3 (0.0.1)                             query
 *     salesforce_rest_api-update-record  7 (0.3.5, 0.3.6 x3 one disabled, 1.0.0, 1.0.1 x2)  update-record
 *     salesforce_rest_api-update-crm-record 1 (0.0.1)                          update-record
 *   code steps reaching Salesforce, 104 (3 disabled)
 *     GET /query                      63 (31 follow nextRecordsUrl)            query, soql-search
 *     POST /sobjects/<object>         27 (Prospect__c, Applicant__c, Lead)     create-record
 *     PATCH /sobjects/<object>/<id>   12                                       update-record
 *     PATCH /sobjects/<obj>/<ext>/<v>  1 (Installment__c)                      upsert-record
 *     /composite/sobjects             12 (PATCH, and POST in the loaders)      update-records, create-records
 *     /jobs/ingest, or jsforce bulk2  23 (1 disabled)                         bulk-ingest, get-ingest-job
 *     /services/apexrest               5 (custommdt/bid x2, prospect-trades,
 *                                        nu_dse/CreateProspect x2 in Tripoint's org)  apex-rest
 * Not built, each too rare to stand alone or already served: /jobs/query (3
 * steps, Bulk API query; a query of fewer than 50,000 rows is salesforce.query),
 * /limits (1 step, the API usage monitor; ops reads limits itself, #2336),
 * tooling executeAnonymous (1 step, in a workflow named disabled), and a GET of
 * one record by id (1 step; salesforce.soql-search reads it).
 *
 * The login is the org's ops connected app, `{ client_id, client_secret }`;
 * the target is `{ instance_url, client_id }` (minters/salesforce.ts). The
 * client id goes into both, because the minter refuses a login whose client id
 * is not the declared one. Org is the declared instance, picked from the orgs
 * Bidspoke knows (D15). Who the connection acts as is never a field: verify
 * reads it from Salesforce (userinfo) when the login is checked.
 *
 * EVERY WRITE IS NOT IDEMPOTENT. A Salesforce save runs the org's record
 * triggered flows, processes and Apex triggers every time, whether or not a
 * value changed, so even an update writing the same values twice can send an
 * email or create a task twice. After an uncertain outcome a person decides.
 */

const value = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: false })
const json = (key: string, required = false): ActionArgument => ({ key, type: 'text', required, allowsVariables: true, parseJson: true })
/** An object or field API name, or a fixed choice: the step's own text, never a value from another step. */
const name = (key: string, required = true): ActionArgument => ({ key, type: 'text', required, allowsVariables: false, parseJson: false })
/** The query text: the step's own, with `?` placeholders for its binds (runtime/salesforce/soql.ts). */
const query: ActionArgument = { key: 'query', type: 'code', required: true, allowsVariables: false, parseJson: false }

const RUNS_AUTOMATION =
  'A Salesforce save runs the org\'s record triggered flows, processes and Apex triggers every time, so a repeat after an uncertain outcome can write or send twice, even when the values are the same.'

export const SALESFORCE_SOQL_SEARCH_V1: ActionSchema = {
  key: 'salesforce.soql-search',
  name: 'SOQL query (first batch)',
  version: 1,
  arguments: [query, json('binds')],
  sideEffect: false,
  idempotent: true,
  idempotentBecause: 'A query reads and changes nothing.',
}

export const SALESFORCE_QUERY_V1: ActionSchema = {
  key: 'salesforce.query',
  name: 'SOQL query (every record)',
  version: 1,
  arguments: [query, json('binds')],
  sideEffect: false,
  idempotent: true,
  idempotentBecause: 'A query reads and changes nothing.',
}

export const SALESFORCE_CREATE_RECORD_V1: ActionSchema = {
  key: 'salesforce.create-record',
  name: 'Create record',
  version: 1,
  arguments: [name('object'), json('fields', true)],
  realSend: 'creates a real Salesforce record',
  sideEffect: true,
  idempotent: false,
  idempotentBecause: `A repeat creates a second record, since Salesforce takes no key to deduplicate a create on. ${RUNS_AUTOMATION}`,
}

export const SALESFORCE_UPDATE_RECORD_V1: ActionSchema = {
  key: 'salesforce.update-record',
  name: 'Update record',
  version: 1,
  arguments: [name('object'), value('record_id', true), json('fields', true)],
  realSend: 'changes a real Salesforce record',
  sideEffect: true,
  idempotent: false,
  idempotentBecause: RUNS_AUTOMATION,
}

export const SALESFORCE_UPSERT_RECORD_V1: ActionSchema = {
  key: 'salesforce.upsert-record',
  name: 'Upsert record by external id',
  version: 1,
  arguments: [name('object'), name('external_id_field'), value('external_id', true), json('fields', true)],
  realSend: 'creates or changes a real Salesforce record',
  sideEffect: true,
  idempotent: false,
  idempotentBecause: `The external id keeps a repeat to one record, but the repeat is still a second save. ${RUNS_AUTOMATION}`,
}

export const SALESFORCE_CREATE_RECORDS_V1: ActionSchema = {
  key: 'salesforce.create-records',
  name: 'Create records (up to 200)',
  version: 1,
  arguments: [name('object'), json('records', true)],
  realSend: 'creates real Salesforce records',
  sideEffect: true,
  idempotent: false,
  idempotentBecause: `A repeat creates every record again. ${RUNS_AUTOMATION}`,
}

export const SALESFORCE_UPDATE_RECORDS_V1: ActionSchema = {
  key: 'salesforce.update-records',
  name: 'Update records (up to 200)',
  version: 1,
  arguments: [name('object'), json('records', true)],
  realSend: 'changes real Salesforce records',
  sideEffect: true,
  idempotent: false,
  idempotentBecause: RUNS_AUTOMATION,
}

export const SALESFORCE_APEX_REST_V1: ActionSchema = {
  key: 'salesforce.apex-rest',
  name: 'Call an Apex REST class',
  version: 1,
  arguments: [name('method'), value('path', true), json('params'), json('body')],
  realSend: 'calls real Apex code in Salesforce',
  sideEffect: true,
  idempotent: false,
  idempotentBecause: 'What an Apex class does is its own code, which may write records or call out, so a repeat after an uncertain outcome is a person\'s decision.',
}

export const SALESFORCE_BULK_INGEST_V1: ActionSchema = {
  key: 'salesforce.bulk-ingest',
  name: 'Bulk load records',
  version: 1,
  arguments: [name('object'), name('operation'), name('external_id_field', false), json('records', true)],
  realSend: 'loads real records into Salesforce',
  sideEffect: true,
  idempotent: false,
  idempotentBecause: `A repeat opens a second job that loads every record again. ${RUNS_AUTOMATION}`,
}

export const SALESFORCE_GET_INGEST_JOB_V1: ActionSchema = {
  key: 'salesforce.get-ingest-job',
  name: 'Read a bulk load job',
  version: 1,
  arguments: [value('job_id', true), json('failed_results'), json('successful_results')],
  sideEffect: false,
  idempotent: true,
  idempotentBecause: 'It reads a job\'s state and results and changes nothing.',
}

export const SALESFORCE_SERVICE: ServiceSchema = {
  key: 'salesforce',
  name: 'Salesforce',
  // The Webhook step's preset when Salesforce is picked there: a bearer token (#2342).
  webRequestAuth: 'bearer',
  actions: [
    SALESFORCE_SOQL_SEARCH_V1, SALESFORCE_QUERY_V1, SALESFORCE_CREATE_RECORD_V1, SALESFORCE_UPDATE_RECORD_V1, SALESFORCE_UPSERT_RECORD_V1,
    SALESFORCE_CREATE_RECORDS_V1, SALESFORCE_UPDATE_RECORDS_V1, SALESFORCE_APEX_REST_V1, SALESFORCE_BULK_INGEST_V1, SALESFORCE_GET_INGEST_JOB_V1,
  ],
  connection: {
    tile: 'An org, signed in as its integration user',
    auth: 'client_credentials',
    fields: [
      { key: 'instance_url', label: 'Org', input: 'salesforce_org', required: true, target: 'instance_url' },
      { key: 'client_id', label: 'Client id', input: 'text', required: true, login: 'client_id', target: 'client_id' },
      { key: 'client_secret', label: 'Client secret', input: 'secret', required: true, login: 'client_secret' },
    ],
  },
}
