import { salesforceSobjectUrl } from '@bidspoke/salesforce-api'
import { fieldsOf, objectName, salesforceInstanceOf, salesforceObject, unreadable, type SalesforceRequest } from '../salesforce/call'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.create-record, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * One record created: POST /sobjects/<object> with the step's fields, as the
 * code steps do (Prospect__c, Applicant__c, Lead), and Salesforce's answer
 * returned as it came, `{ id, success, errors }`. Re-implemented on the money
 * path's URL rule (salesforceSobjectUrl), not copied: Pipedream's create-record
 * (components/salesforce_rest_api/actions/create-record, at b7d67916) is used
 * by no step. A 2xx it cannot read was applied: the record exists, and its id
 * is unknown.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const instance = salesforceInstanceOf(ctx.target)
  const object = objectName(args)
  const fields = fieldsOf(args)
  const request: SalesforceRequest = { method: 'POST', url: salesforceSobjectUrl(instance, object), body: fields, what: `POST sobjects/${object}`, effect: 'write' }
  const answer = await salesforceObject(ctx, request)
  if (typeof answer.id !== 'string' || answer.id === '') throw unreadable(request, 'named no record id')
  return answer
}
