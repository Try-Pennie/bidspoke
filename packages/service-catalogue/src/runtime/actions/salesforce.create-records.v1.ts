import { writeCollection } from '../salesforce/collections'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.create-records, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * Up to 200 records of one object created in one sObject Collections POST,
 * all or none (salesforce/collections.ts), as the commission loaders do with
 * POST /composite/sobjects. Answers `{ results }`, one `{ id, success, errors }`
 * per record in the order given.
 */
export const run: ActionRun = (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => writeCollection(ctx, args, 'POST')
