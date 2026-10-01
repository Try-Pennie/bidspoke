/**
 * The money gate's verdict on a pair of transcripts (#1704).
 *
 * Red on any difference between base and head that expected-changes.json does not
 * excuse (lib/expected-changes.ts), on a malformed or stale excuse, and on a run
 * that checked nothing: a transcript with no workflow or no fixture, a committed
 * definition the head did not replay, or a workflow that executed no node.
 * Coverage is always printed by name: the arms each workflow reached and did not,
 * and the nodes it never executed, so green never implies more than was run
 * (L400, L460). Stale fixture shapes warn from day 23 and ask for a reminder from
 * day 30; they never block, because the shapes age whether or not a pull request
 * touched them.
 */
import { compareTranscripts, coverageReport, formatDifferences, type Transcript } from './compare'
import { applyExpectedChanges, describeEntry, parseExpectedChanges } from './expected-changes'

export const STALE_WARN_DAYS = 23
export const STALE_REMIND_DAYS = 30

/** The full list is capped; the counts and the first difference of each check always print. */
const MAX_LISTED = 300

export function staleness(exportedAt: string, now: Date): { days: number; level: 'fresh' | 'warn' | 'remind' } {
  const days = Math.floor((now.getTime() - new Date(exportedAt).getTime()) / 86_400_000)
  return { days, level: days >= STALE_REMIND_DAYS ? 'remind' : days >= STALE_WARN_DAYS ? 'warn' : 'fresh' }
}

export interface VerdictInput {
  base: Transcript
  head: Transcript
  shapesExportedAt: string
  now: Date
  /** Workflow ids with a committed definition: the head must replay every one. */
  committedDefinitionIds: string[]
  /** expected-changes.json at the head and at the merge base, or null where absent. */
  expectedHead: string | null
  expectedBase: string | null
}

/** A transcript that replayed nothing would compare equal to anything (L98). */
function emptinessFailures(t: Transcript, side: 'base' | 'head'): string[] {
  const out: string[] = []
  if (!t.workflows?.length) out.push(`the ${side} transcript holds no workflow, so nothing was replayed`)
  if (!t.fixtures?.length) out.push(`the ${side} transcript holds no fixture, so nothing was replayed`)
  return out
}

export function gateVerdict(input: VerdictInput): { exitCode: number; output: string } {
  const lines: string[] = []
  const diffs = compareTranscripts(input.base, input.head)
  const headCov = coverageReport(input.head)
  const baseCov = coverageReport(input.base)

  lines.push('money gate coverage (head):')
  lines.push(headCov.text)

  const age = staleness(input.shapesExportedAt, input.now)
  if (age.level !== 'fresh') {
    lines.push(`warning: the fixture shapes are ${age.days} days old; rerun apps/worker/scripts/export-money-fixture-shapes.ts${age.level === 'remind' ? ' (past day 30: file a reminder issue)' : ''}. This never blocks.`)
  }

  const replayed = new Set(input.head.workflows?.map((w) => w.workflow_id) ?? [])
  const missing = input.committedDefinitionIds.filter((id) => !replayed.has(id)).sort()

  const head = parseExpectedChanges(input.expectedHead)
  const base = parseExpectedChanges(input.expectedBase)
  const applied = applyExpectedChanges(diffs, head.entries, base.entries)

  const failures = [...new Set([
    ...emptinessFailures(input.head, 'head'),
    ...emptinessFailures(input.base, 'base'),
    ...(missing.length ? [`committed definitions the head did not replay: ${missing.join(', ')}`] : []),
    ...headCov.failures,
    ...baseCov.failures,
    ...head.failures,
    ...applied.failures,
  ])]

  for (const e of applied.carriedOver) {
    lines.push(`note: expected change for ${describeEntry(e)} is carried over from the merge base, excusing nothing; delete it`)
  }
  if (applied.excused.length) {
    lines.push(`money gate: ${applied.excused.length} difference(s) excused by expected-changes.json, ${applied.unexcused.length} not excused`)
    lines.push(applied.excused.slice(0, MAX_LISTED).map(({ diff, entry }) => `${formatDifferences([diff])} (excused: ${entry.reason})`).join('\n'))
    if (applied.excused.length > MAX_LISTED) lines.push(`${applied.excused.length - MAX_LISTED} more excused differences not shown`)
  }
  const unexcused = applied.unexcused
  if (unexcused.length) {
    const byCheck = new Map<string, typeof unexcused>()
    for (const d of unexcused) byCheck.set(d.check, [...(byCheck.get(d.check) ?? []), d])
    lines.push(`money gate: ${unexcused.length} difference(s) between base and head`)
    lines.push(`checks that fired: ${[...byCheck].map(([c, ds]) => `${c} (${ds.length})`).join(', ')}`)
    lines.push('first difference of each check:')
    lines.push(formatDifferences([...byCheck.values()].map((ds) => ds[0])))
    lines.push('all differences:')
    lines.push(formatDifferences(unexcused.slice(0, MAX_LISTED)))
    if (unexcused.length > MAX_LISTED) lines.push(`${unexcused.length - MAX_LISTED} more differences not shown`)
    lines.push('If these are intended, list them in apps/worker/money-gate/expected-changes.json with a reason (see money-gate/README.md).')
  } else if (!applied.excused.length) {
    lines.push('money gate: no difference between base and head')
  }
  for (const f of failures) lines.push(`money gate: ${f}`)
  return { exitCode: unexcused.length || failures.length ? 1 : 0, output: lines.join('\n') }
}
