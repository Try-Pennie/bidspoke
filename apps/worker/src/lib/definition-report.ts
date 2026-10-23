/**
 * validateDefinition, report only, on every money lane definition write
 * (#1947 PR 3).
 *
 * Every route that writes a workflow's definition, or makes a stored one live,
 * asks this with the definition as it will be stored, the stamp it will be
 * stored under and whether it will be live. It runs every rule at that stamp
 * and logs one `definition_report` line saying what the rules found and what
 * they WOULD refuse (blockingProblems), and it refuses nothing: the route's
 * own checks still decide. The line is a warning whenever a rule would refuse,
 * or the stamp is not one this build can judge, so a search of the warnings is
 * the list of writes the enforcement flip would change.
 *
 * Calibrated before shipping (2026-10-22, read only, every row judged by its
 * own stamp): of 10 live workflows none would be refused; of 610 saved
 * versions 4 would be refused on any restore (two loops and a step id used
 * twice in Main Flow v25, v26 and v31, and the retired integration step in a
 * soft deleted workflow) and 20 more onto a live workflow (unconfigured steps).
 *
 * It never throws into the write it reports on: a report that fails is logged
 * as `definition_report_failed` and the write goes on.
 */
import { blockingProblems, validateDefinition } from '@bidspoke/workflow-definition'
import { isWorkflowLane } from '@bidspoke/node-types'
import { formatErr } from './format-error'

/** Which write the report is about. */
export type DefinitionWriter = 'create' | 'save' | 'restore' | 'duplicate' | 'switch_on'

export interface DefinitionReportOptions {
  writer: DefinitionWriter
  /** Null before a create has an id. */
  workflowId: string | null
  /** The workflow's stored lane, as read. A value that is no lane is reported by name, never judged as money. */
  lane: unknown
  /** Whether the definition is live once written: a live save is held to the live rules too. */
  live: boolean
  /** The stamp the definition is stored under, exactly as written (null is unstamped). */
  schemaVersion: unknown
}

export type DefinitionReport =
  | {
      verdict: 'judged'
      schema_version: number
      stamped: boolean
      /** Every finding, warnings and advice included. */
      problems: number
      by_rule: Record<string, number>
      /** What blockingProblems would refuse for this write. */
      would_refuse: number
      would_refuse_reasons: string[]
    }
  | { verdict: 'unknown_schema_version'; stamp: number }
  | { verdict: 'invalid_schema_version'; stamp: unknown }
  | { verdict: 'invalid_lane' }
  | { verdict: 'report_failed' }

export function reportDefinition(definition: unknown, options: DefinitionReportOptions): DefinitionReport {
  const where = { writer: options.writer, workflow_id: options.workflowId, lane: options.lane, live: options.live }
  let report: DefinitionReport
  try {
    if (!isWorkflowLane(options.lane)) {
      console.warn(JSON.stringify({ event: 'definition_report', ...where, verdict: 'invalid_lane' }))
      return { verdict: 'invalid_lane' }
    }
    const verdict = validateDefinition(definition, { lane: options.lane, schemaVersion: options.schemaVersion })
    switch (verdict.kind) {
      case 'judged': {
        const byRule: Record<string, number> = {}
        for (const p of verdict.problems) byRule[p.rule] = (byRule[p.rule] ?? 0) + 1
        const refused = blockingProblems(verdict.problems, { live: options.live })
        report = {
          verdict: 'judged',
          schema_version: verdict.schemaVersion,
          stamped: verdict.stamped,
          problems: verdict.problems.length,
          by_rule: byRule,
          would_refuse: refused.length,
          would_refuse_reasons: refused.map((p) => p.reason),
        }
        break
      }
      case 'unknown_schema_version':
        report = { verdict: 'unknown_schema_version', stamp: verdict.stamp }
        break
      case 'invalid_schema_version':
        report = { verdict: 'invalid_schema_version', stamp: verdict.stamp }
        break
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'definition_report_failed', ...where, error: formatErr(err) }))
    return { verdict: 'report_failed' }
  }
  const line = JSON.stringify({ event: 'definition_report', ...where, ...report })
  if (report.verdict !== 'judged' || report.would_refuse > 0) console.warn(line)
  else console.log(line)
  return report
}
