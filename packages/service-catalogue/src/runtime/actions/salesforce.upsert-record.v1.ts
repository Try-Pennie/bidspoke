import { salesforceUpsertUrl } from '@bidspoke/salesforce-api'
import { fieldsOf, isObject, objectName, salesforceInstanceOf, salesforceSend, text, unreadable, type SalesforceRequest } from '../salesforce/call'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.upsert-record, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * One record created or updated by an external id: PATCH
 * /sobjects/<object>/<external id field>/<value> with the step's fields, as the
 * tradelines import does for Installment__c, on the money path's URL rule
 * (salesforceUpsertUrl) with the value encoded, so it stays one path segment.
 * Answers `{ id, success, created }`. An external id matching several records
 * (HTTP 300) is `salesforce_external_id_ambiguous`, not applied.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const instance = salesforceInstanceOf(ctx.target)
  const object = objectName(args)
  const field = objectName(args, 'external_id_field')
  const value = text(args, 'external_id')
  const fields = fieldsOf(args)
  const request: SalesforceRequest = {
    method: 'PATCH', url: salesforceUpsertUrl(instance, object, field, encodeURIComponent(value)), body: fields, what: `PATCH sobjects/${object}/${field}`, effect: 'write',
  }
  const answer = await salesforceSend(ctx, request)
  if (answer.status === 204) return { id: null, success: true, created: false }
  if (!isObject(answer.body) || typeof answer.body.id !== 'string') throw unreadable(request, 'named no record id')
  const created = typeof answer.body.created === 'boolean' ? answer.body.created : answer.status === 201
  return { id: answer.body.id, success: true, created }
}
