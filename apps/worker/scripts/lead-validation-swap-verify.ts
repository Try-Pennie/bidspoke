/**
 * After a lead validation swap is saved (#2592, part of #934): checks that the
 * saved step is byte for byte the proven candidate and that nothing else in the
 * workflow changed, against the version before it. The logic is
 * money-gate/swap/verify-save.ts.
 *
 * Hand run, read only: the client refuses every write (money-gate/lib/read-only-client.ts),
 * and it prints step names, ids and field paths, never a config value or a script.
 *
 * Run from apps/worker, with SUPABASE_URL and SUPABASE_SECRET_KEY in the
 * environment, in apps/worker/.dev.vars, or in the file --dev-vars names:
 *   npx tsx scripts/lead-validation-swap-verify.ts <candidate> [--version <n>] [--dev-vars <path>]
 *
 * <candidate> is a file name under money-gate/swap/candidates (rml-gigfi,
 * rml-lendswift, lead-economy; Lead Economy's save also sets its Constants
 * minimumLoanAmount, which the check expects exactly). Without
 * --version it checks the workflow's newest version; with it, that version. Either
 * is compared with the newest version before it that still holds the pinned
 * script, so a swap saved in more than one version (Lead Economy's step in
 * version 40 and its Constants minimum in version 41, #2594) is checked as one
 * change, and the versions between are named. Exit 0 on a pass, or when the
 * version checked still holds the pinned script (the swap is not saved yet, said
 * as such); 1 on any difference, or when none of the SEARCH_DEPTH - 1 versions
 * read before it holds the pinned script (SEARCH_DEPTH counts the one checked).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { readOnlyClient } from '../money-gate/lib/read-only-client'
import { findCandidate } from '../money-gate/swap/ab'
import { formatSwapVerification, pickSwapVersions, verifySavedSwap, type DefinitionLike, type DefinitionVersion } from '../money-gate/swap/verify-save'
import { loadDevVars } from './lib/dev-vars'

/** How many versions back the version before the swap is looked for, counting the one checked. */
export const SEARCH_DEPTH = 20

interface Args { candidate: string; version: number | null; devVars: string | null }

function parseArgs(argv: string[]): Args {
  const out: Args = { candidate: '', version: null, devVars: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--version') {
      out.version = Number(next())
      if (!Number.isInteger(out.version) || out.version < 2) throw new Error('--version is a whole version number of at least 2')
    } else if (a === '--dev-vars') out.devVars = next()
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (!out.candidate) out.candidate = a
    else throw new Error(`unexpected argument ${a}`)
  }
  if (!out.candidate) throw new Error('name a candidate, e.g. rml-gigfi')
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = resolve(here, '..', 'money-gate', 'swap', 'candidates')
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as unknown]))
  const candidate = findCandidate(files, args.candidate)

  let url = process.env.SUPABASE_URL
  let key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    const vars = loadDevVars(args.devVars ?? undefined)
    url = vars.SUPABASE_URL
    key = vars.SUPABASE_SECRET_KEY
  }
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required')
  const client = readOnlyClient(createClient(url, key, { auth: { persistSession: false } }))

  const wf = await client.from('workflows').select('id, name, definition').eq('id', candidate.workflow_id).maybeSingle()
  if (wf.error || !wf.data) throw new Error(`could not read workflow ${candidate.workflow_id}: ${wf.error?.message ?? 'not found'}`)
  let q = client.from('workflow_versions').select('version_number, created_at, message, definition').eq('workflow_id', candidate.workflow_id)
  if (args.version !== null) q = q.lte('version_number', args.version)
  const versions = await q.order('version_number', { ascending: false }).limit(SEARCH_DEPTH)
  if (versions.error) throw new Error(`could not read versions: ${versions.error.message}`)
  const rows = (versions.data ?? []) as Array<DefinitionVersion & { created_at: string; message: string | null }>
  const [saved] = rows
  if (!saved || rows.length < 2 || (args.version !== null && saved.version_number !== args.version)) throw new Error('could not read the version asked for and the one before it')

  const picked = pickSwapVersions(candidate, rows)
  const savedLabel = `${candidate.workflow_name}, version ${saved.version_number} (saved ${saved.created_at})`
  if (picked.kind === 'not_saved') {
    console.log(`${savedLabel}: NOT SAVED YET, the ${candidate.replaces.namespace} step is still the pinned script`)
    return
  }
  if (picked.kind === 'no_base') {
    console.log(`${savedLabel}: FAIL, none of versions ${picked.searched.join(', ')} holds the script the proofs compared against (code step ${candidate.replaces.namespace}, id ${candidate.replaces.node_id}, md5 ${candidate.replaces.script_md5})`)
    process.exitCode = 1
    return
  }
  const between = picked.between.length ? ` (version${picked.between.length === 1 ? '' : 's'} ${picked.between.join(', ')} between)` : ''
  const label = `${savedLabel} against version ${picked.base.version_number}, the last holding the pinned script${between}`
  const report = verifySavedSwap(candidate, picked.base, saved, (wf.data as { definition: DefinitionLike }).definition)
  console.log(formatSwapVerification(report, label))
  if (!report.ok) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'the check failed')
    process.exit(1)
  })
}
