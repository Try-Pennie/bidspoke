/**
 * The copy of the two alerts a timed out write can lead to (#1880): "could not
 * confirm" while the database is silent, and the lost alert once a read back
 * finds the record missing. Read as Slack would render them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendUnconfirmedWritesAlert, sendOutcomeDeadLetterAlert, sendSlowdownSummaryAlert, sendRepeatedSlowdownAlert, type SlackConnection } from '../slack'
import { READ_BACK_MISSING_CODE } from '../db-retry'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.23' }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const conn = { bot_token: 'xoxb-test', default_channel: '#alerts' } as unknown as SlackConnection

async function textOf(): Promise<string> {
  const body = (await slackPostOf(fetchMock.mock.calls[0]))
  return [body.text, ...body.blocks.flatMap((b: { text?: { text: string } }) => b.text?.text ?? '')].join('\n')
}

// Built from char codes, so this file holds none of the characters it bans:
// the em dash, the en dash, and a hyphen standing between spaces.
const BANNED = [String.fromCharCode(8212), String.fromCharCode(8211), ` ${String.fromCharCode(45)} `]

describe('could not confirm alert', () => {
  it('says the records are unconfirmed, never lost, names when and what, and links the runs', async () => {
    const sent = await sendUnconfirmedWritesAlert(conn, {
      count: 3,
      labels: ['execution_finalize', 'lead_sightings.insert', 'lead_sightings.finalize'],
      oldest_at: '2026-10-08T12:20:32Z',
      minutes: 15,
      runs: [{ workflow_id: 'wf-1', workflow_name: 'Engine Bidding Workflow', execution_id: 'ex-1' }],
    }, 'https://app.test')
    expect(sent).toBe(true)
    const text = (await textOf())
    expect(text).toContain('Records could not be confirmed')
    expect(text).toContain('3 records')
    expect(text).toContain('8:20 AM ET')
    expect(text).toContain('run records, lead sightings')
    expect(text).toMatch(/does not mean they were lost/)
    expect(text).not.toMatch(/not auto-recovered|re-derive/i)
    expect(text).toContain('https://app.test/workflows/wf-1?execution=ex-1')
    expect(text).toMatch(/\*Fix:\*/)
    for (const c of BANNED) expect(text).not.toContain(c)
  })

  it('escapes a workflow name so it cannot break the run link or inject markup', async () => {
    await sendUnconfirmedWritesAlert(conn, {
      count: 1,
      labels: ['execution_finalize'],
      oldest_at: '2026-10-08T12:20:32Z',
      minutes: 15,
      runs: [{ workflow_id: 'wf-1', workflow_name: 'A|B <!here> & co', execution_id: 'ex-1' }],
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('|A/B &lt;!here&gt; &amp; co run>')
    expect(text).not.toContain('<!here>')
  })

  it('names at most ten runs and counts the rest', async () => {
    const runs = Array.from({ length: 13 }, (_, i) => ({ workflow_id: 'wf', workflow_name: 'Main Flow', execution_id: `ex-${i}` }))
    await sendUnconfirmedWritesAlert(conn, { count: 13, labels: ['execution_finalize'], oldest_at: '2026-10-08T12:20:32Z', minutes: 15, runs }, 'https://app.test')
    const text = (await textOf())
    expect(text.match(/Main Flow run/g)).toHaveLength(10)
    expect(text).toContain('and 3 more')
  })
})

describe('slowdown summary (#1881)', () => {
  const base = {
    runs: 20,
    workflows: [{ name: 'Engine Bidding Workflow', runs: 12 }, { name: 'RML LendSwift', runs: 5 }, { name: 'Lead Economy', runs: 3 }],
    records: 62,
    from: '2026-10-08T12:20:32Z',
    to: '2026-10-08T12:21:12Z',
  }

  it('escapes workflow names, so a name cannot ping the channel or inject markup', async () => {
    await sendSlowdownSummaryAlert(conn, { ...base, workflows: [{ name: '<!channel> & <x>', runs: 20 }], landed: 62, lost: 0, steps_missing: 0 }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('&lt;!channel&gt; &amp; &lt;x&gt; (20)')
    expect(text).not.toContain('<!channel>')
  })

  it('says when and how many runs on which workflows', async () => {
    await sendSlowdownSummaryAlert(conn, { ...base, landed: 61, lost: 0, steps_missing: 1 }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('Between 8:20 AM and 8:21 AM ET')
    expect(text).toContain('20 runs')
    expect(text).toContain('Engine Bidding Workflow (12), RML LendSwift (5), Lead Economy (3)')
    for (const c of BANNED) expect(text).not.toContain(c)
  })

  it('does not say every record was saved while some are still unconfirmed', async () => {
    await sendSlowdownSummaryAlert(conn, { ...base, records: 61, landed: 61, lost: 0, steps_missing: 0, unconfirmed: 1 }, 'https://app.test')
    const text = (await textOf())
    expect(text).not.toContain('every record saved')
    expect(text).toContain('1 record still could not be read back')
    expect(text).toContain('Records could not be confirmed')
  })

  it('says how many never landed and what to do about them', async () => {
    await sendSlowdownSummaryAlert(conn, {
      ...base,
      landed: 59,
      lost: 2,
      steps_missing: 1,
      lost_runs: [{ workflow_id: 'wf-1', workflow_name: 'Lead Economy', execution_id: 'ex-1', labels: ['execution_finalize', 'lead_sightings.insert'] }],
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('some records not saved')
    expect(text).toContain('59 of 62 landed')
    expect(text).toContain('2 outcome records never did')
    expect(text).toContain('1 run is missing some step records')
    expect(text).toMatch(/\*Fix:\* Re-derive the lost records from the runs below/)
    expect(text).toContain('<https://app.test/workflows/wf-1?execution=ex-1|Lead Economy run> (run records, lead sightings)')
    for (const c of BANNED) expect(text).not.toContain(c)
  })

  // #2292: one line saying a snapshot was taken and where to read it. Never
  // its contents: query text can carry customer data.
  describe('the database snapshot line (#2292)', () => {
    const lost = { ...base, landed: 61, lost: 1, steps_missing: 0 }

    it('says a snapshot was taken and how to read it', async () => {
      await sendSlowdownSummaryAlert(conn, { ...lost, snapshots: { attempts: 1, taken: 1, timed_out: 0, failed: 0, first_at: '2026-10-08T12:20:40Z' } }, 'https://app.test')
      const text = (await textOf())
      expect(text).toContain('A database snapshot was taken during it at 8:20 AM ET.')
      expect(text).toContain('GET /api/admin/db-stall-snapshots')
      expect(text).toContain('kept for 3 days')
      for (const c of BANNED) expect(text).not.toContain(c)
    })

    it('counts several, and says what a timed out one means', async () => {
      await sendSlowdownSummaryAlert(conn, { ...lost, snapshots: { attempts: 3, taken: 1, timed_out: 2, failed: 0, first_at: '2026-10-08T12:20:40Z' } }, 'https://app.test')
      const text = (await textOf())
      expect(text).toContain('Bidspoke took 3 database snapshots during it, the first at 8:20 AM ET: 1 answered, 2 timed out.')
      expect(text).toContain('A snapshot that timed out means the database, or the connection pool in front of it, did not answer a 3 second read either')
    })

    it('says plainly when none was taken, and when it could not look', async () => {
      await sendSlowdownSummaryAlert(conn, { ...lost, snapshots: { attempts: 0, taken: 0, timed_out: 0, failed: 0, first_at: null } }, 'https://app.test')
      expect((await textOf())).toContain('No database snapshot was taken during it.')
      fetchMock.mockClear()
      await sendSlowdownSummaryAlert(conn, { ...lost, snapshots: null }, 'https://app.test')
      expect((await textOf())).toContain('Bidspoke could not look up its database snapshots')
    })

    it('carries no query text, whatever the snapshot held', async () => {
      await sendSlowdownSummaryAlert(conn, { ...lost, snapshots: { attempts: 1, taken: 1, timed_out: 0, failed: 0, first_at: '2026-10-08T12:20:40Z' } }, 'https://app.test')
      expect((await textOf())).not.toMatch(/select|insert|update /i)
    })
  })
})

describe('repeated slowdowns that saved every record (#2165)', () => {
  const slowdowns = [
    { from: '2026-10-15T13:31:10Z', to: '2026-10-15T13:31:10Z', runs: 1, workflows: [{ name: 'RML LendSwift', runs: 1 }] },
    { from: '2026-10-15T17:02:05Z', to: '2026-10-15T17:03:40Z', runs: 3, workflows: [{ name: 'Engine Bidding Workflow', runs: 2 }, { name: '<!here> & co', runs: 1 }] },
    { from: '2026-10-16T01:15:00Z', to: '2026-10-16T01:15:00Z', runs: 2, workflows: [{ name: 'Main Flow', runs: 2 }] },
  ]

  it('says how many, when each was in ET, which workflows, that nothing was lost, and where to look', async () => {
    const sent = await sendRepeatedSlowdownAlert(conn, { slowdowns, window_hours: 24 }, 'https://app.test')
    expect(sent).toBe(true)
    const text = (await textOf())
    expect(text).toContain('Database slowdowns are repeating')
    expect(text).toContain('3 times in the last 24 hours')
    expect(text).toContain('Oct 15 at 9:31 AM ET: 1 run, RML LendSwift (1)')
    expect(text).toContain('Oct 15 from 1:02 PM to 1:03 PM ET: 3 runs, Engine Bidding Workflow (2), &lt;!here&gt; &amp; co (1)')
    expect(text).toContain('Oct 15 at 9:15 PM ET: 2 runs, Main Flow (2)')
    expect(text).toContain('Each time, every record was saved')
    expect(text).toContain('*Fix:* Check the database load on Supabase.')
    expect(text).not.toContain('<!here>')
    expect(text).not.toMatch(/UTC|GMT/)
    for (const c of BANNED) expect(text).not.toContain(c)
  })

  it('names at most ten slowdowns and counts the rest', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...slowdowns[0], from: `2026-10-15T1${i % 10}:00:00Z`, to: `2026-10-15T1${i % 10}:00:00Z` }))
    await sendRepeatedSlowdownAlert(conn, { slowdowns: many, window_hours: 24 }, 'https://app.test')
    const text = (await textOf())
    expect(text.match(/RML LendSwift \(1\)/g)).toHaveLength(10)
    expect(text).toContain('and 2 more')
  })

  it('reports a Slack refusal as not delivered', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) })
    expect(await sendRepeatedSlowdownAlert(conn, { slowdowns, window_hours: 24 }, 'https://app.test')).toBe(false)
  })

  it('says how many database snapshots were taken across them and how to read them (#2292)', async () => {
    await sendRepeatedSlowdownAlert(conn, { slowdowns, window_hours: 24, snapshots: { attempts: 4, taken: 4, timed_out: 0, failed: 0, first_at: '2026-10-15T13:31:12Z' } }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('Bidspoke took 4 database snapshots during them, the first on Oct 15 at 9:31 AM ET: 4 answered.')
    expect(text).toContain('GET /api/admin/db-stall-snapshots')
  })
})

describe('the dead letter count is approximate (#1881)', () => {
  it('says about in the unfinished work alert too, which reads the same count', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'continuation_unfinished',
      window_loss_count: 12,
      window_minutes: 30,
      error_message: "The run's work after the answer did not finish within 12 s of the answer",
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('This happened about 12 times')
    expect(text).not.toMatch(/This happened 12 times/)
  })

  it('says about above one, since KV increments can overwrite each other', async () => {
    await sendOutcomeDeadLetterAlert(conn, { label: 'lead_sightings.insert', window_loss_count: 13, window_minutes: 30, error_message: 'x', error_code: '23502' }, 'https://app.test')
    expect((await textOf())).toContain('About *13* writes were lost')
  })
})

describe('lost alert for a record a read back found missing', () => {
  it('says it timed out and was read back missing, not that the retries ran out', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      // lead_sightings.insert is a genuine loss (no in_flight row for the drain to
      // recover); lead_sightings.finalize now self-heals and is reframed (#1953).
      label: 'lead_sightings.insert',
      window_loss_count: 1,
      window_minutes: 30,
      error_message: 'lead_sightings.insert: the write timed out at 2026-10-08T12:20:32Z and a read back 3 minutes later found the lead sighting row is not there',
      error_code: READ_BACK_MISSING_CODE,
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('Outcome Record Lost')
    expect(text).toMatch(/timed out, and reading it back afterwards found it never landed/)
    expect(text).not.toMatch(/failed after all retries|exhausted its full retry ladder/)
  })

  it('keeps the drain wording for an execution row read back at running, without claiming retries ran out', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'execution_finalize',
      window_loss_count: 1,
      window_minutes: 30,
      error_message: "execution_finalize: the write timed out and a read back found the execution row is still at status 'running'",
      error_code: READ_BACK_MISSING_CODE,
    }, 'https://app.test')
    const text = (await textOf())
    expect(text).toContain('Execution Finalize Delayed')
    expect(text).toMatch(/timed out, and reading it back afterwards found it never landed/)
    expect(text).not.toMatch(/failed after all retries/)
  })
})
