import { salesforceRecordUrl } from '@bidspoke/salesforce-api'
import { fieldsOf, objectName, recordId, salesforceInstanceOf, salesforceSend } from '../salesforce/call'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.update-record, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's Update Record and Update CRM Record
 * (PipedreamHQ/pipedream components/salesforce_rest_api/actions/update-record
 * and update-crm-record, and salesforce_rest_api.app.mjs `updateRecord`, at
 * commit b7d67916): one PATCH of /sobjects/<object>/<id> with only the fields
 * given, and `{ success: true, objectType, recordId }` returned as Pipedream
 * returned it. What differs, on purpose: the record id must be one (15 or 18
 * letters and digits), so a value cannot reach another path, and the call is on
 * API v60.0, where Pipedream's app called v50.0.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const instance = salesforceInstanceOf(ctx.target)
  const object = objectName(args)
  const id = recordId(args, 'record_id')
  const fields = fieldsOf(args)
  await salesforceSend(ctx, { method: 'PATCH', url: salesforceRecordUrl(instance, object, id), body: fields, what: `PATCH sobjects/${object}`, effect: 'write' })
  return { success: true, objectType: object, recordId: id }
}
