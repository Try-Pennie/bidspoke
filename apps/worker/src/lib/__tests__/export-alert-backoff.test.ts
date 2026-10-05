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

// Measured in #statuspage (#1768): the Lead status check posted three different
// problems on Oct 3, 4 and 5, and the second and third went out as "(still)",
// "nothing about it has changed", reminders 2 and 3.
describe('a reminder says what it measured about the findings (#1768)', () => {
  const TITLED = { title: "Some sales aren't showing on their Salesforce Lead" }
  const OCT_3 = ['2 Tripoint sales from Sep 25 to Sep 27 are marked Completed on their Submission, but their Lead still says Fail.']
  const OCT_4 = ['1 Tripoint sale from Sep 30 is marked Completed on its Submission, but its Lead still says Fail.']
  const payload = (i: number) => vi.mocked(sendExportFailureAlert).mock.calls[i]?.[3] as { repeat?: string; errors: string[] }

  it('posts identical findings on the next run as a reminder that nothing has changed', async () => {
    const kv = fakeKv()
    await notifyExportFailure(supabase, JOB, OCT_3, kv, TITLED, NOW)
    kv.store.delete(`${KEY}:cooldown`)
    await notifyExportFailure(supabase, JOB, OCT_3, kv, TITLED, NOW + 24 * H)

    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(2)
    expect(payload(1).repeat).toContain('nothing about it has changed: this is reminder 2')
    expect((await readCondition(kv, KEY))?.alerts).toBe(2)
  })

  it('posts different findings at once as a new condition, inside the cooldown, and restarts the schedule', async () => {
    const kv = fakeKv()
    await notifyExportFailure(supabase, JOB, OCT_3, kv, TITLED, NOW)
    expect(kv.store.has(`${KEY}:cooldown`)).toBe(true)

    await notifyExportFailure(supabase, JOB, OCT_4, kv, TITLED, NOW + H)

    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(2)
    expect(payload(1).repeat).toBeUndefined()
    expect(payload(1).errors).toEqual(OCT_4)
    const standing = await readCondition(kv, KEY)
    expect(standing?.alerts).toBe(1)
    expect(standing?.since).toBe(new Date(NOW + H).toISOString())
    expect(kv.ttls.get(`${KEY}:cooldown`)).toBe(BACKOFF_STEPS_SECONDS[0])
  })

  it('posts a condition stored before fingerprints as new once its cooldown has passed, never claiming nothing changed', async () => {
    const kv = fakeKv()
    // What production KV holds as this ships: the old shape, reminder 2 already sent.
    kv.store.set(`${KEY}:condition`, JSON.stringify({ since: new Date(NOW - 48 * H).toISOString(), alerts: 2 }))

    await notifyExportFailure(supabase, JOB, OCT_3, kv, TITLED, NOW)

    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    expect(payload(0).repeat).toBeUndefined()
    const standing = await readCondition(kv, KEY)
    expect(standing).toMatchObject({ alerts: 1, since: new Date(NOW).toISOString() })
    expect(standing?.fingerprint).toBeDefined()
    expect(kv.ttls.get(`${KEY}:cooldown`)).toBe(BACKOFF_STEPS_SECONDS[0])
  })

  it('keeps an old record\'s cooldown, so every standing condition does not post at once on the deploy', async () => {
    const kv = fakeKv()
    kv.store.set(`${KEY}:condition`, JSON.stringify({ since: new Date(NOW - 48 * H).toISOString(), alerts: 2 }))
    kv.store.set(`${KEY}:cooldown`, '1')

    await notifyExportFailure(supabase, JOB, OCT_3, kv, TITLED, NOW)

    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
  })

  it('holds the reminder schedule when a finding clears and nothing new appears', async () => {
    const kv = fakeKv()
    await notifyExportFailure(supabase, JOB, [...OCT_3, ...OCT_4], kv, TITLED, NOW)
    await notifyExportFailure(supabase, JOB, OCT_4, kv, TITLED, NOW + H)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)

    kv.store.delete(`${KEY}:cooldown`)
    await notifyExportFailure(supabase, JOB, OCT_4, kv, TITLED, NOW + 7 * H)
    expect(payload(1).repeat).toContain('same problem as before')
    expect(payload(1).repeat).not.toContain('nothing about it has changed')
  })

  it('reads a finding whose day moves but whose meaning is the same as a reminder, when the caller names the meaning', async () => {
    const kv = fakeKv()
    const zero = (day: string) => [`Salesforce has no Completed Liberty1 sales from ${day}, so there was nothing to compare.`]
    await notifyExportFailure(supabase, JOB, zero('Oct 6'), kv, TITLED, NOW, { keys: ['zero:Liberty1'] })
    kv.store.delete(`${KEY}:cooldown`)
    await notifyExportFailure(supabase, JOB, zero('Oct 7'), kv, TITLED, NOW + 24 * H, { keys: ['zero:Liberty1'] })

    expect(payload(1).repeat).toContain('reminder 2')
    expect(payload(1).repeat).toContain('same problem as before')
    expect(payload(1).repeat).not.toContain('nothing about it has changed')
  })

  it('stays quiet inside the cooldown when a frequent job\'s counts tick, with no keys of its own', async () => {
    // The buyer sale drain runs every minute and its age moves every run: read
    // as new each time, the change would post sixty times an hour.
    const kv = fakeKv()
    await notifyExportFailure(supabase, JOB, ['3 sales waiting, the oldest 61 minutes old.'], kv, TITLED, NOW)
    await notifyExportFailure(supabase, JOB, ['4 sales waiting, the oldest 62 minutes old.'], kv, TITLED, NOW + 60_000)
    await notifyExportFailure(supabase, JOB, ['4 sales waiting, the oldest 63 minutes old.'], kv, TITLED, NOW + 120_000)

    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    kv.store.delete(`${KEY}:cooldown`)
    await notifyExportFailure(supabase, JOB, ['5 sales waiting, the oldest 481 minutes old.'], kv, TITLED, NOW + 7 * H)
    expect(payload(1).repeat).toContain('same problem as before')
  })

  it('falls back to the default meaning, and says so, when a key list does not name every finding', async () => {
    // Throwing here would lose the page, since callers catch and log; the default
    // meaning can only make more runs read as new, never claim nothing changed.
    const kv = fakeKv()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await notifyExportFailure(supabase, JOB, [...OCT_3, ...OCT_4], kv, TITLED, NOW, { keys: ['backlog:Tripoint'] })
      kv.store.delete(`${KEY}:cooldown`)
      await notifyExportFailure(supabase, JOB, OCT_3, kv, TITLED, NOW + 7 * H)

      expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(2)
      expect(error.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/1 meaning keys for 2 findings/)
      // By the default meaning, the second run's one finding was already posted: a reminder.
      expect(payload(1).repeat).toContain('reminder 2')
    } finally {
      error.mockRestore()
    }
  })
})
