/**
 * Reads the incident outbox (#2099) out of a test's fake KV, in the order the
 * drain would take it, so each check's tests can say which transitions it
 * recorded. Accepts either store shape the fakes use: plain values, or values
 * wrapped with their expiry.
 */
import { INCIDENT_OUTBOX_PREFIX, parseIncidentEvent, type IncidentEvent } from '../incident-outbox'

type Stored = string | { value: string }

export function outboxEvents(store: Map<string, Stored>): IncidentEvent[] {
  return [...store.entries()]
    .filter(([k]) => k.startsWith(INCIDENT_OUTBOX_PREFIX))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => {
      const parsed = parseIncidentEvent(typeof v === 'string' ? v : v.value)
      if ('error' in parsed) throw new Error(`an outbox event the drain would refuse: ${parsed.error}`)
      return parsed
    })
}

/** The transitions alone, as `type subject` (and the reason for an end), for compact assertions. */
export function transitions(store: Map<string, Stored>): string[] {
  return outboxEvents(store).map((e) => `${e.type} ${e.subject}${e.type === 'ended' ? ` ${e.reason}` : ''}`)
}
