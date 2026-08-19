/**
 * Phase A0 measurement for the execution archive (#868). READ ONLY: it writes
 * nothing and deletes nothing.
 *
 * Pulls real executions with their steps through the same read shape the
 * archiver will use, assembles the bundle, gzips and base64s it, and reports
 * the size distribution, steps per execution, and CPU per stage.
 *
 * It prints ONLY numbers. The bundles it handles carry live SSNs, dates of
 * birth, addresses and credit reports, and nothing upstream strips them, so
 * every value that reaches stdout comes from summarize(), whose output is
 * asserted to be numeric in src/archive/__tests__/report.test.ts.
 *
 * Volume: SAMPLE_SIZE executions (default 200) at ~11 steps each, so ~2,200
 * step rows. The step fetch matches execution_started_at exactly, which is the
 * partition key, so each execution reads one daily partition rather than all of
 * them.
 *
 * Run: npx tsx scripts/measure-bundle.ts [sampleSize]
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { encodeBundle } from '../src/archive/bundle'
import { summarize } from '../src/archive/report'
import { measureSettle } from '../src/archive/settle'

const here = dirname(fileURLToPath(import.meta.url))

function loadDevVars(): Record<string, string> {
  const raw = readFileSync(resolve(here, '..', '.dev.vars'), 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    out[t.slice(0, eq).trim()] = val
  }
  return out
}

const SAMPLE_SIZE = Number(process.argv[2] ?? 200)
// PostgREST caps a request at 1,000 rows regardless of a higher .limit(), so
// asking for more silently truncates. Ask for exactly the cap and report when
// it was reached.
const SETTLE_SAMPLE = 1000

async function main() {
  const vars = loadDevVars()
  const supabase = createClient(vars.SUPABASE_URL, vars.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })

  // A whole UTC day that is safely past the settle window and not the current
  // partition, so the sample is representative of what the archiver would take.
  const dayStart = new Date(Date.now() - 3 * 86400_000)
  dayStart.setUTCHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart.getTime() + 86400_000)

  const { data: executions, error } = await supabase
    .from('workflow_executions')
    .select('*')
    .gte('started_at', dayStart.toISOString())
    .lt('started_at', dayEnd.toISOString())
    .limit(SAMPLE_SIZE)
  if (error) throw new Error(`execution fetch failed: ${error.message}`)
  if (!executions || executions.length === 0) throw new Error('no executions in the sampled day')

  const measurements = []
  let stepFetchMs = 0
  for (const execution of executions) {
    const t0 = performance.now()
    const { data: steps, error: stepError } = await supabase
      .from('execution_steps')
      .select('*')
      // Exact match on the partition key: one partition, not all of them.
      .eq('execution_started_at', execution.started_at as string)
      .eq('execution_id', execution.id as string)
      .order('step_order', { ascending: true })
    stepFetchMs += performance.now() - t0
    if (stepError) throw new Error(`step fetch failed: ${stepError.message}`)
    measurements.push(await encodeBundle({ execution, steps: steps ?? [] }))
  }

  const report = summarize(measurements)

  // The settle window: how long after an execution completes before the tail
  // consumer writes its cost. Nothing stamps WHEN that write happened, so it
  // cannot be measured retrospectively; it is measured forwards, over recently
  // completed executions, by age.
  //
  // The first version of this block selected a column that does not exist and
  // did not check the error, so it reported a settle window of zero. Every query
  // here throws on error for that reason.
  const settleSince = new Date(Date.now() - 60 * 60_000).toISOString()
  const { data: recent, error: settleError } = await supabase
    .from('workflow_executions')
    .select('completed_at, cpu_ms')
    .gte('started_at', new Date(Date.now() - 3 * 60 * 60_000).toISOString())
    .gte('completed_at', settleSince)
    .not('completed_at', 'is', null)
    // Newest first, deliberately. Unsettled rows are by definition the youngest,
    // so an unordered sample truncated at PostgREST's 1,000-row cap drops
    // exactly the rows this measurement exists to find, and then reports that
    // everything settled instantly.
    .order('completed_at', { ascending: false })
    .limit(SETTLE_SAMPLE)
  if (settleError) throw new Error(`settle sample failed: ${settleError.message}`)
  const settleCapped = (recent ?? []).length >= SETTLE_SAMPLE

  const settle = measureSettle(
    (recent ?? []).map((r) => ({
      ageMinutes: (Date.now() - new Date(r.completed_at as string).getTime()) / 60_000,
      hasCost: r.cpu_ms !== null,
    })),
  )

  console.log(JSON.stringify({
    sampledDayUtc: dayStart.toISOString().slice(0, 10),
    bundles: report,
    stepFetchMsTotal: Math.round(stepFetchMs),
    stepFetchMsPerExecution: Math.round(stepFetchMs / executions.length),
    settle: { ...settle, capped: settleCapped },
  }, null, 2))
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'measurement failed')
  process.exit(1)
})
