/**
 * Dry run of the execution archive against production (#871, Phase A3).
 *
 * READ ONLY BY CONSTRUCTION. It calls fetchHour and encodeBundle, which are the
 * real read and compress path, and it never calls the send, the watermark write,
 * the id record or the refusal write. There is no code path in this file that
 * writes anything, anywhere.
 *
 * The point is that nothing else has ever exercised this against real data: the
 * unit tests all use doubles, so a pass there says nothing about whether an hour
 * of real executions reads, reconciles and compresses inside the budgets (L3).
 *
 * It prints only counts, sizes and timings. Never a payload: these bundles carry
 * live SSNs, dates of birth, addresses and credit reports, and nothing upstream
 * strips them.
 *
 * Run: npx tsx scripts/dry-run-archive.ts [hoursAgo]
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { fetchHour } from '../src/archive/hour-fetch'
import { encodeBundle } from '../src/archive/bundle'
import { batchByBytes } from '../src/archive/batching'
import { dispositionFor } from '../src/archive/disposition'
import { archiveDay } from '../src/archive/clock'

function devVars(): Record<string, string> {
  const raw = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    const eq = t.indexOf('=')
    if (!t || t.startsWith('#') || eq === -1) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0), sorted.length - 1)]
}

async function main(): Promise<void> {
  const vars = devVars()
  const supabase = createClient(vars.SUPABASE_URL, vars.SUPABASE_SECRET_KEY)

  const hoursAgo = Number(process.argv[2] ?? 6)
  if (!Number.isFinite(hoursAgo) || hoursAgo < 3) {
    throw new Error('hoursAgo must be a number of at least 3, so the hour is closed and settled')
  }

  const hourStartMs = Math.floor((Date.now() - hoursAgo * 3_600_000) / 3_600_000) * 3_600_000
  const hourStart = new Date(hourStartMs).toISOString()
  const hourEnd = new Date(hourStartMs + 3_600_000).toISOString()

  console.log(`hour:     ${hourStart} to ${hourEnd}`)
  console.log('mode:     DRY RUN, nothing is written to Snowflake or Postgres')

  const t0 = Date.now()
  const hour = await fetchHour(supabase, hourStart, hourEnd)
  const fetchMs = Date.now() - t0

  if (!hour.usable) {
    console.log(`\nREAD REFUSED: ${hour.reason}`)
    console.log(`requests spent: ${hour.requests}`)
    process.exit(1)
  }

  console.log(`\nread OK in ${fetchMs} ms`)
  console.log(`  executions: ${hour.executionCount}`)
  console.log(`  steps:      ${hour.stepCount}`)
  console.log(`  requests:   ${hour.requests}`)
  if (hour.empty) {
    console.log('\nhour was empty, which is its own outcome and not a failure')
    return
  }

  // The organization map, same read the job makes.
  const { data: workflows, error } = await supabase.from('workflows').select('id, organizations!workflows_organization_id_fkey(slug)')
  if (error) throw new Error(`workflow read failed: ${JSON.stringify(error)}`)
  const organizationOf = new Map<string, string>()
  for (const row of (workflows ?? []) as Array<Record<string, unknown>>) {
    const org = row.organizations as { slug?: string } | null
    if (typeof row.id === 'string' && typeof org?.slug === 'string') organizationOf.set(row.id, org.slug)
  }

  const now = new Date()
  const refusals: string[] = []
  const keep = []
  const days = new Set<string>()
  for (const bundle of hour.bundles) {
    const d = dispositionFor(bundle.execution, { now, organizationOf })
    if (d.action === 'refuse') {
      refusals.push(d.reason ?? 'refused')
      continue
    }
    const startedAt = bundle.execution.started_at
    days.add(typeof startedAt === 'string' ? archiveDay(startedAt) : 'unknown')
    keep.push(bundle)
  }

  const t1 = Date.now()
  const sizes: number[] = []
  const encoded = []
  let encodeFailures = 0
  for (const bundle of keep) {
    try {
      const e = await encodeBundle({ execution: bundle.execution, steps: bundle.steps })
      sizes.push(e.wireBytes)
      encoded.push({ executionId: bundle.executionId, wireBytes: e.wireBytes })
    } catch {
      encodeFailures++
    }
  }
  const encodeMs = Date.now() - t1

  const { batches, oversized } = batchByBytes(encoded)
  const sorted = [...sizes].sort((a, b) => a - b)
  const total = sizes.reduce((n, s) => n + s, 0)

  console.log(`\ndisposition`)
  console.log(`  kept:     ${keep.length}`)
  console.log(`  refused:  ${refusals.length}`)
  console.log(`  days:     ${[...days].sort().join(', ')}`)
  if (refusals.length > 0) {
    // Reasons only, never ids: a reason is a category, an id is a lead.
    const byReason = new Map<string, number>()
    for (const r of refusals) {
      const kind = r.replace(/execution \S+ /, '')
      byReason.set(kind, (byReason.get(kind) ?? 0) + 1)
    }
    for (const [kind, n] of byReason) console.log(`    ${n}x ${kind}`)
  }

  console.log(`\nencode, ${encodeMs} ms for ${encoded.length} bundles`)
  console.log(`  failures: ${encodeFailures}`)
  console.log(`  wire p50: ${percentile(sorted, 50)} B`)
  console.log(`  wire p99: ${percentile(sorted, 99)} B`)
  console.log(`  wire max: ${sorted[sorted.length - 1] ?? 0} B`)
  console.log(`  total:    ${(total / 1024 / 1024).toFixed(1)} MB held at once`)

  console.log(`\nbatching`)
  console.log(`  batches:   ${batches.length}`)
  console.log(`  oversized: ${oversized.length}`)

  console.log(`\nbudget for one hour`)
  console.log(`  wall clock: ${((fetchMs + encodeMs) / 1000).toFixed(1)} s`)
  console.log(`  requests:   ${hour.requests} read + ${batches.length * 2} write`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
