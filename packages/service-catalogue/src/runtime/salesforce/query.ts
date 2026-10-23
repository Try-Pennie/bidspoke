import { salesforceQueryUrl } from '@bidspoke/salesforce-api'
import type { ActionArgs } from '../types'
import { text } from './call'
import { bindSoql } from './soql'

/**
 * The first page's URL of a step's SOQL query (#2337): the query as the step
 * wrote it, each `?` filled with its bind as a SOQL literal (soql.ts), on the
 * declared instance and the money path's API version (salesforceQueryUrl).
 */
export function firstPageUrl(instance: string, args: ActionArgs): string {
  const query = text(args, 'query')
  return salesforceQueryUrl(instance, bindSoql(query, args.binds))
}
