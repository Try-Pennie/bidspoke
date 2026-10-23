import { ingest } from '../salesforce/bulk'
import { salesforceInstanceOf } from '../salesforce/call'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.bulk-ingest, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * A Bulk API 2.0 ingest job (salesforce/bulk.ts): opened for one object and
 * one operation (insert, update, upsert by an external id field, or delete),
 * its records uploaded as one CSV and the job closed, as the parser workflows
 * do by hand and with jsforce's bulk2. Answers `{ job_id, state, object,
 * operation, records }` without waiting: the job runs after the step, and
 * salesforce.get-ingest-job reads its state and results. Every record must name
 * the same fields; a null is written as #N/A, which Salesforce reads as null.
 */
export const run: ActionRun = (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => ingest(ctx, salesforceInstanceOf(ctx.target), args)
