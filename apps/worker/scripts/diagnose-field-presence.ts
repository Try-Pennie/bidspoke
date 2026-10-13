/**
 * Read-only threshold validation for the silent-output field detector (#432).
 *
 * The detector (`src/lib/field-presence-anomaly.ts`) has run log-only since
 * 2026-06-30 with provisional thresholds. Before Phase 4 (#423) turns it into a
 * Slack page, those thresholds have to be measured against the real
 * distribution rather than reasoned about, because a threshold that lands
 * inside the dense middle of the real data turns its own hit count into noise
 * (L172).
 *
 * This runs the detector's OWN pure functions (never a reimplementation, L107)
 * over the live `field_presence_daily` rollup, and replays Tier-1 once per
 * historical day so the output is "how often would this have paged us over the
 * whole window", not "does it fire right now" on one partial day.
 *
 * Read-only: it issues SELECTs and prints. Run:
 *   cd apps/worker && npx tsx scripts/diagnose-field-presence.ts [days]
 */
import { createClient } from '@supabase/supabase-js'
import { loadDevVars } from './lib/dev-vars'
import {
  BASELINE_MIN_DAY_RUNS,
  COLLAPSE_FLOOR,
  COLLAPSE_K,
  DEAD_MAX_RATE,
  DEAD_MIN_RUNS,
  DEAD_WINDOW_DAYS,
  MIN_BASELINE_DAYS,
  MIN_WINDOW_SAMPLE,
  WINDOW_COLLAPSE_FLOOR,
  STABLE_MEAN_MIN,
  STABLE_STDDEV_MAX,
  dailyRate,
  classifyDeadFields,
  findDroughts,
  isStableBaseline,
  mean,
  stddev,
  type PresenceRow,
  type PresenceThresholds,
} from '../src/lib/field-presence-anomaly'
import { deriveWatchedFieldMap } from '../src/engine/watched-fields'
import type { WorkflowDefinition } from '../src/types'

// Refused rather than defaulted (L50): a garbled argument would become NaN, the
// date arithmetic below would produce an Invalid Date, and the query would ask
// about a window nobody chose while still printing a confident verdict.
const WINDOW_DAYS = (() => {
  const raw = process.argv[2]
  if (raw === undefined) return 30
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`window must be a positive number of days, got: ${raw}`)
    process.exit(1)
  }
  return n
})()

const vars = loadDevVars()
const supabase = createClient(vars.SUPABASE_URL, vars.SUPABASE_SECRET_KEY)

async function readRows(sinceDay: string): Promise<PresenceRow[]> {
  const PAGE = 1000
  const out: PresenceRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('field_presence_daily')
      .select('workflow_id, field_path, day, ran_count, present_count')
      .gte('day', sinceDay)
      .eq('is_test', false)
      .order('workflow_id', { ascending: true })
      .order('field_path', { ascending: true })
      .order('day', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`field_presence_daily read failed: ${error.message}`)
    const rows = data ?? []
    for (const r of rows) {
      out.push({
        workflow_id: r.workflow_id as string,
        field_path: r.field_path as string,
        day: r.day as string,
        ran_count: Number(r.ran_count),
        present_count: Number(r.present_count),
      })
    }
    if (rows.length < PAGE) break
    from += PAGE
  }
  return out
}

async function workflowNames(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, name')
    .is('deleted_at', null)
  if (error) throw new Error(`workflows read failed: ${error.message}`)
  return new Map((data ?? []).map((w) => [w.id as string, w.name as string]))
}

async function activeDefinitions(): Promise<{ id: string; name: string; definition: WorkflowDefinition }[]> {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, definition')
    .eq('is_active', true)
    .is('deleted_at', null)
  if (error) throw new Error(`workflows definition read failed: ${error.message}`)
  return (data ?? []).map((w) => ({
    id: w.id as string,
    name: w.name as string,
    definition: w.definition as unknown as WorkflowDefinition,
  }))
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString().slice(0, 10)
  const rows = await readRows(since)
  const names = await workflowNames()
  const label = (id: string) => names.get(id) ?? id

  const days = [...new Set(rows.map((r) => r.day))].sort()
  console.log(`=== field-presence threshold validation ===`)
  // This sweep drives findDroughts, which judges a whole DAY against the daily
  // rollup, so its numbers calibrate the daily surfaces (the field coverage UI)
  // and the stability gate both tiers share. Since #1101 the Tier-1 ALERT judges
  // a trailing window with WINDOW_COLLAPSE_FLOOR instead, and that floor was
  // measured against hourly buckets of workflow_executions.field_presence rather
  // than against this rollup. Do not read a hit count here as what the alert
  // would have paged on (L107).
  console.log(`window: ${days[0]} .. ${days[days.length - 1]} (${days.length} days, ${rows.length} rollup rows)`)
  console.log(
    `thresholds: MIN_BASELINE_DAYS=${MIN_BASELINE_DAYS} BASELINE_MIN_DAY_RUNS=${BASELINE_MIN_DAY_RUNS} ` +
      `STABLE_MEAN_MIN=${STABLE_MEAN_MIN} STABLE_STDDEV_MAX=${STABLE_STDDEV_MAX} ` +
      `COLLAPSE_K=${COLLAPSE_K} COLLAPSE_FLOOR=${COLLAPSE_FLOOR} ` +
      `WINDOW_COLLAPSE_FLOOR=${WINDOW_COLLAPSE_FLOOR} MIN_WINDOW_SAMPLE=${MIN_WINDOW_SAMPLE} ` +
      `DEAD_MIN_RUNS=${DEAD_MIN_RUNS} DEAD_MAX_RATE=${DEAD_MAX_RATE} DEAD_WINDOW_DAYS=${DEAD_WINDOW_DAYS}`,
  )

  // --- Where the stability gate lands in the real distribution -------------
  // The gate is the load-bearing part: only a field that passes it can ever
  // produce a Tier-1 page. So the first question is how many real fields it
  // admits, and how close the rest sit to the line.
  const byField = new Map<string, PresenceRow[]>()
  for (const r of rows) {
    const key = `${r.workflow_id}|${r.field_path}`
    const b = byField.get(key)
    if (b) b.push(r)
    else byField.set(key, [r])
  }

  let stable = 0
  let tooFewDays = 0
  let failsMean = 0
  let failsStddev = 0
  const nearMiss: { key: string; m: number; sd: number; days: number }[] = []
  for (const [key, bucket] of byField) {
    const rates = bucket
      .filter((r) => r.ran_count >= BASELINE_MIN_DAY_RUNS)
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => dailyRate(r.ran_count, r.present_count))
    if (isStableBaseline(rates)) {
      stable++
      continue
    }
    if (rates.length < MIN_BASELINE_DAYS) {
      tooFewDays++
      continue
    }
    const m = mean(rates)
    const sd = stddev(rates)
    if (m < STABLE_MEAN_MIN) failsMean++
    else failsStddev++
    // A field that is essentially always present but just misses the gate is
    // the interesting case: it is real coverage the detector is declining.
    if (m >= 0.9) nearMiss.push({ key, m, sd, days: rates.length })
  }
  console.log(`\n--- stability gate over ${byField.size} (workflow, field) pairs ---`)
  console.log(`  stable (can ever page):   ${stable}`)
  console.log(`  too few qualifying days:  ${tooFewDays}`)
  console.log(`  fails mean >= ${STABLE_MEAN_MIN}:     ${failsMean}`)
  console.log(`  fails stddev <= ${STABLE_STDDEV_MAX}:  ${failsStddev}`)
  if (nearMiss.length > 0) {
    console.log(`\n  near misses (mean >= 90% but gate declined), worst first:`)
    for (const n of nearMiss.sort((a, b) => b.m - a.m).slice(0, 25)) {
      const [wf, field] = n.key.split('|')
      console.log(`    ${pct(n.m)} mean, ${n.sd.toFixed(4)} sd, ${n.days}d  ${label(wf)}  ${field}`)
    }
  }

  // --- Tier-1 replayed once per historical day ----------------------------
  console.log(`\n--- Tier-1 drought, replayed per day ---`)
  let totalDroughtHits = 0
  const droughtDays: string[] = []
  for (const day of days) {
    const upTo = rows.filter((r) => r.day <= day)
    const hits = findDroughts(upTo, day)
    if (hits.length === 0) continue
    droughtDays.push(day)
    totalDroughtHits += hits.length
    console.log(`  ${day}: ${hits.length} hit(s)`)
    for (const h of hits) {
      console.log(
        `    ${label(h.workflow_id)}  ${h.field_path}  baseline ${pct(h.mean)} (sd ${h.stddev.toFixed(4)}) ` +
          `-> ${pct(h.window_rate)} over ${h.window_ran} runs in ${h.window_minutes}m`,
      )
    }
  }
  console.log(
    `  total: ${totalDroughtHits} hit(s) on ${droughtDays.length} of ${days.length} days ` +
      `(${(droughtDays.length / days.length).toFixed(2)} pages/day if flipped live, before cooldown)`,
  )

  // --- Tier-2 over the trailing dead window --------------------------------
  const deadSince = days[days.length - 1]
    ? new Date(new Date(days[days.length - 1]).getTime() - DEAD_WINDOW_DAYS * 86400_000)
        .toISOString()
        .slice(0, 10)
    : since
  const deadRows = rows.filter((r) => r.day >= deadSince)
  const deadHits = classifyDeadFields(deadRows).dead.filter((s) => s.verdict === 'alerting').map((s) => s.dead!)
  console.log(`\n--- Tier-2 day-one-dead over ${deadSince}.. (${DEAD_WINDOW_DAYS}d) ---`)
  console.log(`  ${deadHits.length} hit(s)`)
  for (const h of deadHits) {
    console.log(
      `    ${label(h.workflow_id)}  ${h.field_path}  ${h.window_present}/${h.window_ran} present (${pct(dailyRate(h.window_ran, h.window_present))})`,
    )
  }

  // Fields that are ~never present but sit UNDER the run floor: the population
  // Tier-2 is currently declining to judge. This is the detection delay the
  // design accepted, measured rather than assumed.
  const belowFloor: { key: string; ran: number; present: number }[] = []
  for (const [key, bucket] of byField) {
    const inWindow = bucket.filter((r) => r.day >= deadSince)
    const ran = inWindow.reduce((s, r) => s + r.ran_count, 0)
    const present = inWindow.reduce((s, r) => s + r.present_count, 0)
    if (ran === 0) continue
    if (ran >= DEAD_MIN_RUNS) continue
    if (dailyRate(ran, present) <= DEAD_MAX_RATE) belowFloor.push({ key, ran, present })
  }
  console.log(`\n  never-present but under the ${DEAD_MIN_RUNS}-run floor (unjudged): ${belowFloor.length}`)
  for (const b of belowFloor.sort((a, z) => z.ran - a.ran).slice(0, 25)) {
    const [wf, field] = b.key.split('|')
    console.log(`    ${b.present}/${b.ran} runs  ${label(wf)}  ${field}`)
  }

  // --- Positive control ----------------------------------------------------
  // Tier-1 reported zero hits above. Zero is exactly what a broken harness
  // reports too, so before reading anything into it, prove the replay path can
  // produce a hit at all: take a real stable field, synthesize a collapsed row
  // for one more day, and confirm it comes back (L98, L171).
  console.log(`\n--- Tier-1 positive control ---`)
  const controlKey = [...byField.entries()].find(([, bucket]) =>
    isStableBaseline(
      bucket
        .filter((r) => r.ran_count >= BASELINE_MIN_DAY_RUNS)
        .map((r) => dailyRate(r.ran_count, r.present_count)),
    ),
  )
  if (!controlKey) {
    console.log(`  NO CONTROL AVAILABLE: no field passes the stability gate, so the zero above is unproven`)
  } else {
    const [key, bucket] = controlKey
    const [wf, field] = key.split('|')
    const lastDay = bucket[bucket.length - 1].day
    const nextDay = new Date(new Date(lastDay).getTime() + 86400_000).toISOString().slice(0, 10)
    const injected: PresenceRow[] = [
      ...rows,
      { workflow_id: wf, field_path: field, day: nextDay, ran_count: 500, present_count: 0 },
    ]
    const controlHits = findDroughts(injected, nextDay)
    const caught = controlHits.some((h) => h.workflow_id === wf && h.field_path === field)
    console.log(
      `  injected a 0%-on-500-runs collapse for ${label(wf)} ${field} on ${nextDay}: ` +
        `${caught ? 'CAUGHT (harness works, the zero above is real)' : 'MISSED (harness is broken, the zero above proves nothing)'}`,
    )
  }

  // --- Threshold sweep -----------------------------------------------------
  // Where each candidate lands in the real distribution, driven through the
  // shipped predicates rather than a copy of them (L107).
  console.log(`\n--- Tier-1 sweep over STABLE_MEAN_MIN (stddev gate unchanged) ---`)
  for (const meanMin of [0.98, 0.96, 0.95, 0.92, 0.9, 0.85, 0.8]) {
    const th: PresenceThresholds = { stableMeanMin: meanMin }
    let admitted = 0
    for (const bucket of byField.values()) {
      const rates = bucket
        .filter((r) => r.ran_count >= BASELINE_MIN_DAY_RUNS)
        .map((r) => dailyRate(r.ran_count, r.present_count))
      if (isStableBaseline(rates, th)) admitted++
    }
    let hits = 0
    const hitDays = new Set<string>()
    for (const day of days) {
      const h = findDroughts(rows.filter((r) => r.day <= day), day, th)
      hits += h.length
      if (h.length > 0) hitDays.add(day)
    }
    console.log(
      `  meanMin=${meanMin.toFixed(2)}  admits ${admitted}/${byField.size} fields  ` +
        `-> ${hits} hit(s) on ${hitDays.size}/${days.length} days` +
        `${meanMin === STABLE_MEAN_MIN ? '   <- shipped' : ''}`,
    )
  }

  console.log(`\n--- Tier-2 sweep over DEAD_MAX_RATE ---`)
  for (const maxRate of [0.005, 0.002, 0.001, 0.0005, 0]) {
    const h = classifyDeadFields(deadRows, { thresholds: { deadMaxRate: maxRate } }).dead.filter((s) => s.verdict === 'alerting')
    console.log(
      `  deadMaxRate=${maxRate}  -> ${h.length} hit(s): ${h.map((x) => x.field_path).join(', ') || 'none'}` +
        `${maxRate === DEAD_MAX_RATE ? '   <- shipped' : ''}`,
    )
  }

  // --- Auto-watch blind spot (the second half of #432) ---------------------
  console.log(`\n--- auto-watch blind spot per active workflow ---`)
  const aliasSites = new Set<string>()
  for (const wf of await activeDefinitions()) {
    if (!wf.definition?.nodes) {
      console.log(`  ${wf.name}: no definition nodes`)
      continue
    }
    const map = deriveWatchedFieldMap(wf.definition)
    const codeNodes = wf.definition.nodes.filter((n) => typeof n.config?.script === 'string').length
    console.log(
      `  ${wf.name}: ${map.fields.length} watched (${map.fields.filter((f) => f.source === 'structured').length} structured, ` +
        `${map.fields.filter((f) => f.source === 'code').length} code), ` +
        `${map.unreadableNodes.length}/${codeNodes} code nodes unreadable`,
    )
    if (map.unreadableNodes.length > 0) {
      console.log(`      unreadable: ${map.unreadableNodes.join(', ')}`)
    }
    // The alias-only blind spot (#435): reads through a local the derivation
    // could not name a path for. Reported from the derivation itself rather than
    // a second copy of its alias matcher, which had stopped at a bracket and so,
    // once #1799 taught the derivation to follow `records?.[0]`, listed every
    // correctly watched `records.0.X` read as unwatched.
    for (const ns of map.aliasOnlyNodes) {
      console.log(`      alias-only code node ${ns}: some reads through a local are not watched`)
      aliasSites.add(`${wf.name}|${ns}`)
    }
  }

  console.log(`\n  alias-only blind spot total: ${aliasSites.size} code node(s)`)

  // Positive control for the blind-spot count: a script the scanner MUST call
  // unreadable. Without it, "0 unreadable" everywhere reads the same whether
  // the codebase is clean or the detector is dead (L98).
  const controlDef = {
    nodes: [{ namespace: 'ctl', type: 'code', config: { script: 'const k = "a"; return steps[k].x' } }],
    edges: [],
  } as unknown as WorkflowDefinition
  const ctl = deriveWatchedFieldMap(controlDef)
  console.log(
    `\n  blind-spot detector control: injected steps[k] access -> ` +
      `${ctl.unreadableNodes.length === 1 ? 'FLAGGED (the zeros above are real)' : 'NOT FLAGGED (the zeros above prove nothing)'}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
