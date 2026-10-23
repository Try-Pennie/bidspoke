import { choice, googleSend, googleTargetOf, invalid, text } from '../google/call'
import { calendarUrl, SEND_UPDATES } from '../google/calendar'
import type { ActionArgs, ActionContext, ActionRun, JsonValue } from '../types'

/**
 * google.calendar-delete-event, version 1 (#2337). Released: never edit it; a
 * change is version 2 (the fingerprint check refuses an edit).
 *
 * Pipedream's Delete Event (PipedreamHQ/pipedream
 * components/google_calendar/actions/delete-event/delete-event.mjs, at commit
 * b7d67916): one events.delete. What differs, on purpose: an event already
 * deleted (HTTP 410 Gone) is answered as deleted, `already_deleted: true`,
 * rather than failed, so a repeat after an uncertain outcome is safe (L745: a
 * deleted record is absent, not an error); one that never existed (404) still
 * fails by name. Answers `{ deleted, event_id, already_deleted }`.
 */
export const run: ActionRun = async (ctx: ActionContext, args: ActionArgs): Promise<JsonValue> => {
  googleTargetOf(ctx.target)
  const calendar = calendarUrl(args)
  const eventId = text(args, 'event_id').trim()
  if (!/^[A-Za-z0-9_-]{1,1024}$/.test(eventId)) throw invalid('event_id must be an event\'s id')
  const sendUpdates = choice(args, 'send_updates', SEND_UPDATES)
  const { status, response } = await googleSend(ctx, {
    method: 'DELETE', url: `${calendar}/events/${eventId}?sendUpdates=${sendUpdates}`, what: 'DELETE event', effect: 'write', answers: [410],
  })
  await response.body?.cancel()
  return { deleted: true, event_id: eventId, already_deleted: status === 410 }
}
