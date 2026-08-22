/**
 * The refusal write is proven to happen, not assumed (#957).
 *
 * `execution_archive_refusals` had ZERO rows in production while #949 recorded
 * 5,617 of 5,617 executions in one hour being refused for a tenancy mismatch.
 * Those two facts are reconcilable: that 5,617 was measured by
 * `scripts/dry-run-archive.ts`, which prints "nothing is written to Snowflake or
 * Postgres" and means it, and the live job only began reaching disposition after
 * the tenancy constant was corrected, at which point nothing is refused. So the
 * refusal path had never run in production at all.
 *
 * That matters because A4's deletion gate (#872) reads this table to account for
 * every execution a day contains. A gate whose input has never been observed to
 * write can pass by reporting nothing, which is the exact failure the gate
 * exists to prevent (L98, L90).
 *
 * These tests drive the REAL `runExecutionArchive` against a recording Supabase
 * double, so they observe which tables it actually writes and what it puts in
 * them, rather than which functions it calls. Mutation checked: commenting out
 * the `upsertRefusal` call in the disposition loop fails the first test, and
 * dropping the `archive_day` from its payload fails the second.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../../index'

// Mocked so the alert can be OBSERVED. The refusal alert is the user-visible
// half of this fix: during the tenancy outage the ledger and the alert were both
// silent, and a counter nobody can see firing is not an improvement.
vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn().mockResolvedValue(undefined) }))

import { runExecutionArchive, ARCHIVE_STREAM, type ArchiveRow } from '../execution-archive'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import { ARCHIVE_JOB_NAMES } from '../../archive/alerts'
import { notifyExportFailure } from '../export-alerts'

// The hour under test, and a clock two hours past its end so the settle window
// has cleared. Both ends are pinned: a fixture whose meaning is the relationship
// between a stored time and the clock must not be left to real time (L130).
const HOUR_START = '2026-08-22T07:00:00.000Z'
const WATERMARK = '2026-08-22T06:00:00.000Z'
const NOW = new Date('2026-08-22T10:00:00.000Z')

const FOREIGN_WORKFLOW = 'wf-foreign'
const EXECUTION_ID = '0198f0a0-0000-7000-8000-000000000001'

function makeKV(): KVNamespace {
  const store = new Map<string, string>()
  return {
    async get(k: string) { return store.get(k) ?? null },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
  } as unknown as KVNamespace
}

interface Recorded { table: string; rows: unknown[] }

/**
 * Records every table written and every row handed to a write, and answers the
 * archive's reads from a one-execution fixture.
 *
 * `organizationSlug` is the seam: the tenancy check compares against the slug,
 * so handing it anything other than EXPECTED_ORGANIZATION_SLUG produces a real
 * refusal through the real disposition code rather than a simulated one.
 */
function makeDouble(opts: { organizationSlug: string }) {
  const writes: Recorded[] = []
  const execution = {
    id: EXECUTION_ID,
    workflow_id: FOREIGN_WORKFLOW,
    started_at: '2026-08-22T07:30:00.000Z',
    status: 'completed',
    finished_at: '2026-08-22T07:30:04.000Z',
    cost_usd: 0.0001,
  }
  const step = {
    id: 'step-1',
    execution_id: EXECUTION_ID,
    execution_started_at: execution.started_at,
    started_at: '2026-08-22T07:30:01.000Z',
  }

  // The stored watermark, advanced by the archive's own upsert. Held as state
  // rather than answered as a constant: a double that always replies with the
  // starting watermark makes the loop re-archive one hour until it hits the
  // per-run hour cap, so every count is a multiple of nothing meaningful.
  let watermark = WATERMARK

  const client = {
    from(table: string) {
      let counting = false
      const chain: Record<string, unknown> = {
        select(_cols?: unknown, opt?: { count?: string; head?: boolean }) {
          counting = opt?.count !== undefined
          return chain
        },
        upsert(row: unknown) {
          writes.push({ table, rows: Array.isArray(row) ? row : [row] })
          if (table === 'execution_archive_progress' && !Array.isArray(row)) {
            const hour = (row as { watermark_hour?: unknown }).watermark_hour
            if (typeof hour === 'string') watermark = hour
          }
          return chain
        },
        insert(row: unknown) {
          writes.push({ table, rows: Array.isArray(row) ? row : [row] })
          return chain
        },
        eq() { return chain },
        gte() { return chain },
        lt() { return chain },
        gt() { return chain },
        order() { return chain },
        limit() { return chain },
        maybeSingle() { return Promise.resolve(resolve()) },
        single() { return Promise.resolve(resolve()) },
        then(res: (v: unknown) => unknown) { return Promise.resolve(resolve()).then(res) },
      }
      function resolve(): unknown {
        switch (table) {
          case 'workflows':
            return {
              data: [{ id: FOREIGN_WORKFLOW, organizations: { id: 'org-1', slug: opts.organizationSlug } }],
              error: null,
            }
          case 'execution_archive_progress':
            return { data: { watermark_hour: watermark }, error: null }
          case 'workflow_executions':
            return counting ? { count: 1, error: null } : { data: [execution], error: null }
          case 'execution_steps':
            return counting ? { count: 1, error: null } : { data: [step], error: null }
          default:
            // Writes answer with no error. A write that silently failed would
            // make every assertion below pass while nothing landed.
            return { data: null, error: null, count: null }
        }
      }
      return chain
    },
  } as unknown as SupabaseClient

  return { client, writes }
}

function rowsFor(writes: Recorded[], table: string): unknown[] {
  return writes.filter((w) => w.table === table).flatMap((w) => w.rows)
}

async function run(organizationSlug: string) {
  const double = makeDouble({ organizationSlug })
  const sent: ArchiveRow[] = []
  const env = { IDEMPOTENCY: makeKV() } as unknown as Env
  const summary = await runExecutionArchive(env, double.client, {
    sendBatch: async (rows) => { sent.push(...rows) },
    now: () => NOW,
  })
  return { summary, sent, writes: double.writes }
}

beforeEach(() => {
  vi.mocked(notifyExportFailure).mockClear()
})

describe('the archive records a refusal in the database (#957)', () => {
  it('writes the refused execution to execution_archive_refusals', async () => {
    const { summary, writes } = await run('someone-else')

    expect(summary.executionsRefused).toBe(1)
    const refusals = rowsFor(writes, 'execution_archive_refusals') as Record<string, unknown>[]
    expect(refusals).toHaveLength(1)
    expect(refusals[0].execution_id).toBe(EXECUTION_ID)
    // The reason must name the tenancy, not just be non-empty: a refusal row
    // whose reason reads like a different problem is worse than none (L11).
    expect(String(refusals[0].reason)).toMatch(/organization|tenan/i)
    expect(refusals[0].resolved_at).toBeNull()
  })

  it('stamps the refusal with a real archive day, never an empty string', async () => {
    const { writes } = await run('someone-else')
    const refusals = rowsFor(writes, 'execution_archive_refusals') as Record<string, unknown>[]

    // archive_day is DATE NOT NULL. An empty string reaches Postgres as invalid
    // date syntax, which throws inside the run and stalls the watermark on an
    // hour that can never pass, so the fallback shape matters as much as the
    // write happening at all.
    expect(refusals[0].archive_day).toBe('2026-08-22')
  })

  it('does not send a refused execution to the archive or count it as archived', async () => {
    const { summary, sent, writes } = await run('someone-else')

    expect(sent).toEqual([])
    expect(rowsFor(writes, 'execution_archive_ids')).toEqual([])
    expect(summary.executionsArchived).toBe(0)
  })

  it('records no refusal, and archives the row, when the tenancy matches', async () => {
    // The negative control. Without it the three tests above are satisfied by an
    // archiver that refuses EVERYTHING, which is precisely the state #949 fixed.
    const { summary, sent, writes } = await run(EXPECTED_ORGANIZATION_SLUG)

    expect(rowsFor(writes, 'execution_archive_refusals')).toEqual([])
    expect(summary.executionsRefused).toBe(0)
    expect(summary.executionsArchived).toBe(1)
    expect(sent.map((r) => r.executionId)).toEqual([EXECUTION_ID])
    expect(rowsFor(writes, 'execution_archive_ids')).toHaveLength(1)
  })

  it('advances the watermark past the hour it refused', async () => {
    // A permanent per-execution refusal must not hold the watermark, or one row
    // stops all archiving forever with nothing able to clear it. That is the
    // whole reason the refusal ledger exists rather than a retry.
    const { writes } = await run('someone-else')
    const progress = rowsFor(writes, 'execution_archive_progress') as Record<string, unknown>[]

    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0].stream).toBe(ARCHIVE_STREAM)
    expect(progress[0].watermark_hour).toBe(HOUR_START)
  })

  it('raises the refusal alert when everything it read was refused', async () => {
    await run('someone-else')

    const calls = vi.mocked(notifyExportFailure).mock.calls
    const refusal = calls.find((c) => c[1] === ARCHIVE_JOB_NAMES.refusal)
    expect(refusal, 'a run that refused every execution must raise the refusal alert').toBeDefined()
    // The wording has to say nothing was backed up, not just that something was
    // refused: one benign refusal and a total outage arriving on the same path
    // reading identically is how the tenancy failure stayed quiet.
    expect(String((refusal as unknown[])[2])).toMatch(/every one of the 1/)
  })

  it('raises no alert at all on a clean run', async () => {
    // The negative control for the alert. Without it the assertion above is
    // satisfied by an archiver that alerts on every run, which is the other way
    // to make an alert useless.
    await run(EXPECTED_ORGANIZATION_SLUG)

    const named = vi.mocked(notifyExportFailure).mock.calls.map((c) => c[1])
    expect(named).not.toContain(ARCHIVE_JOB_NAMES.refusal)
  })
})
