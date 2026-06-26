/**
 * Export-failure alerting (#412): the nightly Snowflake exports accumulate errors
 * into a returned summary instead of throwing, so a Snowflake outage was only
 * console-logged. notifyExportFailure pages every Slack-connected org when an
 * export reports errors (and no-ops on a clean run). Slack is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({ sendExportFailureAlert: vi.fn() }))

import { notifyExportFailure } from '../export-alerts'
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

  it('de-duplicates org ids', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1', 'org-1']), 'x', ['boom'])
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })
})
