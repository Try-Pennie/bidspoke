import { readJob } from '../salesforce/bulk'
import { optionalBoolean, salesforceInstanceOf } from '../salesforce/call'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.get-ingest-job, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * A Bulk API 2.0 ingest job's state (GET /jobs/ingest/<id>), and when asked its
 * failed records (sf__Id, sf__Error and the fields sent) and successful records
 * (sf__Id, sf__Created), each as one object per row (salesforce/bulk.ts). Past
 * SALESFORCE_RESULTS_MAX_ROWS rows it fails by name rather than return part.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const wants = { failed: optionalBoolean(args, 'failed_results'), successful: optionalBoolean(args, 'successful_results') }
  return readJob(ctx, salesforceInstanceOf(ctx.target), args, wants)
}
