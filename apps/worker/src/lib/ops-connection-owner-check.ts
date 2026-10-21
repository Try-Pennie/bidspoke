/**
 * The daily owner check for person bound ops connections (#2340, phase 10 of
 * #1689, item 5; plan: discussion #2329).
 *
 * WHAT IT JUDGES. A person bound connection (service_connections.person_bound)
 * signs in as one person, its owner, service_connections.user_id. Removing that
 * person from Bidspoke on the Access page deletes only their user_allowlist row
 * (routes/api/access.ts DELETE /:email): the users row stays, and cannot be
 * deleted while a connection references it (user_id's ON DELETE NO ACTION). So
 * this judges by the predicate access itself uses, the owner's email (lowercased,
 * as the allowlist stores it) no longer being on user_allowlist, never by
 * whether a users row exists, which would never fire (L162, L90). A person
 * bound row with no owner recorded is paged as its own kind: nobody can say
 * whether that person still has access (L11).
 *
 * WHAT PAGES. Each such connection, to its own organization's Slack alert
 * channel under the configuration alerts toggle, naming the connection by name
 * and service, its owner by display name when one is recorded (never an email),
 * and the workflows of that organization whose definition names the
 * connection's id anywhere (readOrgWorkflows: switched off ones included and
 * marked, since switching one on runs it at once; soft deleted ones left out,
 * since they cannot run). Every day while it stands. The signal is
 * ops-connection-owner (incident-signals.ts), keyed on the connection id: the
 * marker is armed only on a delivered page (markAlerted, then recordPaged), and
 * the all clear is sent once a complete read no longer finds it (the owner is
 * back on the list, or the connection is gone or no longer person bound).
 *
 * A READ THAT FAILS IS NOT QUIET (L10). If the connections, the owners or the
 * allowlist cannot be read, nothing is judged: no page, no all clear, every
 * open incident's marker is kept, and the run pages as could not run through
 * the export alerter (its own platform incident, keyed on this job). A failed
 * workflows read still sends the owner page, saying the workflows could not be
 * read.
 *
 * DATA VOLUME (L24). Person bound connections: none today (measured
 * 2026-10-17: 0 of 1 service_connections rows), bounded by the connections an
 * organization makes. Owners and allowlist rows are read only for those, by id
 * and by email. Workflows are read only for an orphaned connection, inside its
 * organization, through the one scoped read (11 live workflows on 2026-10-15).
 *
 * Who may run it: the bidding Worker's daily cron only, as service_role. Whose
 * data: every organization's person bound connections, each page going only to
 * the connection's own organization and naming only that organization's
 * workflows.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, recoveryKey, refreshAlerted, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { notifyExportFailure, notifyExportRecovery } from './export-alerts'
import { formatErr } from './format-error'
import { readOrgWorkflows, type OrgWorkflow } from './org-workflows'
import { fetchAllPaged } from './paginate'
import { opsConnectionLabel, sendOpsConnectionOwnerAlert, sendOpsConnectionOwnerRecoveryAlert, type OpsConnectionOwnerAlert } from './slack'
import type { Env } from '../index'

/** The job's id in the heartbeat registry and the export alerter. Never rename it: it keys its KV state. */
export const OPS_CONNECTION_OWNER_JOB = 'ops-connection-owner'

/** The incident record's signal (incident-signals.ts). */
export const OPS_CONNECTION_OWNER_SIGNAL = 'ops-connection-owner'

/**
 * Which connections have an incident open, so an owed all clear is not
 * forgotten once the connection, and with it its name, is gone. Written only
 * when it changes, with no expiry: an entry leaves only once its incident is
 * settled, so it is bounded by the connections.
 */
export const OPS_CONNECTION_OWNER_STATE_KEY = 'ops-connection-owner:state'

const LOG = `[${OPS_CONNECTION_OWNER_JOB}]`

/** Owners and emails asked for in one `in` filter. */
const IN_CHUNK = 100

export interface PersonBoundConnection {
  id: string
  organization_id: string
  name: string
  service_type: string
  user_id: string | null
}

export interface ConnectionOwner {
  id: string
  email: string
  display_name: string | null
}

/** The check's reads. Each throws on a failed read, never answering an empty list for one it could not read. */
export interface OwnerCheckReads {
  personBoundConnections(): Promise<PersonBoundConnection[]>
  owners(userIds: string[]): Promise<ConnectionOwner[]>
  /** The given (lowercased) emails that are on user_allowlist. */
  allowlisted(emails: string[]): Promise<Set<string>>
  /** The workflows of `organizationId` whose definition names `connectionId`. */
  workflowsNaming(organizationId: string, connectionId: string): Promise<{ name: string; active: boolean }[]>
}

export interface OpsConnectionOwnerDeps {
  kv: RecoveryKv
  reads: OwnerCheckReads
  /** Pages the connection's organization. Returns whether it reached Slack. */
  sendAlert(organizationId: string, alert: OpsConnectionOwnerAlert): Promise<boolean>
  /** The all clear. Returns whether it reached Slack. */
  sendRecovery(organizationId: string, recovery: { subject: string; alertedAt: string; endedAt: string | null; firstHealthyAt: string | null }): Promise<boolean>
  /** The check could not run: pages through the export alerter. */
  reportUnreadable(problems: string[]): Promise<void>
  /** The check ran: stands an earlier could-not-run page down. */
  reportReadable(): Promise<void>
  now(): number
}

export interface OpsConnectionOwnerSummary {
  /** False when a read failed and nothing was judged. */
  judged: boolean
  personBound: number
  /** The connections whose owner was removed or is not recorded. */
  orphaned: string[]
  paged: string[]
  allClear: string[]
  /** The reads that failed, each naming what it was reading. */
  unreadable: string[]
  /** Faults in the check's own bookkeeping, reported rather than thrown. */
  errors: string[]
}

interface OpenOwner {
  organization_id: string
  label: string
}

interface OwnerState {
  open: Record<string, OpenOwner>
}

/**
 * The stored record, and how many of its entries could not be read. An entry
 * that cannot be read is the only copy of whose incident it was, so it is
 * dropped and counted; its marker lapses and the drain closes it as lapsed.
 */
function parseState(raw: string | null): { state: OwnerState; unreadable: number } {
  if (!raw) return { state: { open: {} }, unreadable: 0 }
  try {
    const v = JSON.parse(raw) as { open?: unknown }
    const open: Record<string, OpenOwner> = {}
    if (!v.open || typeof v.open !== 'object' || Array.isArray(v.open)) return { state: { open }, unreadable: 1 }
    let unreadable = 0
    for (const [id, e] of Object.entries(v.open as Record<string, unknown>)) {
      const o = e as Partial<OpenOwner> | null
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

interface Orphan {
  connection: PersonBoundConnection
  kind: OpsConnectionOwnerAlert['kind']
  ownerName: string | null
}

/** One orphaned connection: its workflows, then its page, armed on delivery. Returns whether it was paged. */
async function pageOrphan(deps: OpsConnectionOwnerDeps, o: Orphan, nowMs: number, errors: string[]): Promise<boolean> {
  const { kv } = deps
  const c = o.connection
  let workflows: OpsConnectionOwnerAlert['workflows'] = null
  try {
    workflows = await deps.reads.workflowsNaming(c.organization_id, c.id)
  } catch (err) {
    errors.push(`${c.id}: the workflows that use it could not be read, so the page does not name them: ${formatErr(err)}`)
  }
  const incident = incidentFor(c.organization_id, opsConnectionLabel(c.name, c.service_type), errors)
  await markSpikeSeen(kv, OPS_CONNECTION_OWNER_SIGNAL, c.id, nowMs)
  const firstReportedAt = await kv.get(recoveryKey(OPS_CONNECTION_OWNER_SIGNAL, c.id))
  const delivered = await deps.sendAlert(c.organization_id, {
    kind: o.kind, name: c.name, service: c.service_type, ownerName: o.ownerName, workflows, firstReportedAt,
  })
  if (!delivered) {
    // Armed only on delivery, so a Slack outage does not open an incident nobody saw.
    if (firstReportedAt !== null) await refreshAlerted(kv, OPS_CONNECTION_OWNER_SIGNAL, c.id)
    return false
  }
  await markAlerted(kv, OPS_CONNECTION_OWNER_SIGNAL, c.id, incident, nowMs)
  await recordPaged(kv, OPS_CONNECTION_OWNER_SIGNAL, c.id, incident, nowMs)
  return true
}

/**
 * One open incident no longer found: its all clear. `sent` when it reached
 * Slack, `nothing_owed` when no page ever did, `still_open` when it did not.
 */
async function clearOrphan(deps: OpsConnectionOwnerDeps, id: string, open: OpenOwner, nowMs: number, errors: string[]): Promise<'sent' | 'nothing_owed' | 'still_open'> {
  const { kv } = deps
  // Never paged (its page did not deliver), or already settled: nothing is owed.
  if ((await kv.get(recoveryKey(OPS_CONNECTION_OWNER_SIGNAL, id))) === null) return 'nothing_owed'
  const delivered = await announceRecovery(
    kv,
    OPS_CONNECTION_OWNER_SIGNAL,
    id,
    null,
    incidentFor(open.organization_id, open.label, errors),
    (alertedAt, endedAt, firstHealthyAt) => deps.sendRecovery(open.organization_id, { subject: open.label, alertedAt, endedAt, firstHealthyAt }),
    // A daily state check: a complete read that no longer finds it is the end.
    { now: nowMs, rearmMinutes: 0 },
  )
  return delivered ? 'sent' : 'still_open'
}

export async function runOpsConnectionOwnerCheck(deps: OpsConnectionOwnerDeps): Promise<OpsConnectionOwnerSummary> {
  const nowMs = deps.now()
  const errors: string[] = []
  const summary: OpsConnectionOwnerSummary = { judged: false, personBound: 0, orphaned: [], paged: [], allClear: [], unreadable: [], errors }

  let rawState: string | null = null
  // A record that could not be read is not an empty one: writing over it would
  // drop every incident it holds, and with it the all clear each is owed.
  let stateRead = true
  try {
    rawState = await deps.kv.get(OPS_CONNECTION_OWNER_STATE_KEY)
  } catch (err) {
    stateRead = false
    errors.push(`the open incidents could not be read, so they are left as stored: ${formatErr(err)}`)
  }
  const parsed = parseState(rawState)
  const previous = parsed.state
  if (parsed.unreadable > 0) errors.push(`${parsed.unreadable} open incident record${parsed.unreadable === 1 ? '' : 's'} could not be read, so no all clear can be sent for ${parsed.unreadable === 1 ? 'it' : 'them'}`)

  // The three reads the judgement rests on. Any failure judges nothing.
  let connections: PersonBoundConnection[] = []
  let owners = new Map<string, ConnectionOwner>()
  let onList = new Set<string>()
  try {
    connections = await deps.reads.personBoundConnections()
  } catch (err) {
    summary.unreadable.push(`The person bound ops connections could not be read: ${formatErr(err)}`)
  }
  const ownerIds = [...new Set(connections.map((c) => c.user_id).filter((id): id is string => id !== null))]
  if (summary.unreadable.length === 0 && ownerIds.length > 0) {
    try {
      owners = new Map((await deps.reads.owners(ownerIds)).map((u) => [u.id, u]))
    } catch (err) {
      summary.unreadable.push(`The owners of the person bound ops connections could not be read: ${formatErr(err)}`)
    }
  }
  const emails = [...new Set([...owners.values()].map((u) => u.email.trim().toLowerCase()))]
  if (summary.unreadable.length === 0 && emails.length > 0) {
    try {
      onList = await deps.reads.allowlisted(emails)
    } catch (err) {
      summary.unreadable.push(`The Access list could not be read: ${formatErr(err)}`)
    }
  }

  if (summary.unreadable.length > 0) {
    for (const id of Object.keys(previous.open)) {
      try {
        await refreshAlerted(deps.kv, OPS_CONNECTION_OWNER_SIGNAL, id)
      } catch (err) {
        errors.push(`${id}: the open incident could not be kept: ${formatErr(err)}`)
      }
    }
    await deps.reportUnreadable(summary.unreadable)
    return summary
  }
  summary.judged = true
  summary.personBound = connections.length

  const orphans: Orphan[] = []
  for (const c of connections) {
    const owner = c.user_id === null ? undefined : owners.get(c.user_id)
    // A users row the database must hold (the foreign key) but did not answer is read as no owner, the side that pages.
    if (owner === undefined) orphans.push({ connection: c, kind: 'owner_missing', ownerName: null })
    else if (!onList.has(owner.email.trim().toLowerCase())) {
      const display = owner.display_name?.trim()
      orphans.push({ connection: c, kind: 'owner_removed', ownerName: display ? display : null })
    }
  }
  summary.orphaned = orphans.map((o) => o.connection.id)
  // Said before any enrichment, so a slow workflows read cannot hide what was found (L492).
  if (orphans.length > 0) console.error(`${LOG} ${orphans.length} person bound ops connection${orphans.length === 1 ? '' : 's'} without an owner on the Access list: ${orphans.map((o) => `${o.connection.id} (${o.kind}, org ${o.connection.organization_id})`).join(', ')}`)

  const next: OwnerState = { open: {} }
  for (const o of orphans) {
    const c = o.connection
    // Listed whatever the page does, so its all clear is asked for once it clears.
    next.open[c.id] = { organization_id: c.organization_id, label: opsConnectionLabel(c.name, c.service_type) }
    try {
      if (await pageOrphan(deps, o, nowMs, errors)) summary.paged.push(c.id)
    } catch (err) {
      errors.push(`${c.id}: the page failed: ${formatErr(err)}`)
    }
  }
  const found = new Set(summary.orphaned)
  for (const [id, open] of Object.entries(previous.open)) {
    if (found.has(id)) continue
    try {
      const cleared = await clearOrphan(deps, id, open, nowMs, errors)
      if (cleared === 'still_open') next.open[id] = open
      else if (cleared === 'sent') summary.allClear.push(id)
    } catch (err) {
      errors.push(`${id}: the all clear failed: ${formatErr(err)}`)
      next.open[id] = open
    }
  }

  if (stateRead && JSON.stringify(next) !== JSON.stringify(previous)) {
    try {
      await deps.kv.put(OPS_CONNECTION_OWNER_STATE_KEY, JSON.stringify(next))
    } catch (err) {
      errors.push(`the open incidents could not be kept for the next check: ${formatErr(err)}`)
    }
  }
  await deps.reportReadable()
  return summary
}

// ── Production wiring ───────────────────────────────────────────────────────

/** Splits a list for `in` filters of a bounded length. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Whether a definition names the id anywhere: no step shape names a connection yet, so any field may (#2338). */
export function definitionNames(definition: unknown, connectionId: string): boolean {
  if (definition === null || definition === undefined) return false
  return JSON.stringify(definition).includes(connectionId)
}

/** The reads, against the bidding database as service_role: the organization filter is the scoping. */
export function liveOwnerCheckReads(supabase: SupabaseClient): OwnerCheckReads {
  return {
    personBoundConnections: () => fetchAllPaged<PersonBoundConnection>(
      (from, to) => supabase
        .from('service_connections')
        // Never the sealed login, its config or its target.
        .select('id, organization_id, name, service_type, user_id')
        .eq('person_bound', true)
        .order('id', { ascending: true })
        .range(from, to),
      'the person bound ops connections',
    ),
    owners: async (userIds) => {
      const out: ConnectionOwner[] = []
      for (const ids of chunks(userIds, IN_CHUNK)) {
        // paginate-ok .in(id): id is the primary key, so at most IN_CHUNK (100) rows, one per owner asked for.
        const { data, error } = await supabase.from('users').select('id, email, display_name').in('id', ids)
        if (error) throw new Error(`the connection owners read failed: ${formatErr(error)}`)
        if (!Array.isArray(data)) throw new Error('the connection owners read answered no rows')
        out.push(...(data as ConnectionOwner[]))
      }
      return out
    },
    allowlisted: async (emails) => {
      const out = new Set<string>()
      for (const list of chunks(emails, IN_CHUNK)) {
        // paginate-ok .in(email): email is the primary key, so at most IN_CHUNK (100) rows, one per email asked for.
        const { data, error } = await supabase.from('user_allowlist').select('email').in('email', list)
        if (error) throw new Error(`the Access list read failed: ${formatErr(error)}`)
        if (!Array.isArray(data)) throw new Error('the Access list read answered no rows')
        for (const row of data as { email: unknown }[]) if (typeof row.email === 'string') out.add(row.email.trim().toLowerCase())
      }
      return out
    },
    workflowsNaming: async (organizationId, connectionId) => {
      let workflows: OrgWorkflow[]
      try {
        workflows = await readOrgWorkflows(supabase, organizationId)
      } catch (err) {
        throw new Error(`the workflows could not be read: ${formatErr(err)}`, { cause: err })
      }
      return workflows
        .filter((w) => definitionNames(w.definition, connectionId))
        .map((w) => ({ name: w.name, active: w.is_active }))
    },
  }
}

const UNREADABLE_FIX = 'Nothing is judged until it runs again at the next daily batch, and no all clear is sent meanwhile. If it fails again, check that the bidding database answers, then search the bidspoke-worker logs for ops-connection-owner.'

/** The daily check wired to the bidding Worker: the bidding database, the shared export alerter, Slack. */
export function runOpsConnectionOwnerCheckForEnv(supabase: SupabaseClient, env: Env): Promise<OpsConnectionOwnerSummary> {
  return runOpsConnectionOwnerCheck({
    kv: env.IDEMPOTENCY,
    reads: liveOwnerCheckReads(supabase),
    sendAlert: (organizationId, alert) => sendOpsConnectionOwnerAlert(supabase, organizationId, alert),
    sendRecovery: (organizationId, recovery) => sendOpsConnectionOwnerRecoveryAlert(supabase, organizationId, recovery),
    reportUnreadable: (problems) => notifyExportFailure(supabase, OPS_CONNECTION_OWNER_JOB, problems, env.IDEMPOTENCY, {
      title: 'The ops connection owner check could not run',
      fixHint: UNREADABLE_FIX,
    }),
    reportReadable: () => notifyExportRecovery(env.IDEMPOTENCY, OPS_CONNECTION_OWNER_JOB, Date.now()),
    now: () => Date.now(),
  })
}
