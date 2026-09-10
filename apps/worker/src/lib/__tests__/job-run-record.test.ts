/**
 * A durable record that a run started, and whether it came back (#960).
 *
 * The only way to tell a KILLED archive run from a run that had nothing to do
 * was the presence of its KV lock, and that self-expires. A run that dies leaves
 * the watermark, `execution_archive_ids` and `execution_archive_refusals` all
 * untouched, which is exactly what an hour with no work looks like. On
 * 2026-08-21 the window in which the distinction was observable at all was hit
 * once and missed twice, purely on timing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { startJobRun, finishJobRun, withJobRun } from '../job-run-record'

interface Recorded { table: string; op: string; row: Record<string, unknown> }

function supabaseDouble(
  opts: {
    insertError?: unknown
    updateError?: unknown
    id?: string | null
    rowsTouched?: Array<Record<string, unknown>>
  } = {},
) {
  const writes: Recorded[] = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {
        insert(row: Record<string, unknown>) {
          writes.push({ table, op: 'insert', row })
          return chain
        },
        update(row: Record<string, unknown>) {
          writes.push({ table, op: 'update', row })
          return chain
        },
        eq(_col: string, value: string) {
          const last = writes[writes.length - 1]
          if (last) last.row = { ...last.row, __id: value }
          return chain
        },
        select() { return chain },
        single() {
          return Promise.resolve({
            data: opts.id === undefined ? { id: 'run-1' } : { id: opts.id },
            error: opts.insertError ?? null,
          })
        },
        // The close reads back the row it touched: supabase-js reports error
        // null on an UPDATE that matched nothing, so a double that answered with
        // no rows and no error would let a silent miss pass (#583).
        then(res: (v: unknown) => unknown) {
          return Promise.resolve({
            data: opts.rowsTouched ?? [{ id: 'run-1' }],
            error: opts.updateError ?? null,
          }).then(res)
        },
      }
      return chain
    },
  } as unknown as SupabaseClient
  return { client, writes }
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('startJobRun', () => {
  it('records the start and hands back the row to close', async () => {
    const db = supabaseDouble()

    const handle = await startJobRun(db.client, 'execution-archive')

    expect(handle.id).toBe('run-1')
    expect(db.writes[0].table).toBe('job_runs')
    expect(db.writes[0].row.job).toBe('execution-archive')
    expect(typeof db.writes[0].row.started_at).toBe('string')
  })

  it('does not throw when the record cannot be written', async () => {
    // A bookkeeping row must not be able to stop the work it describes: failing
    // the archive because we could not write "the archive started" would turn an
    // observability gap into an outage.
    const db = supabaseDouble({ insertError: { message: 'postgrest said no' } })

    const handle = await startJobRun(db.client, 'execution-archive')

    expect(handle.id).toBeNull()
  })

  it('says so loudly when it could not record the start', async () => {
    // With no row, the run will read as killed. That is the safe direction to be
    // wrong in, and it still has to be visible that the reason is a failed write
    // rather than a killed run.
    const db = supabaseDouble({ insertError: { message: 'postgrest said no' } })

    await startJobRun(db.client, 'execution-archive')

    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/will look killed/)
  })
})

describe('finishJobRun', () => {
  it('stamps the ending against the row it opened', async () => {
    const db = supabaseDouble()
    const handle = await startJobRun(db.client, 'execution-archive')

    await finishJobRun(db.client, handle, { outcome: 'caught-up', detail: 'nothing to do', summary: { hours: 0 } })

    const update = db.writes.find((w) => w.op === 'update')
    expect(update?.row.__id).toBe('run-1')
    expect(update?.row.outcome).toBe('caught-up')
    expect(update?.row.detail).toBe('nothing to do')
    expect(update?.row.summary).toEqual({ hours: 0 })
    expect(typeof update?.row.finished_at).toBe('string')
  })

  it('writes nothing when there was no row to close', async () => {
    // Not an error, and not a fabricated row either: an update against no id
    // would either fail or, worse, match everything.
    const db = supabaseDouble({ id: null })
    const handle = await startJobRun(db.client, 'execution-archive')

    await finishJobRun(db.client, handle, { outcome: 'caught-up' })

    expect(db.writes.filter((w) => w.op === 'update')).toEqual([])
  })

  it('says so when the close matched no row, rather than reporting a clean end', async () => {
    // supabase-js reports error null on an UPDATE that matched nothing, so
    // without a rowcount check the run would look closed while the row stayed
    // open forever, which is the one thing this record exists to make
    // unambiguous (#583).
    const db = supabaseDouble({ rowsTouched: [] })
    const handle = await startJobRun(db.client, 'execution-archive')

    await finishJobRun(db.client, handle, { outcome: 'caught-up' })

    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).toMatch(/could not close run/)
  })

  it('does not throw when the close fails', async () => {
    // It is called from a finally, so throwing would replace the error already
    // unwinding with one about bookkeeping.
    const db = supabaseDouble({ updateError: { message: 'gone' } })
    const handle = await startJobRun(db.client, 'execution-archive')

    await expect(finishJobRun(db.client, handle, { outcome: 'caught-up' })).resolves.toBeUndefined()
  })
})

/**
 * One wrapper for "open a run record, do the work, always close it" (#1251).
 *
 * Four archive jobs need the same three steps in the same order, and the
 * ordering is load bearing: the ending must be written in a `finally`, or a run
 * that THREW becomes indistinguishable from one the platform killed, which is
 * the single distinction this record exists to make. Written out at each site
 * that is four chances to get the `finally` wrong, and the one that gets it
 * wrong is silent (L613).
 */
describe('withJobRun', () => {
  it('records the start, runs the work, and closes with the ending the caller derived', async () => {
    const { client, writes } = supabaseDouble()

    const result = await withJobRun(client, 'a-job', async () => 'the answer', (value) => ({
      outcome: 'ok',
      summary: { value },
    }))

    expect(result).toBe('the answer')
    expect(writes.find((w) => w.op === 'insert')?.row).toMatchObject({ job: 'a-job' })
    const close = writes.find((w) => w.op === 'update')
    expect(close?.row).toMatchObject({ outcome: 'ok', summary: { value: 'the answer' } })
  })

  it('closes with an ending that says it threw, and lets the error through', async () => {
    const { client, writes } = supabaseDouble()

    await expect(
      withJobRun(client, 'a-job', async () => { throw new Error('the work failed') }, () => ({ outcome: 'ok' }))
    ).rejects.toThrow('the work failed')

    // The row is CLOSED, saying it threw. A run with NO ending means the
    // platform killed it, and conflating the two destroys the distinction this
    // record exists for.
    const close = writes.find((w) => w.op === 'update')
    expect(close?.row).toMatchObject({ outcome: 'threw' })
  })

  it('does not let a failure to derive the ending swallow the work\'s own error', async () => {
    const { client } = supabaseDouble()

    await expect(
      withJobRun(
        client,
        'a-job',
        async () => { throw new Error('the work failed') },
        () => { throw new Error('the summary blew up') },
      )
    ).rejects.toThrow('the work failed')
  })

  it('does not fail the work when the record cannot be opened', async () => {
    const { client } = supabaseDouble({ id: null })

    // A bookkeeping row must never be able to stop the job it describes.
    const result = await withJobRun(client, 'a-job', async () => 'done', () => ({ outcome: 'ok' }))
    expect(result).toBe('done')
  })
})
