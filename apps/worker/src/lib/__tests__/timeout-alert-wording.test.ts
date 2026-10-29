/**
 * What the daily Step Timeout Warnings alert says about each step (#2934).
 *
 * Each line says only what was measured. On 2026-10-27 the alert said "most runs
 * would time out" of steps where 1 run in 1,020 had. On 2026-10-29 its no retries
 * line said of Main Flow's Send Salesforce "its slowest of 1,180 recent runs took
 * 7,422ms, so a run that slow fails" against a 5,250 ms timeout: that run had
 * FINISHED, because a Salesforce step's recorded time includes work outside the
 * call its timeout bounds. So a line never claims what a run that slow would do.
 *
 * Times are Eastern; 2026-10-28 and 29 were EDT, UTC-4.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'
import { etSpan, headroomLine, losingRunsLine, outageLine, sendTimeoutConfigAlert } from '../slack'
import type { HeadroomFinding, LosingRunsFinding, OutageFinding } from '../timeout-findings'

const URL = 'https://bidspoke.example/workflows/wf?node=n1'

const collections: LosingRunsFinding = {
  kind: 'losing_runs', node_id: 'n1', namespace: 'collections_apex', label: 'Credit Collections', type: 'salesforce',
  configured_ms: 4500, retries: 0, timed_out: 7, latest_at: '2026-10-29T06:25:08.989Z',
  burst: { count: 6, start: '2026-10-28T15:52:00.000Z', end: '2026-10-28T16:36:00.000Z' }, suggested_ms: null,
}

describe('a step losing runs to its timeout', () => {
  it('says how many runs failed on it in five days, when the latest did, and the burst most came in', () => {
    expect(losingRunsLine(collections, URL)).toBe(
      `• <${URL}|Credit Collections> (salesforce): 7 runs failed on its 4,500ms timeout in the last 5 days, the latest at 2:25 AM ET Oct 29. 6 of them came between 11:52 AM and 12:36 PM ET Oct 28.`,
    )
  })

  it('suggests a value only when the runs support one', () => {
    const line = losingRunsLine({ ...collections, label: 'Under 10000 SF Post', type: 'webhook', configured_ms: 3750, retries: 2, burst: null, suggested_ms: 8000 }, URL)
    expect(line).toBe(
      `• <${URL}|Under 10000 SF Post> (webhook): 7 runs failed on its 3,750ms timeout in the last 5 days, the latest at 2:25 AM ET Oct 29. Try 8,000ms.`,
    )
  })
})

describe('a likely upstream outage', () => {
  const gigfi: OutageFinding = {
    kind: 'outage', node_id: 'n1', namespace: 'ping_gigfi', label: 'Ping GigFi', type: 'webhook',
    configured_ms: 3000, timed_out: 9, start: '2026-10-29T14:42:00.000Z', end: '2026-10-29T15:31:00.000Z',
  }

  it('gives the count and the window, and no value to change to', () => {
    const line = outageLine(gigfi, URL)
    expect(line).toBe(`• <${URL}|Ping GigFi> (webhook): 9 runs timed out at 3,000ms, all between 10:42 AM and 11:31 AM ET Oct 29.`)
    expect(line).not.toContain('Try')
  })

  it('names both days when the burst crosses midnight', () => {
    expect(etSpan('2026-10-29T03:30:00.000Z', '2026-10-29T04:45:00.000Z')).toBe('between 11:30 PM ET Oct 28 and 12:45 AM ET Oct 29')
  })
})

describe('a step with little headroom', () => {
  const noBidsCall: HeadroomFinding = {
    kind: 'headroom', node_id: 'n1', namespace: 'engine_no_bids_call', label: 'Engine No Bids Call', type: 'code',
    configured_ms: 43500, retries: 2, suggested_ms: 47000, p99_ms: 31236, max_ms: 39773, sample_size: 955, severity: 'amber',
  }

  it('gives the five day p99 it was judged on', () => {
    expect(headroomLine(noBidsCall, URL)).toBe(
      `• <${URL}|Engine No Bids Call> (code): set to 43,500ms; its p99 over the last 5 days was 31,236ms (955 runs sampled). Try 47,000ms.`,
    )
  })

  it('says when the setting is below that p99', () => {
    expect(headroomLine({ ...noBidsCall, configured_ms: 30000, severity: 'red' }, URL)).toBe(
      `• <${URL}|Engine No Bids Call> (code): set to 30,000ms, below its p99 over the last 5 days of 31,236ms (955 runs sampled). Try 47,000ms.`,
    )
  })

  it('never says a run as slow as the slowest would fail, which a Salesforce step does not', () => {
    const line = headroomLine({ ...noBidsCall, label: 'Send Salesforce', type: 'salesforce', configured_ms: 5250, retries: 0, suggested_ms: 8000, p99_ms: 3780, max_ms: 7422, sample_size: 1180, severity: 'red' }, URL)
    expect(line).toBe(
      `• <${URL}|Send Salesforce> (salesforce): set to 5,250ms with no retries; over the last 5 days its slowest finished run took 7,422ms and its p99 was 3,780ms (1,180 runs sampled). Try 8,000ms.`,
    )
    expect(line).not.toMatch(/fails|would time out|most runs/)
  })
})

describe('the alert', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.1' }) })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())
  const posted = async () => (await slackPostOf(fetchMock.mock.calls[0])) as { text: string; blocks: Array<{ text?: { text?: string } }> }

  it('lists losing runs, then outages, then headroom, each under its own heading', async () => {
    await sendTimeoutConfigAlert(
      { bot_token: 't', default_channel: 'c', config_alerts_enabled: true } as never,
      [],
      [{
        workflow_id: 'wf', workflow_name: 'Main Flow',
        findings: [
          { kind: 'headroom', node_id: 'h', namespace: 'h', label: 'H', type: 'code', configured_ms: 43500, retries: 2, suggested_ms: 47000, p99_ms: 31236, max_ms: 39773, sample_size: 955, severity: 'amber' },
          { kind: 'outage', node_id: 'o', namespace: 'o', label: 'O', type: 'webhook', configured_ms: 3000, timed_out: 9, start: '2026-10-29T14:42:00.000Z', end: '2026-10-29T15:31:00.000Z' },
          collections,
        ],
      }],
      'https://app',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const text = (await posted()).blocks.map((b) => b.text?.text ?? '').join('\n')
    const order = ['*Losing runs to the timeout:* 1 step', '|Credit Collections>', '*Likely upstream outages:*', '|O>', '*Little headroom:* 1 step', '|H>']
    const at = order.map((s) => text.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect((await posted()).text).toBe('Step timeout warnings: 3 steps')
  })

  it('posts nothing when nothing is listed', async () => {
    await sendTimeoutConfigAlert({ bot_token: 't', default_channel: 'c', config_alerts_enabled: true } as never, [], [], 'https://app')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
