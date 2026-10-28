import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubFetch, type FetchMock } from '../../__tests__/helpers/fetch-mock'
import { postMessage, sendHttpMoneyHostAlert, sendThreadReply, type HttpMoneyHostAlert } from '../slack'
import {
  ALERT_KIND_MAX,
  ALERT_KIND_PATTERN,
  alertTitleOf,
  redactAlertTitle,
  SLACK_ALERT_KINDS,
  SLACK_POST_OUTCOME_PREFIX,
  THREAD_REPLY_TITLE,
  type SlackPostOutcomeLine,
} from '../slack-post-outcome'
import { slackPostsIn } from '../../../../worker-tail/src/slack-posts'
import { alertRowsAnswer } from '../../__tests__/helpers/slack-alert-read'
import { sealedSlackRow, withSlackKeyRing } from '../../__tests__/helpers/sealed-slack-row'

/**
 * Every Slack post says how it went, in one structured line (#2364).
 *
 * From 2026-10-23 to 26 about 3,400 alert posts were refused with
 * not_in_channel and nothing paged, because a refusal reached only a free text
 * log line that nothing reads. deliverMessage and sendThreadReply, the only two
 * places the Worker posts to Slack, now each write ONE line per post through
 * the same logger: the outcome, the reason or HTTP status, the channel, any
 * Retry-After, a fresh post id and the alert's title (never its body, never
 * the token). The tail Worker copies those lines into slack_post_outcomes,
 * which the minute check reads. Writing the line adds no I/O and no await, and
 * changes neither what either function returns nor whether it throws.
 */

const TOKEN = 'canary-bot-token-2364'
const BODY_SECRET = 'applicant Jane Roe 123-45-6789'

function slackResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const blocks = [
  { type: 'header', text: { type: 'plain_text', text: 'Workflow Execution Failed', emoji: false } },
  { type: 'section', text: { type: 'mrkdwn', text: `*Error:* ${BODY_SECRET}` } },
]

let fetchMock: FetchMock
let logged: string[]
let everyLine: string[]

beforeEach(() => {
  fetchMock = stubFetch()
  logged = []
  everyLine = []
  const capture = (sink: string[]) => (...args: unknown[]) => {
    const line = args.map(String).join(' ')
    sink.push(line)
    everyLine.push(line)
  }
  vi.spyOn(console, 'log').mockImplementation(capture(logged))
  vi.spyOn(console, 'error').mockImplementation(capture([]))
  vi.spyOn(console, 'warn').mockImplementation(capture([]))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const outcomeLines = (): SlackPostOutcomeLine[] =>
  logged.filter((l) => l.startsWith(SLACK_POST_OUTCOME_PREFIX)).map((l) => JSON.parse(l.slice(SLACK_POST_OUTCOME_PREFIX.length)) as SlackPostOutcomeLine)

describe('deliverMessage logs one outcome line per post', () => {
  it('a delivered post: outcome delivered, the channel, the title, a fresh post id, and the ts returned as before', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '171.99' }))
    expect(await postMessage(TOKEN, 'C0STATUS', blocks, 'fallback with the body')).toBe('171.99')
    const lines = outcomeLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({
      post_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      outcome: 'delivered',
      reason: null,
      status: 200,
      kind: null,
      channel: 'C0STATUS',
      retry_after: null,
      title: 'Workflow Execution Failed',
      alert_kind: null,
    })
  })

  it('two posts get two different post ids', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.1' }))
    await postMessage(TOKEN, 'C0STATUS', blocks, 'x')
    await postMessage(TOKEN, 'C0STATUS', blocks, 'x')
    const ids = outcomeLines().map((l) => l.post_id)
    expect(new Set(ids).size).toBe(2)
  })

  it('ok:false not_in_channel: refused, a destination refusal, null returned as before', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'not_in_channel' }))
    expect(await postMessage(TOKEN, 'C0STATUS', blocks, 'x')).toBeNull()
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'not_in_channel', status: 200, kind: 'destination', channel: 'C0STATUS', retry_after: null, title: 'Workflow Execution Failed' })])
  })

  it('a 429 with Retry-After: refused, transient, the status and the Retry-After, null returned', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'ratelimited' }, 429, { 'Retry-After': '30' }))
    expect(await postMessage(TOKEN, 'C0STATUS', blocks, 'x')).toBeNull()
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'refused', reason: null, status: 429, kind: 'transient', retry_after: '30' })])
  })

  it('a 503: refused, transient, the status, null returned', async () => {
    fetchMock.mockImplementation(async () => new Response('down', { status: 503 }))
    expect(await postMessage(TOKEN, 'C0STATUS', blocks, 'x')).toBeNull()
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'refused', reason: null, status: 503, kind: 'transient', retry_after: null })])
  })

  it('no answer (a network failure): logged as no_answer BEFORE the same error is rethrown', async () => {
    const down = new TypeError('fetch failed')
    fetchMock.mockImplementation(() => Promise.reject(down))
    await expect(postMessage(TOKEN, 'C0STATUS', blocks, 'x')).rejects.toBe(down)
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'no_answer', reason: null, status: null, kind: 'transient', channel: 'C0STATUS' })])
  })

  it('a 200 that is not JSON: logged as no_answer, and still throws the SyntaxError', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>edge</html>', { status: 200 }))
    await expect(postMessage(TOKEN, 'C0STATUS', blocks, 'x')).rejects.toBeInstanceOf(SyntaxError)
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'no_answer' })])
  })

  it('ok:false with no error code is refused with no reason, so it is judged as an unknown, temporary refusal', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false }))
    expect(await postMessage(TOKEN, 'C0STATUS', blocks, 'x')).toBeNull()
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'refused', reason: null, status: 200, kind: 'transient' })])
  })

  it('never writes the token, the body or the fallback text into any line', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_auth' }))
    await postMessage(TOKEN, 'C0STATUS', blocks, `fallback ${BODY_SECRET}`)
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    await postMessage(TOKEN, 'C0STATUS', blocks, `fallback ${BODY_SECRET}`).catch(() => undefined)
    const all = everyLine.join('\n')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain('Jane Roe')
    expect(all).not.toContain('123-45-6789')
  })

  it('a message with no header block has no title', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.1' }))
    await postMessage(TOKEN, 'C0STATUS', [{ type: 'section', text: { type: 'mrkdwn', text: BODY_SECRET } }], 'x')
    expect(outcomeLines()[0].title).toBeNull()
  })

  it('the line it writes is the line the tail Worker copies (the real line, through the real parser)', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'not_in_channel' }))
    await postMessage(TOKEN, 'C0STATUS', blocks, 'x')
    const line = logged.find((l) => l.startsWith(SLACK_POST_OUTCOME_PREFIX))!
    const trace = { scriptName: 'bidspoke-worker', logs: [{ timestamp: Date.parse('2026-10-23T03:00:00Z'), level: 'log', message: [line] }] } as unknown as TraceItem
    expect(slackPostsIn(trace)).toEqual([{
      post_id: outcomeLines()[0].post_id,
      occurred_at: '2026-10-23T03:00:00.000Z',
      channel: 'C0STATUS',
      outcome: 'refused',
      reason: 'not_in_channel',
      kind: 'destination',
      status: 200,
      title: 'Workflow Execution Failed',
      alert_kind: null,
    }])
  })
})

/**
 * Every alert carries a fixed kind name (#2948). The title is read from the
 * header block, and some alerts have none (the HTTP money host page lost its
 * title at Dan's request, #2761), while others build their title from a value,
 * so neither tells one alert kind apart from another. The kind is a name from
 * one fixed list, recorded on the outcome line whether or not a title is shown,
 * and copied by the tail Worker into slack_post_outcomes.alert_kind.
 */
describe('an alert kind is logged with every post that names one', () => {
  const untitled = [{ type: 'section', text: { type: 'mrkdwn', text: BODY_SECRET } }]

  it('an untitled alert still logs its kind, delivered or refused', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.1' }))
    await postMessage(TOKEN, 'C0STATUS', untitled, 'x', 'http-money-host')
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_blocks' }))
    await postMessage(TOKEN, 'C0STATUS', untitled, 'x', 'http-money-host')
    expect(outcomeLines().map((l) => [l.outcome, l.title, l.alert_kind])).toEqual([
      ['delivered', null, 'http-money-host'],
      ['refused', null, 'http-money-host'],
    ])
  })

  it('a post with no answer logs its kind before the error is rethrown', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    await expect(postMessage(TOKEN, 'C0STATUS', untitled, 'x', 'http-money-host')).rejects.toBeInstanceOf(TypeError)
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'no_answer', alert_kind: 'http-money-host' })])
  })

  it('a titled alert with a kind keeps its title as before, beside the kind', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'not_in_channel' }))
    await postMessage(TOKEN, 'C0STATUS', blocks, 'x', 'http-money-host')
    expect(outcomeLines()).toEqual([expect.objectContaining({ title: 'Workflow Execution Failed', alert_kind: 'http-money-host', kind: 'destination' })])
  })

  it('a titled alert that names no kind logs exactly what it did before, with a null kind', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.1' }))
    await postMessage(TOKEN, 'C0STATUS', blocks, 'x')
    expect(outcomeLines()[0]).toMatchObject({ title: 'Workflow Execution Failed', alert_kind: null })
  })

  it('the HTTP money host page, which has no title, logs the http-money-host kind', async () => {
    const chain: unknown = new Proxy({}, {
      get(_, prop) {
        if (typeof prop === 'symbol') return undefined
        if (prop === 'limit') {
          return alertRowsAnswer(() => sealedSlackRow({ bot_token: TOKEN, default_channel: 'C0CONFIG', workspace_name: 'Pennie' }).then((row) => ({ data: row, error: null })))
        }
        return () => chain
      },
    })
    const supabase = withSlackKeyRing({ from: () => chain }) as never
    const alert: HttpMoneyHostAlert = {
      name: 'Lender API',
      host: 'api.lendco.test',
      source: 'partner_configs',
      origin: { kind: 'partner', slug: 'lendco', name: 'Lendco' },
      workflows: [],
      firstReportedAt: null,
    }
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.3' }))
    expect(await sendHttpMoneyHostAlert(supabase, 'org-1', alert, 'https://app.test')).toBe(true)
    const lines = outcomeLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ outcome: 'delivered', channel: 'C0CONFIG', title: null, alert_kind: 'http-money-host' })
  })

  it('every kind is a fixed name the table accepts: lower case words joined by hyphens, at most ALERT_KIND_MAX characters', () => {
    expect(SLACK_ALERT_KINDS.length).toBeGreaterThan(0)
    expect(new Set(SLACK_ALERT_KINDS).size).toBe(SLACK_ALERT_KINDS.length)
    for (const kind of SLACK_ALERT_KINDS) {
      expect(kind).toMatch(ALERT_KIND_PATTERN)
      expect(kind.length).toBeLessThanOrEqual(ALERT_KIND_MAX)
    }
    // And the tail Worker's parser, which keeps its own copy of the rule, copies each one.
    for (const kind of SLACK_ALERT_KINDS) {
      const line = `${SLACK_POST_OUTCOME_PREFIX}${JSON.stringify({ post_id: `p-${kind}`, outcome: 'delivered', reason: null, status: 200, kind: null, channel: 'C0STATUS', retry_after: null, title: null, alert_kind: kind })}`
      const trace = { scriptName: 'bidspoke-worker', logs: [{ timestamp: Date.parse('2026-10-28T15:00:00Z'), level: 'log', message: [line] }] } as unknown as TraceItem
      expect(slackPostsIn(trace).map((r) => r.alert_kind)).toEqual([kind])
    }
    expect('Http Money Host').not.toMatch(ALERT_KIND_PATTERN)
    expect('http--money').not.toMatch(ALERT_KIND_PATTERN)
  })

  it('the kind reaches the tail Worker\'s row (the real line, through the real parser)', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'invalid_blocks' }))
    await postMessage(TOKEN, 'C0STATUS', untitled, 'x', 'http-money-host')
    const line = logged.find((l) => l.startsWith(SLACK_POST_OUTCOME_PREFIX))!
    const trace = { scriptName: 'bidspoke-worker', logs: [{ timestamp: Date.parse('2026-10-28T15:00:00Z'), level: 'log', message: [line] }] } as unknown as TraceItem
    expect(slackPostsIn(trace)).toEqual([expect.objectContaining({ title: null, alert_kind: 'http-money-host' })])
  })
})

describe('sendThreadReply logs through the same logger', () => {
  const HANDLE = { channel: 'C0ALERTS', ts: '1760700000.000100', bot_token: TOKEN }

  it('a delivered reply: one line, titled as a thread reply, never the reply text', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: true, ts: '1.2' }))
    await sendThreadReply(HANDLE, `Summary: ${BODY_SECRET}`)
    expect(outcomeLines()).toEqual([expect.objectContaining({ outcome: 'delivered', channel: 'C0ALERTS', title: THREAD_REPLY_TITLE })])
    expect(everyLine.join('\n')).not.toContain('Jane Roe')
  })

  it('a refused reply and a reply with no answer each log one line, and it still never throws', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'not_in_channel' }))
    await expect(sendThreadReply(HANDLE, 'x')).resolves.toBeUndefined()
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('fetch failed')))
    await expect(sendThreadReply(HANDLE, 'x')).resolves.toBeUndefined()
    expect(outcomeLines().map((l) => [l.outcome, l.reason, l.kind])).toEqual([
      ['refused', 'not_in_channel', 'destination'],
      ['no_answer', null, 'transient'],
    ])
  })
})

/**
 * Dan's decision 5: the all clear lists lost alerts by title, so a title is
 * stored for every refused post. A title must never carry applicant data. Most
 * titles are fixed words, but some are built from a value (a partner, a job,
 * a workflow name), and nothing stops a future builder putting a lead's field
 * in one. So the logger does not trust its callers: it keeps only the header's
 * plain text, cut to 120 characters, with anything shaped like an email
 * address, a phone number, an SSN or any run of four or more digits replaced.
 * That is provable here for every title, whoever builds it.
 */
describe('a stored title cannot carry applicant data', () => {
  it.each([
    ['Lead jane.roe@example.com failed', 'Lead [redacted] failed'],
    ['SSN 123-45-6789 rejected', 'SSN [redacted] rejected'],
    ['SSN 123456789 rejected', 'SSN [redacted] rejected'],
    ['Call (555) 123-4567 back', 'Call [redacted] back'],
    ['Call 555.123.4567 back', 'Call [redacted] back'],
    ['Account 4111111111111111 declined', 'Account [redacted] declined'],
    ['Zip 10001 missing', 'Zip [redacted] missing'],
  ])('%s', (raw, stored) => {
    expect(redactAlertTitle(raw)).toBe(stored)
  })

  it('keeps fixed words and small counts as written', () => {
    expect(redactAlertTitle('Table approaching the 1,000-row read cap')).toBe('Table approaching the 1,000-row read cap')
    expect(redactAlertTitle('Workflow Volume Cliff (still)')).toBe('Workflow Volume Cliff (still)')
  })

  it('is at most 120 characters', () => {
    expect(redactAlertTitle('x'.repeat(500))).toHaveLength(120)
  })

  it('reads only the header block, never a section, a context or the fallback text', () => {
    expect(alertTitleOf([{ type: 'section', text: { type: 'mrkdwn', text: BODY_SECRET } }, { type: 'header', text: { type: 'plain_text', text: 'Failure Spike' } }])).toBe('Failure Spike')
    expect(alertTitleOf([{ type: 'context', elements: [{ type: 'mrkdwn', text: BODY_SECRET }] }])).toBeNull()
    expect(alertTitleOf([{ type: 'header', text: { type: 'plain_text', text: '   ' } }])).toBeNull()
    expect(alertTitleOf([{ type: 'header' }])).toBeNull()
  })

  it('a header carrying applicant data is stored redacted, end to end through deliverMessage', async () => {
    fetchMock.mockImplementation(async () => slackResponse({ ok: false, error: 'not_in_channel' }))
    await postMessage(TOKEN, 'C0STATUS', [{ type: 'header', text: { type: 'plain_text', text: 'Lead jane.roe@example.com 123-45-6789' } }], 'x')
    expect(outcomeLines()[0].title).toBe('Lead [redacted] [redacted]')
  })
})
