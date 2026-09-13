import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../slack', () => ({
  sendExportFailureAlert: vi.fn(async () => true),
}))

import { sendExportFailureAlert } from '../slack'
import { notifyExportFailure, type AlertRemedy } from '../export-alerts'
import { BACKOFF_STEPS_SECONDS, readCondition } from '../alert-backoff'

/**
 * The export family repeated a standing failure every eight hours for ever,
 * which is the same flat-cooldown shape that produced three identical archive
 * alerts in twelve hours (#1334). It backs off now, on the same schedule and
 * with the same reset on recovery.
 */
const REMEDY: AlertRemedy = {
  consequence: 'nothing was exported:',
  fixHint: 'check Snowflake.',
  headlineVerb: 'failed',
}
const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const H = 3_600_000
const JOB = 'Sightings export'
// Permanent, so the transient grace does not hold the first alert back.
const ERRORS = ['permission denied for table LEAD_SIGHTINGS']

function fakeKv() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  return {
    store,
    ttls,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, v)
      ttls.set(k, opts?.expirationTtl)
    },
    delete: async (k: string) => { store.delete(k) },
  }
}

const supabase = {
  from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [{ organization_id: 'org-1' }], error: null }) }) }),
} as unknown as SupabaseClient

const KEY = `export-alert:${JOB}`

beforeEach(() => {
  vi.mocked(sendExportFailureAlert).mockClear()
  vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
})

describe('a standing export failure', () => {
  it('holds the second alert for the first interval, then lengthens the gap', async () => {
    const kv = fakeKv()

    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    expect(kv.ttls.get(`${KEY}:cooldown`)).toBe(BACKOFF_STEPS_SECONDS[0])

    // Inside the cooldown: silent.
    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW + H)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)

    // Past it: the reminder goes, and the next gap is the longer one.
    kv.store.delete(`${KEY}:cooldown`)
    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW + 7 * H)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(2)
    expect(kv.ttls.get(`${KEY}:cooldown`)).toBe(BACKOFF_STEPS_SECONDS[1])
  })

  it('tells the reader it is a reminder and how long the failure has stood', async () => {
    const kv = fakeKv()
    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW)
    kv.store.delete(`${KEY}:cooldown`)
    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW + 7 * H)

    const second = vi.mocked(sendExportFailureAlert).mock.calls[1]?.[3] as { repeat?: string }
    expect(second.repeat).toContain('reminder 2')
    expect(second.repeat).toContain('7h')
  })

  it('says nothing about repeats on the first alert', async () => {
    const kv = fakeKv()
    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW)

    const first = vi.mocked(sendExportFailureAlert).mock.calls[0]?.[3] as { repeat?: string }
    expect(first.repeat).toBeUndefined()
  })

  it('forgets the schedule on a clean run, so the next failure pages at once', async () => {
    const kv = fakeKv()
    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW)
    expect(await readCondition(kv, KEY)).not.toBeNull()

    await notifyExportFailure(supabase, JOB, [], kv, REMEDY, NOW + H)
    expect(await readCondition(kv, KEY)).toBeNull()

    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW + 2 * H)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(2)
    expect(kv.ttls.get(`${KEY}:cooldown`)).toBe(BACKOFF_STEPS_SECONDS[0])
  })

  it('does not arm the cooldown when nothing was delivered, so a Slack outage cannot silence it', async () => {
    const kv = fakeKv()
    vi.mocked(sendExportFailureAlert).mockResolvedValue(false)

    await notifyExportFailure(supabase, JOB, ERRORS, kv, REMEDY, NOW)

    expect(kv.store.has(`${KEY}:cooldown`)).toBe(false)
    expect(await readCondition(kv, KEY)).toBeNull()
  })
})
