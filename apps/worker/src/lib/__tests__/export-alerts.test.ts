/**
 * Export-failure alerting (#412): the nightly Snowflake exports accumulate errors
 * into a returned summary instead of throwing, so a Snowflake outage was only
 * console-logged. notifyExportFailure pages every Slack-connected org when an
 * export reports errors (and no-ops on a clean run). Slack is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({ sendExportFailureAlert: vi.fn() }))

import { notifyExportFailure, EXPORT_ALERT_BACKSTOP_TTL_SECONDS } from '../export-alerts'
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

  it('alerts and sets an 8h cooldown state on the first failure when kv is provided', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', ['Snowflake 503'], kv)
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
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', ['Snowflake 503'], kv)
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
