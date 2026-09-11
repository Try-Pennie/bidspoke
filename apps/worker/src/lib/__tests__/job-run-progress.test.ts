/**
 * Keeping the open run record current, so a killed run explains itself (#1034).
 *
 * `startJobRun` opens a row and `finishJobRun` closes it, and a run the platform
 * kills closes nothing, which is exactly how a kill is detected. What that
 * leaves is a row saying a run began and nothing else: out of memory, out of
 * wall time, out of subrequests and a platform blip are indistinguishable in it,
 * and they are different fixes.
 *
 * So the row is kept current while the run proceeds, and the takeover that
 * reclaims a stale lock reads what its predecessor had reached.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { stampJobRunProgress, readLastUnfinishedRun } from '../job-run-record'

interface Update { table: string; values: Record<string, unknown>; id?: string }

function supabaseDouble(opts: { rows?: unknown[]; updateFails?: boolean; selectFails?: boolean } = {}) {
  const updates: Update[] = []
  const client = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            eq(_col: string, id: string) {
              updates.push({ table, values, id })
              return {
                select: async () =>
                  opts.updateFails
                    ? { data: null, error: { message: 'no' } }
                    : { data: [{ id }], error: null },
              }
            },
          }
        },
        select() {
          const chain = {
            eq: () => chain,
            is: () => chain,
            order: () => chain,
            limit: async () =>
              opts.selectFails
                ? { data: null, error: { message: 'no' } }
                : { data: opts.rows ?? [], error: null },
          }
          return chain
        },
      }
    },
  } as unknown as SupabaseClient
  return { client, updates }
}

const progress = {
  hoursArchived: 4,
  hoursEmpty: 1,
  executionsArchived: 12_000,
  executionsRefused: 3,
  detail: 'archived the hour beginning 2026-08-23T13:00:00.000Z',
}

describe('stampJobRunProgress', () => {
  it('writes the progress onto the open row without closing it', async () => {
    const { client, updates } = supabaseDouble()

    await stampJobRunProgress(client, { id: 'run-1' }, progress)

    expect(updates).toHaveLength(1)
    expect(updates[0].id).toBe('run-1')
    expect(updates[0].values.summary).toMatchObject({ hoursArchived: 4, executionsArchived: 12_000 })
    // Closing it here would make every stamped run look finished, and a killed
    // run is told from a finished one by exactly this field being absent.
    expect(updates[0].values).not.toHaveProperty('finished_at')
    expect(updates[0].values).not.toHaveProperty('outcome')
  })

  it('does nothing when the run has no row, rather than inventing one', async () => {
    const { client, updates } = supabaseDouble()

    await stampJobRunProgress(client, { id: null }, progress)

    expect(updates).toEqual([])
  })

  it('never throws, because a stamp must not be able to kill the run it describes', async () => {
    const { client } = supabaseDouble({ updateFails: true })

    await expect(stampJobRunProgress(client, { id: 'run-1' }, progress)).resolves.toBeUndefined()
  })
})

describe('readLastUnfinishedRun', () => {
  it('reports what the predecessor had reached', async () => {
    const { client } = supabaseDouble({
      rows: [{ id: 'run-0', started_at: '2026-08-23T14:00:40.000Z', summary: progress }],
    })

    const found = await readLastUnfinishedRun(client, 'execution-archive')

    expect(found.kind).toBe('found')
    expect(found.kind === 'found' && found.run.summary).toMatchObject({ hoursArchived: 4 })
    expect(found.kind === 'found' && found.run.startedAt).toBe('2026-08-23T14:00:40.000Z')
  })

  it('separates a predecessor that stamped nothing from one that was never there', async () => {
    // Two different facts, and an alert that reported them the same way would
    // say "it reached nothing" about a run that simply died before its first
    // hour AND about a run that does not exist (L11).
    const { client } = supabaseDouble({ rows: [{ id: 'run-0', started_at: 'x', summary: null }] })

    const found = await readLastUnfinishedRun(client, 'execution-archive')

    expect(found.kind).toBe('found')
    expect(found.kind === 'found' && found.run.summary).toBeNull()

    const { client: empty } = supabaseDouble({ rows: [] })
    expect((await readLastUnfinishedRun(empty, 'execution-archive')).kind).toBe('none')
  })

  it('says it could not read, rather than claiming there was no predecessor', async () => {
    // "Nothing was found" and "we could not look" point at different fixes, and
    // only one of them is something the check measured (L11).
    const { client } = supabaseDouble({ selectFails: true })

    const read = await readLastUnfinishedRun(client, 'execution-archive')

    expect(read.kind).toBe('unreadable')
  })
})
