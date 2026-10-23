import { ActionFailure } from '../failure'
import { googleJson, googleTargetOf, optionalText, unreadable, type GoogleRequest } from '../google/call'
import { calendarUrl } from '../google/calendar'
import { CALENDAR_LIST_MAX_PAGES } from '../google/limits'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.calendar-list-events, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * Calendar events.list, as the agent availability code steps read a calendar:
 * the events between `time_min` and `time_max`, recurring events expanded and
 * ordered by start (singleEvents, orderBy startTime), optionally matching
 * `query`, every page. Cancelled events are left out, as Calendar leaves them
 * out unless asked (L745). Past CALENDAR_LIST_MAX_PAGES pages of 250 it fails by
 * name (`google_calendar_list_page_cap`), never a prefix.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const calendar = calendarUrl(args)
  const items: JsonValue[] = []
  let pageToken: string | null = null
  for (let page = 1; page <= CALENDAR_LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250' })
    for (const [arg, param] of [['time_min', 'timeMin'], ['time_max', 'timeMax'], ['query', 'q']] as const) {
      const value = optionalText(args, arg)
      if (value !== null) params.set(param, value)
    }
    if (pageToken !== null) params.set('pageToken', pageToken)
    const request: GoogleRequest = { method: 'GET', url: `${calendar}/events?${params.toString()}`, what: `GET events page ${page}`, effect: 'read' }
    const answer = await googleJson(ctx, request)
    if (!Array.isArray(answer.items)) throw unreadable(request, 'held no items list')
    items.push(...(answer.items as readonly JsonValue[]))
    if (typeof answer.nextPageToken !== 'string' || answer.nextPageToken === '') return { items }
    pageToken = answer.nextPageToken
  }
  throw new ActionFailure('google_calendar_list_page_cap', `the calendar has more than ${CALENDAR_LIST_MAX_PAGES} pages of events in the window, so none is returned; narrow it`, 'not_applied')
}
