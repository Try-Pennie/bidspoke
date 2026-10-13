/**
 * Listing the alerts that are currently suppressed, and when they return (#1047).
 *
 * The export alerter keeps a condition quiet while its `:cooldown` key is set,
 * so a standing condition and a hand-set mute both read from the channel as
 * silence. listMutedAlerts is the read that makes that silence legible: it must
 * name the muted job, say when the suppression lifts, and never read a KV
 * failure as "nothing is muted" (L98), which is the exact lie the feature
 * exists to prevent.
 */
import { describe, it, expect } from 'vitest'
import { listMutedAlerts, EXPORT_ALERT_PREFIX } from '../muted-alerts'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const nowSeconds = Math.floor(NOW / 1000)

/** A KV double that keeps per-key expiry and hands it back from list, as Workers KV does. */
function kvDouble(opts: { failList?: boolean } = {}) {
  const store = new Map<string, { value: string; expiration?: number }>()
  return {
    store,
    set(name: string, value: string, expiration?: number) {
      store.set(name, { value, expiration })
    },
    async get(key: string) {
      return store.get(key)?.value ?? null
    },
    async put() {},
    async delete() {},
    async list(o: { prefix: string; cursor?: string }) {
      if (opts.failList) throw new Error('KV list failed: 500 Internal Server Error')
      const keys = [...store.entries()]
        .filter(([k]) => k.startsWith(o.prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, e]) => ({ name, expiration: e.expiration }))
      return { keys, list_complete: true as const, cursor: undefined, cacheStatus: null }
    },
  }
}

function mute(kv: ReturnType<typeof kvDouble>, job: string, opts: { expiresInSeconds?: number | null; since?: string; alerts?: number } = {}) {
  const family = `${EXPORT_ALERT_PREFIX}${job}`
  const expiration = opts.expiresInSeconds === null ? undefined : nowSeconds + (opts.expiresInSeconds ?? 8 * 3600)
  kv.set(`${family}:cooldown`, '1', expiration)
  if (opts.since) kv.set(`${family}:condition`, JSON.stringify({ since: opts.since, alerts: opts.alerts ?? 1 }), nowSeconds + 30 * 24 * 3600)
}

describe('listMutedAlerts', () => {
  it('reports a muted job with its return time and how long the condition has stood', async () => {
    const kv = kvDouble()
    mute(kv, 'Archive ingest', { expiresInSeconds: 3600, since: '2026-10-13T06:00:00Z', alerts: 3 })

    const muted = await listMutedAlerts(kv, NOW)
    expect(muted).toHaveLength(1)
    expect(muted[0]).toEqual({
      familyKey: 'export-alert:Archive ingest',
      jobName: 'Archive ingest',
      returnsAt: new Date((nowSeconds + 3600) * 1000).toISOString(),
      secondsRemaining: 3600,
      standingSince: '2026-10-13T06:00:00Z',
      reminders: 3,
    })
  })

  it('ignores the paired :condition record and unrelated keys: only a :cooldown is a mute', async () => {
    const kv = kvDouble()
    mute(kv, 'Archive lag', { since: '2026-10-13T11:00:00Z' })
    // A pending-grace marker shares the export-alert stem but not the family prefix.
    kv.set('export-alert-pending:Archive lag', '2026-10-13T11:00:00Z')

    const muted = await listMutedAlerts(kv, NOW)
    expect(muted.map((m) => m.jobName)).toEqual(['Archive lag'])
  })

  it('lists a hand-set mute that has no condition record, with null standing fields', async () => {
    const kv = kvDouble()
    kv.set('export-alert:Archive backlog:cooldown', '1', nowSeconds + 10 * 24 * 3600)

    const muted = await listMutedAlerts(kv, NOW)
    expect(muted).toHaveLength(1)
    expect(muted[0].jobName).toBe('Archive backlog')
    expect(muted[0].standingSince).toBeNull()
    expect(muted[0].reminders).toBeNull()
    expect(muted[0].secondsRemaining).toBe(10 * 24 * 3600)
  })

  it('reports a mute with no expiry as never returning on its own, and leads with it', async () => {
    const kv = kvDouble()
    mute(kv, 'Archive refusal', { expiresInSeconds: 3600 })
    kv.set('export-alert:Archive standstill:cooldown', '1') // no expiration = silent forever

    const muted = await listMutedAlerts(kv, NOW)
    expect(muted.map((m) => m.jobName)).toEqual(['Archive standstill', 'Archive refusal'])
    const standstill = muted[0]
    expect(standstill.returnsAt).toBeNull()
    expect(standstill.secondsRemaining).toBeNull()
  })

  it('orders by soonest return when every mute has an expiry', async () => {
    const kv = kvDouble()
    mute(kv, 'Later', { expiresInSeconds: 20000 })
    mute(kv, 'Soonest', { expiresInSeconds: 60 })
    mute(kv, 'Middle', { expiresInSeconds: 5000 })

    const muted = await listMutedAlerts(kv, NOW)
    expect(muted.map((m) => m.jobName)).toEqual(['Soonest', 'Middle', 'Later'])
  })

  it('returns every muted alert when there are more than one read batch, in return order', async () => {
    const kv = kvDouble()
    // 25 > the condition-read batch size, so this exercises more than one batch.
    for (let i = 0; i < 25; i++) mute(kv, `Job ${String(i).padStart(2, '0')}`, { expiresInSeconds: (i + 1) * 60, since: '2026-10-13T11:00:00Z' })

    const muted = await listMutedAlerts(kv, NOW)
    expect(muted).toHaveLength(25)
    // Soonest return first, and every condition record was read.
    expect(muted[0].jobName).toBe('Job 00')
    expect(muted[24].jobName).toBe('Job 24')
    expect(muted.every((m) => m.standingSince === '2026-10-13T11:00:00Z')).toBe(true)
  })

  it('does not read a KV list failure as an empty, healthy set: it throws (L98)', async () => {
    const kv = kvDouble({ failList: true })
    kv.set('export-alert:Archive gate:cooldown', '1', nowSeconds + 3600)
    await expect(listMutedAlerts(kv, NOW)).rejects.toThrow(/KV list failed/)
  })
})
