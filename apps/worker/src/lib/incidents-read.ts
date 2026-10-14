/**
 * The incident record as a reader sees it (#2101, under #818): one page of
 * alert_incidents for the dashboard, every reader facing field resolved here.
 *
 * SCOPE. alert_incidents is service role only with no RLS policy (L124), so this
 * read is the only thing between one organization and another's incidents. It
 * asks the database for the caller's organization's rows and the platform's,
 * and then refuses, as an error, any row that is neither: a scope lost on the
 * way to the database must not reach a browser either.
 *
 * ORDER. Ongoing incidents first, then the newest start, then the id, so the
 * order is total and a page boundary never splits a tie differently on two
 * reads. PostgREST cannot sort on `ended_reason IS NULL`, so the ongoing rows
 * and the closed rows are two reads, and an offset walks their concatenation.
 * Closed rows are kept for 90 days of start; an ongoing one is shown however
 * old it is.
 *
 * FIELDS. The signal's label from the registry (an unknown signal is named as
 * unrecognised, never given an invented label); the subject by name, never a
 * raw id; the end and the duration from the span rule the Slack all-clear uses
 * (incident-span.ts). None of the bookkeeping (event ids, moved starts, the
 * lapse check's stamp) leaves this module.
 *
 * FAILURE. Any read that fails throws. An empty list would read as "no
 * incidents", which is the one thing this record must never claim falsely.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { INCIDENT_SIGNALS, incidentSignalLabel, isIncidentSignal, incidentSignal } from './incident-signals'
import { incidentDurationText, measureIncidentSpan } from './incident-span'

export const INCIDENTS_DEFAULT_LIMIT = 50
export const INCIDENTS_MAX_LIMIT = 100
/** How far back closed incidents are listed, by start. The table keeps rows 90 days after they close. */
export const INCIDENTS_LOOKBACK_DAYS = 90

export const UNNAMED_SUBJECT = 'Unnamed subject'
export const MISSING_WORKFLOW_SUBJECT = 'A workflow no longer on record'
export const ORGANIZATION_SUBJECT = 'This organization'

export type IncidentState = 'ongoing' | 'ended' | 'end_not_recorded'

/** One incident as the dashboard shows it. */
export interface IncidentView {
  id: string
  signal: string
  signal_label: string
  signal_known: boolean
  subject_name: string
  scope: 'org' | 'platform'
  started_at: string
  ended_at: string | null
  state: IncidentState
  duration: string | null
  pages_sent: number
}

export interface IncidentsPage {
  incidents: IncidentView[]
  has_more: boolean
  /** The offset that reads the next page, or null when there is none. */
  next_offset: number | null
}

/** Thrown for a read that failed or returned a row outside the caller's scope. */
export class IncidentReadError extends Error {}

const COLUMNS = 'id, signal, subject, subject_label, scope, organization_id, started_at, ended_at, ended_reason, pages_sent, window_minutes'

interface StoredIncident {
  id: string
  signal: string
  subject: string
  subject_label: string | null
  scope: 'org' | 'platform'
  organization_id: string | null
  started_at: string
  ended_at: string | null
  ended_reason: string | null
  pages_sent: number
  window_minutes: number | null
}

interface WorkflowName {
  id: string
  name: string
  deleted_at: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LEADING_UUID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(.*)$/is
const CONTAINS_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const WORKFLOW_SIGNALS: ReadonlySet<string> = new Set(INCIDENT_SIGNALS.filter((s) => s.subject === 'workflow').map((s) => s.signal))

/** The workflow id a workflow keyed subject starts with, and what follows it. */
function workflowKey(row: StoredIncident): { id: string; rest: string } | null {
  if (!WORKFLOW_SIGNALS.has(row.signal)) return null
  const m = LEADING_UUID.exec(row.subject)
  return m ? { id: m[1].toLowerCase(), rest: m[2] } : null
}

function subjectName(row: StoredIncident, workflows: ReadonlyMap<string, WorkflowName>): string {
  const label = row.subject_label?.trim() ? row.subject_label.trim() : null
  const key = workflowKey(row)
  if (key) {
    const wf = workflows.get(key.id)
    if (!wf) return label ?? MISSING_WORKFLOW_SUBJECT
    const name = label ?? `${wf.name}${key.rest}`
    return wf.deleted_at ? `${name} (deleted)` : name
  }
  if (label) return label
  if (isIncidentSignal(row.signal) && incidentSignal(row.signal).subject === 'organization') return ORGANIZATION_SUBJECT
  return CONTAINS_UUID.test(row.subject) || row.subject.trim() === '' ? UNNAMED_SUBJECT : row.subject
}

function toView(row: StoredIncident, workflows: ReadonlyMap<string, WorkflowName>, now: number): IncidentView {
  const { label, known } = incidentSignalLabel(row.signal)
  const state: IncidentState = row.ended_reason === null ? 'ongoing' : row.ended_at ? 'ended' : 'end_not_recorded'
  const duration = state === 'ended' ? incidentDurationText(measureIncidentSpan(row.started_at, row.ended_at, row.window_minutes, now)) : null
  return {
    id: row.id,
    signal: row.signal,
    signal_label: label,
    signal_known: known,
    subject_name: subjectName(row, workflows),
    scope: row.scope,
    started_at: row.started_at,
    ended_at: state === 'ended' ? row.ended_at : null,
    state,
    duration,
    pages_sent: Number(row.pages_sent),
  }
}

function failed(what: string, error: { message?: string } | null | undefined): IncidentReadError {
  return new IncidentReadError(`${what} could not be read: ${error?.message ?? 'no rows came back'}`)
}

/** One page of the caller's incident record. Throws IncidentReadError on any failed read. */
export async function readIncidents(
  supabase: SupabaseClient,
  orgId: string,
  opts: { limit: number; offset: number; now: number },
): Promise<IncidentsPage> {
  // The organization id is interpolated into a PostgREST filter, so it must be
  // exactly a uuid: anything else could widen the filter.
  if (!UUID.test(orgId)) throw new IncidentReadError('the caller has no organization to scope incidents to')
  const { limit, offset, now } = opts
  const scope = `organization_id.eq.${orgId},scope.eq.platform`
  const since = new Date(now - INCIDENTS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const open = await supabase
    .from('alert_incidents')
    .select(COLUMNS, { count: 'exact' })
    .or(scope)
    .is('ended_reason', null)
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit)
  if (open.error || !open.data || typeof open.count !== 'number') throw failed('Ongoing incidents', open.error)
  const openRows = open.data as unknown as StoredIncident[]

  let rows = openRows.slice(0, limit)
  let hasMore = openRows.length > limit
  if (!hasMore) {
    // The rest of the page comes from the closed rows, plus one to learn whether
    // more exist. Their offset is how far this page starts past the ongoing ones.
    const room = limit - rows.length
    const closedOffset = Math.max(0, offset - open.count)
    const closed = await supabase
      .from('alert_incidents')
      .select(COLUMNS)
      .or(scope)
      .not('ended_reason', 'is', null)
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .order('id', { ascending: false })
      .range(closedOffset, closedOffset + room)
    if (closed.error || !closed.data) throw failed('Closed incidents', closed.error)
    const closedRows = closed.data as unknown as StoredIncident[]
    rows = rows.concat(closedRows.slice(0, room))
    hasMore = closedRows.length > room
  }

  for (const row of rows) {
    if (row.organization_id !== orgId && row.scope !== 'platform') {
      throw new IncidentReadError(`refused incident ${row.id}: it belongs to another organization`)
    }
  }

  const workflowIds = [...new Set(rows.map(workflowKey).filter((k): k is { id: string; rest: string } => k !== null).map((k) => k.id))]
  const workflows = new Map<string, WorkflowName>()
  if (workflowIds.length > 0) {
    const wf = await supabase
      .from('workflows')
      .select('id, name, deleted_at')
      .eq('organization_id', orgId)
      .in('id', workflowIds)
      .limit(workflowIds.length)
    if (wf.error || !wf.data) throw failed('Workflow names', wf.error)
    for (const w of wf.data as unknown as WorkflowName[]) workflows.set(w.id.toLowerCase(), w)
  }

  return {
    incidents: rows.map((r) => toView(r, workflows, now)),
    has_more: hasMore,
    next_offset: hasMore ? offset + rows.length : null,
  }
}
