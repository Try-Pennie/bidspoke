/**
 * Instrument 3 of a lead validation swap (#2591, part of #934): replays a
 * candidate node over real production runs of its workflow and prints how it
 * would have answered against how the script did, counts only.
 * The logic and its refusals are money-gate/swap/real-traffic.ts.
 *
 * Hand run, read only: the client's insert, update, upsert, delete, rpc and
 * schema throw (money-gate/lib/read-only-client.ts), and nothing it prints is a
 * payload value or an id. Its output guard is
 * money-gate/swap/__tests__/real-traffic.test.ts.
 *
 * Run from apps/worker, with SUPABASE_URL and SUPABASE_SECRET_KEY in the
 * environment, in apps/worker/.dev.vars, or in the file --dev-vars names:
 *   npx tsx scripts/lead-validation-replay.ts <candidate> [--hours 24] [--to <ISO time>] [--seed <check>:<lenient|strict>] [--dev-vars <path>]
 *
 * <candidate> is a file name under money-gate/swap/candidates (rml-gigfi,
 * rml-lendswift, lead-economy). The window is the --hours before --to (default:
 * the 24 hours before the current hour). Execution steps are kept 7 days, so a
 * window reaching further back reads runs whose steps are gone, which land in
 * no_validate_step.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { readOnlyClient } from '../money-gate/lib/read-only-client'
import { parseSeed, seedDefect } from '../money-gate/swap/candidate'
import { findCandidate } from '../money-gate/swap/ab'
import { formatRealTrafficReport, replayRealTraffic } from '../money-gate/swap/real-traffic'
import { loadDevVars } from './lib/dev-vars'

export interface ReplayArgs { candidate: string; hours: number; to: Date | null; seed: string | null; devVars: string | null }

export function parseArgs(argv: string[]): ReplayArgs {
  const out: ReplayArgs = { candidate: '', hours: 24, to: null, seed: null, devVars: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--hours') {
      out.hours = Number(next())
      if (!Number.isInteger(out.hours) || out.hours < 1 || out.hours > 168) throw new Error('--hours is a whole number from 1 to 168 (steps are kept 7 days)')
    } else if (a === '--to') {
      out.to = new Date(next())
      if (Number.isNaN(out.to.getTime())) throw new Error('--to is not a time')
    } else if (a === '--seed') out.seed = next()
    else if (a === '--dev-vars') out.devVars = next()
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else if (!out.candidate) out.candidate = a
    else throw new Error(`unexpected argument ${a}`)
  }
  if (!out.candidate) throw new Error('name a candidate: rml-gigfi, rml-lendswift or lead-economy')
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = resolve(here, '..', 'money-gate', 'swap', 'candidates')
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as unknown]))
  let candidate = findCandidate(files, args.candidate)
  const seed = parseSeed(args.seed ?? undefined)
  if (seed) candidate = seedDefect(candidate, seed.checkId, seed.direction)

  let url = process.env.SUPABASE_URL
  let key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    const vars = loadDevVars(args.devVars ?? undefined)
    url = vars.SUPABASE_URL
    key = vars.SUPABASE_SECRET_KEY
  }
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required')

  const to = args.to ?? new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000)
  const from = new Date(to.getTime() - args.hours * 3_600_000)
  const client = readOnlyClient(createClient(url, key, { auth: { persistSession: false } }))
  const report = await replayRealTraffic(candidate, { from, to }, { client, log: (l) => console.log(l) })
  if (seed) console.log(`seeded defect: ${args.seed}`)
  console.log(formatRealTrafficReport(report, candidate))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'the replay failed')
    process.exit(1)
  })
}
