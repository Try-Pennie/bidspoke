/**
 * Which UTC days Postgres still holds executions for (#1025).
 *
 * ONE method, used by both readers of this question. The backlog walk asked the
 * data, one cheap existence query per day; the deletion gate computed its list
 * arithmetically from the retention constant. On 2026-08-23 the constant said 7
 * while the purge jobs said 9, so the gate's list began on 2026-08-17 and the
 * walk's on 2026-08-16, and from there the two were reporting on overlapping but
 * not identical sets of days with nothing comparing them.
 *
 * The consequence is not cosmetic. The gate decides which days are safe to
 * delete. If its idea of which days EXIST is narrower than reality, the oldest
 * recoverable days sit outside its view entirely, which is the state that hid the
 * six day gap.
 *
 * Asked one day at a time on purpose: the answer that matters is "does Postgres
 * still hold anything for this day", and each query carries the partition key so
 * it touches one partition rather than scanning every one.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from '../lib/format-error'

const DAY_MS = 24 * 60 * 60 * 1000

function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The days from `from` to `to` inclusive, oldest first. */
export function daysBetween(from: string, to: string): string[] {
  const fromMs = Date.parse(`${from}T00:00:00.000Z`)
  const toMs = Date.parse(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return []
  const days: string[] = []
  for (let ms = fromMs; ms <= toMs; ms += DAY_MS) days.push(dayString(ms))
  return days
}

/**
 * Days in the range whose executions Postgres still holds.
 *
 * THROWS rather than treating a day as absent. Reading "the query failed" as
 * "the day is gone" would quietly stop both callers considering a day that is
 * still rescuable, which is the exact failure they exist to prevent (L215).
 */
export async function daysHeldInPostgres(
  supabase: SupabaseClient,
  range: { from: string; to: string },
): Promise<string[]> {
  const held: string[] = []
  for (const day of daysBetween(range.from, range.to)) {
    const next = dayString(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS)
    const { data, error } = await supabase
      .from('workflow_executions')
      .select('id')
      .gte('started_at', `${day}T00:00:00.000Z`)
      .lt('started_at', `${next}T00:00:00.000Z`)
      .limit(1)
    if (error) throw new Error(`checking whether Postgres still holds ${day} failed: ${formatErr(error)}`)
    if ((data ?? []).length > 0) held.push(day)
  }
  return held
}

/**
 * Days Postgres holds that are OLDER than anything the gate is considering.
 *
 * Only the old side is a finding. A day NEWER than the newest candidate is
 * legitimately excluded, because the archiver has not finished it, and reporting
 * those would fire every single run (L11). A day older than the oldest candidate
 * is a day the gate can never vouch for while the purge deletes it on schedule.
 */
export function daysBeneathTheGate(held: string[], candidates: string[]): string[] {
  if (candidates.length === 0) return []
  const oldestConsidered = candidates[0]
  return held.filter((d) => d < oldestConsidered)
}
