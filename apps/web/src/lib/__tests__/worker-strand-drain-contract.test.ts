/**
 * #367: keep the strand drain's SQL reconstruction in sync with the live finalize.
 *
 * After #353 two implementations define what a recovered lead looks like:
 *   - the live engine in TypeScript — `SightingFinalizeFields` (engine/lead-sightings.ts)
 *     projected onto workflow_executions.sighting_finalize, plus `ProjectedBidAttempt`
 *     (engine/bid-log.ts) under sighting_finalize->'bid_attempts'.
 *   - the strand drain in SQL — `reduce_finalize_stranded`, which reads those JSONB
 *     keys back out to recover stranded leads.
 *
 * They are coupled only by the JSONB key names. If the TS shape gains, renames, or
 * retypes a field and the SQL drain isn't updated, ~5% of leads/day (the strands)
 * silently recover with a missing/wrong field — the exact falsification #353 killed,
 * reintroduced quietly. This guard fails the build when the SQL stops reading every
 * projected field, forcing the drain to be updated in lockstep.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC } from './_scan-utils'

// The bid_attempts array is the one sighting_finalize key that is NOT a
// SightingFinalizeFields member (it carries ProjectedBidAttempt[]). Its element
// fields are checked separately, so the container key is allowed on the SQL side.
const SF_CONTAINER_KEYS = new Set(['bid_attempts'])

function interfaceFieldNames(src: string, name: string): string[] {
  // These interfaces are flat (no nested braces), so a non-greedy body match is safe.
  const m = src.match(new RegExp(`export interface ${name} \\{([^}]*)\\}`))
  if (!m) throw new Error(`interface ${name} not found`)
  const fields = m[1]
    .split('\n')
    .map((line) => line.trim().match(/^([a-z_][a-z0-9_]*)\s*[?:]/i)?.[1])
    .filter((x): x is string => Boolean(x))
  if (fields.length === 0) throw new Error(`no fields parsed from ${name}`)
  return fields
}

// Strip `-- ...` line comments so a key mentioned in a comment isn't counted as read.
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '')
}

function sightingFinalizeKeys(sql: string): Set<string> {
  const keys = new Set<string>()
  for (const m of sql.matchAll(/sighting_finalize\s*->>?\s*'([a-z_]+)'/gi)) keys.add(m[1])
  return keys
}

function bidAttemptKeys(sql: string): Set<string> {
  // The CROSS JOIN LATERAL jsonb_array_elements(...) alias is `a`.
  const keys = new Set<string>()
  for (const m of sql.matchAll(/\ba\s*->>\s*'([a-z_]+)'/gi)) keys.add(m[1])
  return keys
}

// The authoritative drain is whichever migration most recently CREATE OR REPLACEs
// the function — find the highest-versioned migration that defines it, so this
// guard follows the function forward instead of pinning to one file.
function latestDrainSql(): string {
  const dir = path.join(REPO_ROOT, 'supabase/migrations')
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) =>
      // Word-boundary the function name so a differently-named function that merely
      // shares the prefix (e.g. reduce_finalize_stranded_executions, added 2026-07-08
      // for the workflow_executions strand, unrelated to this lead_sightings drain)
      // isn't mistaken for a CREATE OR REPLACE of the real drain.
      /create\s+or\s+replace\s+function\s+public\.reduce_finalize_stranded\s*\(/i.test(
        readFileSync(path.join(dir, f), 'utf8'),
      ),
    )
    .sort()
  if (defining.length === 0) throw new Error('no migration defines reduce_finalize_stranded')
  return stripSqlComments(readFileSync(path.join(dir, defining[defining.length - 1]), 'utf8'))
}

describe('strand drain SQL stays in sync with the finalize projection (#367)', () => {
  const leadSightings = readFileSync(path.join(WORKER_SRC, 'engine/lead-sightings.ts'), 'utf8')
  const bidLog = readFileSync(path.join(WORKER_SRC, 'engine/bid-log.ts'), 'utf8')
  const sql = latestDrainSql()

  const sfFields = interfaceFieldNames(leadSightings, 'SightingFinalizeFields')
  const bidFields = interfaceFieldNames(bidLog, 'ProjectedBidAttempt')
  const sqlSfKeys = sightingFinalizeKeys(sql)
  const sqlBidKeys = bidAttemptKeys(sql)

  it('reads every SightingFinalizeFields key back out of sighting_finalize', () => {
    const missing = sfFields.filter((f) => !sqlSfKeys.has(f))
    expect(missing, `drain SQL never reads sighting_finalize->>'${missing.join("', '")}'`).toEqual([])
  })

  it('reads every ProjectedBidAttempt key from the bid_attempts array', () => {
    const missing = bidFields.filter((f) => !sqlBidKeys.has(f))
    expect(missing, `drain SQL never reads bid_attempts element key(s): ${missing.join(', ')}`).toEqual([])
  })

  it('does not read a sighting_finalize key that no longer exists on the projection', () => {
    const known = new Set([...sfFields, ...SF_CONTAINER_KEYS])
    const stale = [...sqlSfKeys].filter((k) => !known.has(k))
    expect(stale, `drain SQL reads sighting_finalize key(s) not on SightingFinalizeFields: ${stale.join(', ')}`).toEqual([])
  })
})
