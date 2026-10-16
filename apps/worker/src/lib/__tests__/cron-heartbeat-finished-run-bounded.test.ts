/**
 * The heartbeat check asks job_runs before accusing a job of being dark
 * (lastFinishedRun, #1332). Found by the outage simulation (#2061): on the
 * scheduled client that read waited for the client's full 45 s deadline and its
 * retries, past the 50 s minute deadline, so in a stalled database the heartbeat
 * page, which the #1303 plan counts on to speak from KV, was cut off with its
 * job and never posted. On the scheduled client it now goes through readAside:
 * the tick's 3 s deadline, skipped once the tick has seen the database fail,
 * but its own failure never marks the tick or tells the database owner, since a
 * fault in this one table is not a database outage. A read that does not answer
 * is no evidence, which leaves the verdict standing, as a failed read always
 * did (L98).
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
    const slack = registerScheduledSlack(client, { kv: kvWith(), secretKeys: TEST_KEY, sleep: timers.sleep })
    const errors = vi.mocked(console.error)
    // A Slack read of the tick fails first, which is what marks it.
    await slack.read('slack organizations', client.from('service_connections') as unknown as Parameters<typeof slack.read>[1])
    errors.mockClear()
    await expect(lastFinishedRun(client, 'timeout-audit')).resolves.toBeNull()
    expect(calls).toHaveLength(1)
    // The failure was logged once, when it happened; a skipped read adds nothing per job.
    expect(errors).not.toHaveBeenCalled()
  })

  // Lessons review of #2250: a fault in this one table (a missing table, a
  // revoked grant) is not the database being down, so it must not page the
  // database owner or send the tick's Slack lookups to the saved copy.
  it('does not mark the tick unreachable or tell the owner when job_runs answers with an error', async () => {
    const { client } = fakeClient([{ error: { message: 'relation "job_runs" does not exist', code: '42P01' } }])
    const onUnreachable = vi.fn()
    const slack = registerScheduledSlack(client, { kv: kvWith(), secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep, onUnreachable })
    await expect(lastFinishedRun(client, 'sightings-export')).resolves.toBeNull()
    expect(slack.unreachable).toBeNull()
    expect(onUnreachable).not.toHaveBeenCalled()
  })

  it('does not mark the tick unreachable when job_runs alone stalls', async () => {
    const { client } = fakeClient(['stall'])
    const onUnreachable = vi.fn()
    const slack = registerScheduledSlack(client, { kv: kvWith(), secretKeys: TEST_KEY, sleep: fakeTimers('now').sleep, onUnreachable })
    await lastFinishedRun(client, 'sightings-export')
    expect(slack.unreachable).toBeNull()
    expect(onUnreachable).not.toHaveBeenCalled()
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
