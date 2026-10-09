/**
 * Read-only calibration for the build-time reference validator (#424).
 *
 * A validator is only real once it has been run against the data it will judge
 * (L56). A client-side rule stricter than what the engine accepts blocks the
 * author against a rule nothing states (L99), and a validator that reports
 * false errors on the workflows people actually edit gets switched off and
 * protects nothing (L36).
 *
 * So this runs the SHIPPED validator over every live workflow definition and
 * prints what it would say. Every finding has to be inspected before this is
 * wired to the editor: each one is either a real broken reference or a false
 * positive that has to be fixed here first.
 *
 * Run: cd apps/worker && npx tsx scripts/diagnose-reference-validation.ts
 */
import { createClient } from '@supabase/supabase-js'
import { loadDevVars } from './lib/dev-vars'
import {
  validateDefinitionReferences,
  type ReferenceProblem,
} from '@bidspoke/workflow-definition'
import type { NodeDef, EdgeDef } from '../../web/src/types/workflow'

const vars = loadDevVars()
const supabase = createClient(vars.SUPABASE_URL, vars.SUPABASE_SECRET_KEY)

interface WorkflowRow {
  id: string
  name: string
  is_active: boolean
  definition: { nodes?: NodeDef[]; edges?: EdgeDef[] } | null
}

async function main(): Promise<void> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, is_active, definition')
    .is('deleted_at', null)
    .eq('is_active', true)
    .order('name')
  if (error) throw new Error(`workflows read failed: ${error.message}`)

  let total = 0
  for (const wf of (data ?? []) as unknown as WorkflowRow[]) {
    const nodes = wf.definition?.nodes ?? []
    const edges = wf.definition?.edges ?? []
    let problems: ReferenceProblem[] = []
    try {
      problems = validateDefinitionReferences(nodes, edges)
    } catch (e) {
      console.log(`  ${wf.name}: VALIDATOR THREW ${String(e)}`)
      continue
    }
    total += problems.length
    console.log(`${wf.name}: ${nodes.length} nodes, ${edges.length} edges, ${problems.length} problem(s)`)
    for (const p of problems) {
      console.log(`    [${p.severity}] ${p.namespace}: ${p.message}`)
    }
  }
  // Positive control. Zero findings is also what a validator that never runs
  // reports, so before reading anything into the number above, prove each check
  // fires on a deliberate defect injected into a REAL definition (L98, L171).
  const sample = ((data ?? []) as unknown as WorkflowRow[]).find((w) => (w.definition?.nodes?.length ?? 0) > 2)
  if (!sample) {
    console.log('\nNO CONTROL AVAILABLE: no definition large enough, so the zeros above are unproven')
  } else {
    const nodes = sample.definition?.nodes ?? []
    const edges = sample.definition?.edges ?? []
    const last = nodes[nodes.length - 1]

    const withBadRoot = nodes.map((n) =>
      n.id === last.id ? { ...n, config: { ...n.config, __control: '{{payload.debt}}' } } : n,
    )
    const rootCaught = validateDefinitionReferences(withBadRoot, edges).some((p) => p.reference === 'payload')

    const withGhostStep = nodes.map((n) =>
      n.id === last.id ? { ...n, config: { ...n.config, __control: '{{steps.__ghost__.output.x}}' } } : n,
    )
    const stepCaught = validateDefinitionReferences(withGhostStep, edges).some((p) => p.reference === '__ghost__')

    console.log(`\ncontrols against ${sample.name}:`)
    console.log(`  unknown root {{payload.debt}}: ${rootCaught ? 'CAUGHT' : 'MISSED (the zeros above prove nothing)'}`)
    console.log(`  missing step steps.__ghost__: ${stepCaught ? 'CAUGHT' : 'MISSED (the zeros above prove nothing)'}`)
  }

  console.log(`\ntotal problems across active workflows: ${total}`)
  console.log('Every one must be inspected: a real broken reference, or a false positive to fix before wiring this to the editor.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
