import type { ExpectedLogpushJob } from '../lib/logpush-expectation'
import { DELIVERY_STALE_MS } from '../lib/logpush-expectation'

/**
 * Fields in the `workers_trace_events` dataset that carry consumer data.
 *
 * `Logs` is the console messages of each invocation, which is where an
 * applicant's SSN was found being exported (#1214, #1007). `Event` is the
 * source event, which Cloudflare documents as carrying request metadata and
 * headers, so it holds partner API keys and the consumer's IP (#958).
 * `Exceptions` is included because an uncaught error routinely quotes the value
 * that caused it.
 *
 * These are named so that adding one to a job reads as what it is, rather than
 * as ordinary configuration drift.
 */
export const PII_BEARING_FIELDS = ['Event', 'Logs', 'Exceptions'] as const

export interface ObservedLogpushJob {
  id: number
  name: string
  destinationHost: string
  dataset: string
  enabled: boolean
  fieldNames: string[]
  /**
   * Epoch ms of the last successful push, or null when there is no usable one.
   * Null covers two different situations, which `lastCompleteRaw` separates.
   */
  lastCompleteMs: number | null
  /**
   * What the API actually reported, or null when it reported nothing.
   *
   * Needed because `Date.parse` yields NaN on a bad string and `now - NaN > x`
   * is FALSE, so an unparseable timestamp would otherwise land on the healthy
   * side of the staleness test and report a dead job as fine (L50).
   */
  lastCompleteRaw: string | null
}

export interface ObservedLogpush {
  jobs: ObservedLogpushJob[]
  /** Non-empty when the account could not be read. See the guard in the diff. */
  unreadable: string[]
}

function piiIn(fields: readonly string[]): string[] {
  return PII_BEARING_FIELDS.filter((f) => fields.includes(f))
}

/**
 * Every way the live account differs from the expectation, as sentences.
 *
 * An UNREADABLE account short-circuits everything else. A reader that cannot
 * see the jobs would otherwise report each expected job as missing, which is a
 * confident accusation built on no evidence, and the remedy it implies (go and
 * re-create them) is the opposite of what is needed (L98, L215).
 */
export function logpushDifferences(
  observed: ObservedLogpush,
  expected: readonly ExpectedLogpushJob[],
  nowMs: number,
): string[] {
  if (observed.unreadable.length > 0) {
    return observed.unreadable.map(
      (u) => `Logpush could not be checked, so nothing below is known: ${u}`,
    )
  }

  const out: string[] = []
  const byId = new Map(observed.jobs.map((j) => [j.id, j]))

  for (const want of expected) {
    const got = byId.get(want.id)
    if (got === undefined) {
      out.push(
        `Logpush job ${String(want.id)} (${want.name}, to ${want.destinationHost}) is gone from the account.`,
      )
      continue
    }
    if (got.destinationHost !== want.destinationHost) {
      out.push(
        `Logpush job ${want.name} now sends to ${got.destinationHost}, expected ${want.destinationHost}.`,
      )
    }
    if (got.dataset !== want.dataset) {
      out.push(`Logpush job ${want.name} now reads dataset ${got.dataset}, expected ${want.dataset}.`)
    }
    if (want.enabled && !got.enabled) {
      out.push(`Logpush job ${want.name} has been disabled.`)
    }
    if (!want.enabled && got.enabled) {
      out.push(`Logpush job ${want.name} has been enabled.`)
    }

    const added = got.fieldNames.filter((f) => !want.fieldNames.includes(f))
    const removed = want.fieldNames.filter((f) => !got.fieldNames.includes(f))
    const addedPii = piiIn(added)
    if (addedPii.length > 0) {
      out.push(
        `Logpush job ${want.name} now exports ${addedPii.join(', ')} to ${got.destinationHost}. ` +
          'Those fields carry personal data, so consumer information is leaving Pennie.',
      )
    }
    const addedPlain = added.filter((f) => !addedPii.includes(f))
    if (addedPlain.length > 0) {
      out.push(`Logpush job ${want.name} has gained the field(s) ${addedPlain.join(', ')}.`)
    }
    if (removed.length > 0) {
      out.push(`Logpush job ${want.name} no longer exports ${removed.join(', ')}.`)
    }

    if (got.enabled) {
      if (got.lastCompleteRaw === null) {
        out.push(
          `Logpush job ${want.name} is enabled and has never completed a push, so it is delivering nothing.`,
        )
      } else if (got.lastCompleteMs === null) {
        // Distinct from never having delivered: the API said something and we
        // could not read it, which is a different remedy (L11).
        out.push(
          `Logpush job ${want.name} reported a last_complete of "${got.lastCompleteRaw}", ` +
            'which is not a date, so whether it is still delivering is unknown.',
        )
      } else if (nowMs - got.lastCompleteMs > DELIVERY_STALE_MS) {
        const hours = Math.floor((nowMs - got.lastCompleteMs) / (60 * 60 * 1000))
        out.push(
          `Logpush job ${want.name} has not delivered for ${String(hours)} hours.`,
        )
      }
    }
  }

  for (const got of observed.jobs) {
    if (expected.some((w) => w.id === got.id)) continue
    const pii = piiIn(got.fieldNames)
    if (pii.length > 0) {
      out.push(
        `An unexpected Logpush job (${got.name}, ${String(got.id)}) is sending ${pii.join(', ')} ` +
          `to ${got.destinationHost}. Those fields carry personal data, so consumer information ` +
          'is leaving Pennie to a destination nobody here has recorded.',
      )
    } else {
      out.push(
        `An unexpected Logpush job (${got.name}, ${String(got.id)}) is sending to ${got.destinationHost}.`,
      )
    }
  }

  return out
}
