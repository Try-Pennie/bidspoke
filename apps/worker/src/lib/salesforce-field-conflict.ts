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
 * THE FIELD'S OWN HISTORY, where Salesforce keeps one (#2264). LastModifiedDate
 * says the RECORD was written, not which field. Engine Bidding's reject patch
 * starts milliseconds after the run's own prospect_trades Apex update writes
 * other fields of the same Prospect, so every resend of a timed out reject
 * patch found the record written since and called BidStatus__c moved for
 * holding "No Bid", which is the field's create default and the value the patch
 * exists to replace. Whether anybody changed THIS field since the write began
 * is what Salesforce records in field history, for the fields an admin tracks
 * (BidStatus__c on Prospect__c is one). So a field the rule above calls moved is
 * asked about there (readFieldHistory): a tracked field with no change recorded
 * since the margin before the write began still holds its value from before the
 * write, and is sent. A recorded change, a field Salesforce keeps no history
 * of, or a history that cannot be read leaves the field moved: the history can
 * only clear a field, never accuse one. It costs a resender up to two queries,
 * only for a record whose fields the rule above called moved, and nothing on
 * the run's own path, so the reject patch's 1,500 ms budget is untouched.
 *
 * Here rather than in either job so the drain's send path (writeback-replay.ts),
 * which the read-back itself imports, can reach it without a cycle.
 */
import { isSalesforceApiName, isSalesforceRecordId } from './salesforce-names'

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
 * What Salesforce's field history says about the fields asked about since a
 * write began (#2264). `read`: `tracked` are the asked fields Salesforce keeps a
 * history of, and `changes` every recorded change to one of them from the
 * margin before the write began. `not_kept`: the object has no field history
 * this code reads. `unread`: the history could not be read, with why.
 * `quotable`, when the field definitions were read, are the asked fields whose
 * values an alert may quote (QUOTABLE_FIELD_TYPES).
 */
export type FieldHistory =
  | { kind: 'read'; tracked: string[]; changes: Array<{ field: string; atMs: number }>; quotable: string[] }
  | { kind: 'not_kept'; quotable?: string[] }
  | { kind: 'unread'; why: string; quotable?: string[] }

/**
 * The Salesforce field types whose values the conflict alert quotes (#2264): a
 * value list the org defines, or a checkbox, which cannot carry what a lead
 * typed. Every other type (text, email, phone, a number such as an income, a
 * date such as a birth date) can hold a lead's personal data, and a field whose
 * type is not known is treated the same: its values never reach Slack.
 */
export const QUOTABLE_FIELD_TYPES: readonly string[] = ['Picklist', 'Checkbox']

/** Rows one history query asks for; an answer with more reads as unread, never as complete. */
export const FIELD_HISTORY_ROW_LIMIT = 200

/**
 * The history object of `sfObject` and the field naming its record: a custom
 * object's `X__History` by ParentId, and Lead's LeadHistory by LeadId. Any other
 * standard object is not one this code reads (Opportunity keeps its history
 * elsewhere), so it has none here, the side that clears nothing.
 */
function historyObjectOf(sfObject: string): { object: string; parent: string } | null {
  if (/__c$/.test(sfObject)) return { object: sfObject.replace(/__c$/, '__History'), parent: 'ParentId' }
  if (sfObject === 'Lead') return { object: 'LeadHistory', parent: 'LeadId' }
  return null
}

/** A SOQL datetime literal in whole seconds, rounded down, so a change in that second is included. */
const soqlTime = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * The two queries that read one record's field history, as `/query?q=` paths
 * below the API version: which of `fields` Salesforce tracks, then the changes
 * to the tracked ones from the margin before `sinceMs`. Null when the object has
 * no field history this code reads, or a name is not a plain Salesforce name
 * (nothing else reaches a query).
 */
export function fieldHistoryQueries(
  sfObject: string,
  recordId: string,
  fields: string[],
  sinceMs: number,
): { tracked: string; changes: (tracked: string[]) => string } | null {
  const history = historyObjectOf(sfObject)
  if (!history || fields.length === 0 || !Number.isFinite(sinceMs)) return null
  if (!isSalesforceApiName(sfObject) || !isSalesforceRecordId(recordId) || !fields.every(isSalesforceApiName)) return null
  const quoted = (names: string[]) => names.map((f) => `'${f}'`).join(',')
  const path = (soql: string) => `/query?q=${encodeURIComponent(soql)}`
  return {
    tracked: path(`SELECT QualifiedApiName, DataType, IsFieldHistoryTracked FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${sfObject}' AND QualifiedApiName IN (${quoted(fields)})`),
    changes: (tracked) =>
      path(
        `SELECT Field, CreatedDate FROM ${history.object} WHERE ${history.parent} = '${recordId}' AND Field IN (${quoted(tracked)}) AND CreatedDate >= ${soqlTime(sinceMs - LAST_MODIFIED_MARGIN_MS)} ORDER BY CreatedDate LIMIT ${FIELD_HISTORY_ROW_LIMIT}`,
      ),
  }
}

/** One Salesforce GET as a resender makes it: an answer, or none. */
export type HistoryGet = (path: string) => Promise<{ kind: 'answer'; status: number; text: string } | { kind: 'no_answer'; error: string }>

/** The rows of a query answer, or null when it is not a complete one. */
function queryRecords(text: string): Array<Record<string, unknown>> | null {
  try {
    const v = JSON.parse(text) as { done?: unknown; totalSize?: unknown; records?: unknown }
    if (!v || v.done !== true || !Array.isArray(v.records)) return null
    if (typeof v.totalSize === 'number' && v.totalSize > v.records.length) return null
    return v.records as Array<Record<string, unknown>>
  } catch {
    return null
  }
}

/**
 * Reads what Salesforce's field history says about `fields` of one record since
 * `sinceMs` (#2264), through the resender's own GET. A call with no answer is
 * returned as `no_answer`, for the resender to stop on as it stops on any other;
 * every other failure is `unread`, which clears no field.
 */
export async function readFieldHistory(
  get: HistoryGet,
  args: { sfObject: string; recordId: string; fields: string[]; sinceMs: number },
): Promise<FieldHistory | { kind: 'no_answer'; error: string }> {
  // With no readable start there is no "since" to ask about, which clears nothing.
  if (!Number.isFinite(args.sinceMs)) return { kind: 'unread', why: 'the write has no readable start time' }
  const queries = fieldHistoryQueries(args.sfObject, args.recordId, args.fields, args.sinceMs)
  if (!queries) return { kind: 'not_kept' }
  const ask = async (path: string, what: string): Promise<Array<Record<string, unknown>> | { kind: 'unread'; why: string } | { kind: 'no_answer'; error: string }> => {
    const answer = await get(path)
    if (answer.kind === 'no_answer') return answer
    if (answer.status < 200 || answer.status >= 300) return { kind: 'unread', why: `Salesforce answered ${answer.status} to the ${what} query` }
    return queryRecords(answer.text) ?? { kind: 'unread', why: `the ${what} query's answer was not a complete list` }
  }
  const definitions = await ask(queries.tracked, 'field definitions')
  if (!Array.isArray(definitions)) return definitions
  const asked = definitions.filter((r) => typeof r.QualifiedApiName === 'string' && args.fields.includes(r.QualifiedApiName))
  const names = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.QualifiedApiName as string)
  // Only an explicit true is tracked, and only a listed type is quotable: anything else is the side that clears and quotes nothing.
  const tracked = names(asked.filter((r) => r.IsFieldHistoryTracked === true))
  const quotable = names(asked.filter((r) => typeof r.DataType === 'string' && QUOTABLE_FIELD_TYPES.includes(r.DataType)))
  if (tracked.length === 0) return { kind: 'read', tracked: [], changes: [], quotable }
  const changeRows = await ask(queries.changes(tracked), 'field history')
  if (!Array.isArray(changeRows)) return changeRows.kind === 'unread' ? { ...changeRows, quotable } : changeRows
  const changes: Array<{ field: string; atMs: number }> = []
  for (const r of changeRows) {
    const atMs = salesforceTimeMs(r.CreatedDate)
    // A row with no readable field or time is a change nobody can place: it clears nothing.
    if (typeof r.Field !== 'string' || !Number.isFinite(atMs)) return { kind: 'unread', why: 'a field history row had no readable field or time', quotable }
    changes.push({ field: r.Field, atMs })
  }
  return { kind: 'read', tracked, changes, quotable }
}

/**
 * Whether the history proves nobody changed `field` since the write began: it
 * is tracked, and no change to it is recorded later than the margin before the
 * write began. A change inside the margin may be after the write began, so it
 * proves nothing (Salesforce stamps it in whole seconds, on its own clock).
 */
function historyClears(field: string, history: FieldHistory | undefined, sinceMs: number | undefined): boolean {
  if (!history || history.kind !== 'read' || sinceMs === undefined || !Number.isFinite(sinceMs)) return false
  if (!history.tracked.includes(field)) return false
  return !history.changes.some((c) => c.field === field && c.atMs + LAST_MODIFIED_MARGIN_MS > sinceMs)
}

/**
 * The fields of `fields` that another writer moved since the write began, per
 * the header's rule. `current` is one read of the record naming LastModifiedDate
 * and every field; `sinceMs` is when the write began (absent, the record is
 * judged as written since); `earlier` are bodies an earlier write of ours sent
 * to the same record, whose values are ours and which this newer write replaces;
 * `history`, when read, is what Salesforce's field history says since then,
 * which can only clear a field (#2264).
 */
export function fieldsMovedSince(args: {
  fields: string[]
  body: Record<string, unknown>
  current: Record<string, unknown>
  sinceMs: number | undefined
  earlier: Array<Record<string, unknown>>
  history?: FieldHistory
}): string[] {
  const { fields, body, current, sinceMs, earlier, history } = args
  const lastModifiedMs = salesforceTimeMs(current.LastModifiedDate)
  // Nobody has written the record since this write began: whatever it holds
  // came before the write, which is what the write was sent to replace.
  const untouched = Number.isFinite(lastModifiedMs) && sinceMs !== undefined && Number.isFinite(sinceMs) && lastModifiedMs + LAST_MODIFIED_MARGIN_MS <= sinceMs
  if (untouched) return []
  return fields.filter((f) => {
    const now = current[f]
    if (isBlank(now) || sameSalesforceValue(now, body[f])) return false
    // A value an earlier write of ours sent is ours, and this newer write replaces it.
    if (earlier.some((e) => Object.hasOwn(e, f) && sameSalesforceValue(now, e[f]))) return false
    // The field's own history says nobody changed it since: it still holds its
    // value from before the write, which is what the write replaces.
    return !historyClears(f, history, sinceMs)
  })
}

/**
 * One field left out as moved, for the conflict alert (#2264): what it held and
 * what was being sent, only when its type is quotable (QUOTABLE_FIELD_TYPES),
 * and what its history says.
 */
export interface MovedFieldValues {
  field: string
  /** Present only for a field of a quotable type: anything else may be a lead's personal data. */
  held?: unknown
  sending?: unknown
  /** `changed`: its history records a change since the write began, the latest at `changed_at`. */
  history: 'changed' | 'not_kept' | 'unread'
  changed_at?: string
}

/** The values behind each moved field, from the same record read and history the rule judged it by. */
export function movedFieldValues(args: {
  moved: string[]
  body: Record<string, unknown>
  current: Record<string, unknown>
  sinceMs: number | undefined
  history?: FieldHistory
}): MovedFieldValues[] {
  const { moved, body, current, sinceMs, history } = args
  const since = sinceMs !== undefined && Number.isFinite(sinceMs) ? sinceMs : Number.NEGATIVE_INFINITY
  return moved.map((field) => {
    const base = history?.quotable?.includes(field) ? { field, held: current[field] ?? null, sending: body[field] ?? null } : { field }
    if (!history || history.kind === 'unread') return { ...base, history: 'unread' as const }
    if (history.kind === 'not_kept' || !history.tracked.includes(field)) return { ...base, history: 'not_kept' as const }
    const latest = Math.max(...history.changes.filter((c) => c.field === field && c.atMs + LAST_MODIFIED_MARGIN_MS > since).map((c) => c.atMs))
    // Tracked and moved means a change was recorded; one that is not is a read that cannot be placed.
    return Number.isFinite(latest) ? { ...base, history: 'changed' as const, changed_at: new Date(latest).toISOString() } : { ...base, history: 'unread' as const }
  })
}
