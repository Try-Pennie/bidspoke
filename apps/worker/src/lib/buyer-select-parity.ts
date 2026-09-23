/**
 * The Stage A parity summary (#1413, Phase 6, PR 3): per workflow and Eastern
 * day, what the buyer_select node decided beside what the incumbent
 * tripoint_ping step did in the same execution, counted into one
 * buyer_select_parity_days row (L202: execution_steps is purged after
 * RETENTION_DAYS, so the Stage A exit criteria are read from these rows).
 *
 * Every comparison names what it could not measure rather than counting it as
 * agreement (L11, L90): a body hash missing on either side is hash_unmeasured,
 * an execution missing one of the two rows is unpaired, and the counts the node
 * does not yet record are listed in `unmeasured` by name. The latency
 * percentiles and the state counts describe only the rows that rehearsed: a
 * lead the node decided was not for sale took no time and resolved no state,
 * and on a real day those are most rows (#1506, #1507). The row carries a
 * hash of its counts, so a sign off is tied to the numbers it approved (L641);
 * the refresh clears a sign off whose numbers have moved. A day is complete
 * only when its Eastern midnight has passed AND the purge has not yet reached
 * it (L696, L202).
 *
 * The pure summary is here; the reads, the write and the routes are wired at
 * the bottom of the file and in routes/api/buyer-select-parity.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { canonicalBodySha256, easternDayStartUtc, easternParts, evaluateSaleOutcome, type Signal } from '@bidspoke/buyer-profile'
import { RETENTION_DAYS } from '../archive/candidate-days'
import type { Env } from '../index'
import { loadBuyerProfiles } from './buyer-profile-loader'
import { notifyExportFailure, type AlertRemedy } from './export-alerts'
import { fetchAllPaged } from './paginate'

export { RETENTION_DAYS }

/**
 * The incumbent seller's step namespace in the Engine Bidding Workflow, the one
 * flow Stage A runs in (docs/engine-cutover-scope.md). A code node has no type
 * to key on, so the namespace is the key.
 */
export const INCUMBENT_NAMESPACE = 'tripoint_ping'

// ── Shapes ────────────────────────────────────────────────────────────────────

/** The fields of the node's output the comparison reads. */
export interface NodeOutputLike {
  _route: string
  reason?: string
  mode_effective?: string
  would_send_body_sha256?: string
  /** The two letter state the node resolved for the lead, null when it could not; absent from older node versions. */
  lead_state?: string | null
  rehearsal_in_doubt_heals?: number
  rehearsal_expired_in_flight?: number
}

/** The fields of tripoint_ping's output the comparison reads (its live script, 2026-09-22). */
export interface IncumbentOutputLike {
  skipped: unknown
  qualified: unknown
  resultCode: unknown
  /** Added by Phase 7; absent until then. */
  sent_body_sha256?: unknown
  debug?: { httpStatus?: unknown; rawText?: unknown }
}

export interface ParityExecution {
  execution_id: string
  started_at: string
  node: NodeOutputLike | null
  node_duration_ms: number | null
  incumbent: IncumbentOutputLike | null
}

export interface ParityRules {
  accept: Signal[]
  decline: Signal[]
}

export interface ParityCounts {
  sell_off_agree: number
  sell_off_disagree: number
  hash_match: number
  hash_mismatch: number
  hash_unmeasured: number
  classification_agree: number
  classification_disagree: number
  outcome_unknown_count: number
  state_resolved: number
  state_unresolved: number
  rehearsal_in_doubt_heals: number
  rehearsal_expired_in_flight: number
  decide_only_latency_p50_ms: number | null
  decide_only_latency_p95_ms: number | null
  executions_unpaired: number
  disagreement_execution_ids: string[]
  /** What this summary could not measure, by name, with a count where one applies. */
  unmeasured: string[]
}

// ── The summary ───────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const sha256 = (v: unknown): string | null => (typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : null)

function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

/** What the incumbent concluded, in the classifier's vocabulary. */
function incumbentVerdict(inc: IncumbentOutputLike): 'accepted' | 'declined_by_buyer' {
  return inc.qualified === true ? 'accepted' : 'declined_by_buyer'
}

export function summariseParityDay(executions: ParityExecution[], rules: ParityRules): ParityCounts {
  const counts: ParityCounts = {
    sell_off_agree: 0, sell_off_disagree: 0,
    hash_match: 0, hash_mismatch: 0, hash_unmeasured: 0,
    classification_agree: 0, classification_disagree: 0, outcome_unknown_count: 0,
    state_resolved: 0, state_unresolved: 0,
    rehearsal_in_doubt_heals: 0, rehearsal_expired_in_flight: 0,
    decide_only_latency_p50_ms: null, decide_only_latency_p95_ms: null,
    executions_unpaired: 0,
    disagreement_execution_ids: [],
    unmeasured: [],
  }
  const disagree = new Set<string>()
  const durations: number[] = []
  let stateNotRecorded = 0
  let classificationNoResponse = 0
  let healsRecorded = false
  let expiredRecorded = false

  for (const e of executions) {
    // A lead the node decided was not for sale did no rehearsal: it took no time and
    // resolved no state, so it says nothing about either (#1506, #1507). Only the rows
    // that rehearsed are the population these two measurements describe.
    const rehearsed = e.node !== null && e.node._route !== 'not_applicable'
    if (e.node && rehearsed && typeof e.node_duration_ms === 'number' && e.node.mode_effective === 'decide_only') durations.push(e.node_duration_ms)

    if (e.node && rehearsed) {
      if (e.node.lead_state === undefined) stateNotRecorded += 1
      else if (e.node.lead_state === null) counts.state_unresolved += 1
      else counts.state_resolved += 1
    }
    if (e.node) {
      if (typeof e.node.rehearsal_in_doubt_heals === 'number') { healsRecorded = true; counts.rehearsal_in_doubt_heals += e.node.rehearsal_in_doubt_heals }
      if (typeof e.node.rehearsal_expired_in_flight === 'number') { expiredRecorded = true; counts.rehearsal_expired_in_flight += e.node.rehearsal_expired_in_flight }
    }

    if (!e.node || !e.incumbent) { counts.executions_unpaired += 1; continue }

    // Sell off: the node says not for sale exactly when the incumbent skipped.
    const nodeSkipped = e.node._route === 'not_applicable'
    const incumbentSkipped = e.incumbent.skipped === true
    if (nodeSkipped === incumbentSkipped) counts.sell_off_agree += 1
    else { counts.sell_off_disagree += 1; disagree.add(e.execution_id) }

    if (incumbentSkipped) continue

    // Body hash: only when both sides recorded one.
    const ours = sha256(e.node.would_send_body_sha256)
    const theirs = sha256(e.incumbent.sent_body_sha256)
    if (ours && theirs) {
      if (ours === theirs) counts.hash_match += 1
      else { counts.hash_mismatch += 1; disagree.add(e.execution_id) }
    } else {
      counts.hash_unmeasured += 1
    }

    // Classification: the shared classifier over what the incumbent recorded.
    const debug = isRecord(e.incumbent.debug) ? e.incumbent.debug : null
    const status = debug && typeof debug.httpStatus === 'number' ? debug.httpStatus : null
    const rawText = debug && typeof debug.rawText === 'string' ? debug.rawText : null
    if (status === null || rawText === null) { classificationNoResponse += 1; continue }
    let body: unknown
    try { body = JSON.parse(rawText) } catch { body = null }
    const isHtml = /^\s*</.test(rawText)
    const verdict = evaluateSaleOutcome(rules.accept, rules.decline, status, body, isHtml, true).outcome
    if (verdict === 'outcome_unknown') { counts.outcome_unknown_count += 1; disagree.add(e.execution_id); continue }
    if (verdict === incumbentVerdict(e.incumbent)) counts.classification_agree += 1
    else { counts.classification_disagree += 1; disagree.add(e.execution_id) }
  }

  if (durations.length > 0) {
    const sorted = [...durations].sort((a, b) => a - b)
    counts.decide_only_latency_p50_ms = nearestRank(sorted, 0.5)
    counts.decide_only_latency_p95_ms = nearestRank(sorted, 0.95)
  }
  if (stateNotRecorded > 0) counts.unmeasured.push(`state:${stateNotRecorded} rehearsed execution${stateNotRecorded === 1 ? '' : 's'} with no recorded state`)
  if (classificationNoResponse > 0) counts.unmeasured.push(`classification:${classificationNoResponse} execution${classificationNoResponse === 1 ? '' : 's'} without a recorded response`)
  if (!healsRecorded) counts.unmeasured.push('rehearsal_in_doubt_heals')
  if (!expiredRecorded) counts.unmeasured.push('rehearsal_expired_in_flight')
  counts.disagreement_execution_ids = [...disagree]
  return counts
}

/**
 * True only for a day that is both fully elapsed (its Eastern midnight has
 * passed) and not yet touched by the execution purge, which drops steps older
 * than `retentionDays` days.
 */
export function windowComplete(day: string, nowMs: number, retentionDays: number): boolean {
  const dayStart = easternDayStartUtc(day)
  const nextDayStart = easternDayStartUtc(nextIsoDate(day))
  if (nextDayStart > nowMs) return false
  const purgeReach = nowMs - retentionDays * 86_400_000
  return dayStart > purgeReach
}

export function nextIsoDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export function previousIsoDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

/** A hash over the counts only, never the bookkeeping, so a sign off names the numbers it approved (L641). */
export function countsHash(counts: ParityCounts): Promise<string> {
  const { unmeasured: _unmeasured, disagreement_execution_ids, ...numbers } = counts
  void _unmeasured
  return canonicalBodySha256({ ...numbers, disagreement_execution_ids: [...disagreement_execution_ids].sort() })
}

// ── Reading a day ─────────────────────────────────────────────────────────────

export interface ParityReadDeps {
  /** How many buyer_select rows the workflow wrote inside [fromIso, toIso); zero means the node was not on the canvas then. */
  countNodeRows(workflowId: string, fromIso: string, toIso: string): Promise<number>
  /** Executions of the workflow started inside [fromIso, toIso), oldest first, every one of them (paged past the row cap). */
  listExecutions(workflowId: string, fromIso: string, toIso: string): Promise<Array<{ id: string; started_at: string }>>
  /** The node and incumbent rows for the executions given. */
  readRows(executionIds: string[], fromIso: string, toIso: string): Promise<Array<{ execution_id: string; step_type: string; step_namespace: string; output: unknown; duration_ms: number | null }>>
}

/** Three hour windows over the day, so no single read spans more than a partition's worth of rows. */
export const READ_WINDOW_MS = 3 * 3_600_000

export async function readParityDay(deps: ParityReadDeps, workflowId: string, day: string): Promise<ParityExecution[]> {
  const start = easternDayStartUtc(day)
  const end = easternDayStartUtc(nextIsoDate(day))
  const out: ParityExecution[] = []
  for (let from = start; from < end; from += READ_WINDOW_MS) {
    const to = Math.min(from + READ_WINDOW_MS, end)
    const fromIso = new Date(from).toISOString()
    const toIso = new Date(to).toISOString()
    // One cheap count before the expensive listing (#1497): a window with no
    // node row at all is one the node was not on the canvas for, and listing
    // its executions (about 10,000 per window on the Engine flow, in pages of
    // 1,000) would only count every one of them as unpaired. A window where the
    // node ran and some executions lack its row is still read in full, and
    // those executions are the unpaired count.
    if ((await deps.countNodeRows(workflowId, fromIso, toIso)) === 0) continue
    const executions = await deps.listExecutions(workflowId, fromIso, toIso)
    if (executions.length === 0) continue
    const rows = await deps.readRows(executions.map((e) => e.id), fromIso, toIso)
    const byExecution = new Map<string, ParityExecution>()
    for (const e of executions) byExecution.set(e.id, { execution_id: e.id, started_at: e.started_at, node: null, node_duration_ms: null, incumbent: null })
    for (const r of rows) {
      const target = byExecution.get(r.execution_id)
      if (!target) continue
      if (r.step_type === 'buyer_select' && isRecord(r.output) && typeof r.output._route === 'string') {
        target.node = r.output as unknown as NodeOutputLike
        target.node_duration_ms = typeof r.duration_ms === 'number' ? r.duration_ms : null
      } else if (r.step_namespace === INCUMBENT_NAMESPACE && isRecord(r.output) && 'skipped' in r.output) {
        target.incumbent = r.output as unknown as IncumbentOutputLike
      }
    }
    // Only executions the node actually ran in count: before Stage A places the
    // node, the flow has no buyer_select step and the day has nothing to compare.
    for (const e of byExecution.values()) if (e.node || e.incumbent) out.push(e)
  }
  return out
}

/** The accept and decline rules the incumbent buyer is judged by, from the same loader the node reads. */
export async function incumbentRules(orgId: string, env: Env, supabase: SupabaseClient, slug = 'tripoint'): Promise<ParityRules | null> {
  const snapshot = await loadBuyerProfiles(orgId, env.WORKFLOW_CACHE, supabase)
  const buyer = snapshot.buyers.find((b) => b.partner.slug === slug)
  if (!buyer) return null
  const decline = buyer.partner.response_classification?.rejection_signals ?? []
  return { accept: buyer.partner.accept_signals, decline }
}

export function productionReadDeps(supabase: SupabaseClient): ParityReadDeps {
  return {
    countNodeRows: async (workflowId, fromIso, toIso) => {
      const { count, error } = await supabase
        .from('execution_steps')
        .select('execution_id', { count: 'exact', head: true })
        .eq('workflow_id', workflowId)
        .eq('step_type', 'buyer_select')
        .gte('execution_started_at', fromIso)
        .lt('execution_started_at', toIso)
      if (error) throw new Error(`execution_steps count: ${error.message}`)
      // A null count is an unanswered question, not zero rows (L215): read the
      // window rather than skip it.
      return count ?? 1
    },
    // Paged, because a three hour window of the Engine flow holds about 10,000
    // executions and PostgREST answers at most 1,000 rows however high the limit
    // (#1497): the first Stage A refresh listed each window's first 1,000 and
    // recorded the day as unpaired. Ordered by started_at with id as the
    // tiebreaker so offset pages neither skip nor repeat an execution.
    listExecutions: (workflowId, fromIso, toIso) =>
      fetchAllPaged<{ id: string; started_at: string }>(
        (from, to) => supabase
          .from('workflow_executions')
          .select('id, started_at')
          .eq('workflow_id', workflowId)
          .eq('is_test', false)
          .gte('started_at', fromIso)
          .lt('started_at', toIso)
          .order('started_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
        'workflow_executions',
      ),
    readRows: async (executionIds, fromIso, toIso) => {
      const out: Array<{ execution_id: string; step_type: string; step_namespace: string; output: unknown; duration_ms: number | null }> = []
      // PostgREST caps a read at 1,000 rows, so the ids are read in slices that
      // cannot exceed it even with both rows present (L24).
      for (let i = 0; i < executionIds.length; i += 400) {
        const slice = executionIds.slice(i, i + 400)
        const { data, error } = await supabase
          .from('execution_steps')
          .select('execution_id, step_type, step_namespace, output, duration_ms')
          .in('execution_id', slice)
          .gte('execution_started_at', fromIso)
          .lt('execution_started_at', toIso)
          .or(`step_type.eq.buyer_select,step_namespace.eq.${INCUMBENT_NAMESPACE}`)
          .limit(1000)
        if (error) throw new Error(`execution_steps: ${error.message}`)
        out.push(...((data ?? []) as typeof out))
      }
      return out
    },
  }
}

/**
 * The days the hourly refresh summarises: today (incomplete by construction)
 * and yesterday, so a finished day is re-read once with window_complete true.
 * Older days keep the row they have: their step rows never change, and reading
 * every day inside retention each hour costs about 300 database requests per
 * day at the Engine flow's volume (10,000 executions per three hour window in
 * pages of 1,000 plus the row slices), against an invocation budget of about
 * 900 shared with the other hourly work (#1497). Any day can still be re-read
 * by hand through POST /api/admin/buyer-select/parity/refresh with a `day`.
 */
export function refreshableDays(nowMs: number, retentionDays: number): string[] {
  const today = easternParts(nowMs).date
  const yesterday = previousIsoDate(today)
  return windowComplete(yesterday, nowMs, retentionDays) ? [today, yesterday] : [today]
}

// ── The refresh ───────────────────────────────────────────────────────────────

/** The heartbeat name of the hourly refresh. */
export const BUYER_SELECT_PARITY_JOB = 'buyer-select-parity'

export interface ParityWorkflow {
  id: string
  organization_id: string
}

/** The row the upsert rpc takes: the counts, the hash, the window flag, never a sign off column. */
export type ParityRowWrite = ParityCounts & {
  workflow_id: string
  et_day: string
  organization_id: string
  window_complete: boolean
  counts_hash: string
}

export interface RefreshDeps {
  /** The workflows whose definition carries a buyer_select node. */
  listWorkflows(): Promise<ParityWorkflow[]>
  /** The incumbent buyer's accept and decline rules for the organisation; null when it has none. */
  rules(orgId: string): Promise<ParityRules | null>
  read: ParityReadDeps
  upsert(row: ParityRowWrite): Promise<unknown>
  now(): number
  retentionDays: number
  localDev: boolean
  log(line: string): void
}

export interface RefreshSummary {
  skipped?: 'local_dev'
  days: string[]
  rows_written: number
  errors: string[]
}

export async function runParityRefresh(deps: RefreshDeps, only: { workflowId?: string; day?: string } = {}): Promise<RefreshSummary> {
  const now = deps.now()
  const days = only.day ? [only.day] : refreshableDays(now, deps.retentionDays)
  if (deps.localDev) {
    deps.log(`[${BUYER_SELECT_PARITY_JOB}] skipped: local dev`)
    return { skipped: 'local_dev', days, rows_written: 0, errors: [] }
  }
  const errors: string[] = []
  let written = 0

  let workflows: ParityWorkflow[]
  try {
    workflows = (await deps.listWorkflows()).filter((w) => !only.workflowId || w.id === only.workflowId)
  } catch (err) {
    return { days, rows_written: 0, errors: [`the workflow list could not be read: ${messageOf(err)}`] }
  }

  for (const wf of workflows) {
    let rules: ParityRules | null
    try {
      rules = await deps.rules(wf.organization_id)
    } catch (err) {
      errors.push(`${wf.id}: the buyer rules could not be read: ${messageOf(err)}`)
      continue
    }
    if (!rules) {
      errors.push(`${wf.id}: the incumbent buyer has no accept and decline rules in this organisation, so its responses cannot be classified; nothing written`)
      continue
    }
    for (const day of days) {
      try {
        const executions = await readParityDay(deps.read, wf.id, day)
        const counts = summariseParityDay(executions, rules)
        const row: ParityRowWrite = {
          ...counts,
          workflow_id: wf.id,
          et_day: day,
          organization_id: wf.organization_id,
          window_complete: windowComplete(day, now, deps.retentionDays),
          counts_hash: await countsHash(counts),
        }
        await deps.upsert(row)
        written += 1
      } catch (err) {
        errors.push(`${wf.id} ${day}: ${messageOf(err)}`)
      }
    }
  }
  return { days, rows_written: written, errors }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : 'non Error thrown')

interface WorkflowDefinitionRow {
  id: string
  organization_id: string
  definition: { nodes?: Array<{ type?: unknown }> } | null
}

export function productionRefreshDeps(supabase: SupabaseClient, env: Env): RefreshDeps {
  return {
    listWorkflows: async () => {
      // The workflows table is small (about a dozen rows), so the definitions are
      // read whole and filtered here; a buyer_select node is what makes a
      // workflow a parity subject.
      const { data, error } = await supabase
        .from('workflows')
        .select('id, organization_id, definition')
        .is('deleted_at', null)
        .limit(200)
      if (error) throw new Error(`workflows: ${error.message}`)
      return ((data ?? []) as unknown as WorkflowDefinitionRow[])
        .filter((w) => Array.isArray(w.definition?.nodes) && w.definition.nodes.some((n) => n.type === 'buyer_select'))
        .map((w) => ({ id: w.id, organization_id: w.organization_id }))
    },
    rules: (orgId) => incumbentRules(orgId, env, supabase),
    read: productionReadDeps(supabase),
    upsert: async (row) => {
      const { data, error } = (await supabase.rpc('upsert_buyer_select_parity_day', { p_row: row })) as { data: unknown; error: { message: string } | null }
      if (error) throw new Error(`upsert_buyer_select_parity_day: ${error.message}`)
      return data
    },
    now: () => Date.now(),
    retentionDays: RETENTION_DAYS,
    localDev: Boolean(env.LOCAL_DEV),
    log: (line) => console.log(line),
  }
}

export const BUYER_SELECT_PARITY_REMEDY: AlertRemedy = {
  consequence:
    'A parity day could not be summarised or written, so the buyer_select_parity_days record the Stage A exit criteria are read ' +
    'from is behind for that day. Selling is unaffected; this is the comparison record, not the sale. The lines below name the ' +
    'workflow, the day and what failed:',
  fixHint:
    'A read error (statement timeout, an unreadable table) clears itself on the next hour if the database is healthy; a day that ' +
    'keeps failing can be re-run by hand with POST /api/admin/buyer-select/parity/refresh {"workflow_id", "day"}. A workflow ' +
    "reported as having no accept and decline rules needs the incumbent buyer's rules saved on its partner page.",
  headlineVerb: 'could not summarise a day',
  itemNoun: { one: 'day', many: 'days' },
}

/**
 * What the scheduled handler and the refresh route call. A run whose days could
 * not all be written pages through the shared alerter (L13), so a day cannot
 * pass out of retention unsummarised with nothing said; a clean run clears it.
 */
export async function runParityRefreshAndPage(deps: RefreshDeps, notify: (lines: string[]) => Promise<void>, only: { workflowId?: string; day?: string } = {}): Promise<RefreshSummary> {
  const summary = await runParityRefresh(deps, only)
  // Only a FULL run speaks for the job: a skipped run measured nothing, and a
  // run scoped to one workflow or one day (the route's retry) knows nothing about
  // the days it did not touch, so its clean answer must not clear a standing
  // page for them (L11). Its result is the HTTP response.
  const full = !only.workflowId && !only.day
  if (!summary.skipped && full) await notify(summary.errors)
  return summary
}

export function runBuyerSelectParityRefreshForEnv(supabase: SupabaseClient, env: Env, only: { workflowId?: string; day?: string } = {}): Promise<RefreshSummary> {
  return runParityRefreshAndPage(
    productionRefreshDeps(supabase, env),
    (lines) => notifyExportFailure(supabase, BUYER_SELECT_PARITY_JOB, lines, env.IDEMPOTENCY, BUYER_SELECT_PARITY_REMEDY),
    only,
  )
}
