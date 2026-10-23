import { CALENDAR_API, choice, googleJson, googleTargetOf, invalid, optionalBoolean, optionalText, text } from '../google/call'
import { calendarUrl, SEND_UPDATES } from '../google/calendar'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.calendar-create-event, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Create Event (PipedreamHQ/pipedream
 * components/google_calendar/actions/create-event/create-event.mjs and
 * actions/common/create-event-common.mjs, at commit b7d67916), with the props
 * the steps set: a summary, description and location; a start and end, each a
 * date when ten characters or fewer and a date time otherwise; the time zone,
 * read from the calendar's own setting when the step names none; attendees (a
 * list, or text separated by commas); sendUpdates; visibility; and a Meet room.
 * One events.insert, the event returned as Google answers it. What differs, on
 * purpose: a start or end that is neither a date nor a date time is refused
 * before anything is sent; repeating events, colours and adding the mailbox
 * as an attendee are not offered, since no step set them.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/
const VISIBILITY = ['default', 'public', 'private', 'confidential'] as const
const MAILBOX = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

function when(args: ActionArgs, key: string): { date: string } | { dateTime: string } {
  const value = text(args, key).trim()
  if (value.length <= 10 && DATE.test(value)) return { date: value }
  if (DATE_TIME.test(value)) return { dateTime: value }
  throw invalid(`${key} must be a date (2026-10-23) or a date time (2026-10-23T15:00:00-04:00)`)
}

function attendeesOf(args: ActionArgs): Array<{ email: string }> {
  const raw = args.attendees
  if (raw === undefined || raw === null || raw === '') return []
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : null
  if (list === null || !list.every((a): a is string => typeof a === 'string')) throw invalid('attendees must be a list of email addresses, or text separated by commas')
  const emails = list.map((a) => a.trim()).filter((a) => a !== '')
  if (!emails.every((e) => MAILBOX.test(e))) throw invalid('attendees holds something that is not an email address')
  return emails.map((email) => ({ email }))
}

export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const calendar = calendarUrl(args)
  const start = when(args, 'start')
  const end = when(args, 'end')
  const attendees = attendeesOf(args)
  const sendUpdates = choice(args, 'send_updates', SEND_UPDATES)
  const visibility = choice(args, 'visibility', VISIBILITY)
  const meet = optionalBoolean(args, 'create_meet_room')
  let timeZone = optionalText(args, 'time_zone')
  if (timeZone === null) {
    const setting = await googleJson(ctx, { method: 'GET', url: `${CALENDAR_API}/users/me/settings/timezone`, what: 'GET the calendar\'s time zone', effect: 'read' })
    timeZone = typeof setting.value === 'string' ? setting.value : null
  }
  const params = new URLSearchParams({ sendUpdates })
  const event: Record<string, JsonValue> = {
    start: { ...start, ...(timeZone === null ? {} : { timeZone }) },
    end: { ...end, ...(timeZone === null ? {} : { timeZone }) },
    attendees,
    visibility,
  }
  for (const key of ['summary', 'description', 'location'] as const) {
    const value = optionalText(args, key)
    if (value !== null) event[key] = value
  }
  if (meet) {
    params.set('conferenceDataVersion', '1')
    event.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  }
  return googleJson(ctx, { method: 'POST', url: `${calendar}/events?${params.toString()}`, body: event, what: 'POST events insert', effect: 'write' })
}
