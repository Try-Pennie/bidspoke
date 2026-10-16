/**
 * Where a recovery run's lineage began (#2176): the run every replay and resume
 * in the chain goes back to, and when it started.
 *
 * A credit inquiry post on a recovery run checks for the Inquiries file created
 * since the ORIGINAL run's post began. The recovery run cannot read that step's
 * own start reliably (its step rows are flushed after the walk, can fail to
 * flush, and are archived after 7 days), so it takes the original run's start,
 * which is never later than its post: the window is only ever wider, the side
 * that never posts twice. And it is the ROOT run of the chain, not the run
 * directly replayed: a replay of a replay that skipped would otherwise look only
 * after the first replay began, miss the root's file, and post a second one.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MAX_RECOVERY_LINEAGE, readRecoveryOrigin } from '../recovery-origin'

type Row = { id: string; started_at: string; parent_execution_id: string | null }

/** workflow_executions as a map, recording each id asked for. */
function db(rows: Row[], fail?: { id: string; message: string }) {
  const asked: string[] = []
  const client = {
    from(table: string) {
      if (table !== 'workflow_executions') throw new Error(`unexpected table ${table}`)
      return {
        select(columns: string) {
          if (columns !== 'id, started_at, parent_execution_id') throw new Error(`unexpected columns ${columns}`)
          return {
            eq(col: string, id: string) {
              if (col !== 'id') throw new Error(`unexpected column ${col}`)
              return {
                async maybeSingle() {
                  asked.push(id)
                  if (fail && fail.id === id) return { data: null, error: { message: fail.message } }
                  return { data: rows.find((r) => r.id === id) ?? null, error: null }
                },
              }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
  return { asked, client }
}

const ROOT = { id: 'root', started_at: '2026-10-15T20:00:00.000Z', parent_execution_id: null }
const FIRST = { id: 'first-replay', started_at: '2026-10-15T21:00:00.000Z', parent_execution_id: 'root' }
const SECOND = { id: 'second-replay', started_at: '2026-10-15T22:00:00.000Z', parent_execution_id: 'first-replay' }

describe('readRecoveryOrigin', () => {
  it('the run recovered from, when it is itself an original run: its id and start', async () => {
    const d = db([ROOT])
    expect(await readRecoveryOrigin(d.client, 'root')).toEqual({ executionId: 'root', startedAtMs: Date.parse(ROOT.started_at), lineage: ['root'] })
    expect(d.asked).toEqual(['root'])
  })

  // Every run of the chain is named, nearest first: any of them may be the one
  // whose post the read-back still holds (#2176, Dan, 2026-10-16).
  it('a recovery of a recovery goes back to the root run of the chain, naming every run on the way', async () => {
    const d = db([ROOT, FIRST, SECOND])
    expect(await readRecoveryOrigin(d.client, 'second-replay')).toEqual({
      executionId: 'root',
      startedAtMs: Date.parse(ROOT.started_at),
      lineage: ['second-replay', 'first-replay', 'root'],
    })
    expect(d.asked).toEqual(['second-replay', 'first-replay', 'root'])
  })

  it('a run in the chain no longer kept cannot say how far back the chain goes, so it throws', async () => {
    await expect(readRecoveryOrigin(db([SECOND]).client, 'second-replay')).rejects.toThrow(/first-replay.*no longer kept/)
  })

  it('a read the database refuses throws, naming the run', async () => {
    await expect(readRecoveryOrigin(db([ROOT, FIRST], { id: 'root', message: 'timeout' }).client, 'first-replay')).rejects.toThrow(/root.*timeout/)
  })

  it('a start that is not a time throws rather than guessing a window', async () => {
    await expect(readRecoveryOrigin(db([{ ...ROOT, started_at: 'soon' }]).client, 'root')).rejects.toThrow(/start/)
  })

  it('a chain longer than the bound, or one that loops, throws rather than reading for ever', async () => {
    const loop = db([{ id: 'a', started_at: ROOT.started_at, parent_execution_id: 'b' }, { id: 'b', started_at: ROOT.started_at, parent_execution_id: 'a' }])
    await expect(readRecoveryOrigin(loop.client, 'a')).rejects.toThrow(/lineage/)
    expect(loop.asked.length).toBe(MAX_RECOVERY_LINEAGE)
  })
})
