/**
 * The money gate's verdict on a pair of transcripts (#1704).
 *
 * Red on any difference between base and head, and red when a workflow executed
 * no node at all (a gate that ran nothing would otherwise read as agreement).
 * Coverage is always printed by name: the arms each workflow reached and did not,
 * and the nodes it never executed, so green never implies more than was run
 * (L400, L460). Stale fixture shapes warn from day 23 and ask for a reminder from
 * day 30; they never block, because the shapes age whether or not a pull request
 * touched them.
 */
import { compareTranscripts, coverageReport, formatDifferences, type Transcript } from './compare'

export const STALE_WARN_DAYS = 23
export const STALE_REMIND_DAYS = 30

/** The full list is capped; the counts and the first difference of each check always print. */
const MAX_LISTED = 300

export function staleness(exportedAt: string, now: Date): { days: number; level: 'fresh' | 'warn' | 'remind' } {
  const days = Math.floor((now.getTime() - new Date(exportedAt).getTime()) / 86_400_000)
  return { days, level: days >= STALE_REMIND_DAYS ? 'remind' : days >= STALE_WARN_DAYS ? 'warn' : 'fresh' }
}

export function gateVerdict(input: { base: Transcript; head: Transcript; shapesExportedAt: string; now: Date }): { exitCode: number; output: string } {
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

  const failures = [...new Set([...headCov.failures, ...baseCov.failures])]
  if (diffs.length) {
    const byCheck = new Map<string, typeof diffs>()
    for (const d of diffs) byCheck.set(d.check, [...(byCheck.get(d.check) ?? []), d])
    lines.push(`money gate: ${diffs.length} difference(s) between base and head`)
    lines.push(`checks that fired: ${[...byCheck].map(([c, ds]) => `${c} (${ds.length})`).join(', ')}`)
    lines.push('first difference of each check:')
    lines.push(formatDifferences([...byCheck.values()].map((ds) => ds[0])))
    lines.push('all differences:')
    lines.push(formatDifferences(diffs.slice(0, MAX_LISTED)))
    if (diffs.length > MAX_LISTED) lines.push(`${diffs.length - MAX_LISTED} more differences not shown`)
  } else {
    lines.push('money gate: no difference between base and head')
  }
  for (const f of failures) lines.push(`money gate: ${f}`)
  return { exitCode: diffs.length || failures.length ? 1 : 0, output: lines.join('\n') }
}
