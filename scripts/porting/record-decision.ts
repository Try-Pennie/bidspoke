/**
 * Records a person's porting decision in the porting schema (#2979): a Pipedream
 * workflow that will not be ported, or a step left out of a port, with who
 * decided and why. Dan makes these as he ports; this script only records them.
 *
 *   node scripts/porting/record-decision.ts --retire <hashid> --by <who decided> --reason <why> [--apply]
 *   node scripts/porting/record-decision.ts --unretire <hashid> [--apply]
 *   node scripts/porting/record-decision.ts --drop-step <hashid> --step <step namespace> --export <export dir> --by <who decided> --reason <why> [--apply]
 *   node scripts/porting/record-decision.ts --keep-step <hashid> --step <step namespace> [--apply]
 *
 * Without --apply it reads what is stored and prints what it would record,
 * writing nothing. With --apply it writes the one decision and reads it back.
 * It refuses by name: a workflow the inventory does not hold, a retirement of a
 * workflow already past none, a step the named export does not hold (so a
 * misspelt step is never recorded), a step already dropped, and any change made
 * between its read and its write.
 *
 * The loader never writes either decision, so a reload of a newer export keeps
 * them, and unlock-table.ts leaves retired workflows and dropped steps out.
 *
 * Credentials: as load-inventory.ts (credentials.ts). Nothing here prints a value.
 * Runs on Node's own TypeScript type stripping (Node 23.6 or later).
 */
import {
  parseDecisionArgs,
  readExport,
  recordDecision,
  stepNamespaces,
  type DecisionArgs,
} from '../../packages/porting-evidence/src/inventory/index.ts'
import { credentials, fail } from './credentials.ts'

let args: DecisionArgs
try {
  args = parseDecisionArgs(process.argv.slice(2))
} catch (e) {
  fail(e instanceof Error ? e.message : `could not read the command line: ${JSON.stringify(e)}`)
}

let exportSteps: string[] | null = null
if (args.exportDir !== null) {
  const w = readExport(args.exportDir).flatMap((p) => p.workflows).find((x) => x.hashid === args.request.hashid)
  exportSteps = w?.workflow ? stepNamespaces(w.workflow) : null
}

const { url, key } = credentials()
try {
  const lines = await recordDecision(fetch, url, key, args.request, { apply: args.apply, now: new Date().toISOString(), exportSteps })
  process.stdout.write(`${lines.join('\n')}\n`)
} catch (e) {
  fail(e instanceof Error ? e.message : `recording the decision failed: ${JSON.stringify(e)}`)
}
