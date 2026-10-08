/**
 * The copy of the two alerts a timed out write can lead to (#1880): "could not
 * confirm" while the database is silent, and the lost alert once a read back
 * finds the record missing. Read as Slack would render them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendUnconfirmedWritesAlert, sendOutcomeDeadLetterAlert, type SlackConnection } from '../slack'
import { READ_BACK_MISSING_CODE } from '../db-retry'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.23' }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const conn = { bot_token: 'xoxb-test', default_channel: '#alerts' } as unknown as SlackConnection

function textOf(): string {
  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
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
    const text = textOf()
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

  it('names at most ten runs and counts the rest', async () => {
    const runs = Array.from({ length: 13 }, (_, i) => ({ workflow_id: 'wf', workflow_name: 'Main Flow', execution_id: `ex-${i}` }))
    await sendUnconfirmedWritesAlert(conn, { count: 13, labels: ['execution_finalize'], oldest_at: '2026-10-08T12:20:32Z', minutes: 15, runs }, 'https://app.test')
    const text = textOf()
    expect(text.match(/Main Flow run/g)).toHaveLength(10)
    expect(text).toContain('and 3 more')
  })
})

describe('lost alert for a record a read back found missing', () => {
  it('says it timed out and was read back missing, not that the retries ran out', async () => {
    await sendOutcomeDeadLetterAlert(conn, {
      label: 'lead_sightings.finalize',
      window_loss_count: 1,
      window_minutes: 30,
      error_message: 'lead_sightings.finalize: the write timed out at 2026-10-08T12:20:32Z and a read back 3 minutes later found the lead sighting row is not there',
      error_code: READ_BACK_MISSING_CODE,
    }, 'https://app.test')
    const text = textOf()
    expect(text).toContain('Outcome Record Lost')
    expect(text).toMatch(/timed out, and reading it back afterwards found it never landed/)
    expect(text).not.toMatch(/failed after all retries|exhausted its full retry ladder/)
  })
})
