import type { ActionArgs } from '../types'
import { CALENDAR_API, invalid, optionalText } from './call'

/**
 * What the Calendar actions share (#2337), as Pipedream's Google Calendar app
 * built it (components/google_calendar, at commit b7d67916): the calendar is
 * `primary` unless the step names one, and its id goes into the path encoded.
 */

export const SEND_UPDATES = ['none', 'all', 'externalOnly'] as const

export function calendarUrl(args: ActionArgs): string {
  const id = optionalText(args, 'calendar_id')?.trim() || 'primary'
  if (id.length > 256) throw invalid('calendar_id is too long to be a calendar\'s id')
  return `${CALENDAR_API}/calendars/${encodeURIComponent(id)}`
}
