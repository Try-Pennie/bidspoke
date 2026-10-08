/**
 * The pure parts of the outage drill (#1305, plan on #1675).
 *
 * The drill runs each money flow's live leads twice from the same warmed state:
 * once with the database up and once with it failing, and requires the failing
 * run to decide and send exactly what its twin did. This module holds what that
 * needs and can be tested without workerd: the shapes a failing database takes,
 * the naming rule for stored copies, decisions read from the engine's own step
 * records (a down run never writes its step rows), the comparison, and the
 * exemptions for flows that do not pass yet.
 */

import { LEAD_READ_DEADLINE_MS } from '../../src/lib/lead-read-budget'

/**
 * How the database answers in an outage. `refused` is a connection that never
 * opens; `unavailable_503` is PostgREST answering that it cannot reach Postgres
 * (PGRST002, with Retry-After); `gateway_html_522` is Cloudflare in front of
 * Supabase answering with an HTML error page. Which one 2026-09-10 produced was
 * never recorded, so all of them are drilled. `hung` is a database that never
 * answers (#1851): only the caller giving up ends a request, so a wait with no
 * deadline is a run that never finishes, which the drill stops by name.
 */
export const OUTAGE_SHAPES = ['refused', 'unavailable_503', 'gateway_html_522', 'hung'] as const
export type OutageShape = (typeof OUTAGE_SHAPES)[number]

export interface OutageNetwork {
  fetch: typeof fetch
  /** How many requests reached the failing database: a positive control. */
  requests(): number
}

/** A request no one answers: it ends only when its signal aborts, as fetch does. */
function never(signal: AbortSignal | undefined): Promise<Response> {
  const aborted = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  return new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted) return reject(aborted())
    signal?.addEventListener('abort', () => reject(aborted()), { once: true })
  })
}

export function outageNetwork(shape: OutageShape): OutageNetwork {
  let count = 0
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    count++
    if (shape === 'hung') return await never(init?.signal ?? undefined)
    if (shape === 'refused') throw new TypeError('fetch failed')
    if (shape === 'unavailable_503') {
      return new Response(
        JSON.stringify({ code: 'PGRST002', details: null, hint: null, message: 'Could not query the database for the schema cache. Retrying.' }),
        { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '1' } },
      )
    }
    return new Response('<!DOCTYPE html><html><head><title>Connection timed out | supabase.co | Cloudflare</title></head><body>Error code 522</body></html>', {
      status: 522,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    })
  }) as typeof fetch
  return { fetch: fetchImpl, requests: () => count }
}

/**
 * How long the whole drill may run before vitest stops it (#1851). The hung
 * shape waits out each bounded deadline for real, so it is the slow one: with
 * it the drill took 608 s on a laptop on 2026-10-07, and CI ran the three shape
 * drill 5 to 20 percent slower than the same laptop. Twenty minutes is half as
 * much again as the slowest of those, and the jobs' 25 leave room to install,
 * build and upload the report, so a slow run still ends with a verdict.
 */
export const OUTAGE_DRILL_TIMEOUT_MS = 20 * 60_000

/**
 * How much later than its database-up twin a lead may be answered while the
 * database hangs (#1851): twice the lead read deadline, the budget a lead spends
 * before going to its stored copies, with room for a second bounded wait.
 * Engine's own timeout is recorded nowhere; production shows it routinely waits
 * about 10 s (the Engine flow's slowest 1 in 1,000 answers took 9.4 s over the 7
 * days to 2026-10-07), so the rule is relative to the twin, not a guessed cutoff.
 */
export const HUNG_ANSWER_ALLOWANCE_MS = 2 * LEAD_READ_DEADLINE_MS

/** The difference to report when the down run answered too long after its twin, or null. */
export function lateAnswer(upMs: number, downMs: number): OutageDifference | null {
  if (downMs - upMs <= HUNG_ANSWER_ALLOWANCE_MS) return null
  return { field: 'answer_time', detail: `up answered in ${Math.round(upMs)} ms; down in ${Math.round(downMs)} ms, more than ${HUNG_ANSWER_ALLOWANCE_MS} ms later` }
}

/**
 * Whether an unhandled error vitest reports is the outage network's own rejection:
 * the refused shape refusing a request, or the hung shape abandoning one its
 * caller gave up on. workerd reports a rejected fetch as unhandled even when
 * supabase-js catches it and the caller awaits the answer (reproduced 2026-10-07
 * with a single awaited read and nothing of ours around it), so every such read
 * would otherwise fail the drill. Matched on the error itself AND its origin in
 * this file, so any other unhandled error still fails the run.
 */
export function isOutageNetworkRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; message?: unknown; stack?: unknown }
  const ours = typeof e.stack === 'string' && /money-gate\/lib\/outage\.ts/.test(e.stack)
  const refused = e.name === 'TypeError' && e.message === 'fetch failed'
  const abandoned = e.name === 'AbortError' && e.message === 'The operation was aborted'
  return ours && (refused || abandoned)
}

/**
 * A KV key holding a stored copy served when the database cannot be read. Every
 * such key the worker writes names itself `lastgood` (ep-lastgood:,
 * partner-lastgood:, env-vars-<org>-lastgood, partner-constants-v2-<org>-lastgood,
 * buyer-profiles:<org>:lastgood, workflow-def-lastgood:, slack-conns-lastgood),
 * and no fast cache key does.
 */
export function isLastGoodKey(name: string): boolean {
  return /last-?good/.test(name)
}

/** The fields of an engine step record the drill reads. */
export interface ObservedStep {
  step_order: number
  step_namespace: string
  step_node_id?: string | null
  step_type: string
  output: unknown
}

export interface RouteRecord { node: string; namespace: string; type: string; route: string }
export interface Decisions { routes: RouteRecord[]; nodes_executed: string[]; final_node: string | null }

/** A run's decisions, from the steps the engine queued, in step order. */
export function decisionsFrom(steps: ObservedStep[]): Decisions {
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order || a.step_namespace.localeCompare(b.step_namespace))
  const routes = ordered
    .filter((s) => s.output && typeof s.output === 'object' && typeof (s.output as Record<string, unknown>)._route === 'string')
    .map((s) => ({ node: String(s.step_node_id ?? s.step_namespace), namespace: s.step_namespace, type: s.step_type, route: String((s.output as Record<string, unknown>)._route) }))
  return {
    routes,
    nodes_executed: ordered.map((s) => s.step_namespace),
    final_node: ordered.length ? ordered[ordered.length - 1].step_namespace : null,
  }
}

/**
 * The first step, in step order, whose output differs between the two runs, or
 * that only one of them reached: the cause a report names, where the decisions
 * only say where the paths split. A diagnostic for the report, never compared.
 */
export function firstStepOutputDifference(up: ObservedStep[], down: ObservedStep[]): { namespace: string; up: string; down: string } | null {
  const order = (xs: ObservedStep[]) => [...xs].sort((a, b) => a.step_order - b.step_order || a.step_namespace.localeCompare(b.step_namespace))
  const upByNs = new Map(up.map((s) => [s.step_namespace, s]))
  const downByNs = new Map(down.map((s) => [s.step_namespace, s]))
  const namespaces = [...new Set([...order(up), ...order(down)].sort((a, b) => a.step_order - b.step_order).map((s) => s.step_namespace))]
  for (const ns of namespaces) {
    const a = upByNs.get(ns)
    const b = downByNs.get(ns)
    const sa = a ? canonical(a.output) : '(not reached)'
    const sb = b ? canonical(b.output) : '(not reached)'
    if (sa !== sb) return { namespace: ns, up: sa.slice(0, 400), down: sb.slice(0, 400) }
  }
  return null
}

export interface OutboundSent { via: string; method: string; host: string; path: string; headers?: Record<string, string>; body: unknown }
export interface DispatchSent { binding: string; name: string; path: string; namespaces: string[] }

/** What one run decided and sent, as the drill compares it. */
export interface OutageRecord {
  response: { status: number; body: unknown; headers?: unknown }
  outbound: OutboundSent[]
  code_dispatch: DispatchSent[]
  decisions: Decisions
  do_state: Record<string, unknown>
  error: string | undefined
}

export interface OutageDifference { field: string; detail: string }

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  ) ?? 'undefined'
}

const short = (v: unknown) => {
  const s = canonical(v)
  return s.length > 300 ? `${s.slice(0, 300)}...` : s
}

/**
 * Every way the database-down run differs from its database-up twin, the error
 * first: a run that threw differs everywhere after it, and the throw is what an
 * exemption names. Outbound requests and dispatches are compared as sorted lists,
 * because parallel calls land in either order.
 */
export function compareOutage(up: OutageRecord, down: OutageRecord): OutageDifference[] {
  const diffs: OutageDifference[] = []
  const check = (field: string, a: unknown, b: unknown) => {
    if (canonical(a) === canonical(b)) return
    if (Array.isArray(a) && Array.isArray(b)) {
      // The first place the runs part: a long list cut short would hide it (L445).
      let i = 0
      while (i < a.length && i < b.length && canonical(a[i]) === canonical(b[i])) i++
      const at = (xs: unknown[]) => (i < xs.length ? short(xs[i]) : '(nothing)')
      diffs.push({ field, detail: `at [${i}]: up ${at(a)}; down ${at(b)} (up has ${a.length}, down has ${b.length})` })
      return
    }
    diffs.push({ field, detail: `up ${short(a)}; down ${short(b)}` })
  }
  if ((up.error ?? null) !== (down.error ?? null)) diffs.push({ field: 'error', detail: down.error ?? `down run did not throw; up threw ${up.error}` })
  check('response', up.response, down.response)
  const sorted = <T>(xs: T[]) => [...xs].map(canonical).sort()
  check('outbound', sorted(up.outbound), sorted(down.outbound))
  check('code_dispatch', sorted(up.code_dispatch), sorted(down.code_dispatch))
  check('routes', up.decisions.routes, down.decisions.routes)
  check('nodes_executed', up.decisions.nodes_executed, down.decisions.nodes_executed)
  check('final_node', up.decisions.final_node, down.decisions.final_node)
  check('do_state', comparedDoState(up.do_state), comparedDoState(down.do_state))
  return diffs
}

/**
 * Durable Object namespaces whose state is not compared. ALERT_CLAIM records who
 * may post an alert (#1298), and since #1881 the outcome dead letter takes its
 * cooldown there: an outage is expected to raise alerts its twin does not, and no
 * alert claim decides anything about a lead. Every other object is compared.
 */
export const DO_STATE_NOT_COMPARED = ['ALERT_CLAIM'] as const

function comparedDoState(state: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([ns]) => !(DO_STATE_NOT_COMPARED as readonly string[]).includes(ns)))
}

/**
 * A flow that does not pass the drill yet, keyed on the workflow, the outage
 * shape (or `*`) and its expected FIRST difference (`field: pattern`, `*` as a
 * wildcard), so any other difference in that flow still fails. Each carries the
 * issue that removes it and a date it stops excusing anything.
 */
export interface OutageExemption {
  workflow: string
  shape: OutageShape | '*'
  first_difference: string
  issue: number
  expires: string
}

export interface FixtureOutcome {
  workflow: string
  variant: string
  shape: OutageShape
  diffs: OutageDifference[]
  /** Where the cause is: the first step whose output differs (a diagnostic). */
  first_step_difference?: { namespace: string; up: string; down: string } | null
}

function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's')
}

function matches(e: OutageExemption, f: FixtureOutcome): boolean {
  if (e.workflow !== f.workflow) return false
  if (e.shape !== '*' && e.shape !== f.shape) return false
  const first = f.diffs[0]
  return !!first && wildcard(e.first_difference).test(`${first.field}: ${first.detail}`)
}

/**
 * The drill's verdict. A fixture with differences passes only when a live
 * exemption matches its first difference. An exemption past its date, or one
 * that matched no fixture, is itself a failure, so a flow that has been fixed
 * cannot stay exempt and an exemption cannot outlive its issue.
 */
export function applyExemptions(outcomes: FixtureOutcome[], exemptions: OutageExemption[], today: string): { failures: string[]; excused: FixtureOutcome[] } {
  const failures: string[] = []
  const excused: FixtureOutcome[] = []
  const used = new Set<OutageExemption>()
  for (const f of outcomes) {
    if (f.diffs.length === 0) continue
    // A live entry wins over an expired one for the same difference, whatever
    // their order; the expired one then matched nothing and is reported for removal.
    const candidates = exemptions.filter((e) => matches(e, f))
    const hit = candidates.find((e) => e.expires >= today) ?? candidates[0]
    if (hit) {
      used.add(hit)
      if (hit.expires < today) {
        failures.push(`${f.workflow}/${f.variant} [${f.shape}]: its exemption expired on ${hit.expires} (#${hit.issue}); ${f.diffs[0].field}: ${f.diffs[0].detail}`)
      } else {
        excused.push(f)
      }
      continue
    }
    failures.push(`${f.workflow}/${f.variant} [${f.shape}] differs from its database-up twin: ${f.diffs.map((d) => `${d.field}: ${d.detail}`).join(' | ')}`)
  }
  for (const e of exemptions) {
    if (!used.has(e)) failures.push(`exemption for ${e.workflow} [${e.shape}] '${e.first_difference}' matched no difference; remove it (#${e.issue})`)
  }
  return { failures, excused }
}
