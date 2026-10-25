import { ActionFailure } from '../failure'
import { asSupabaseJs, filterValueOf, identifierOf, invalid, supabaseRequest } from '../supabase/call'
import type { ActionArgs, ActionRun } from '../types'

/**
 * supabase.select-row, version 1 (#2337). Released: never edit it; a change is
 * version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Select Row (PipedreamHQ/pipedream
 * components/supabase/actions/select-row/select-row.mjs and supabase.app.mjs
 * selectRow, at commit b7d67916): `from(table).select().order(order_by,
 * { ascending }).limit(max)`, with one filter when column, filter and value
 * are all given (refused when only some are, as Pipedream refused), answered
 * as supabase-js answered it. As Pipedream read them: ascending only when
 * sort_order is `ascending`, so a blank one is descending, and max 20 when blank.
 * What differs, on purpose:
 *  - max is 1 to 1,000, the most rows PostgREST answers to one read;
 *  - the read asks for the exact count of matching rows (Prefer: count=exact),
 *    answered as `count`, and fails by name (`supabase_rows_capped`) when the
 *    project's own row cap answered fewer rows than max while more matched, so
 *    a cut list is never answered as a whole one; an answer naming no count
 *    fails as `supabase_count_unreadable`;
 *  - Pipedream's three tries of a failed read are not kept: the executor
 *    repeats a read, which this action is declared safe to repeat.
 */

const FILTERS: Readonly<Record<string, (value: string) => string>> = {
  equalTo: (v) => `eq.${v}`,
  notEqualTo: (v) => `neq.${v}`,
  greaterThan: (v) => `gt.${v}`,
  greaterThanOrEqualTo: (v) => `gte.${v}`,
  lessThan: (v) => `lt.${v}`,
  lessThanOrEqualTo: (v) => `lte.${v}`,
  // supabase-js wrote like('%v%'); PostgREST takes * as the wildcard in a URL.
  patternMatch: (v) => `like.*${v}*`,
  patternMatchCaseInsensitive: (v) => `ilike.*${v}*`,
}

/** The most rows one PostgREST read answers (the project's max rows). */
export const SELECT_MAX_ROWS = 1000

function maxOf(args: ActionArgs): number {
  const raw = args.max
  if (raw === undefined || raw === null || raw === '') return 20
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > SELECT_MAX_ROWS) throw invalid(`max must be a whole number from 1 to ${SELECT_MAX_ROWS}`)
  return raw
}

export const run: ActionRun = async (ctx, args) => {
  const table = identifierOf(args, 'table', 'supabase_table_missing') as string
  const column = identifierOf(args, 'column', null)
  const filterName = args.filter === undefined || args.filter === null || args.filter === '' ? undefined : args.filter
  const value = filterValueOf(args, 'value', null)
  if ((column !== undefined || filterName !== undefined || value !== undefined) && !(column !== undefined && filterName !== undefined && value !== undefined)) {
    throw invalid('column, filter and value go together: give all three or none')
  }
  if (filterName !== undefined && (typeof filterName !== 'string' || !Object.hasOwn(FILTERS, filterName))) {
    throw invalid(`filter must be one of ${Object.keys(FILTERS).join(', ')}`)
  }
  const orderBy = identifierOf(args, 'order_by', 'supabase_order_by_missing') as string
  const sort = args.sort_order
  if (sort !== undefined && sort !== null && sort !== '' && sort !== 'ascending' && sort !== 'descending') throw invalid('sort_order must be ascending or descending')
  const max = maxOf(args)

  const query: Array<readonly [string, string]> = []
  if (column !== undefined && value !== undefined && typeof filterName === 'string') query.push([column, FILTERS[filterName](value)])
  query.push(['order', `${orderBy}.${sort === 'ascending' ? 'asc' : 'desc'}`], ['limit', String(max)])

  const answer = await supabaseRequest(ctx, { method: 'GET', table, query, prefer: 'count=exact', writes: false })
  if (answer.count === null) throw new ActionFailure('supabase_count_unreadable', `Supabase did not say how many rows of ${table} matched, so a cut read cannot be told from a whole one`, 'not_applied')
  if (answer.rows.length < max && answer.count > answer.rows.length) {
    throw new ActionFailure('supabase_rows_capped', `Supabase answered ${answer.rows.length} of the ${Math.min(max, answer.count)} rows of ${table} asked for, so the project caps a read below max; lower max or read in pages`, 'not_applied')
  }
  return asSupabaseJs(answer, answer.count)
}
