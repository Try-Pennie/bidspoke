/**
 * Replays the gone silent check (#1215) over real rollup history, before it is
 * allowed to page.
 *
 * It runs the check's OWN function, `classifySilentRare`, once per historical
 * day, never a reimplementation (L107), so its output is "what would this have
 * paged on, day by day", not a model of it. The check is log only until this
 * replay has been reviewed and its activation issue is done.
 *
 * Input is a JSON file of rollup rows, so the script holds no credentials:
 *   [{ "workflow_id": "Main Flow", "field_path": "...", "day": "2026-09-05",
 *      "ran_count": 3121, "present_count": 0 }, ...]
 * (workflow_id may be the workflow's name, which makes the output readable).
 * Export it read only, for example through the Supabase SQL editor:
 *   SELECT w.name AS workflow_id, d.field_path, d.day, d.ran_count, d.present_count
 *   FROM field_presence_daily d JOIN workflows w ON w.id = d.workflow_id
 *   WHERE NOT d.is_test AND w.deleted_at IS NULL
 *
 * One limit to read the output with: each replayed day is judged as a WHOLE day,
 * while the live check runs at 13:00 UTC on a part day, so live it judges a
 * little later in an incident than this replay shows.
 *
 * Run: cd apps/worker && npx tsx scripts/replay-silent-check.ts <rows.json> [lookbackDays]
 */
import { readFileSync } from 'node:fs'
import { classifySilentRare, EVER_CARRIED_LOOKBACK_DAYS, type PresenceRow } from '../src/lib/field-presence-anomaly'

const file = process.argv[2]
if (!file) {
  console.error('usage: npx tsx scripts/replay-silent-check.ts <rows.json> [lookbackDays]')
  process.exit(2)
}
const lookback = process.argv[3] === undefined ? EVER_CARRIED_LOOKBACK_DAYS : Number(process.argv[3])
if (!Number.isInteger(lookback) || lookback < 2) {
  console.error(`lookbackDays must be a whole number of at least 2, got ${process.argv[3]}`)
  process.exit(2)
}

const rows = JSON.parse(readFileSync(file, 'utf8')) as PresenceRow[]
const days = [...new Set(rows.map((r) => r.day))].sort()
const dayMinus = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

// Start on the fifteenth day with data, so the first days are not judged on
// almost nothing. Refused, never a clean looking empty replay (L98).
const MIN_HISTORY_DAYS = 15
if (days.length < MIN_HISTORY_DAYS) {
  console.error(`need at least ${MIN_HISTORY_DAYS} days of rows to replay, got ${days.length}`)
  process.exit(1)
}
const start = days[MIN_HISTORY_DAYS - 1]
const byDay: { day: string; judged: number; pages: { field: string; window_days: number; expected: number }[] }[] = []
for (const day of days.filter((d) => d >= start)) {
  const from = dayMinus(day, lookback - 1)
  const visible = rows.filter((r) => r.day >= from && r.day <= day)
  const states = classifySilentRare(visible)
  byDay.push({
    day,
    judged: states.filter((s) => s.verdict !== 'insufficient').length,
    pages: states
      .filter((s) => s.verdict === 'alerting')
      .map((s) => ({
        field: `${s.workflow_id} ${s.field_path}`,
        window_days: s.silent?.window_days ?? 0,
        expected: Math.round((s.silent?.expected ?? 0) * 10) / 10,
      })),
  })
}

if (byDay.length === 0) {
  console.error('no day was replayed, so there is nothing to report')
  process.exit(1)
}

const fieldsPaged = new Map<string, string[]>()
for (const d of byDay) for (const p of d.pages) fieldsPaged.set(p.field, [...(fieldsPaged.get(p.field) ?? []), d.day])

console.log(`=== gone silent replay (#1215) ===`)
console.log(`days replayed: ${byDay.length} (${byDay[0]?.day} .. ${byDay[byDay.length - 1]?.day}), rows: ${rows.length}, lookback: ${lookback} days`)
console.log(`would-page days: ${byDay.filter((d) => d.pages.length > 0).length}, would-page field-days: ${byDay.reduce((n, d) => n + d.pages.length, 0)}, distinct fields: ${fieldsPaged.size}`)
console.log(`fields judged per day: min ${Math.min(...byDay.map((d) => d.judged))}, max ${Math.max(...byDay.map((d) => d.judged))}`)
console.log('')
console.log('by field (days it would have paged):')
for (const [field, ds] of [...fieldsPaged.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${field}: ${ds.length} day(s): ${ds.join(', ')}`)
}
console.log('')
console.log('by day:')
for (const d of byDay) {
  if (d.pages.length === 0) continue
  console.log(`  ${d.day}: ${d.pages.map((p) => `${p.field} (window ${p.window_days}d, expected ${p.expected})`).join('; ')}`)
}
