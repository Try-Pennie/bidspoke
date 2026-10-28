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
 *
 * Who may run it: the bidding Worker's daily cron, through the checks above.
 * Whose data: the state names connection ids and their organizations; each
 * page and all clear goes to the connection's own organization.
 */
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, recoveryKey, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { formatErr } from './format-error'
import type { RecoveryMarkerSignal } from './incident-signals'
import { readOrgWorkflows, type OrgWorkflow } from './org-workflows'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface StandingConnectionFinding {
  id: string
  organizationId: string
  /** The incident's label: the connection's name and service (opsConnectionLabel). */
  label: string
  /** Sends the page, given when it was first reported (null on the first). Returns whether it reached Slack. */
  send(firstReportedAt: string | null): Promise<boolean>
}

export interface StandingConnectionRecovery {
  subject: string
  alertedAt: string
  endedAt: string | null
  firstHealthyAt: string | null
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
      const o = e as Partial<OpenIncident> | null
      if (o && typeof o.organization_id === 'string' && typeof o.label === 'string') open[id] = { organization_id: o.organization_id, label: o.label }
      else unreadable++
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
    (alertedAt, endedAt, firstHealthyAt) => o.sendRecovery(open.organization_id, { subject: open.label, alertedAt, endedAt, firstHealthyAt }),
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
    next.open[f.id] = { organization_id: f.organizationId, label: f.label }
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

/** Whether a definition names the id anywhere: no step shape names a connection yet, so any field may (#2338). */
export function definitionNames(definition: unknown, connectionId: string): boolean {
  if (definition === null || definition === undefined) return false
  return JSON.stringify(definition).includes(connectionId)
}

/**
 * The workflows of one organization whose definition names a connection, for
 * the page to name: switched off ones included and marked, since switching one
 * on runs it at once; soft deleted ones left out, since they cannot run.
 * Throws when the workflows cannot be read, never answering none.
 */
export async function workflowsNamingConnection(supabase: SupabaseClient, organizationId: string, connectionId: string): Promise<{ name: string; active: boolean }[]> {
  let workflows: OrgWorkflow[]
  try {
    workflows = await readOrgWorkflows(supabase, organizationId)
  } catch (err) {
    throw new Error(`the workflows could not be read: ${formatErr(err)}`, { cause: err })
  }
  return workflows
    .filter((w) => definitionNames(w.definition, connectionId))
    .map((w) => ({ name: w.name, active: w.is_active }))
}
