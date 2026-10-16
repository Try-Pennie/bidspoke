/**
 * The one rule for a Salesforce field another writer moved (#2023, #468).
 *
 * Both automatic resenders of a failed Salesforce write use it: the read-back
 * (salesforce-read-back.ts), which resends writes cut off in flight, and the
 * drain (writeback-drain.ts), which resends writes stored after Salesforce
 * answered with a failure. Neither may overwrite a value somebody else set
 * since the write began, so neither has a rule of its own.
 *
 * NEWER WINS, read off LastModifiedDate. A record nobody has written since the
 * write began holds only values from before it, which are exactly what the
 * write was sent to replace, so every field is sent. A record written since, or
 * one whose LastModifiedDate cannot be read, is judged field by field: a field
 * that now holds a different, non-blank value, which no earlier write of ours
 * sent, has moved, and is left out. That side overwrites nothing.
 *
 * Here rather than in either job so the drain's send path (writeback-replay.ts),
 * which the read-back itself imports, can reach it without a cycle.
 */

/**
 * Salesforce keeps LastModifiedDate in whole seconds, and its clock is not the
 * Worker's. A record last written within this of a write's start is read as
 * written since, the side that overwrites nothing.
 */
export const LAST_MODIFIED_MARGIN_MS = 2_000

const isBlank = (v: unknown) => v === null || v === undefined || v === ''

/** A Salesforce time read as ms: `2026-10-15T12:00:00.000+0000` included. NaN otherwise. */
export function salesforceTimeMs(v: unknown): number {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(v)) return Number.NaN
  return Date.parse(v.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'))
}

/**
 * Whether a value Salesforce holds is the value a write sent, allowing for the
 * ways Salesforce spells a value back: a number as text or text as a number, a
 * time to the second in +0000, a checkbox as true or "true". Anything else
 * different is different, the side that overwrites nothing.
 */
export function sameSalesforceValue(current: unknown, sent: unknown): boolean {
  if (current === sent) return true
  if (isBlank(current) && isBlank(sent)) return true
  if (isBlank(current) || isBlank(sent)) return false
  const asNumber = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Number.NaN)
  if (typeof current === 'number' || typeof sent === 'number') {
    const a = asNumber(current)
    const b = asNumber(sent)
    return Number.isFinite(a) && Number.isFinite(b) && a === b
  }
  if (typeof current === 'boolean' || typeof sent === 'boolean') {
    const asBoolean = (v: unknown) => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null)
    const a = asBoolean(current)
    return a !== null && a === asBoolean(sent)
  }
  if (typeof current === 'string' && typeof sent === 'string') {
    const a = salesforceTimeMs(current)
    const b = salesforceTimeMs(sent)
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.floor(a / 1000) === Math.floor(b / 1000)
    return false
  }
  return JSON.stringify(current) === JSON.stringify(sent)
}

/**
 * The fields of `fields` that another writer moved since the write began, per
 * the header's rule. `current` is one read of the record naming LastModifiedDate
 * and every field; `sinceMs` is when the write began (absent, the record is
 * judged as written since); `earlier` are bodies an earlier write of ours sent
 * to the same record, whose values are ours and which this newer write replaces.
 */
export function fieldsMovedSince(args: {
  fields: string[]
  body: Record<string, unknown>
  current: Record<string, unknown>
  sinceMs: number | undefined
  earlier: Array<Record<string, unknown>>
}): string[] {
  const { fields, body, current, sinceMs, earlier } = args
  const lastModifiedMs = salesforceTimeMs(current.LastModifiedDate)
  // Nobody has written the record since this write began: whatever it holds
  // came before the write, which is what the write was sent to replace.
  const untouched = Number.isFinite(lastModifiedMs) && sinceMs !== undefined && Number.isFinite(sinceMs) && lastModifiedMs + LAST_MODIFIED_MARGIN_MS <= sinceMs
  if (untouched) return []
  return fields.filter((f) => {
    const now = current[f]
    if (isBlank(now) || sameSalesforceValue(now, body[f])) return false
    // A value an earlier write of ours sent is ours, and this newer write replaces it.
    return !earlier.some((e) => Object.hasOwn(e, f) && sameSalesforceValue(now, e[f]))
  })
}
