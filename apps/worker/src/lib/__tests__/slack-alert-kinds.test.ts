import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sendBuyerClickAlert,
  sendCronHeartbeatAlert,
  sendCronHeartbeatGroupAlert,
  sendDatabaseUnreachableAlert,
  sendGroupedRecoveryAlert,
  sendPartnerPageLiveAlert,
  sendRecoveryAlert,
  sendSalesforceReadBackAlert,
  sendTitledAlert,
} from '../slack'
import { SLACK_POST_OUTCOME_PREFIX, type SlackPostOutcomeLine } from '../slack-post-outcome'
import { READ_BACK_SLACK_KINDS, type ReadBackAlertKind } from '../salesforce-read-back-alert'
import { clickAlertMessage, type ClickAlert } from '../buyer-click-alert'
import { alertRowsAnswer } from '../../__tests__/helpers/slack-alert-read'
import { sealedSlackRow, withSlackKeyRing } from '../../__tests__/helpers/sealed-slack-row'

/**
 * Every alert lib/slack.ts sends is logged under its own fixed kind (#2948).
 *
 * A title does not tell alerts apart: every all-clear is headed "Recovered",
 * and some titles are built from a value. So every sender names a kind from
 * SLACK_ALERT_KINDS, which the post outcome line records. The compiler makes
 * every sender name one; these pin the senders that choose between kinds, or
 * pass one through, to the kind the line actually carries, read from the real
 * line through a stubbed Slack.
 */

const SLACK = { bot_token: 'xoxb-kinds', default_channel: 'C0ALERTS' }

let logged: string[]
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: '1.0' }), { status: 200 })))
  logged = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The alert kind on every outcome line written so far, in order. */
const kinds = (): string[] =>
  logged
    .filter((l) => l.startsWith(SLACK_POST_OUTCOME_PREFIX))
    .map((l) => (JSON.parse(l.slice(SLACK_POST_OUTCOME_PREFIX.length)) as SlackPostOutcomeLine).alert_kind)

function supabaseWithSlack() {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'limit') {
        return alertRowsAnswer(() => sealedSlackRow({ ...SLACK, workspace_name: 'Pennie' }).then((row) => ({ data: row, error: null })))
      }
      return () => chain
    },
  })
  return withSlackKeyRing({ from: () => chain }) as never
}

describe('the scheduled job heartbeat: one kind per verdict, alone or grouped', () => {
  const job = { label: 'Execution archive to Snowflake', triggerCron: '23 * * * *', dependents: 'nothing is copied' }

  it('dark, never finished and unstamped are three kinds', async () => {
    await sendCronHeartbeatAlert(supabaseWithSlack(), 'org-1', job, 'stale', 90 * 60_000)
    await sendCronHeartbeatAlert(supabaseWithSlack(), 'org-1', job, 'vanished', 90 * 60_000)
    await sendCronHeartbeatAlert(supabaseWithSlack(), 'org-1', job, 'unstamped', 90 * 60_000)
    expect(kinds()).toEqual(['cron-heartbeat-dark', 'cron-heartbeat-vanished', 'cron-heartbeat-unstamped'])
  })

  it('the grouped page carries the same kind as the single page for its verdict', async () => {
    const jobs = [{ label: 'Job A', dependents: 'a stops', ageMs: 60_000 }, { label: 'Job B', dependents: 'b stops', ageMs: 60_000 }]
    const at = { triggerCron: '*/5 * * * *', runAt: '2026-10-14T21:30:00.400Z', jobs }
    const now = Date.parse('2026-10-14T21:48:35Z')
    await sendCronHeartbeatGroupAlert(supabaseWithSlack(), 'org-1', { status: 'stale', ...at }, null, now)
    await sendCronHeartbeatGroupAlert(supabaseWithSlack(), 'org-1', { status: 'vanished', ...at }, null, now)
    expect(kinds()).toEqual(['cron-heartbeat-dark', 'cron-heartbeat-vanished'])
  })
})

describe('the partners page live alert: the two problems are two kinds', () => {
  it('a channel miss and a monitor that cannot run', async () => {
    const base = { reason: 'timed out', since: '2026-10-28T12:00:00Z', repeat: null, at: Date.parse('2026-10-28T12:05:00Z') }
    await sendPartnerPageLiveAlert(SLACK, 'C0ALERTS', { problem: 'channel', ...base })
    await sendPartnerPageLiveAlert(SLACK, 'C0ALERTS', { problem: 'monitor', ...base })
    expect(kinds()).toEqual(['partner-page-live-channel', 'partner-page-live-monitor'])
  })
})

describe('the Salesforce read back: one kind per alert', () => {
  it('maps every read back alert to its own kind', () => {
    const all: ReadBackAlertKind[] = ['resend_failed', 'unknown', 'conflict', 'unread', 'not_running']
    const mapped = all.map((k) => READ_BACK_SLACK_KINDS[k])
    expect(new Set(mapped).size).toBe(all.length)
  })

  it('posts each under the kind the map names', async () => {
    const waiting = { writes: [], count: 3, oldest_at: '2026-10-28T12:00:00Z', oldest_expires_at: '2026-10-29T12:00:00Z' }
    await sendSalesforceReadBackAlert(SLACK, { kind: 'unread', reason: 'bulkhead_busy', ...waiting }, 'https://app.test')
    await sendSalesforceReadBackAlert(SLACK, { kind: 'not_running', last_finished_at: null, ...waiting }, 'https://app.test')
    expect(kinds()).toEqual(['salesforce-read-back-unread', 'salesforce-read-back-not-running'])
  })
})

describe('the buyer click alerts: a page and the over cap notice', () => {
  it('the composer names the kind and the sender posts under it', async () => {
    const page: ClickAlert = {
      kind: 'page', reason: 'count_failed', partner_id: 'p-1', partner_slug: 'liberty1', prospect_id: null,
      detail: 'the count did not answer', hold_recorded: null, workflow_id: 'wf-1', trace_id: 't-1', at: Date.parse('2026-10-28T12:00:00Z'),
    }
    const overCap: ClickAlert = {
      kind: 'over_cap', partner_id: 'p-1', partner_slug: 'liberty1', date: '2026-10-28', count: 120,
      daily_lead_cap: 100, alert_over_percent: 110, threshold: 110, workflow_id: 'wf-1', at: Date.parse('2026-10-28T12:00:00Z'),
    }
    await sendBuyerClickAlert(SLACK, 'C0ALERTS', clickAlertMessage(page, 'https://app.test'))
    await sendBuyerClickAlert(SLACK, 'C0ALERTS', clickAlertMessage(overCap, 'https://app.test'))
    expect(kinds()).toEqual(['buyer-click-page', 'buyer-click-over-cap'])
  })
})

describe('the shared senders log the kind their caller names', () => {
  it('a titled alert, a single all-clear and a grouped all-clear', async () => {
    await sendTitledAlert(SLACK, null, { title: 'Leads are being served from stored copies', errors: ['one'] }, 'stored-copy-serving')
    const item = { subject: 'Main Flow', alertedAt: '2026-10-28T12:00:00Z', endedAt: '2026-10-28T12:10:00Z' }
    await sendRecoveryAlert(SLACK, 'C0ALERTS', { signal: 'volume cliff', ...item }, 'volume-cliff-all-clear')
    await sendGroupedRecoveryAlert(SLACK, 'C0ALERTS', { signal: 'output field stopped', items: [item] }, 'field-presence-drought-all-clear')
    expect(kinds()).toEqual(['stored-copy-serving', 'volume-cliff-all-clear', 'field-presence-drought-all-clear'])
  })

  it('the database outage page is one kind whether or not Cloudflare answered for the database', async () => {
    const payload = { what: 'workflows', copyAgeMs: 60_000, appUrl: 'https://app.test' }
    await sendDatabaseUnreachableAlert(SLACK, 'C0ALERTS', { ...payload, error: 'connection refused' })
    await sendDatabaseUnreachableAlert(SLACK, 'C0ALERTS', { ...payload, error: 'error code: 1016' })
    expect(kinds()).toEqual(['db-unreachable', 'db-unreachable'])
  })
})
