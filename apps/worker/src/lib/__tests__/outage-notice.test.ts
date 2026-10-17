/**
 * The outage line (#2061, decided 2026-10-14): while the database unreachable
 * incident is open, every other alert a scheduled tick posts carries ONE line
 * naming the outage, added in the one shared post path (postMessage), so no
 * sender can leave it out (L621). The database owner's own page and all-clear
 * do not get it. Reading the incident must never block or fail a post.
 *
 * Every timer is injected; nothing here waits for real (L524).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'
import { postMessage, sendDatabaseUnreachableAlert, sendDatabaseRecoveredAlert, sendTitledAlert } from '../slack'
import { runWithOutageNotice, OUTAGE_NOTICE_SIGNAL, OUTAGE_NOTICE_READ_DEADLINE_MS } from '../outage-notice'
import { DB_UNREACHABLE_PREFIX } from '../database-reachability'
import { registerScheduledSlack, type ScheduledSlack } from '../scheduled-slack'
import { encryptSecret } from '../secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY, SLACK_COPY_SAVED_AT_KEY } from '../slack-copy'
import { fakeClient, fakeTimers, TEST_KEY } from './_scheduled-slack-doubles'

const ORG = '55555555-5555-4555-8555-555555555555'
const CONN = { bot_token: 'xoxb-t', default_channel: 'C1', volume_alerts_enabled: true }
const MIN = 60_000
// 9:14 PM EDT on 2026-10-14.
const REPORTED = Date.parse('2026-10-15T01:14:00Z')
const LAST_FAILED = Date.parse('2026-10-15T01:41:00Z')
const NOW = Date.parse('2026-10-15T01:42:00Z')
const SAVED_AT = NOW - 12 * MIN

// The owner's keys spelled out, so a renamed key fails here rather than
// silently reading every incident as closed.
const RECOVERY = `db-unreachable-recovery:${ORG}`
const ACTIVE = `db-unreachable-active:${ORG}`

type Kv = { store: Map<string, string>; reads: string[]; get(k: string): Promise<string | null> }

async function copyBlob(): Promise<string> {
  return encryptSecret(JSON.stringify({ [ORG]: CONN, [SLACK_COPY_SAVED_AT_KEY]: new Date(SAVED_AT).toISOString() }), TEST_KEY)
}

async function kvWith(seed: Record<string, string>, get?: (k: string) => Promise<string | null>): Promise<Kv> {
  const store = new Map(Object.entries({ [SLACK_CONNS_LASTGOOD_KEY]: await copyBlob(), ...seed }))
  const reads: string[] = []
  return {
    store,
    reads,
    get: (k: string) => {
      reads.push(k)
      return get ? get(k) : Promise.resolve(store.get(k) ?? null)
    },
  }
}

const openIncident = () => kvWith({ [RECOVERY]: new Date(REPORTED).toISOString(), [ACTIVE]: new Date(LAST_FAILED).toISOString() })

/** This tick's ScheduledSlack; `fellBack` makes its first read fail, so later lookups use the copy. */
async function tick(kv: Kv, fellBack: boolean): Promise<ScheduledSlack> {
  const timers = fakeTimers('now')
  const slack = registerScheduledSlack({}, { kv, secretKeys: TEST_KEY, sleep: timers.sleep, now: () => NOW })
  if (fellBack) {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    const query = fakeClient(['stall']).client.from('service_connections') as unknown as Parameters<ScheduledSlack['read']>[1]
    await slack.read('slack organizations', query)
  }
  return slack
}

let posted: { blocks: { type: string; elements?: { text: string }[]; text?: { text: string } }[]; text: string }[]
let errors: string[]
beforeEach(() => {
  posted = []
  errors = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...call) => {
    posted.push((await slackPostOf(call)) as unknown as (typeof posted)[number])
    return new Response(JSON.stringify({ ok: true, ts: '1.2' }), { status: 200 })
  })
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const blocks = () => [
  { type: 'header', text: { type: 'plain_text', text: 'A scheduled job has not run' } },
  { type: 'section', text: { type: 'mrkdwn', text: 'The body.' } },
]
const outageLines = (i = 0) => posted[i].blocks.filter((b) => b.type === 'context' && b.elements?.some((e) => /database outage/.test(e.text)))
const lineText = (i = 0) => outageLines(i)[0].elements![0].text

describe('the outage line on scheduled alerts (#2061)', () => {
  it('reads the incident under the owner signal', () => {
    expect(OUTAGE_NOTICE_SIGNAL).toBe(DB_UNREACHABLE_PREFIX)
  })

  it('adds one line, under the title, naming when the outage was reported, when reads last failed, and the saved settings used', async () => {
    const kv = await openIncident()
    const slack = await tick(kv, true)
    await runWithOutageNotice({ kv, scheduled: slack }, () => postMessage('xoxb-t', 'C1', blocks(), 'A scheduled job has not run'))
    expect(outageLines()).toHaveLength(1)
    expect(posted[0].blocks[1].type).toBe('context')
    expect(lineText()).toBe(
      'Sent during the database outage reported at Oct 14, 9:14 PM EDT (database reads last failed at Oct 14, 9:41 PM EDT), so this alert may be a consequence of it. It was posted using Slack settings saved 12 minutes ago.',
    )
    // The rest of the message is the sender's, untouched.
    expect(posted[0].blocks.filter((b) => b.type !== 'context')).toEqual(blocks())
    expect(posted[0].text).toBe('A scheduled job has not run')
  })

  it('says nothing about saved settings when this tick read Slack live', async () => {
    const kv = await openIncident()
    const slack = await tick(kv, false)
    await runWithOutageNotice({ kv, scheduled: slack }, () => postMessage('xoxb-t', 'C1', blocks(), 'x'))
    expect(lineText()).toBe('Sent during the database outage reported at Oct 14, 9:14 PM EDT (database reads last failed at Oct 14, 9:41 PM EDT), so this alert may be a consequence of it.')
  })

  it('leaves out the last failure when it was not recorded', async () => {
    const kv = await kvWith({ [RECOVERY]: new Date(REPORTED).toISOString() })
    const slack = await tick(kv, false)
    await runWithOutageNotice({ kv, scheduled: slack }, () => postMessage('xoxb-t', 'C1', blocks(), 'x'))
    expect(lineText()).toBe('Sent during the database outage reported at Oct 14, 9:14 PM EDT, so this alert may be a consequence of it.')
  })

  it('puts the line first when the message has no title', async () => {
    const kv = await openIncident()
    const slack = await tick(kv, false)
    await runWithOutageNotice({ kv, scheduled: slack }, () => postMessage('xoxb-t', 'C1', [{ type: 'section', text: { type: 'mrkdwn', text: 'b' } }], 'x'))
    expect(posted[0].blocks[0].type).toBe('context')
  })

  it('adds it to an alert sent through a sender, not only a direct post', async () => {
    const kv = await openIncident()
    const slack = await tick(kv, true)
    await runWithOutageNotice({ kv, scheduled: slack }, () => sendTitledAlert(CONN, null, { title: 'A title', errors: ['A finding'] }))
    expect(outageLines()).toHaveLength(1)
  })

  it('adds exactly one line to each post, even when a sender posts the same blocks twice', async () => {
    const kv = await openIncident()
    const slack = await tick(kv, true)
    const shared = blocks()
    await runWithOutageNotice({ kv, scheduled: slack }, async () => {
      await postMessage('xoxb-t', 'C1', shared, 'x')
      await postMessage('xoxb-t', 'C2', shared, 'x')
    })
    expect(outageLines(0)).toHaveLength(1)
    expect(outageLines(1)).toHaveLength(1)
    expect(shared).toEqual(blocks())
  })

  it('adds nothing when no outage is open', async () => {
    const kv = await kvWith({})
    const slack = await tick(kv, false)
    await runWithOutageNotice({ kv, scheduled: slack }, () => postMessage('xoxb-t', 'C1', blocks(), 'x'))
    expect(posted[0].blocks).toEqual(blocks())
  })

  it('leaves a post outside a scheduled tick unchanged and reads nothing for it (the request and engine paths)', async () => {
    const kv = await openIncident()
    await postMessage('xoxb-t', 'C1', blocks(), 'x')
    expect(posted[0].blocks).toEqual(blocks())
    expect(kv.reads).toEqual([])
  })

  it('never adds it to the database owner page or its all-clear', async () => {
    const kv = await openIncident()
    const slack = await tick(kv, true)
    await runWithOutageNotice({ kv, scheduled: slack }, async () => {
      await sendDatabaseUnreachableAlert(CONN, 'C1', { what: 'workflows', error: 'timeout', appUrl: 'https://app', copyAgeMs: 12 * MIN })
      await sendDatabaseRecoveredAlert(CONN, 'C1', { alertedAt: new Date(REPORTED).toISOString(), endedAt: null, measured: 'Measured: x.', appUrl: 'https://app' }, NOW)
    })
    expect(posted).toHaveLength(2)
    expect(outageLines(0)).toEqual([])
    expect(outageLines(1)).toEqual([])
    expect(posted.flatMap((p) => p.blocks).some((b) => b.type === 'context')).toBe(false)
  })

  it('posts without the line, and says why, when the incident cannot be read', async () => {
    const kv = await kvWith({}, (k) => (k === RECOVERY ? Promise.reject(new Error('KV GET failed: 500')) : Promise.resolve(null)))
    // The copy is read through the same KV, so it is read before the failing key.
    kv.store.set(SLACK_CONNS_LASTGOOD_KEY, await copyBlob())
    const working = await kvWith({})
    const slack = await tick(working, false)
    const sent = await runWithOutageNotice({ kv, scheduled: slack }, () => postMessage('xoxb-t', 'C1', blocks(), 'x'))
    expect(sent).toBe('1.2')
    expect(posted[0].blocks).toEqual(blocks())
    expect(errors.some((e) => e.includes('[outage-notice]') && e.includes('KV GET failed: 500') && e.includes('posted without the outage line'))).toBe(true)
  })

  it('posts without the line at its deadline when the incident read never answers, and does not wait again that tick', async () => {
    const kv = await kvWith({}, () => new Promise(() => {}))
    const working = await kvWith({})
    const slack = await tick(working, false)
    const waited: number[] = []
    const delay = (ms: number) => { waited.push(ms); return Promise.resolve() }
    await runWithOutageNotice({ kv, scheduled: slack, delay }, async () => {
      await postMessage('xoxb-t', 'C1', blocks(), 'x')
      await postMessage('xoxb-t', 'C2', blocks(), 'x')
    })
    expect(posted).toHaveLength(2)
    expect(posted.every((p) => !p.blocks.some((b) => b.type === 'context'))).toBe(true)
    expect(waited).toEqual([OUTAGE_NOTICE_READ_DEADLINE_MS])
    expect(errors.filter((e) => e.includes('[outage-notice]') && e.includes(`no answer in ${OUTAGE_NOTICE_READ_DEADLINE_MS} ms`))).toHaveLength(1)
  })

  it('posts without the line, and says why, when there is no saved copy to list organizations from', async () => {
    const kv = await kvWith({ [RECOVERY]: new Date(REPORTED).toISOString() })
    kv.store.delete(SLACK_CONNS_LASTGOOD_KEY)
    const slack = await tick(kv, false)
    await runWithOutageNotice({ kv, scheduled: slack }, async () => {
      await postMessage('xoxb-t', 'C1', blocks(), 'x')
      await postMessage('xoxb-t', 'C2', blocks(), 'x')
    })
    expect(posted.map((p) => p.blocks)).toEqual([blocks(), blocks()])
    // Said once a tick: the tick's copy cannot change under it.
    expect(errors.filter((e) => e.includes('[outage-notice]') && e.includes('no saved Slack copy'))).toHaveLength(1)
  })
})
