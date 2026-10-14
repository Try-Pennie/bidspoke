/**
 * Reads the incident outbox (#2099) out of a test's fake KV, in the order the
 * drain would take it, so each check's tests can say which transitions it
 * recorded. Accepts either store shape the fakes use: plain values, or values
 * wrapped with their expiry.
 */
import { vi } from 'vitest'
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

/**
 * Runs fn with a clock that moves one millisecond on every Date.now() read,
 * starting from the real time. Two reads of the clock in one pass then never
 * agree, so a record stamped from a second read sorts after one stamped from the
 * first: the ordering race that, on a real clock, shows only when two reads
 * straddle a millisecond.
 */
export async function withTickingClock<T>(fn: () => Promise<T>): Promise<T> {
  let t = Date.now()
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => t++)
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}
