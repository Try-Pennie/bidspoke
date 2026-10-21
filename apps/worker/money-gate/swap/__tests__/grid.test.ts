/**
 * Instrument 1 of a validation swap (#2591, part of #934): the live
 * `validate_bidding_and_state` script and its candidate lead validation node,
 * run side by side over a generated grid of synthetic leads, in CI.
 *
 * The script is the one in the committed money gate definition, pinned by the
 * md5 the candidate carries (read from production's workflow_versions), so the
 * text compared is the text production runs: a definition refreshed with an
 * edited script fails the pin here rather than proving the wrong text.
 *
 * For each candidate it holds that:
 * - the candidate is what a save accepts, in place, in that workflow;
 * - every arm is reached (each reason rejected by both sides, and a lead let
 *   through by both);
 * - every difference is one the candidate names, with its reason, and every
 *   named one still happens;
 * - one seeded defect per check, in both directions, is found and named by that check.
 */
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { constantsNamespacesOf, findLeadValidationProblems, validateWorkflowDef } from '@bidspoke/workflow-definition'
import { applyCandidate, parseCandidate, seedDefect, type SwapCandidate } from '../candidate'
import { applyGridAccepted, formatGridDifference, formatGridReport, gridDifferences, runGrid, type GridArmResult, type GridSpec } from '../grid'
import { leadEconomyGrid, rmlGrid } from '../grid-specs'
import gigfi from '../candidates/rml-gigfi.json'
import lendswift from '../candidates/rml-lendswift.json'
import leadEconomy from '../candidates/lead-economy.json'
import gigfiDef from '../../fixtures/definitions/6624acd0-bf61-4d21-85fc-4371ca7ed77d.json'
import lendswiftDef from '../../fixtures/definitions/e1b810da-16c0-49eb-bf12-ba1c9b67c914.json'
import leadEconomyDef from '../../fixtures/definitions/89b1a6af-7e0f-43de-bc66-1e888184551f.json'

interface Def { id: string; name: string; definition: { nodes: Array<{ id: string; namespace: string; type: string; label?: string; config?: Record<string, unknown> }>; edges: Array<{ source: string; target: string; source_handle?: string }> } }

interface Case {
  file: string
  candidate: SwapCandidate
  def: Def
  spec: (constants: Record<string, unknown>, candidate: SwapCandidate) => GridSpec
}

const CASES: Case[] = [
  { file: 'rml-gigfi.json', candidate: parseCandidate(gigfi, 'rml-gigfi.json'), def: gigfiDef as Def, spec: (k) => rmlGrid(k, 'parsed_name', true) },
  { file: 'rml-lendswift.json', candidate: parseCandidate(lendswift, 'rml-lendswift.json'), def: lendswiftDef as Def, spec: (k) => rmlGrid(k, 'parse_name', false) },
  { file: 'lead-economy.json', candidate: parseCandidate(leadEconomy, 'lead-economy.json'), def: leadEconomyDef as Def, spec: (k, c) => leadEconomyGrid(k, c.constants_data ?? {}) },
]

const md5 = (s: string) => createHash('md5').update(s).digest('hex')

function scriptOf(c: Case): string {
  const node = c.def.definition.nodes.find((n) => n.id === c.candidate.replaces.node_id)
  const script = node?.config?.script
  if (typeof script !== 'string') throw new Error(`${c.def.name} holds no script at ${c.candidate.replaces.node_id}`)
  return script
}

function constantsOf(c: Case): Record<string, unknown> {
  const k = c.def.definition.nodes.find((n) => n.type === 'constants')
  return ((k?.config as { data?: Record<string, unknown> } | undefined)?.data ?? {})
}

async function grid(c: Case, candidate: SwapCandidate = c.candidate) {
  return runGrid({
    script: scriptOf(c),
    config: candidate.node.config,
    namespace: candidate.node.namespace,
    constantsNamespaces: constantsNamespacesOf(c.def.definition.nodes),
    constantsData: candidate.constants_data,
    spec: c.spec(constantsOf(c), candidate),
  })
}

for (const c of CASES) {
  describe(`${c.candidate.workflow_name} (${c.file})`, () => {
    it('compares against the script production runs, pinned by its md5', () => {
      expect(c.def.id).toBe(c.candidate.workflow_id)
      expect(md5(scriptOf(c)), `the committed definition's ${c.candidate.replaces.namespace} script is not the one the candidate was proved against; refresh the candidate's pin from workflow_versions and rerun the proofs`).toBe(c.candidate.replaces.script_md5)
    })

    it('is a node a save accepts, in place, in that workflow', () => {
      const swapped = applyCandidate(c.def, c.candidate)
      const nodes = swapped.definition.nodes
      expect(findLeadValidationProblems(nodes, swapped.definition.edges)).toEqual([])
      expect(validateWorkflowDef(nodes, swapped.definition.edges).filter((e) => e.namespace === c.candidate.replaces.namespace)).toEqual([])
      const placed = nodes.find((n) => n.id === c.candidate.replaces.node_id)
      expect(placed?.type).toBe('lead_validation')
      expect(placed?.label, 'the label lead sightings and Snowflake record must not change').toBe(c.def.definition.nodes.find((n) => n.id === c.candidate.replaces.node_id)?.label)
    })

    it('reaches every arm, and differs from the script only where the candidate says why', async () => {
      const report = await grid(c)
      const text = formatGridReport(c.candidate.workflow_name, report)
      // Every reason the node can give, given by the script and by the node.
      for (const check of c.candidate.node.config.checks) {
        expect(report.scriptReasons[check.reason] ?? 0, `${text}\nthe script never rejected for ${check.reason}`).toBeGreaterThan(0)
        expect(report.nodeChecks[check.id] ?? 0, `${text}\nthe node never rejected at ${check.id}`).toBeGreaterThan(0)
      }
      expect(report.buckets.agree, text).toBeGreaterThan(0)
      expect(report.results.some((r) => r.script.kind === 'pass' && r.node.kind === 'pass'), `${text}\nno lead was let through by both`).toBe(true)

      const { unaccepted, unused } = applyGridAccepted(gridDifferences(report), c.candidate.grid_accepted)
      expect(unaccepted.map(formatGridDifference), `${text}\ndifferences the candidate does not name (add them to grid_accepted with a reason, or fix the node):`).toEqual([])
      expect(unused, `grid_accepted entries that match no difference; remove them`).toEqual([])
    })

    it('names a seeded defect in each check, in both directions', async () => {
      const baseline = new Map((await grid(c)).results.map((r) => [r.arm, r]))
      const sameDifference = (a: GridArmResult, b: GridArmResult | undefined) => b !== undefined && JSON.stringify(a.difference) === JSON.stringify(b.difference)
      for (const check of c.candidate.node.config.checks) {
        for (const direction of ['lenient', 'strict'] as const) {
          const report = await grid(c, seedDefect(c.candidate, check.id, direction))
          const changed = report.results.filter((r) => !sameDifference(r, baseline.get(r.arm)))
          const label = `${check.id} made ${direction}`
          expect(changed.length, `${label}: the grid found no new difference\n${formatGridReport(c.candidate.workflow_name, report)}`).toBeGreaterThan(0)
          // Lenient: the arms that moved are those this check used to reject.
          // Strict: the arms that moved are those this check now rejects.
          const names = (r: GridArmResult) => {
            const was = baseline.get(r.arm)?.node
            return direction === 'lenient' ? was?.kind === 'reject' && was.check_id === check.id : r.node.kind === 'reject' && r.node.check_id === check.id
          }
          expect(changed.filter((r) => !names(r)).map((r) => r.arm), `${label}: arms that moved without naming ${check.id}`).toEqual([])
          // And the report itself names the check: as the check that let the lead
          // through or rejected it, or, where a later check then rejected it, as
          // the script's side of `<script check>><node check>`.
          const primary = direction === 'lenient' ? 'node_passes' : 'node_rejects'
          const named = gridDifferences(report).filter((d) =>
            (d.kind === primary && d.check === check.id) ||
            (d.kind === 'other_reason' && (direction === 'lenient' ? d.check.startsWith(`${check.id}>`) : d.check.endsWith(`>${check.id}`))))
          expect(named.length, `${label}: the report does not name ${check.id}\n${formatGridReport(c.candidate.workflow_name, report)}`).toBeGreaterThan(0)
        }
      }
    })
  })
}
