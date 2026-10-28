/**
 * The bookkeeping a daily check of ops connections shares (#2340, #2761): which
 * connections it found, which it has an incident open for, the page for each
 * found one (repeated every run while it stands) and the all clear for each
 * that a complete read no longer finds.
 *
 * Its users: `lib/ops-connection-owner-check.ts` (a person bound connection
 * whose owner left, #2340) and `lib/http-money-host-check.ts` (an HTTP
 * connection whose host bidding now sends to, #2761). Each keeps its own state
 * key and signal, so neither's bookkeeping can drop the other's incidents.
 *
 * THE RULES, the same for each:
 * - A page arms the incident only once it reached Slack (markAlerted, then
 *   recordPaged), so a Slack outage opens no incident nobody saw. A repeat
 *   that did not reach Slack keeps the marker it already had.
 * - Each found connection is kept in the state whatever its page did, so its
 *   all clear is owed once it clears.
 * - A connection not judged this run (the caller could not read it, or the
 *   sources it is judged against) keeps its incident: it is never cleared on
 *   a read that did not look at it. `findings: null` means nothing was judged.
 * - A state record that could not be read is never written over, since that
 *   would drop every incident it holds and the all clear each is owed.
 * - A finding may carry a `context` of plain strings, kept with its open
 *   incident and handed back to its all clear, so the all clear can say what
 *   the page said even once the thing it named has changed (#2761).
 *
 * Who may run it: the bidding Worker's daily cron, through the checks above.
 * Whose data: the state names connection ids and their organizations; each
 * page and all clear goes to the connection's own organization.
 */
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, recoveryKey, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { formatErr } from './format-error'
import type { RecoveryMarkerSignal } from './incident-signals'
import { readConnectionReferences, type ConnectionReferences } from './connection-references'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface StandingConnectionFinding {
  id: string
  organizationId: string
  /** The incident's label: the connection's name and service (opsConnectionLabel). */
  label: string
  /** What the all clear needs to repeat from the page, kept with the open incident. */
  context?: Readonly<Record<string, string>>
  /** Sends the page, given when it was first reported (null on the first). Returns whether it reached Slack. */
  send(firstReportedAt: string | null): Promise<boolean>
}

export interface StandingConnectionRecovery {
  subject: string
  alertedAt: string
  endedAt: string | null
  firstHealthyAt: string | null
  /** The context the last page recorded, or null when it recorded none. */
  context: Readonly<Record<string, string>> | null
}

export interface StandingConnectionsOptions {
  kv: RecoveryKv
  signal: RecoveryMarkerSignal
  /** Where the open incidents are kept. Never renamed: it holds the all clears owed. */
  stateKey: string
  nowMs: number
  /** What this run found, or null when nothing could be judged. */
  findings: readonly StandingConnectionFinding[] | null
  /** An open incident this run did not look at, so it is kept rather than cleared. */
  unjudged?: (id: string, organizationId: string) => boolean
  /** The all clear. Returns whether it reached Slack. */
  sendRecovery(organizationId: string, recovery: StandingConnectionRecovery): Promise<boolean>
  /** Faults in the bookkeeping, reported rather than thrown. */
  errors: string[]
}

export interface StandingConnectionsOutcome {
  paged: string[]
  allClear: string[]
}

interface OpenIncident {
  organization_id: string
  label: string
  context?: Record<string, string>
}

/** A context of strings only, or undefined: anything else in a stored record is not trusted. */
function contextOf(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.every(([, v]) => typeof v === 'string') ? Object.fromEntries(entries) as Record<string, string> : null
}

interface OpenState {
  open: Record<string, OpenIncident>
}

/**
 * The stored record, and how many of its entries could not be read. An entry
 * that cannot be read is the only copy of whose incident it was, so it is
 * dropped and counted; its marker lapses and the drain closes it as lapsed.
 */
function parseState(raw: string | null): { state: OpenState; unreadable: number } {
  if (!raw) return { state: { open: {} }, unreadable: 0 }
  try {
    const v = JSON.parse(raw) as { open?: unknown }
    const open: Record<string, OpenIncident> = {}
    if (!v.open || typeof v.open !== 'object' || Array.isArray(v.open)) return { state: { open }, unreadable: 1 }
    let unreadable = 0
    for (const [id, e] of Object.entries(v.open as Record<string, unknown>)) {
      const o = e as (Partial<OpenIncident> & { context?: unknown }) | null
      const context = o ? contextOf(o.context) : null
      if (o && typeof o.organization_id === 'string' && typeof o.label === 'string' && context !== null) {
        open[id] = context === undefined ? { organization_id: o.organization_id, label: o.label } : { organization_id: o.organization_id, label: o.label, context }
      } else unreadable++
    }
    return { state: { open }, unreadable }
  } catch {
    return { state: { open: {} }, unreadable: 1 }
  }
}

const incidentFor = (organizationId: string, label: string, errors: string[]): IncidentContext => ({
  scope: { kind: 'org', organizationId },
  subjectLabel: label,
  onRecordError: (message) => errors.push(message),
})

/** One found connection's page, armed on delivery. Returns whether it was delivered. */
async function page(o: StandingConnectionsOptions, f: StandingConnectionFinding): Promise<boolean> {
  const { kv, signal, nowMs, errors } = o
  await markSpikeSeen(kv, signal, f.id, nowMs)
  const firstReportedAt = await kv.get(recoveryKey(signal, f.id))
  if (!(await f.send(firstReportedAt))) {
    // Armed only on delivery, so a Slack outage does not open an incident nobody saw.
    if (firstReportedAt !== null) await refreshAlerted(kv, signal, f.id)
    return false
  }
  const incident = incidentFor(f.organizationId, f.label, errors)
  await markAlerted(kv, signal, f.id, incident, nowMs)
  await recordPaged(kv, signal, f.id, incident, nowMs)
  return true
}

/**
 * One open incident no longer found: its all clear. `sent` when it reached
 * Slack, `nothing_owed` when no page ever did, `still_open` when it did not.
 */
async function clear(o: StandingConnectionsOptions, id: string, open: OpenIncident): Promise<'sent' | 'nothing_owed' | 'still_open'> {
  const { kv, signal, nowMs, errors } = o
  // Never paged (its page did not deliver), or already settled: nothing is owed.
  if ((await kv.get(recoveryKey(signal, id))) === null) return 'nothing_owed'
  const delivered = await announceRecovery(
    kv,
    signal,
    id,
    null,
    incidentFor(open.organization_id, open.label, errors),
    (alertedAt, endedAt, firstHealthyAt) => o.sendRecovery(open.organization_id, { subject: open.label, alertedAt, endedAt, firstHealthyAt, context: open.context ?? null }),
    // A daily state check: a complete read that no longer finds it is the end.
    { now: nowMs, rearmMinutes: 0 },
  )
  return delivered ? 'sent' : 'still_open'
}

/** Pages what was found, keeps what was not judged, and sends the all clear for the rest. */
export async function settleStandingConnections(o: StandingConnectionsOptions): Promise<StandingConnectionsOutcome> {
  const { kv, signal, stateKey, errors } = o
  const outcome: StandingConnectionsOutcome = { paged: [], allClear: [] }

  let rawState: string | null = null
  // A record that could not be read is not an empty one: writing over it would
  // drop every incident it holds, and with it the all clear each is owed.
  let stateRead = true
  try {
    rawState = await kv.get(stateKey)
  } catch (err) {
    stateRead = false
    errors.push(`the open incidents could not be read, so they are left as stored: ${formatErr(err)}`)
  }
  const parsed = parseState(rawState)
  const previous = parsed.state
  if (parsed.unreadable > 0) errors.push(`${parsed.unreadable} open incident record${parsed.unreadable === 1 ? '' : 's'} could not be read, so no all clear can be sent for ${parsed.unreadable === 1 ? 'it' : 'them'}`)

  const keep = async (id: string) => {
    try {
      await refreshAlerted(kv, signal, id)
    } catch (err) {
      errors.push(`${id}: the open incident could not be kept: ${formatErr(err)}`)
    }
  }

  if (o.findings === null) {
    for (const id of Object.keys(previous.open)) await keep(id)
    return outcome
  }

  const next: OpenState = { open: {} }
  for (const f of o.findings) {
    // Listed whatever the page does, so its all clear is asked for once it clears.
    next.open[f.id] = f.context ? { organization_id: f.organizationId, label: f.label, context: { ...f.context } } : { organization_id: f.organizationId, label: f.label }
    try {
      if (await page(o, f)) outcome.paged.push(f.id)
    } catch (err) {
      errors.push(`${f.id}: the page failed: ${formatErr(err)}`)
    }
  }
  const found = new Set(o.findings.map((f) => f.id))
  for (const [id, open] of Object.entries(previous.open)) {
    if (found.has(id)) continue
    if (o.unjudged?.(id, open.organization_id)) {
      next.open[id] = open
      await keep(id)
      continue
    }
    try {
      const cleared = await clear(o, id, open)
      if (cleared === 'still_open') next.open[id] = open
      else if (cleared === 'sent') outcome.allClear.push(id)
    } catch (err) {
      errors.push(`${id}: the all clear failed: ${formatErr(err)}`)
      next.open[id] = open
    }
  }

  if (stateRead && JSON.stringify(next) !== JSON.stringify(previous)) {
    try {
      await kv.put(stateKey, JSON.stringify(next))
    } catch (err) {
      errors.push(`the open incidents could not be kept for the next check: ${formatErr(err)}`)
    }
  }
  return outcome
}

/** Workflow ids asked for in one `in` filter. */
const IN_CHUNK = 100

/**
 * The workflows of one organization that use a connection, for the page to
 * name: the ones the Connections page's Used by list names
 * (connection-references.ts, the database's one predicate, #2946), with
 * switched off ones included and marked, since switching one on runs it at
 * once, and soft deleted ones left out, since they cannot run. A connection
 * removed since the caller read it is used by none: Remove refuses while any
 * workflow names it, and no definition naming a removed connection can be
 * saved (workflows_refuse_missing_connections).
 *
 * Whether each is switched on is read after, by id, inside the organization;
 * one soft deleted or gone between the two reads is left out. DATA VOLUME: the
 * workflows naming one connection, read IN_CHUNK ids at a time.
 *
 * Throws when either read fails, never answering none.
 */
export async function workflowsNamingConnection(supabase: SupabaseClient, organizationId: string, connectionId: string): Promise<{ id: string; name: string; active: boolean }[]> {
  let refs: ConnectionReferences
  try {
    refs = await readConnectionReferences(supabase, organizationId, connectionId)
  } catch (err) {
    throw new Error(`the workflows could not be read: ${formatErr(err)}`, { cause: err })
  }
  if (!refs.found) return []
  const live = refs.workflows.filter((w) => !w.deleted)
  const active = new Map<string, boolean>()
  for (let i = 0; i < live.length; i += IN_CHUNK) {
    const ids = live.slice(i, i + IN_CHUNK).map((w) => w.id)
    // paginate-ok .in(id): id is the primary key, so at most IN_CHUNK (100) rows, one per workflow asked for.
    const { data, error } = await supabase.from('workflows').select('id, is_active').eq('organization_id', organizationId).is('deleted_at', null).in('id', ids)
    if (error) throw new Error(`the workflows could not be read: ${formatErr(error)}`)
    if (!Array.isArray(data)) throw new Error('the workflows could not be read: the read answered no rows')
    for (const row of data as { id: string; is_active: unknown }[]) active.set(row.id, row.is_active === true)
  }
  return live.flatMap((w) => {
    const on = active.get(w.id)
    return on === undefined ? [] : [{ id: w.id, name: w.name, active: on }]
  })
}
