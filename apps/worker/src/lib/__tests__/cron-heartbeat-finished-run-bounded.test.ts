/**
 * The heartbeat check asks job_runs before accusing a job of being dark
 * (lastFinishedRun, #1332). Found by the outage simulation (#2061): on the
 * scheduled client that read waited for the client's full 45 s deadline and its
 * retries, past the 50 s minute deadline, so in a stalled database the heartbeat
 * page, which the #1303 plan counts on to speak from KV, was cut off with its
 * job and never posted. On the scheduled client it is now one bounded read
 * through the tick's budget; a read that does not answer is no evidence, which
 * leaves the verdict standing, as a failed read always did (L98).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { lastFinishedRun } from '../cron-heartbeat'
import { registerScheduledSlack, SCHEDULED_SLACK_READ_DEADLINE_MS } from '../scheduled-slack'
import { fakeClient, fakeTimers, kvWith, TEST_KEY } from './_scheduled-slack-doubles'

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('lastFinishedRun on the scheduled client', () => {
  it('gives up a stalled read at the scheduled deadline and leaves the verdict standing', async () => {
    const { client, calls } = fakeClient(['stall'])
    const timers = fakeTimers('now')
    registerScheduledSlack(client, { kv: kvWith(), secretKeys: TEST_KEY, sleep: timers.sleep })
    await expect(lastFinishedRun(client, 'sightings-export')).resolves.toBeNull()
    expect(timers.asked).toEqual([SCHEDULED_SLACK_READ_DEADLINE_MS])
    expect(calls).toEqual([{ table: 'job_runs', aborted: true, retry: false }])
  })

  it('does not ask at all once this tick has seen the database fail', async () => {
    const { client, calls } = fakeClient(['stall', { data: [{ finished_at: '2026-10-15T00:00:00Z' }] }])
    const timers = fakeTimers('now')
    registerScheduledSlack(client, { kv: kvWith(), secretKeys: TEST_KEY, sleep: timers.sleep })
    await lastFinishedRun(client, 'sightings-export')
    await expect(lastFinishedRun(client, 'timeout-audit')).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('still reads the finish when the database answers', async () => {
    const { client } = fakeClient([{ data: [{ finished_at: '2026-10-15T00:00:00Z' }] }])
    registerScheduledSlack(client, { kv: kvWith(), secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    await expect(lastFinishedRun(client, 'sightings-export')).resolves.toBe('2026-10-15T00:00:00Z')
  })

  it('reads as before on any other client', async () => {
    const { client, calls } = fakeClient([{ data: [{ finished_at: '2026-10-15T00:00:00Z' }] }])
    await expect(lastFinishedRun(client, 'sightings-export')).resolves.toBe('2026-10-15T00:00:00Z')
    expect(calls).toEqual([{ table: 'job_runs', aborted: false, retry: undefined }])
  })
})
