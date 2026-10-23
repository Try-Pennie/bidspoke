import { ActionFailure } from '../failure'
import { nextPageUrl, queryPage, SALESFORCE_QUERY_MAX_PAGES, salesforceInstanceOf, unreadable } from '../salesforce/call'
import { firstPageUrl } from '../salesforce/query'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * salesforce.query, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * A SOQL query read in full: the first page, then each nextRecordsUrl on the
 * declared instance until Salesforce says it is done, as the code steps do by
 * hand and as Pipedream's SOQL Query (soql-query.mjs at b7d67916) did for up to
 * five pages, answering a silent `hasMore` past them. Here the result is never
 * a prefix: past SALESFORCE_QUERY_MAX_PAGES pages it fails by name
 * (`salesforce_query_page_cap`), and a page that fails fails the step. The
 * query takes `?` binds as salesforce.soql-search does.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  const instance = salesforceInstanceOf(ctx.target)
  let url = firstPageUrl(instance, args)
  const records: JsonValue[] = []
  let totalSize = 0
  for (let page = 1; page <= SALESFORCE_QUERY_MAX_PAGES; page++) {
    const read = await queryPage(ctx, url, `GET query page ${page}`)
    records.push(...read.records)
    totalSize = read.totalSize
    if (read.done) return { totalSize, done: true, records }
    if (read.nextRecordsUrl === null) throw unreadable({ what: `GET query page ${page}`, effect: 'read' }, 'said it was not done and named no next page')
    url = nextPageUrl(instance, read.nextRecordsUrl)
  }
  throw new ActionFailure(
    'salesforce_query_page_cap',
    `the query has more than ${SALESFORCE_QUERY_MAX_PAGES} pages (${totalSize} records), so none is returned; narrow the query`,
    'not_applied',
  )
}
