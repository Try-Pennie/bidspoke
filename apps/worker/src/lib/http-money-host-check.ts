/**
 * The daily recheck of saved HTTP connections against the hosts bidding sends
 * to (#2761, milestone "Move every Pipedream workflow to Bidspoke").
 *
 * WHY. An HTTP connection's save refuses a host bidding sends to
 * (connection-money-targets.ts, moneyHostOf, #2337), but only at the save. When
 * the money lane later starts sending to a host (a partner endpoint changed, a
 * money workflow edited), an HTTP connection already saved for that host is
 * never caught, and ops cannot read bidding's hosts to check itself. So once a
 * day the bidding Worker recomputes the money hosts with the same
 * readMoneyHosts and moneyHostsFrom the save uses, through the same reads
 * (money-host-reads.ts), and compares every saved HTTP connection's host,
 * read as the save reads it (httpHostOf on the target's `host`).
 *
 * ALERT ONLY (Dan, 2026-10-28, on #2761). A caught connection keeps working and
 * keeps being served to ops; this pages, naming it, every day until someone
 * removes it. Nothing here writes a connection.
 *
 * WHAT PAGES. Each caught connection, to its own organization's Slack alert
 * channel under the configuration alerts toggle (sendHttpMoneyHostAlert),
 * naming the connection, its host, where bidding sends to that host (the
 * partner or money workflow by name, linked, when it came from one), and the
 * organization's active workflows that name the connection, each linked.
 * Every day while it stands. The signal is http-money-host
 * (incident-signals.ts), keyed on the connection id, armed only on a delivered
 * page; the all clear goes once a complete read no longer finds it
 * (standing-connection-incidents.ts, shared with the owner check), and names
 * the source the last page named, which the open incident keeps
 * (httpMoneyHostContext), since the partner's settings may since have changed.
 *
 * Each connection is judged against its own organization's money hosts, as
 * the save judged it: an organization's partners and money workflows are its
 * own. A host a money workflow reaches only through {{env.X}} is still not
 * seen, as at the save (Dan chose the derived sources on 2026-10-23, #2337).
 *
 * A READ THAT FAILS IS NOT QUIET (L98, L10). If the HTTP connections cannot be
 * read, nothing is judged. If one organization's money hosts cannot be read
 * (its Salesforce instance, its partner endpoints, its money workflows), or the
 * Worker's own SUPABASE_URL or APP_URL gives no host, none of that
 * organization's connections is judged. A connection whose stored host cannot
 * be read is not judged either (ops refuses to send through it, httpHostOf in
 * the catalogue's call). Every connection not judged keeps any open incident
 * with no all clear, and the run pages that the check could not run, naming
 * what it could not read, through the export alerter (its own platform
 * incident, keyed on this job). The other connections are still judged.
 *
 * DATA VOLUME (L24). HTTP connections: bounded by the connections an
 * organization makes (none on 2026-10-28, the service shipped that week),
 * read paged under a full order. The money host sources are read once per
 * organization holding an HTTP connection, and the workflows once per caught
 * connection.
 *
 * Who may run it: the bidding Worker's daily cron only, as service_role. Whose
 * data: every organization's HTTP connections (id, organization, name and
 * target, which holds the host, header name and check path and never the key),
 * each page going only to the connection's own organization.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { HTTP_SERVICE_KEY, httpHostOf } from '@bidspoke/service-catalogue/schema'
import type { RecoveryKv } from './alert-recovery'
import { moneyHostOf, readMoneyHosts, type MoneyHostSource, type MoneyHostsRead } from './connection-money-targets'
import { notifyExportFailure, notifyExportRecovery } from './export-alerts'
import { formatErr } from './format-error'
import { liveMoneyHostReads } from './money-host-reads'
import { fetchAllPaged } from './paginate'
import { httpMoneyHostContext, opsConnectionLabel, sendHttpMoneyHostAlert, sendHttpMoneyHostRecoveryAlert, type HttpMoneyHostAlert } from './slack'
import { settleStandingConnections, workflowsNamingConnection, type StandingConnectionFinding, type StandingConnectionRecovery } from './standing-connection-incidents'
import type { Env } from '../index'

/** The job's id in the heartbeat registry and the export alerter. Never rename it: it keys its KV state. */
export const HTTP_MONEY_HOST_JOB = 'http-money-host'

/** The incident record's signal (incident-signals.ts). */
export const HTTP_MONEY_HOST_SIGNAL = 'http-money-host'

/** Which connections have an incident open, for the all clear each is owed. Never renamed. */
export const HTTP_MONEY_HOST_STATE_KEY = 'http-money-host:state'

/**
 * The Worker settings that must each give a money host. Read from the Worker's
 * own env, so one that gives none is a broken deploy, never a legitimate empty:
 * judging without it would pass every connection to the bidding database or
 * the bidding Worker's zone.
 */
export const REQUIRED_MONEY_HOST_SOURCES: readonly MoneyHostSource[] = ['SUPABASE_URL', 'APP_URL']

const LOG = `[${HTTP_MONEY_HOST_JOB}]`

export interface HttpConnection {
  id: string
  organization_id: string
  name: string
  target: unknown
}

/** The check's reads. Each throws on a failed read, never answering an empty list for one it could not read. */
export interface HttpMoneyHostReads {
  httpConnections(): Promise<HttpConnection[]>
  /** The organization's money hosts, or which of their sources could not be read. */
  moneyHosts(organizationId: string): Promise<MoneyHostsRead>
  /** The workflows of `organizationId` whose definition names `connectionId`. */
  workflowsNaming(organizationId: string, connectionId: string): Promise<{ id: string; name: string; active: boolean }[]>
}

export interface HttpMoneyHostDeps {
  kv: RecoveryKv
  reads: HttpMoneyHostReads
  /** Pages the connection's organization. Returns whether it reached Slack. */
  sendAlert(organizationId: string, alert: HttpMoneyHostAlert): Promise<boolean>
  /** The all clear. Returns whether it reached Slack. */
  sendRecovery(organizationId: string, recovery: StandingConnectionRecovery): Promise<boolean>
  /** The check could not judge everything: pages through the export alerter. */
  reportUnreadable(problems: string[]): Promise<void>
  /** The check judged everything: stands an earlier could-not-run page down. */
  reportReadable(): Promise<void>
  now(): number
}

export interface HttpMoneyHostSummary {
  /** False when the connections could not be read and nothing was judged. */
  judged: boolean
  /** The HTTP connections read. */
  connections: number
  /** The connections whose host bidding now sends to. */
  found: string[]
  paged: string[]
  allClear: string[]
  /** What could not be read, each naming it. Non empty means some connection was not judged. */
  unreadable: string[]
  /** Faults in the check's own bookkeeping, reported rather than thrown. */
  errors: string[]
}

/**
 * The host a stored HTTP connection sends to, read as the save reads it
 * (httpHostOf on the target's `host`), or null when it cannot be read. A host
 * another catalogue service owns is still answered: the save refuses it for
 * that reason first, but bidding may send there too.
 */
export function storedHttpHost(target: unknown): string | null {
  if (target === null || typeof target !== 'object' || Array.isArray(target)) return null
  const read = httpHostOf((target as Record<string, unknown>).host)
  if (read.ok) return read.host
  return read.problem === 'service_owned' ? read.host : null
}

export async function runHttpMoneyHostCheck(deps: HttpMoneyHostDeps): Promise<HttpMoneyHostSummary> {
  const nowMs = deps.now()
  const errors: string[] = []
  const summary: HttpMoneyHostSummary = { judged: false, connections: 0, found: [], paged: [], allClear: [], unreadable: [], errors }
  const unjudgedIds = new Set<string>()
  const unjudgedOrgs = new Set<string>()
  const settle = (findings: StandingConnectionFinding[] | null) => settleStandingConnections({
    kv: deps.kv,
    signal: HTTP_MONEY_HOST_SIGNAL,
    stateKey: HTTP_MONEY_HOST_STATE_KEY,
    nowMs,
    findings,
    unjudged: (id, organizationId) => unjudgedIds.has(id) || unjudgedOrgs.has(organizationId),
    sendRecovery: (organizationId, recovery) => deps.sendRecovery(organizationId, recovery),
    errors,
  })

  let connections: HttpConnection[]
  try {
    connections = await deps.reads.httpConnections()
  } catch (err) {
    summary.unreadable.push(`The HTTP connections could not be read, so none was checked: ${formatErr(err)}`)
    await settle(null)
    await deps.reportUnreadable(summary.unreadable)
    return summary
  }
  summary.judged = true
  summary.connections = connections.length

  // Each organization's money hosts, read once, only for organizations holding an HTTP connection.
  const hostsByOrg = new Map<string, MoneyHostsRead>()
  for (const organizationId of [...new Set(connections.map((c) => c.organization_id))]) {
    let read: MoneyHostsRead
    try {
      read = await deps.reads.moneyHosts(organizationId)
    } catch (err) {
      read = { ok: false, detail: `the hosts bidding sends to could not be read (${formatErr(err)})` }
    }
    if (read.ok) {
      const { hosts } = read
      const missing = REQUIRED_MONEY_HOST_SOURCES.filter((source) => !hosts.some((h) => h.source === source))
      if (missing.length > 0) read = { ok: false, detail: `${missing.join(' and ')} on bidspoke-worker gave no host` }
    }
    hostsByOrg.set(organizationId, read)
    if (!read.ok) {
      unjudgedOrgs.add(organizationId)
      const count = connections.filter((c) => c.organization_id === organizationId).length
      // The export alerter tells every organization, so the line names no organization; the log does.
      console.error(`${LOG} organization ${organizationId}: ${count} HTTP connection(s) not checked: ${read.detail}`)
      summary.unreadable.push(`${count === 1 ? 'An HTTP connection was' : `${count} HTTP connections were`} not checked against the hosts bidding sends to, because ${read.detail}.`)
    }
  }

  const findings: StandingConnectionFinding[] = []
  for (const c of connections) {
    const read = hostsByOrg.get(c.organization_id)
    if (read === undefined || !read.ok) continue
    const host = storedHttpHost(c.target)
    if (host === null) {
      unjudgedIds.add(c.id)
      continue
    }
    const money = moneyHostOf(host, read.hosts)
    if (money === null) continue
    summary.found.push(c.id)
    findings.push({
      id: c.id,
      organizationId: c.organization_id,
      label: opsConnectionLabel(c.name, HTTP_SERVICE_KEY),
      context: httpMoneyHostContext(money.source, money.origin),
      send: async (firstReportedAt) => {
        let workflows: HttpMoneyHostAlert['workflows'] = null
        try {
          workflows = await deps.reads.workflowsNaming(c.organization_id, c.id)
        } catch (err) {
          errors.push(`${c.id}: the workflows that use it could not be read, so the page does not name them: ${formatErr(err)}`)
        }
        return deps.sendAlert(c.organization_id, { name: c.name, host: money.host, source: money.source, origin: money.origin, workflows, firstReportedAt })
      },
    })
  }
  if (unjudgedIds.size > 0) {
    console.error(`${LOG} ${unjudgedIds.size} HTTP connection(s) not checked, their stored host unreadable: ${[...unjudgedIds].join(', ')}`)
    summary.unreadable.push(`${unjudgedIds.size === 1 ? 'An HTTP connection was' : `${unjudgedIds.size} HTTP connections were`} not checked because the host stored for ${unjudgedIds.size === 1 ? 'it' : 'each'} could not be read. The bidspoke-worker logs name ${unjudgedIds.size === 1 ? 'it' : 'them'} under http-money-host.`)
  }
  // Said before any enrichment, so a slow workflows read cannot hide what was found (L492).
  if (findings.length > 0) console.error(`${LOG} ${findings.length} HTTP connection${findings.length === 1 ? '' : 's'} reaching a host bidding sends to: ${findings.map((f) => `${f.id} (org ${f.organizationId})`).join(', ')}`)

  const outcome = await settle(findings)
  summary.paged = outcome.paged
  summary.allClear = outcome.allClear
  if (summary.unreadable.length > 0) await deps.reportUnreadable(summary.unreadable)
  else await deps.reportReadable()
  return summary
}

// ── Production wiring ───────────────────────────────────────────────────────

/** The reads, against the bidding database as service_role: the organization filter is the scoping. */
export function liveHttpMoneyHostReads(supabase: SupabaseClient, env: Env): HttpMoneyHostReads {
  const money = liveMoneyHostReads(supabase, env)
  return {
    httpConnections: () => fetchAllPaged<HttpConnection>(
      (from, to) => supabase
        .from('service_connections')
        // Never the sealed login or its config: the target holds the host, the header name and the check path.
        .select('id, organization_id, name, target')
        .eq('service_type', HTTP_SERVICE_KEY)
        .order('id', { ascending: true })
        .range(from, to),
      'the HTTP connections',
    ),
    moneyHosts: (organizationId) => readMoneyHosts(env as unknown as Record<string, unknown>, organizationId, money),
    workflowsNaming: (organizationId, connectionId) => workflowsNamingConnection(supabase, organizationId, connectionId),
  }
}

const UNREADABLE_FIX = 'The connections counted above were not checked, and nothing is checked again until the next daily batch. If it fails again, check that the bidding database answers and that SUPABASE_URL and APP_URL are set on bidspoke-worker, then search the bidspoke-worker logs for http-money-host.'

/** The daily check wired to the bidding Worker: the bidding database, the shared export alerter, Slack. */
export function runHttpMoneyHostCheckForEnv(supabase: SupabaseClient, env: Env): Promise<HttpMoneyHostSummary> {
  return runHttpMoneyHostCheck({
    kv: env.IDEMPOTENCY,
    reads: liveHttpMoneyHostReads(supabase, env),
    sendAlert: (organizationId, alert) => sendHttpMoneyHostAlert(supabase, organizationId, alert, env.APP_URL),
    sendRecovery: (organizationId, recovery) => sendHttpMoneyHostRecoveryAlert(supabase, organizationId, recovery, env.APP_URL),
    reportUnreadable: (problems) => notifyExportFailure(supabase, HTTP_MONEY_HOST_JOB, problems, env.IDEMPOTENCY, {
      title: 'The HTTP connection host check could not run',
      fixHint: UNREADABLE_FIX,
    }),
    reportReadable: () => notifyExportRecovery(env.IDEMPOTENCY, HTTP_MONEY_HOST_JOB, Date.now()),
    now: () => Date.now(),
  })
}
