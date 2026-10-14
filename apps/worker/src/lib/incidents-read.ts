/**
 * The incident record as a reader sees it (#2101, under #818), in the two
 * shapes the dashboard shows it (settled with Dan on 2026-10-14):
 *
 *  - ONGOING: every incident still open, each one line under the page header.
 *  - CLOSED: the Incidents card at the bottom of the page, one page at a time,
 *    holding only incidents that have closed, inside the page's own 7, 14 or 30
 *    day window. An incident is in the window when it started in it or ended in
 *    it. An open incident is never in the card, so each fact is stated once.
 *
 * SCOPE. alert_incidents is service role only with no RLS policy (L124), so this
 * read is the only thing between one organization and another's incidents. It
 * asks the database for the caller's organization's rows and the platform's,
 * and then refuses, as an error, any row that is neither: a scope lost on the
 * way to the database must not reach a browser either.
 *
 * ORDER. The newest start first, then the id, so the order is total and a page
 * boundary never splits a tie differently on two reads.
 *
 * FIELDS. The signal's label from the registry (an unknown signal is named as
 * unrecognised, never given an invented label); the subject by name, never a
 * raw id; the duration from the span rule the Slack all-clear uses
 * (incident-span.ts). None of the bookkeeping (event ids, moved starts, the
 * lapse check's stamp) leaves this module.
 *
 * FAILURE. Any read that fails throws. An empty list would read as "no
 * incidents", which is the one thing this record must never claim falsely.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { INCIDENT_SIGNALS, incidentSignal, incidentSignalLabel, isIncidentSignal } from './incident-signals'
import { incidentDurationText, incidentSoFarText, measureIncidentSpan } from './incident-span'

export const INCIDENTS_DEFAULT_LIMIT = 50
export const INCIDENTS_MAX_LIMIT = 100
/** The windows the dashboard's day switch offers; the card follows it. */
export const INCIDENT_WINDOW_DAYS = [7, 14, 30] as const
export type IncidentWindowDays = (typeof INCIDENT_WINDOW_DAYS)[number]
/** Open incidents are a handful at a time (#2098: about 27 a month); a list longer than this says so. */
export const ONGOING_LIMIT = 100

export const UNNAMED_SUBJECT = 'Unnamed subject'
export const MISSING_WORKFLOW_SUBJECT = 'A workflow no longer on record'
export const ORGANIZATION_SUBJECT = 'This organization'

/** What every incident carries, open or closed. */
interface IncidentBase {
  id: string
  signal: string
  signal_label: string
  signal_known: boolean
  subject_name: string
  scope: 'org' | 'platform'
  started_at: string
  pages_sent: number
}

/** One closed incident, as the Incidents card shows it. */
export interface IncidentView extends IncidentBase {
  ended_at: string | null
  state: 'ended' | 'end_not_recorded'
  duration: string | null
}

/** One open incident, as the line under the page header shows it. */
export interface OngoingIncidentView extends IncidentBase {
  so_far: string | null
}

export interface IncidentsPage {
  incidents: IncidentView[]
  has_more: boolean
  /** The offset that reads the next page, or null when there is none. */
  next_offset: number | null
}

export interface OngoingIncidents {
  incidents: OngoingIncidentView[]
  /** More are open than ONGOING_LIMIT. */
  has_more: boolean
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

/** Whether a query value names one of the windows the card follows. */
export function isIncidentWindowDays(n: number): n is IncidentWindowDays {
  return (INCIDENT_WINDOW_DAYS as readonly number[]).includes(n)
}

/** The PostgREST filter for the caller's organization's rows and the platform's. */
function scopeFilter(orgId: string): string {
  // The organization id is interpolated into a filter, so it must be exactly a
  // uuid: anything else could widen it.
  if (!UUID.test(orgId)) throw new IncidentReadError('the caller has no organization to scope incidents to')
  return `organization_id.eq.${orgId},scope.eq.platform`
}

/** Refuse, as an error, any row outside the caller's scope. */
function assertScoped(rows: readonly StoredIncident[], orgId: string): void {
  for (const row of rows) {
    if (row.organization_id !== orgId && row.scope !== 'platform') {
      throw new IncidentReadError(`refused incident ${row.id}: it belongs to another organization`)
    }
  }
}

/** The workflow id a workflow keyed subject starts with, and what follows it. */
function workflowKey(row: StoredIncident): { id: string; rest: string } | null {
  if (!WORKFLOW_SIGNALS.has(row.signal)) return null
  const m = LEADING_UUID.exec(row.subject)
  return m ? { id: m[1].toLowerCase(), rest: m[2] } : null
}

/** The names of the workflows these rows key on, read inside the caller's organization. */
async function workflowNames(supabase: SupabaseClient, orgId: string, rows: readonly StoredIncident[]): Promise<Map<string, WorkflowName>> {
  const ids = [...new Set(rows.map(workflowKey).filter((k): k is { id: string; rest: string } => k !== null).map((k) => k.id))]
  const names = new Map<string, WorkflowName>()
  if (ids.length === 0) return names
  const wf = await supabase
    .from('workflows')
    .select('id, name, deleted_at')
    .eq('organization_id', orgId)
    .in('id', ids)
    .limit(ids.length)
  if (wf.error || !wf.data) throw failed('Workflow names', wf.error)
  for (const w of wf.data as unknown as WorkflowName[]) names.set(w.id.toLowerCase(), w)
  return names
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

function baseView(row: StoredIncident, workflows: ReadonlyMap<string, WorkflowName>): IncidentBase {
  const { label, known } = incidentSignalLabel(row.signal)
  return {
    id: row.id,
    signal: row.signal,
    signal_label: label,
    signal_known: known,
    subject_name: subjectName(row, workflows),
    scope: row.scope,
    started_at: row.started_at,
    pages_sent: Number(row.pages_sent),
  }
}

function failed(what: string, error: { message?: string } | null | undefined): IncidentReadError {
  return new IncidentReadError(`${what} could not be read: ${error?.message ?? 'no rows came back'}`)
}

/** Every open incident in the caller's scope, newest start first. Throws IncidentReadError on any failed read. */
export async function readOngoingIncidents(supabase: SupabaseClient, orgId: string, opts: { now: number }): Promise<OngoingIncidents> {
  const scope = scopeFilter(orgId)
  const res = await supabase
    .from('alert_incidents')
    .select(COLUMNS)
    .or(scope)
    .is('ended_reason', null)
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .range(0, ONGOING_LIMIT)
  if (res.error || !res.data) throw failed('Ongoing incidents', res.error)
  const all = res.data as unknown as StoredIncident[]
  const rows = all.slice(0, ONGOING_LIMIT)
  assertScoped(rows, orgId)
  const workflows = await workflowNames(supabase, orgId, rows)
  return {
    incidents: rows.map((row) => ({
      ...baseView(row, workflows),
      so_far: incidentSoFarText(measureIncidentSpan(row.started_at, null, row.window_minutes, opts.now)),
    })),
    has_more: all.length > ONGOING_LIMIT,
  }
}

/**
 * One page of the closed incidents that started or ended in the last `days`
 * days, newest start first. Throws IncidentReadError on any failed read.
 */
export async function readClosedIncidents(
  supabase: SupabaseClient,
  orgId: string,
  opts: { days: IncidentWindowDays; limit: number; offset: number; now: number },
): Promise<IncidentsPage> {
  const { days, limit, offset, now } = opts
  const scope = scopeFilter(orgId)
  const since = new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
  // One logic tree, so the scope and the window are each one OR and the two are
  // ANDed: started in the window or ended in it, for the caller's organization
  // or the platform.
  const inWindow = `or(started_at.gte.${since},ended_at.gte.${since})`
  const res = await supabase
    .from('alert_incidents')
    .select(COLUMNS)
    .or(`and(or(${scope}),${inWindow})`)
    .not('ended_reason', 'is', null)
    .order('started_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit)
  if (res.error || !res.data) throw failed('Closed incidents', res.error)
  const all = res.data as unknown as StoredIncident[]
  const rows = all.slice(0, limit)
  assertScoped(rows, orgId)
  const workflows = await workflowNames(supabase, orgId, rows)
  const hasMore = all.length > limit
  return {
    incidents: rows.map((row) => {
      const ended = row.ended_at !== null
      return {
        ...baseView(row, workflows),
        ended_at: row.ended_at,
        state: ended ? 'ended' : 'end_not_recorded',
        duration: ended ? incidentDurationText(measureIncidentSpan(row.started_at, row.ended_at, row.window_minutes, now)) : null,
      }
    }),
    has_more: hasMore,
    next_offset: hasMore ? offset + rows.length : null,
  }
}
