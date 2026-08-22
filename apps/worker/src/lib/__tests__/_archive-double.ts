/**
 * The shared archive test double (#957, #927).
 *
 * Extracted so both the refusal suite and the ssn-hash suite drive the REAL
 * `runExecutionArchive` against one recording client rather than each keeping
 * its own copy. Two copies of a double drift, and the one that drifts is
 * whichever suite is not being edited that day.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

// The hour under test, and a clock two hours past its end so the settle window
// has cleared. Both ends are pinned: a fixture whose meaning is the relationship
// between a stored time and the clock must not be left to real time (L130).
export const HOUR_START = '2026-08-22T07:00:00.000Z'
export const WATERMARK = '2026-08-22T06:00:00.000Z'
export const NOW = new Date('2026-08-22T10:00:00.000Z')

export const FOREIGN_WORKFLOW = 'wf-foreign'
export const EXECUTION_ID = '0198f0a0-0000-7000-8000-000000000001'

export function makeKV(): KVNamespace {
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
export function makeArchiveDouble(opts: { organizationSlug: string; triggerPayload?: unknown }) {
  const writes: Recorded[] = []
  const execution = {
    id: EXECUTION_ID,
    workflow_id: FOREIGN_WORKFLOW,
    started_at: '2026-08-22T07:30:00.000Z',
    status: 'completed',
    finished_at: '2026-08-22T07:30:04.000Z',
    cost_usd: 0.0001,
    // Undefined rather than null when the caller says nothing, so a suite that
    // does not care about the payload is not silently asserting it is absent.
    trigger_payload: opts.triggerPayload ?? null,
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
      let inValues: string[] | null = null
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
        // Honoured rather than ignored: the slice reader asks for a slice's
        // steps BY NAME, and a double that returned every step regardless would
        // hide a reader that named the wrong ids.
        in(_col: string, values: string[]) { inValues = values; return chain },
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
          case 'execution_steps': {
            if (counting) return { count: 1, error: null }
            const wanted = inValues
            const mine = wanted === null || wanted.includes(EXECUTION_ID) ? [step] : []
            return { data: mine, error: null }
          }
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

export function rowsFor(writes: Recorded[], table: string): unknown[] {
  return writes.filter((w) => w.table === table).flatMap((w) => w.rows)
}

