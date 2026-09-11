/**
 * The run record is closed BEFORE the run lock is released (#1277).
 *
 * This ordering is the reason `execution-archive` was left outside the shared
 * `withJobRun` wrapper, and it is load bearing rather than stylistic. Release
 * the lock first and there is a window where the lock is free while this run's
 * record is still open, so the next invocation starting in that window finds an
 * unfinished record and reports its healthy predecessor as killed (#1034 reads
 * exactly that row). A false accusation is what teaches people to ignore an
 * alert.
 *
 * Asserted as behaviour rather than by reading the source, because what matters
 * is the order the two writes actually reach the outside world, and nesting can
 * be rearranged without any of the words changing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runExecutionArchive, RUN_LOCK_KEY } from '../execution-archive'
import { makeArchiveDouble } from './_archive-double'
import { EXPECTED_ORGANIZATION_SLUG } from '../../archive/disposition'
import type { Env } from '../../index'

vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn(async () => {}) }))

const NOW = new Date('2026-08-23T15:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the order the run ends in', () => {
  it('closes the record, then releases the lock', async () => {
    const order: string[] = []
    const double = makeArchiveDouble({ organizationSlug: EXPECTED_ORGANIZATION_SLUG })

    const store = new Map<string, string>()
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => {
        if (k === RUN_LOCK_KEY) order.push('lock-released')
        store.delete(k)
      },
    }

    const client = double.client as unknown as { from: (t: string) => Record<string, unknown> }
    const realFrom = client.from.bind(client)
    client.from = (table: string) => {
      const builder = realFrom(table)
      if (table !== 'job_runs') return builder
      const realUpdate = builder.update as (row: unknown) => unknown
      return {
        ...builder,
        update: (row: Record<string, unknown>) => {
          // Only the CLOSE, not the progress stamps (#1034), which are updates
          // on the same row and would otherwise answer for it.
          if (row.finished_at !== undefined) order.push('record-closed')
          return realUpdate(row)
        },
      }
    }

    await runExecutionArchive({ IDEMPOTENCY: kv, SSN_HASH_PEPPER: 'test-pepper' } as unknown as Env, double.client, {
      sendBatch: async () => {},
      now: () => NOW,
    })

    expect(order).toEqual(['record-closed', 'lock-released'])
  })
})
