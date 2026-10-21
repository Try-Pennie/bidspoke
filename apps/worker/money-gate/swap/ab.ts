/**
 * Instrument 2 of a validation swap (#2591): the money gate's definition A/B
 * mode. The same engine (the head) replays one workflow's fixtures twice, once
 * with the committed definition (the current side) and once with the candidate
 * swapped in (the candidate side), and the two transcripts are compared with the
 * gate's own comparator: response (status, headers, body), outbound requests,
 * writes, routes, nodes run and the final node.
 *
 * Run by `.github/scripts/money-gate-swap.sh <candidate> [<check>:<lenient|strict>]`.
 * No expected-changes.json entry is involved: the engine is the same on both
 * sides, so nothing here is a change to the engine.
 *
 * What differs by construction is set aside and listed, never compared: the
 * replaced step's own step row (a code step's output and log become the node's),
 * the code bundle it ran in, the run's estimated cost (a code step is priced, a
 * lead validation step is not) and the cached definition in KV. Everything else
 * is compared exactly, and every difference the candidate does not accept in
 * `gate_accepted` fails.
 */
import { applyCandidate, parseCandidate, parseSeed, seedDefect, type SwapCandidate } from './candidate'
import { compareTranscripts, coverageReport, formatDifferences, type Difference, type FixtureRecord, type Transcript } from '../lib/compare'
import { applyExpectedChanges, parseExpectedChanges } from '../lib/expected-changes'
import type { RecordedWrite } from '../lib/supabase-double'

export type AbSide = 'current' | 'candidate'

export interface AbMode {
  /** The candidate file's name, with or without `.json`. */
  candidate: string
  side: AbSide
  /** `<check>:<lenient|strict>`, the candidate side only. */
  seed?: string
}

/** The A/B mode the replay was started in, from its environment, or null for the ordinary gate. */
export function abModeOf(env: { candidate?: string; side?: string; seed?: string }): AbMode | null {
  if (!env.candidate) {
    if (env.side || env.seed) throw new Error('money gate: MONEY_GATE_CANDIDATE_SIDE or MONEY_GATE_CANDIDATE_SEED was set without MONEY_GATE_CANDIDATE')
    return null
  }
  if (env.side !== 'current' && env.side !== 'candidate') throw new Error(`money gate: MONEY_GATE_CANDIDATE_SIDE must be current or candidate, not ${JSON.stringify(env.side)}`)
  if (env.seed && env.side !== 'candidate') throw new Error('money gate: a seeded defect belongs on the candidate side only')
  return { candidate: env.candidate, side: env.side, seed: env.seed || undefined }
}

/** Finds a candidate among the globbed files (keyed by path) by its file name. */
export function findCandidate(files: Record<string, unknown>, name: string): SwapCandidate {
  const want = name.endsWith('.json') ? name : `${name}.json`
  const hits = Object.entries(files).filter(([path]) => path.split('/').pop() === want)
  if (hits.length !== 1) {
    const known = Object.keys(files).map((p) => p.split('/').pop()).sort().join(', ')
    throw new Error(`money gate: no swap candidate named ${want} (candidates: ${known || 'none'})`)
  }
  return parseCandidate(hits[0][1], want)
}

interface DefLike { id: string; name: string; definition: { nodes: Array<{ id: string; namespace: string; type: string; config?: Record<string, unknown> }>; edges: Array<{ source: string; target: string; source_handle?: string }> } }

/**
 * The definitions the replay runs in A/B mode: only the candidate's workflow, as
 * committed on the current side and with the candidate (seeded, when asked) in
 * place on the candidate side. Outside A/B mode, every definition as committed.
 */
export function abDefinitions<T extends DefLike>(defs: T[], files: Record<string, unknown>, mode: AbMode | null): T[] {
  if (!mode) return defs
  const candidate = findCandidate(files, mode.candidate)
  const mine = defs.filter((d) => d.id === candidate.workflow_id)
  if (mine.length !== 1) throw new Error(`money gate: ${candidate.workflow_name} has ${mine.length} committed definitions, so there is nothing to swap the candidate into`)
  if (mode.side === 'current') return mine
  const seed = parseSeed(mode.seed)
  const applied = seed ? seedDefect(candidate, seed.checkId, seed.direction) : candidate
  return [applyCandidate(mine[0], applied)]
}

// ── Setting aside the replaced step's own record ──────────────────────────────

/** The replaced step's own rows, set aside per fixture, for the report. */
export interface SetAside {
  fixture: string
  rows: number
  dispatches: number
}

const isRow = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const SET_ASIDE = '(set aside)'

/**
 * The run's estimated cost: a code step is priced and a lead validation step is
 * not, so the estimate falls by construction on every run that reaches the step.
 */
function withoutCost(w: RecordedWrite): RecordedWrite {
  if (w.table !== 'workflow_executions' || !isRow(w.values) || !('cost_usd' in w.values)) return w
  return { ...w, values: { ...w.values, cost_usd: SET_ASIDE } }
}

/**
 * KV, without what holds the definition itself (the cached definition and its
 * last good copy differ by construction), and with each answer journal entry
 * read as the object it is, cost set aside, so a field inside it is named.
 */
function kvWithoutDefinition(kv: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [ns, entries] of Object.entries(kv)) {
    if (!isRow(entries)) { out[ns] = entries; continue }
    const kept: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(entries)) {
      if (ns === 'WORKFLOW_CACHE' && key.startsWith('workflow-def-')) { kept[key] = SET_ASIDE; continue }
      if (key.startsWith('answer-journal:') && typeof value === 'string') {
        try {
          const parsed = JSON.parse(value) as unknown
          kept[key] = isRow(parsed) && 'cost_usd' in parsed ? { ...parsed, cost_usd: SET_ASIDE } : parsed
          continue
        } catch { /* compared as the text it is */ }
      }
      kept[key] = value
    }
    out[ns] = kept
  }
  return out
}

/**
 * The transcript without the replaced step's own record: its step rows (on
 * either side the row of a step of that namespace) and its code dispatch (the
 * replaced code node is no longer in any bundle, so every bundle of the workflow
 * is renamed). What is left is what the swap must not change.
 */
export function setAsideReplacedStep(t: Transcript, namespace: string): { transcript: Transcript; setAside: SetAside[] } {
  const setAside: SetAside[] = []
  const fixtures: FixtureRecord[] = t.fixtures.map((f) => {
    let rows = 0
    const writes: RecordedWrite[] = []
    for (const w of f.supabase_writes) {
      if (w.table !== 'execution_steps') { writes.push(w); continue }
      const values = Array.isArray(w.values) ? (w.values as unknown[]) : [w.values]
      const kept = values.filter((v) => !(isRow(v) && v.step_namespace === namespace))
      rows += values.length - kept.length
      if (kept.length === values.length) writes.push(w)
      else if (kept.length > 0) writes.push({ ...w, values: Array.isArray(w.values) ? kept : kept[0] })
    }
    const dispatches = f.code_dispatch.filter((d) => d.namespaces.includes(namespace)).length
    // Compared by where the code went and which steps it ran, not by the bundle's
    // name, which is derived from every script in the workflow.
    const code_dispatch = f.code_dispatch
      .map((d) => ({ ...d, name: '(bundle)', path: '(bundle)', namespaces: d.namespaces.filter((n) => n !== namespace) }))
      .filter((d) => d.namespaces.length > 0)
    setAside.push({ fixture: f.id, rows, dispatches })
    return { ...f, supabase_writes: writes.map(withoutCost), code_dispatch, kv_state: kvWithoutDefinition(f.kv_state) }
  })
  return { transcript: { ...t, fixtures }, setAside }
}

/** What the replaced step decided on one fixture, read from its step row: what the reader needs to name a difference by check. */
export function validationDecisions(t: Transcript, namespace: string, checkOfReason: (reason: string) => string | null = () => null): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of t.fixtures) {
    const rows = f.supabase_writes.filter((w) => w.table === 'execution_steps')
      .flatMap((w) => (Array.isArray(w.values) ? (w.values as unknown[]) : [w.values]))
      .filter((v): v is Record<string, unknown> => isRow(v) && v.step_namespace === namespace && 'output' in v)
    const row = rows[rows.length - 1]
    if (!row) { out.set(f.id, f.nodes_executed.includes(namespace) ? 'ran, no row recorded' : 'not reached'); continue }
    const output = row.output as Record<string, unknown> | null
    const status = typeof row.status === 'string' ? row.status : '?'
    if (status !== 'completed') out.set(f.id, `${status}`)
    else if (output && typeof output.check_id === 'string') out.set(f.id, `rejected at check ${output.check_id} (${String(output.reason)})`)
    else if (output && isRow(output.response)) {
      const reason = String((output.response.body as { reason?: unknown } | undefined)?.reason)
      const check = checkOfReason(reason)
      out.set(f.id, `rejected (${reason})${check ? `, the reason of check ${check}` : ''}`)
    }
    else out.set(f.id, 'let through')
  }
  return out
}

export interface AbVerdict { exitCode: number; output: string }

/** The A/B verdict: every difference outside the replaced step, named by fixture, check and the validation decision on each side. */
export function swapVerdict(current: Transcript, candidateSide: Transcript, candidate: SwapCandidate, seed?: string): AbVerdict {
  const ns = candidate.replaces.namespace
  const lines: string[] = [`money gate swap: ${candidate.workflow_name}, current definition against the candidate${seed ? ` seeded with ${seed}` : ''}`]
  const a = setAsideReplacedStep(current, ns)
  const b = setAsideReplacedStep(candidateSide, ns)
  const failures: string[] = []
  for (const [t, side] of [[current, 'current'], [candidateSide, 'candidate']] as const) {
    if (!t.fixtures.length) failures.push(`the ${side} transcript holds no fixture, so nothing was replayed`)
    if (t.workflows.length !== 1 || t.workflows[0].workflow_id !== candidate.workflow_id) failures.push(`the ${side} transcript is not of ${candidate.workflow_name} alone`)
  }
  const cov = coverageReport(candidateSide)
  lines.push('coverage (candidate side):', cov.text)
  failures.push(...cov.failures)
  const reached = candidateSide.fixtures.filter((f) => f.nodes_executed.includes(ns)).length
  if (reached === 0) failures.push(`no fixture reached ${ns}, so the swap was not exercised`)
  lines.push(`fixtures that reached ${ns}: ${reached} of ${candidateSide.fixtures.length}`)
  const rowsSet = b.setAside.reduce((n, s) => n + s.rows, 0) + a.setAside.reduce((n, s) => n + s.rows, 0)
  lines.push(`set aside as the replaced step's own record: ${rowsSet} step row(s) across both sides, the code bundle names, the run's estimated cost, and the cached definition`)

  const diffs: Difference[] = compareTranscripts(a.transcript, b.transcript)
  const accepted = parseExpectedChanges(JSON.stringify({ entries: candidate.gate_accepted }))
  failures.push(...accepted.failures.map((f) => f.replace('expected-changes.json', `${candidate.workflow_name} gate_accepted`)))
  const applied = applyExpectedChanges(diffs, accepted.entries, [])
  failures.push(...applied.failures.map((f) => f.replace('expected change', 'gate_accepted entry')))

  const before = validationDecisions(current, ns, (r) => candidate.node.config.checks.find((c) => c.reason === r)?.id ?? null)
  const after = validationDecisions(candidateSide, ns)
  if (applied.excused.length) {
    lines.push(`${applied.excused.length} difference(s) the candidate accepts:`)
    lines.push(applied.excused.map(({ diff, entry }) => `${formatDifferences([diff])} (accepted: ${entry.reason})`).join('\n'))
  }
  const unexcused = applied.unexcused
  if (unexcused.length) {
    const byCheck = new Map<string, Difference[]>()
    for (const d of unexcused) byCheck.set(d.check, [...(byCheck.get(d.check) ?? []), d])
    lines.push(`money gate swap: ${unexcused.length} difference(s) between the current definition and the candidate`)
    lines.push(`checks that fired: ${[...byCheck].map(([c, ds]) => `${c} (${ds.length})`).join(', ')}`)
    const fixtures = [...new Set(unexcused.map((d) => d.fixture))].sort()
    lines.push('by fixture, with what the validation step decided on each side:')
    for (const id of fixtures) {
      lines.push(`  ${id}: current ${before.get(id) ?? '?'}; candidate ${after.get(id) ?? '?'}`)
      lines.push(formatDifferences(unexcused.filter((d) => d.fixture === id)).split('\n').map((l) => `    ${l}`).join('\n'))
    }
  } else {
    lines.push('money gate swap: no difference between the current definition and the candidate outside the replaced step')
  }
  for (const f of failures) lines.push(`money gate swap: ${f}`)
  return { exitCode: unexcused.length || failures.length ? 1 : 0, output: lines.join('\n') }
}

