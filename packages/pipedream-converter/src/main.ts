/**
 * Prints the draft of one Pipedream workflow (#1695, plan 9.1). Writes nothing.
 *
 *   pnpm run convert -- <export dir> <workflow id>
 *
 * Reads the workflow's row of porting.pipedream_inventory (one GET through the
 * Data API) to decide whether the export is the newest recorded snapshot, then
 * prints the draft as JSON on stdout, or the refusal and its reason on stderr.
 * Exit codes: 0 drafted, 1 refused or failed, 2 usage.
 *
 * Credentials: SUPABASE_URL and SUPABASE_SECRET_KEY from the environment, else
 * from apps/worker/.dev.vars, read as scripts/porting/load-inventory.ts reads
 * them. Nothing here prints a value.
 *
 * Runs on Node's own TypeScript type stripping (Node 22.18 or later).
 */
import path from 'node:path'
import { inventoryCredentials, readStoredRow } from '@bidspoke/porting-evidence/inventory'
import { convertExport } from './convert.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

async function main(argv: string[]): Promise<number> {
  // pnpm hands the `--` separator through to the script.
  const args = argv[0] === '--' ? argv.slice(1) : argv
  if (args.length !== 2 || args.some((a) => a.startsWith('--'))) {
    process.stderr.write('usage: pnpm run convert -- <export dir> <workflow id>\n')
    return 2
  }
  const [dir, workflowId] = args
  try {
    const { url, key } = inventoryCredentials(process.env, path.join(REPO_ROOT, 'apps', 'worker', '.dev.vars'))
    const stored = await readStoredRow(fetch, url, key, workflowId)
    const result = convertExport(path.resolve(dir), workflowId, stored)
    if (!result.ok) {
      process.stderr.write(`Refused (${result.reason}): ${result.message}\nNothing written.\n`)
      return 1
    }
    const d = result.draft
    process.stdout.write(`${JSON.stringify(d, null, 2)}\n`)
    process.stderr.write(`Draft of ${d.workflow.hashid}: ${d.triggers.length} trigger(s), ${d.steps.length} step(s), ${d.unconverted.length} not converted. Snapshot ${d.snapshot.sha256}. Nothing written.\n`)
    return 0
  } catch (e) {
    // fetch reports an unreachable address only in its cause.
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : ''
    process.stderr.write(`${e instanceof Error ? e.message : 'the converter failed'}${cause}\nNothing written.\n`)
    return 1
  }
}

process.exitCode = await main(process.argv.slice(2))
