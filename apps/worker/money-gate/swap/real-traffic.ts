/**
 * Instrument 3 of a validation swap (#2591): the candidate node replayed over
 * real production runs, sized, counts only.
 *
 * What it reads, all through a client whose writes and rpc throw
 * (lib/read-only-client.ts):
 * - the workflow's versions, to find those whose replaced step's script has the
 *   md5 the candidate pins: only runs of those versions are judged, because a run
 *   of another version ran another script;
 * - its runs, one hour of `started_at` at a time, every page of 1,000 counted
 *   against an exact count first, each request bounded at 30 s;
 * - the steps of those runs the node reads, and the replaced step itself, by
 *   `execution_started_at` (the partition key, equal to the run's `started_at`)
 *   so each read stays in one partition.
 *
 * What the script did is what production recorded for the step; what the node
 * does is its own executor run on the recorded payload and step outputs, with the
 * candidate's Constants data applied. Each run lands in exactly one bucket
 * (outcomes.ts). It prints counts only: never a payload value, never an id.
 *
 * It refuses to report, by name, on a read it cannot vouch for: no version
 * carrying the pinned script, no run in the window, or any page or slice that
 * returned fewer rows than its count.
 */
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { constantsNamespacesOf, leadValidationReferences, parseNodeReference } from '@bidspoke/workflow-definition'
import type { SwapCandidate } from './candidate'
import { withConstantsData } from './grid'
import { BUCKETS, compareOutcomes, namedCheck, outcomeOfScriptOutput, runNode, type Bucket, type ValidationOutcome } from './outcomes'

/** PostgREST's row cap: no page asks for more. */
export const PAGE = 1000
/** Run ids per steps read, so the filter stays well inside a URL. */
export const STEP_BATCH = 100
/** Every request is abandoned after this long, inside the database's own 30 s statement timeout. */
export const REQUEST_TIMEOUT_MS = 30_000
/** A reason the script gave fewer times than this is too thin to prove anything here; the grid covers it. */
export const MIN_REAL_CASES = 20
const HOUR_MS = 3_600_000

export class ReplayRefused extends Error {
  constructor(message: string) {
    super(`lead validation replay refused: ${message}`)
    this.name = 'ReplayRefused'
  }
}

export interface ReplayDeps {
  client: Pick<SupabaseClient, 'from'>
  log: (line: string) => void
  /** A deadline per request; the default is AbortSignal.timeout(REQUEST_TIMEOUT_MS). */
  deadline?: () => AbortSignal
}

export interface ReplayWindow { from: Date; to: Date }

interface Version { id: string; constantsNamespaces: Set<string> }

interface StepRow { execution_id: string; step_namespace: string; status: string; output: unknown; step_order: number | null }
interface RunRow { id: string; workflow_version_id: string; trigger_payload: unknown; trace_id: string | null }

export interface RealTrafficReport {
  workflow: string
  window: ReplayWindow
  versions: { pinned: number; total: number }
  /** Runs of the workflow in the window, and of those, runs of a pinned version. */
  runsInWindow: number
  runsJudged: number
  buckets: Record<Bucket, number>
  /** How the script rejected, by reason, and how the node rejected, by check. */
  scriptReasons: Record<string, number>
  nodeChecks: Record<string, number>
  /** Differences by `<kind> at <check>`, with the fields that differed. */
  differences: Record<string, { count: number; fields: string[] }>
  /** What the node did with the runs on which the script threw. */
  afterScriptThrew: Record<ValidationOutcome['kind'], number>
  /** Runs set aside as not reaching the step, by why. */
  noValidateStep: Record<string, number>
  /** Runs whose step was recorded more than once (the last is judged). */
  repeatedStepRows: number
}

type Query = PromiseLike<{ data: unknown; error: { message: string } | null; count?: number | null }>

function guard(q: Query, what: string): Promise<{ data: unknown[]; count: number | null }> {
  return Promise.resolve(q).then(({ data, error, count }) => {
    if (error) throw new ReplayRefused(`reading ${what} failed: ${error.message}`)
    return { data: (data ?? []) as unknown[], count: count ?? null }
  })
}

const signal = (deps: ReplayDeps) => (deps.deadline ? deps.deadline() : AbortSignal.timeout(REQUEST_TIMEOUT_MS))

/** The versions whose replaced step runs the pinned script. */
async function pinnedVersions(candidate: SwapCandidate, deps: ReplayDeps): Promise<{ pinned: Map<string, Version>; total: number }> {
  const head = await guard(deps.client.from('workflow_versions').select('id', { count: 'exact', head: true }).eq('workflow_id', candidate.workflow_id).abortSignal(signal(deps)), 'the version count')
  const expected = head.count
  if (expected === null) throw new ReplayRefused('the version count came back empty')
  const rows: Array<{ id: string; definition: { nodes?: Array<{ namespace?: string; type?: string; config?: { script?: unknown } }> } }> = []
  for (let off = 0; off < expected; off += PAGE) {
    const page = await guard(deps.client.from('workflow_versions').select('id, definition').eq('workflow_id', candidate.workflow_id).order('id').range(off, off + PAGE - 1).abortSignal(signal(deps)), 'the versions')
    if (page.data.length === 0) break
    rows.push(...(page.data as typeof rows))
  }
  if (rows.length !== expected) throw new ReplayRefused(`read ${rows.length} of ${expected} versions`)
  const pinned = new Map<string, Version>()
  for (const v of rows) {
    const nodes = v.definition?.nodes ?? []
    const step = nodes.find((n) => n.namespace === candidate.replaces.namespace && n.type === 'code')
    const script = step?.config?.script
    if (typeof script !== 'string') continue
    if (createHash('md5').update(script).digest('hex') !== candidate.replaces.script_md5) continue
    pinned.set(v.id, { id: v.id, constantsNamespaces: constantsNamespacesOf(nodes) })
  }
  return { pinned, total: rows.length }
}

/** The steps the node reads (and the replaced step), by namespace. */
export function stepsRead(candidate: SwapCandidate): string[] {
  const out = new Set<string>([candidate.replaces.namespace])
  for (const ref of leadValidationReferences(candidate.node.config)) {
    const parsed = parseNodeReference(ref.path)
    if (parsed?.root === 'steps' && parsed.namespace) out.add(parsed.namespace)
  }
  return [...out].sort()
}

async function readRuns(candidate: SwapCandidate, versionIds: string[], from: string, to: string, deps: ReplayDeps): Promise<{ runs: RunRow[]; inWindow: number }> {
  // One filter for the counts and every page, so they cannot drift apart.
  const inHour = (columns: string, head: boolean) => deps.client.from('workflow_executions')
    .select(columns, head ? { count: 'exact', head: true } : undefined)
    .eq('workflow_id', candidate.workflow_id).eq('is_test', false).gte('started_at', from).lt('started_at', to)
  const all = await guard(inHour('id', true).abortSignal(signal(deps)), `the run count for ${from}`)
  if (all.count === null) throw new ReplayRefused(`the run count for the hour from ${from} came back empty`)
  const mine = await guard(inHour('id', true).in('workflow_version_id', versionIds).abortSignal(signal(deps)), `the pinned run count for ${from}`)
  if (mine.count === null) throw new ReplayRefused(`the pinned run count for the hour from ${from} came back empty`)
  const runs: RunRow[] = []
  for (let off = 0; off < mine.count; off += PAGE) {
    const page = await guard(inHour('id, workflow_version_id, trigger_payload, trace_id', false).in('workflow_version_id', versionIds)
      .order('id').range(off, off + PAGE - 1).abortSignal(signal(deps)), `the runs for ${from}`)
    if (page.data.length === 0) break
    runs.push(...(page.data as RunRow[]))
  }
  if (runs.length !== mine.count) throw new ReplayRefused(`a short read: the hour from ${from} counted ${mine.count} runs and ${runs.length} were read`)
  return { runs, inWindow: all.count }
}

async function readSteps(candidate: SwapCandidate, ids: string[], namespaces: string[], from: string, to: string, deps: ReplayDeps): Promise<StepRow[]> {
  const out: StepRow[] = []
  for (let i = 0; i < ids.length; i += STEP_BATCH) {
    const batch = ids.slice(i, i + STEP_BATCH)
    // One filter for the count and every page, so the two cannot drift apart.
    const filtered = (columns: string, head: boolean) => deps.client.from('execution_steps')
      .select(columns, head ? { count: 'exact', head: true } : undefined)
      .eq('workflow_id', candidate.workflow_id).gte('execution_started_at', from).lt('execution_started_at', to).in('execution_id', batch).in('step_namespace', namespaces)
    const counted = await guard(filtered('id', true).abortSignal(signal(deps)), `the step count for ${from}`)
    if (counted.count === null) throw new ReplayRefused(`the step count for the hour from ${from} came back empty`)
    const rows: StepRow[] = []
    for (let off = 0; off < counted.count; off += PAGE) {
      const page = await guard(filtered('execution_id, step_namespace, status, output, step_order', false).order('id').range(off, off + PAGE - 1).abortSignal(signal(deps)), `the steps for ${from}`)
      if (page.data.length === 0) break
      rows.push(...(page.data as StepRow[]))
    }
    if (rows.length !== counted.count) throw new ReplayRefused(`a short read: the hour from ${from} counted ${counted.count} step rows and ${rows.length} were read`)
    out.push(...rows)
  }
  return out
}

function hourSlices(window: ReplayWindow): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = []
  for (let t = window.from.getTime(); t < window.to.getTime(); t += HOUR_MS) {
    out.push({ from: new Date(t).toISOString(), to: new Date(Math.min(t + HOUR_MS, window.to.getTime())).toISOString() })
  }
  return out
}

const bump = (m: Record<string, number>, k: string, by = 1) => { m[k] = (m[k] ?? 0) + by }

export async function replayRealTraffic(candidate: SwapCandidate, window: ReplayWindow, deps: ReplayDeps): Promise<RealTrafficReport> {
  if (!(window.from.getTime() < window.to.getTime())) throw new ReplayRefused('the window is empty')
  const { pinned, total } = await pinnedVersions(candidate, deps)
  if (pinned.size === 0) throw new ReplayRefused(`no version of ${candidate.workflow_name} carries the pinned script ${candidate.replaces.script_md5} (${total} versions read)`)
  deps.log(`${candidate.workflow_name}: ${pinned.size} of ${total} versions carry the pinned script`)
  const namespaces = stepsRead(candidate)
  const versionIds = [...pinned.keys()]

  const report: RealTrafficReport = {
    workflow: candidate.workflow_name,
    window,
    versions: { pinned: pinned.size, total },
    runsInWindow: 0,
    runsJudged: 0,
    buckets: Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>,
    scriptReasons: {},
    nodeChecks: {},
    differences: {},
    afterScriptThrew: { pass: 0, reject: 0, threw: 0 },
    noValidateStep: {},
    repeatedStepRows: 0,
  }
  const config = candidate.node.config

  for (const slice of hourSlices(window)) {
    const { runs, inWindow } = await readRuns(candidate, versionIds, slice.from, slice.to, deps)
    report.runsInWindow += inWindow
    const steps = runs.length ? await readSteps(candidate, runs.map((r) => r.id), namespaces, slice.from, slice.to, deps) : []
    const byRun = new Map<string, Map<string, StepRow[]>>()
    for (const s of steps) {
      const m = byRun.get(s.execution_id) ?? new Map<string, StepRow[]>()
      m.set(s.step_namespace, [...(m.get(s.step_namespace) ?? []), s])
      byRun.set(s.execution_id, m)
    }
    for (const run of runs) {
      report.runsJudged++
      const rows = byRun.get(run.id) ?? new Map<string, StepRow[]>()
      const last = (ns: string): StepRow | undefined => {
        const r = rows.get(ns) ?? []
        return [...r].sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0))[r.length - 1]
      }
      if ((rows.get(candidate.replaces.namespace)?.length ?? 0) > 1) report.repeatedStepRows++
      const step = last(candidate.replaces.namespace)
      if (!step || (step.status !== 'completed' && step.status !== 'failed')) {
        report.buckets.no_validate_step++
        bump(report.noValidateStep, step ? `step ${step.status}` : 'no step row')
        continue
      }
      const script: ValidationOutcome = step.status === 'failed' ? { kind: 'threw', error: 'recorded failed' } : outcomeOfScriptOutput(step.output)
      const version = pinned.get(run.workflow_version_id)!
      const constantsNs = version.constantsNamespaces.size === 1 ? [...version.constantsNamespaces][0] : null
      const upstream: Record<string, { output: unknown }> = {}
      for (const ns of namespaces) {
        if (ns === candidate.replaces.namespace) continue
        const r = last(ns)
        if (r) upstream[ns] = { output: r.output }
      }
      const lead = withConstantsData({ payload: run.trigger_payload, steps: upstream, trace_id: run.trace_id ?? '' }, constantsNs, candidate.constants_data)
      const node = runNode(config, candidate.replaces.namespace, version.constantsNamespaces, lead)
      const { bucket, difference } = compareOutcomes(script, node, config)
      report.buckets[bucket]++
      if (script.kind === 'reject') bump(report.scriptReasons, String((script.body as { reason?: unknown } | null)?.reason))
      if (node.kind === 'reject' && node.check_id) bump(report.nodeChecks, node.check_id)
      if (bucket === 'script_threw') report.afterScriptThrew[node.kind]++
      if (difference) {
        const key = `${difference.kind} at ${namedCheck(difference)}`
        const d = report.differences[key] ?? { count: 0, fields: [] }
        d.count++
        for (const f of difference.fields) if (!d.fields.includes(f)) d.fields.push(f)
        report.differences[key] = d
      }
    }
    deps.log(`  ${slice.from}: ${runs.length} runs judged of ${inWindow}`)
  }
  if (report.runsJudged === 0) throw new ReplayRefused(`no run of a pinned version of ${candidate.workflow_name} started between ${window.from.toISOString()} and ${window.to.toISOString()} (${report.runsInWindow} runs of other versions)`)
  return report
}

/** The report in words: counts only. */
export function formatRealTrafficReport(r: RealTrafficReport, candidate: SwapCandidate): string {
  const lines: string[] = []
  lines.push(`${r.workflow}: real traffic from ${r.window.from.toISOString()} to ${r.window.to.toISOString()}`)
  lines.push(`  versions carrying the pinned script: ${r.versions.pinned} of ${r.versions.total}`)
  lines.push(`  runs in the window: ${r.runsInWindow}; judged (a pinned version): ${r.runsJudged}`)
  const sum = BUCKETS.reduce((n, b) => n + r.buckets[b], 0)
  lines.push(`  buckets: ${BUCKETS.map((b) => `${b} ${r.buckets[b]}`).join(', ')} (total ${sum}${sum === r.runsJudged ? '' : `, NOT the ${r.runsJudged} judged`})`)
  if (r.buckets.no_validate_step) lines.push(`  not reaching the step: ${Object.entries(r.noValidateStep).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  if (r.buckets.script_threw) lines.push(`  where the script threw, the node: ${Object.entries(r.afterScriptThrew).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  if (r.repeatedStepRows) lines.push(`  runs whose step was recorded more than once (the last judged): ${r.repeatedStepRows}`)
  lines.push('  rejections by reason (script / node at the check with that reason):')
  for (const check of candidate.node.config.checks) {
    const s = r.scriptReasons[check.reason] ?? 0
    const n = r.nodeChecks[check.id] ?? 0
    lines.push(`    ${check.reason}: ${s} / ${n}${s < MIN_REAL_CASES ? `  (fewer than ${MIN_REAL_CASES} real cases: covered by the grid only)` : ''}`)
  }
  const other = Object.keys(r.scriptReasons).filter((reason) => !candidate.node.config.checks.some((c) => c.reason === reason))
  for (const reason of other) lines.push(`    ${reason}: ${r.scriptReasons[reason]} / no check of the candidate gives this reason`)
  const diffs = Object.entries(r.differences).sort((a, b) => b[1].count - a[1].count)
  if (diffs.length) {
    lines.push('  differences by check:')
    for (const [key, d] of diffs) lines.push(`    ${key}: ${d.count}${d.fields.length ? ` (${d.fields.join(', ')})` : ''}`)
  } else {
    lines.push('  no difference between the script and the node')
  }
  return lines.join('\n')
}
