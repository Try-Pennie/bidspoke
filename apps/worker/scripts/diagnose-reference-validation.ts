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
} from '../../web/src/lib/reference-validation'
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
  console.log(`\ntotal problems across active workflows: ${total}`)
  console.log('Every one must be inspected: a real broken reference, or a false positive to fix before wiring this to the editor.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
