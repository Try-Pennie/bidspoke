/**
 * Export-failure alerting (#412): the nightly Snowflake exports accumulate errors
 * into a returned summary instead of throwing, so a Snowflake outage was only
 * console-logged. notifyExportFailure pages every Slack-connected org when an
 * export reports errors (and no-ops on a clean run). Slack is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({ sendExportFailureAlert: vi.fn() }))

import { notifyExportFailure, EXPORT_ALERT_BACKSTOP_TTL_SECONDS, EXPORT_ALERT_PENDING_TTL_SECONDS } from '../export-alerts'
import { sendExportFailureAlert } from '../slack'

function makeSupabase(orgIds: string[]) {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then')
        return (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: orgIds.map((organization_id) => ({ organization_id })), error: null }).then(resolve)
      return () => chain
    },
  })
  return { from: () => chain } as never
}

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get: vi.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
    put: vi.fn((key: string, value: string) => {
      store.set(key, value)
      return Promise.resolve()
    }),
    delete: vi.fn((key: string) => {
      store.delete(key)
      return Promise.resolve()
    }),
  }
}

describe('notifyExportFailure', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does nothing (no Slack lookup) when there are no errors', async () => {
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings export', [])
    expect(from).not.toHaveBeenCalled()
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
  })

  it('alerts each Slack-connected org when an export reports errors', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1', 'org-2']), 'Lead sightings export', ['Snowflake 503'])
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(2)
    const [, orgId, channel, payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(orgId).toBe('org-1')
    expect(channel).toBeNull()
    expect(payload).toMatchObject({ jobName: 'Lead sightings export', errors: ['Snowflake 503'] })
  })

  it('passes a fix hint derived from the actual error class (#542)', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', [
      'sightings export: canceling statement due to statement timeout (57014)',
    ])
    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    // A DB congestion error must not tell the reader to go look at Snowflake.
    expect(payload.fixHint).toBeDefined()
    expect(payload.fixHint).not.toContain('Snowflake availability')
    expect(payload.fixHint?.toLowerCase()).toContain('congestion')
  })

  it('de-duplicates org ids', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1', 'org-1']), 'x', ['boom'])
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('suppresses repeat alerts for the same job while cooldown state is set', async () => {
    const kv = makeKv({ 'export-alert-state:Lead sightings export': '1' })
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings export', ['still broken'], kv)
    expect(from).not.toHaveBeenCalled()
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
  })

  it('alerts and sets an 8h cooldown state on the first PERMANENT failure when kv is provided', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(
      makeSupabase(['org-1']),
      'Lead sightings export',
      ['sightings export: permission denied for table lead_sightings (42501)'],
      kv,
    )
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    expect(kv.put).toHaveBeenCalledWith(
      'export-alert-state:Lead sightings export',
      '1',
      { expirationTtl: EXPORT_ALERT_BACKSTOP_TTL_SECONDS },
    )
  })

  it('does not set cooldown state when the alert failed to deliver', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(false)
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', ['boom nobody recognises'], kv)
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('clears cooldown state on a successful run when kv is provided', async () => {
    const kv = makeKv({ 'export-alert-state:Lead sightings export': '1' })
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings export', [], kv)
    expect(from).not.toHaveBeenCalled()
    expect(kv.delete).toHaveBeenCalledWith('export-alert-state:Lead sightings export')
  })
})

/**
 * Transient-failure grace (2026-07-24): a lone connectivity blip (Cloudflare 522,
 * Snowflake 503, a statement timeout) self-heals on the next scheduled run, because
 * every run automatically re-attempts whatever the failed run left behind. Alerting
 * on the first one is pure noise, so a transient failure is held silently in KV and
 * only pages when the NEXT run fails too. Permanent errors (permissions, schema,
 * auth) and unrecognised errors still page immediately: a retry cannot fix those.
 */
describe('notifyExportFailure transient grace (alert only on two consecutive failed runs)', () => {
  beforeEach(() => vi.clearAllMocks())
  const TRANSIENT = ['sightings purge: error code: 522']
  const PENDING_KEY = 'export-alert-pending:Lead sightings purge'

  it('stays silent on the first transient failure and records a pending marker', async () => {
    const kv = makeKv()
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings purge', TRANSIENT, kv)
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    expect(kv.put).toHaveBeenCalledWith(
      PENDING_KEY,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      { expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS },
    )
  })

  it('alerts on the second consecutive transient failure and says when the failures started', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-07-24T11:48:00.000Z' })
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', TRANSIENT, kv)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload).toMatchObject({ jobName: 'Lead sightings purge', failingSince: '2026-07-24T11:48:00.000Z' })
  })

  it('refreshes the pending marker with the ORIGINAL first-failure time on repeat failures', async () => {
    // During a long outage the marker must not expire mid-outage (that would
    // silently restart the grace period), and the alert's "failing since" must
    // keep pointing at the first failure, not the latest one.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-07-24T11:48:00.000Z' })
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', TRANSIENT, kv)
    expect(kv.put).toHaveBeenCalledWith(
      PENDING_KEY,
      '2026-07-24T11:48:00.000Z',
      { expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS },
    )
  })

  it('clears the pending marker on a successful run, so blip-then-recovery never pages', async () => {
    const kv = makeKv({ [PENDING_KEY]: '2026-07-24T11:48:00.000Z' })
    await notifyExportFailure({ from: vi.fn() } as never, 'Lead sightings purge', [], kv)
    expect(kv.delete).toHaveBeenCalledWith(PENDING_KEY)
  })

  it('alerts immediately on a permanent error even with no pending marker', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(
      makeSupabase(['org-1']),
      'Lead sightings purge',
      ['sightings purge: permission denied for table lead_sightings (42501)'],
      kv,
    )
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('alerts immediately when a transient error is mixed with a permanent one', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(
      makeSupabase(['org-1']),
      'Lead sightings purge',
      ['sightings purge: error code: 522', 'sightings purge: permission denied for table lead_sightings (42501)'],
      kv,
    )
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('alerts immediately on an unrecognised error (fail loud when we cannot tell)', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', ['something nobody has seen'], kv)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('alerts immediately when no KV is available (no store to hold the grace state)', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', TRANSIENT)
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('stays quiet during the post-alert cooldown but keeps the pending marker fresh', async () => {
    const kv = makeKv({
      [PENDING_KEY]: '2026-07-24T11:48:00.000Z',
      'export-alert-state:Lead sightings purge': '1',
    })
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings purge', TRANSIENT, kv)
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
    expect(kv.put).toHaveBeenCalledWith(
      PENDING_KEY,
      '2026-07-24T11:48:00.000Z',
      { expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS },
    )
  })
})

describe('the consequence sentence travels with the classification (#1180)', () => {
  beforeEach(() => vi.clearAllMocks())

  const KILLED =
    'the previous run has held the lock for 60 minutes, past its own deadline and the 5 minute grace, ' +
    'so it was killed rather than still working. This run is proceeding; the work its predecessor did not finish is simply unarchived.'

  it('hands the killed-run consequence and hint to the alert', async () => {
    // Derived once, next to the hint, from the same classification. Left to the
    // alert renderer, the sentence is chosen by job name alone and says rows were
    // not exported for a job that exports nothing.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'execution-archive-killed', [KILLED])

    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.consequence).toBeDefined()
    expect(payload.consequence).not.toContain('not exported')
    expect(payload.fixHint).not.toContain('Snowflake availability')
  })

  it('hands no consequence for an ordinary export failure, so the renderer keeps its default', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', ['Snowflake 401: JWT token is invalid'])

    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.consequence).toBeUndefined()
  })
})
