/**
 * Loads a Pipedream export into porting.pipedream_inventory (#1710, plan 0.F).
 *
 *   node scripts/porting/load-inventory.ts <export dir> --org <organization uuid> [--apply]
 *
 * Without --apply it reads the stored rows and the export and prints what a load
 * would do, writing nothing. With --apply it writes the rows, prints the number
 * the database reports written, then reads the inventory back and checks every
 * planned row landed as planned.
 *
 * What it writes (packages/porting-evidence/src/inventory/plan-load.ts):
 * pipedream_state and the export fields, upserted on the hashid. It never writes
 * porting_stage. A workflow a newer export of its project no longer lists is
 * stamped absent and reported, never deleted. An export older than what is stored
 * is refused.
 *
 * Credentials: SUPABASE_URL and SUPABASE_SECRET_KEY from the environment, else
 * from apps/worker/.dev.vars. Nothing here prints a value.
 *
 * Runs on Node's own TypeScript type stripping (Node 23.6 or later).
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  differencesAfterWrite,
  planLoad,
  readExport,
  readStoredRows,
  writeRows,
} from '../../packages/porting-evidence/src/inventory/index.ts'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

function credentials(): { url: string; key: string } {
  let url = process.env.SUPABASE_URL
  let key = process.env.SUPABASE_SECRET_KEY
  const devVars = path.join(REPO_ROOT, 'apps', 'worker', '.dev.vars')
  if ((!url || !key) && existsSync(devVars)) {
    for (const line of readFileSync(devVars, 'utf8').split('\n')) {
      const m = /^\s*(SUPABASE_URL|SUPABASE_SECRET_KEY)\s*=\s*(.*)\s*$/.exec(line)
      if (!m) continue
      const value = m[2].replace(/^(["'])(.*)\1$/, '$2')
      if (m[1] === 'SUPABASE_URL') url ??= value
      else key ??= value
    }
  }
  if (!url || !key) fail('SUPABASE_URL and SUPABASE_SECRET_KEY are required, in the environment or in apps/worker/.dev.vars')
  return { url: url.replace(/\/$/, ''), key }
}

const dir = process.argv[2]
const org = arg('--org')
if (!dir || dir.startsWith('--') || !org) fail('usage: load-inventory.ts <export dir> --org <organization uuid> [--apply]')
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org)) fail(`--org ${org} is not a uuid`)
const apply = process.argv.includes('--apply')

const { url, key } = credentials()
const projects = readExport(dir)
const stored = await readStoredRows(fetch, url, key)
const plan = planLoad(stored, projects, org)

const listed = projects.reduce((n, p) => n + p.workflows.length, 0)
process.stdout.write(`Export: ${projects.length} projects, ${listed} workflows. Stored before: ${stored.length} rows.\n`)
process.stdout.write(`Plan: ${plan.rows.length} rows to write; ${plan.inserted.length} new, ${plan.stateChanged.length} changed state, ${plan.newlyAbsent.length} newly absent, ${plan.reappeared.length} reappeared.\n`)
for (const c of plan.stateChanged) process.stdout.write(`  state ${c.hashid}: ${c.from} to ${c.to}\n`)
for (const h of plan.newlyAbsent) process.stdout.write(`  ABSENT from the newer export of its project: ${h}\n`)
for (const h of plan.reappeared) process.stdout.write(`  reappeared: ${h}\n`)

if (!apply) {
  process.stdout.write('Nothing written: run again with --apply to write.\n')
  process.exit(0)
}

const written = await writeRows(fetch, url, key, plan.rows, new Date().toISOString())
process.stdout.write(`Written: ${written} row(s).\n`)

// Read back: every planned row must now be stored exactly as planned.
const after = await readStoredRows(fetch, url, key)
const wrong = differencesAfterWrite(plan.rows, after)
if (wrong.length > 0) fail(`Read back found ${wrong.length} difference(s):\n  ${wrong.slice(0, 20).join('\n  ')}`)
process.stdout.write(`Read back: all ${plan.rows.length} planned row(s) stored as planned; ${after.length} row(s) in the inventory.\n`)
