/**
 * The per write marker on a post-answer Salesforce update (#2023, #2020).
 *
 * The read-back (lib/salesforce-read-back.ts) has to tell whether a write that
 * was cut off landed. Field equality cannot say so: Salesforce rewrites types and
 * timestamps, and other writers move the same fields (#2015). So every
 * post-answer `update` on an object that has the `Bidspoke_Write__c` field
 * (Text 255, writable only by the Bidspoke integration user, #2020) carries this
 * write's own stamp, and "landed" means the record holds it.
 *
 * THE ENGINE STAMPS IT, NOT THE CANVAS (Dan, 2026-10-15): nobody has to edit or
 * push a workflow for this. The walk decides "post-answer" by its one fact, a
 * response already pending when the step starts, the same fact that starts the
 * at-risk watch, and hands the stamp to the Salesforce node through the run's
 * context for that step only. A write before the answer is never stamped.
 *
 * FORMAT: `<execution id>:<step namespace>:<attempt>`, at most 255 characters.
 * The run and the step name the write; one step writes one record once per run.
 * The attempt is 0 for the run's own step, every retry inside it included: those
 * retries send the identical PATCH, so any of them landing is this write landing,
 * and one body means the at-risk record holds exactly what was sent. The
 * read-back's own resends carry 1 and 2, so a landed resend can be told from a
 * late original. A marker that would not fit (a step name over 216 characters)
 * is not stamped at all: Salesforce would refuse the whole PATCH, and losing the
 * write to guard it would be the worse failure. Such a write is then not the
 * read-back's to judge, and keeps the held alert.
 *
 * A LATER STAMP DOES NOT COVER AN EARLIER WRITE. A record written twice in one
 * run (a Prospect's `patch_prospect` then `patch_prospect_success`) holds only
 * the last stamp that landed. The read-back merges a record's writes in attempt
 * order and decides each by its own stamp (#2020).
 */

/** The field on Applicant__c, Prospect__c and Lead that holds the marker (#2020). */
export const WRITE_MARKER_FIELD = 'Bidspoke_Write__c'

/** Its length in Salesforce: Text(255). */
export const WRITE_MARKER_MAX_LENGTH = 255

/**
 * The objects that have the field. Submission__c does not: its read-back would
 * need a marker of its own, which is a decision recorded on #2023, not a field
 * to borrow.
 */
export const WRITE_MARKER_OBJECTS: ReadonlySet<string> = new Set(['Applicant__c', 'Prospect__c', 'Lead'])

/** The attempt the run's own step stamps, every retry inside it included. */
export const ENGINE_ATTEMPT = 0

export function stampsWrites(object: string): boolean {
  return WRITE_MARKER_OBJECTS.has(object)
}

/** This write's marker, or null when it would not fit the field. */
export function writeMarker(executionId: string, stepNamespace: string, attempt: number): string | null {
  const marker = `${executionId}:${stepNamespace}:${attempt}`
  return marker.length <= WRITE_MARKER_MAX_LENGTH ? marker : null
}

export interface ParsedWriteMarker {
  executionId: string
  stepNamespace: string
  attempt: number
}

/**
 * A marker read back from a record, or null for anything else. The execution id
 * holds no colon, so the step is everything between the first colon and the
 * last, whatever it holds.
 */
export function parseWriteMarker(value: unknown): ParsedWriteMarker | null {
  if (typeof value !== 'string') return null
  const first = value.indexOf(':')
  const last = value.lastIndexOf(':')
  if (first <= 0 || last <= first + 1) return null
  const attemptText = value.slice(last + 1)
  if (!/^\d+$/.test(attemptText)) return null
  return { executionId: value.slice(0, first), stepNamespace: value.slice(first + 1, last), attempt: Number(attemptText) }
}

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The body a post-answer update sends: the marker added on an object that has
 * the field, and nothing changed otherwise. A marker a canvas body carried is
 * replaced, since only the engine's stamp means anything to the read-back.
 */
export function stampWriteMarker(body: unknown, object: string, marker: string | undefined): unknown {
  if (!marker || !stampsWrites(object) || !isPlainRecord(body)) return body
  return { ...body, [WRITE_MARKER_FIELD]: marker }
}

/**
 * Whether the read-back judges this held update: an object with the field, and a
 * body carrying this step's own engine stamp. An update held from before the
 * stamp shipped, or one whose marker would not fit, is not the read-back's, and
 * keeps the held alert (#2163).
 */
export function readBackOwns(object: string, body: unknown, executionId: string, stepNamespace: string): boolean {
  if (!stampsWrites(object) || !isPlainRecord(body)) return false
  const expected = writeMarker(executionId, stepNamespace, ENGINE_ATTEMPT)
  return expected !== null && body[WRITE_MARKER_FIELD] === expected
}

/**
 * Runs one step with the marker on the run's context, and takes it back however
 * the step ends. One slot holds because only the walk's own sequential loop sets
 * it, as with the at-risk watch's request hook.
 */
export async function withWriteMarker<T>(ctx: { writeMarker?: string }, marker: string | undefined, work: () => Promise<T>): Promise<T> {
  ctx.writeMarker = marker
  try {
    return await work()
  } finally {
    ctx.writeMarker = undefined
  }
}
