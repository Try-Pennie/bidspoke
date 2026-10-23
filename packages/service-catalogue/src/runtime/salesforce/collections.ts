import { ActionFailure } from '../failure'
import type { ActionArgs, ActionContext, JsonValue } from '../types'
import {
  dataUrl, invalid, isObject, objectName, SALESFORCE_COLLECTION_MAX_RECORDS, salesforceFailure, salesforceInstanceOf, salesforceSend, unreadable, type SalesforceRequest,
} from './call'

/**
 * Several records written in one sObject Collections request (#2337): POST
 * (create) or PATCH (update) /composite/sobjects, every record typed as the
 * step's object, at most SALESFORCE_COLLECTION_MAX_RECORDS (Salesforce's own
 * limit, 200), refused by name past it rather than split, so a step is one
 * request.
 *
 * ALWAYS allOrNone: true, so a batch lands whole or not at all. The code steps
 * sent allOrNone: false and read each record's result, which leaves a partial
 * write a repeat duplicates; here one bad record rolls every record back and
 * the step fails `salesforce_batch_rejected`, not applied, naming the record's
 * place, its status code and the fields Salesforce blamed (never its message,
 * which can quote a value). Salesforce answers that batch with its per record
 * results whatever the status, so they are read at 400 too. A batch that comes
 * back applied in part all the same is `salesforce_partial_batch`, applied.
 */

const ROLLED_BACK = 'ALL_OR_NONE_OPERATION_ROLLED_BACK'
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/
const NAME = /^[A-Za-z0-9_.]{1,80}$/

interface RecordResult {
  readonly success: boolean
  readonly errors: readonly JsonValue[]
}

function isResult(value: JsonValue): value is Readonly<Record<string, JsonValue>> & RecordResult {
  return isObject(value) && typeof value.success === 'boolean' && (value.errors === undefined || Array.isArray(value.errors))
}

/** Why one record failed: its first status code that is not the rollback, and the fields blamed. */
function why(result: RecordResult): string {
  const errors = (result.errors ?? []).filter(isObject)
  const first = errors.find((e) => e.statusCode !== ROLLED_BACK) ?? errors[0]
  if (first === undefined) return 'no status code'
  const code = typeof first.statusCode === 'string' && NAME.test(first.statusCode) ? first.statusCode : 'an unnamed status'
  const fields = Array.isArray(first.fields) ? first.fields.filter((f): f is string => typeof f === 'string' && NAME.test(f)) : []
  return fields.length > 0 ? `${code}, blaming ${fields.join(', ')}` : code
}

function recordsOf(args: ActionArgs, update: boolean): readonly Readonly<Record<string, JsonValue>>[] {
  const value = args.records
  if (!Array.isArray(value) || value.length === 0) throw invalid('records must be a list of one or more objects of field API names and values')
  if (value.length > SALESFORCE_COLLECTION_MAX_RECORDS) {
    throw new ActionFailure('salesforce_too_many_records', `a step writes at most ${SALESFORCE_COLLECTION_MAX_RECORDS} records in one request; it was given ${value.length}`, 'not_applied')
  }
  return (value as readonly JsonValue[]).map((r, i) => {
    if (!isObject(r)) throw invalid(`record ${i + 1} is not an object`)
    if (Object.hasOwn(r, 'attributes')) throw invalid(`record ${i + 1} names its own attributes; every record is the step's object`)
    if (update && (typeof r.Id !== 'string' || !RECORD_ID.test(r.Id))) throw invalid(`record ${i + 1} has no Id to update`)
    return r
  })
}

export async function writeCollection(ctx: ActionContext, args: ActionArgs, method: 'POST' | 'PATCH'): Promise<JsonValue> {
  const instance = salesforceInstanceOf(ctx.target)
  const object = objectName(args)
  const records = recordsOf(args, method === 'PATCH')
  const request: SalesforceRequest = {
    method,
    url: dataUrl(instance, '/composite/sobjects'),
    body: { allOrNone: true, records: records.map((r) => ({ attributes: { type: object }, ...r })) },
    what: `${method} composite/sobjects (${object})`,
    effect: 'write',
    answers: [400],
  }
  const answer = await salesforceSend(ctx, request)
  const results = answer.body
  if (!Array.isArray(results) || !results.every(isResult)) {
    if (answer.status >= 400) throw salesforceFailure(request, answer.status, answer.text, results)
    throw new ActionFailure('salesforce_answer_unreadable', `Salesforce's answer to ${request.what} held no result per record, so what it wrote is unknown`, 'unknown')
  }
  if (results.length !== records.length) {
    throw new ActionFailure('salesforce_answer_unreadable', `Salesforce answered ${results.length} results for ${records.length} records, so what it wrote is unknown`, 'unknown')
  }
  const failed = results.map((r, i) => ({ r, place: i + 1 })).filter(({ r }) => !r.success)
  if (failed.length === 0) {
    if (answer.status >= 400) throw unreadable(request, `was HTTP ${answer.status} with every record a success`)
    return { results }
  }
  if (failed.length === results.length) {
    const cause = failed.find(({ r }) => why(r) !== ROLLED_BACK) ?? failed[0]
    throw new ActionFailure(
      'salesforce_batch_rejected',
      `Salesforce rolled back all ${records.length} records of ${request.what}: record ${cause.place} failed with ${why(cause.r)}; none was written`,
      'not_applied',
    )
  }
  throw new ActionFailure(
    'salesforce_partial_batch',
    `Salesforce wrote ${results.length - failed.length} of ${records.length} records of ${request.what} despite allOrNone; records ${failed.map((f) => f.place).join(', ')} failed`,
    'applied',
  )
}
