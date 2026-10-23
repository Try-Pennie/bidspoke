import { queryPage, salesforceInstanceOf } from '../salesforce/call'
import { firstPageUrl } from '../salesforce/query'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.soql-search, version 1 (#2337). Released: never edit it; a change
 * is version 2 (the fingerprint check refuses an edit).
 *
 * At parity with Pipedream's SOQL Query (Object Query) (PipedreamHQ/pipedream
 * components/salesforce_rest_api/actions/soql-search/soql-search.mjs and
 * salesforce_rest_api.app.mjs `query`, at commit b7d67916): one GET of
 * /query?q=, and Salesforce's answer returned as it came, so the FIRST BATCH
 * ONLY, with `totalSize`, `done` and `nextRecordsUrl` for a step to see there
 * is more. What differs, on purpose: a step's values reach the query only as
 * `?` binds written as SOQL literals (salesforce/soql.ts), where Pipedream
 * interpolated them as given; the call is on API v60.0, where Pipedream's app
 * called v50.0. salesforce.query reads every page.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const instance = salesforceInstanceOf(ctx.target)
  const page = await queryPage(ctx, firstPageUrl(instance, args), 'GET query')
  return page.raw
}
