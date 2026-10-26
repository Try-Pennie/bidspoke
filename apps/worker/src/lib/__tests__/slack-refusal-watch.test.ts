import { describe, expect, it } from 'vitest'
import {
  RESEND_INTERVAL_MS,
  runSlackRefusalWatch,
  slackRefusalWatchRunFailure,
  SLACK_REFUSED_LINE,
  SLACK_REFUSED_SIGNAL,
  type ChannelRun,
  type RefusalSummary,
  type SlackRefusalWatchDeps,
  type SlackRefusedEvent,
} from '../slack-refusal-watch'
import type { BetterStackSendOutcome } from '../better-stack-line'
import type { AlertClaims } from '../alert-claim'
import { INCIDENT_OUTBOX_PREFIX, type IncidentEvent } from '../incident-outbox'
import { RECOVERY_REARM_MINUTES, recoveryKey } from '../alert-recovery'
import type { JobRunEnding } from '../job-run-record'

/**
 * The minute check that pages, through Better Stack and never Slack, when
 * Slack refuses Bidspoke's alert posts (#2364).
 *
 * The outage it is built for: a Reconnect at 10:05 PM ET on 2026-10-22 saved a
 * bot token that was not in #statuspage, and for three days about 3,400 alert
 * posts were refused with not_in_channel at about 2 a minute while nothing
 * paged, because every page that could have said so was itself a Slack post.
 *
 * It reads a run per channel (the refusals since the newest delivered post,
 * slack_refusal_runs) and pages when a run holds any destination refusal, or 5
 * temporary refusals spanning 5 minutes. While the incident stands it re-sends
 * every 5 minutes. A delivered post stops the lines, and after 30 clean
 * minutes one Slack all clear names the start, the end, the count by reason and
 * the lost alerts by title. A record it cannot read, or a tail Worker that has
 * stopped writing, is reported as unmeasured, never as no refusals. Every
 * clock is injected; nothing here waits real time.
 */

const ORG = '00000000-0000-4000-8000-0000000000aa'
const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb'
const CHANNEL = 'C0STATUS'
const T0 = Date.parse('2026-10-23T02:06:00.000Z')
const MIN = 60_000
const iso = (ms: number) => new Date(ms).toISOString()
/** Built from char codes, so no dash sits in this file for the style gate to read as one. */
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`)

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
    delete: (k: string) => { store.delete(k); return Promise.resolve() },
    events: (): IncidentEvent[] => [...store.entries()].filter(([k]) => k.startsWith(INCIDENT_OUTBOX_PREFIX)).map(([, v]) => JSON.parse(v) as IncidentEvent),
  }
}

/** Claims as the Durable Object answers them: one caller per key while it is held. */
function memoryClaims(): AlertClaims & { asked: string[] } {
  const held = new Set<string>()
  const asked: string[] = []
  return {
    asked,
    claim: (key) => { asked.push(key); if (held.has(key)) return Promise.resolve(false); held.add(key); return Promise.resolve(true) },
    release: (key) => { held.delete(key); return Promise.resolve() },
  }
}

/** A run of refusals on one channel. */
function run(opts: Partial<ChannelRun> & { refused: number }): ChannelRun {
  return {
    channel: CHANNEL,
    lastDeliveredAt: '2026-10-23T02:04:00.000Z',
    destination: 0,
    firstRefusedAt: '2026-10-23T02:05:00.000Z',
    lastRefusedAt: '2026-10-23T02:05:30.000Z',
    reasons: [],
    titles: [],
    ...opts,
  }
}

/** not_in_channel at the measured cadence, 2 a minute, from `first`. */
const notInChannel = (refused: number, first = '2026-10-23T02:05:00.000Z', last = iso(Date.parse(first) + Math.max(0, refused - 1) * 30_000)): ChannelRun =>
  run({
    refused,
    destination: refused,
    firstRefusedAt: first,
    lastRefusedAt: last,
    reasons: [{ reason: 'not_in_channel', status: 200, kind: 'destination', refused }],
    titles: [{ title: 'Workflow Execution Failed', refused }],
  })

const transient = (refused: number, first: string, last: string, status = 429): ChannelRun =>
  run({ refused, destination: 0, firstRefusedAt: first, lastRefusedAt: last, reasons: [{ reason: null, status, kind: 'transient', refused }], titles: [{ title: 'Failure Spike', refused }] })

const delivered = (at: string): ChannelRun => run({ refused: 0, lastDeliveredAt: at, firstRefusedAt: null, lastRefusedAt: null })

interface Harness {
  deps: SlackRefusalWatchDeps
  kv: ReturnType<typeof memoryKv>
  pages: SlackRefusedEvent[]
  allClears: Array<{ channel: string; title: string; sections: string[] }>
  runs: { now: ChannelRun[] }
  summaries: Array<{ channels: string[]; from: string; to: string }>
  recorded: JobRunEnding[]
  clock: { now: number }
  pageAnswer: { next: () => BetterStackSendOutcome }
}

function harness(opts: { claims?: AlertClaims; kv?: ReturnType<typeof memoryKv>; summary?: RefusalSummary; connections?: Map<string, { bot_token: string; default_channel: string }> | null } = {}): Harness {
  const kv = opts.kv ?? memoryKv()
  const pages: SlackRefusedEvent[] = []
  const allClears: Harness['allClears'] = []
  const runs = { now: [] as ChannelRun[] }
  const summaries: Harness['summaries'] = []
  const recorded: JobRunEnding[] = []
  const clock = { now: T0 }
  const pageAnswer = { next: (): BetterStackSendOutcome => ({ outcome: 'sent', status: 202 }) }
  const connections = opts.connections === undefined ? new Map([[ORG, { bot_token: 'xoxb-test', default_channel: CHANNEL }]]) : opts.connections
  const deps: SlackRefusalWatchDeps = {
    kv,
    claims: opts.claims,
    now: () => clock.now,
    readNewestDelivery: () => Promise.resolve(iso(clock.now + 0 * MIN)),
    readRuns: () => Promise.resolve(runs.now),
    readConnections: () => Promise.resolve(connections),
    readSummary: (channels, from, to) => {
      summaries.push({ channels, from, to })
      return Promise.resolve(opts.summary ?? {
        refused: 6,
        firstRefusedAt: '2026-10-23T02:05:00.000Z',
        lastRefusedAt: '2026-10-23T02:07:30.000Z',
        reasons: [{ reason: 'not_in_channel', status: 200, kind: 'destination', refused: 5 }, { reason: null, status: 429, kind: 'transient', refused: 1 }],
        titles: [{ title: 'Workflow Execution Failed', refused: 4 }, { title: 'Failure Spike', refused: 1 }, { title: null, refused: 1 }],
      })
    },
    sendPage: (event) => { pages.push(event); return Promise.resolve(pageAnswer.next()) },
    sendAllClear: (_slack, channel, message) => { allClears.push({ channel, ...message }); return Promise.resolve(true) },
    recordRun: (ending) => { recorded.push(ending); return Promise.resolve() },
  }
  return { deps, kv, pages, allClears, runs, summaries, recorded, clock, pageAnswer }
}

describe('a run of not_in_channel at the measured cadence (2 posts a minute)', () => {
  it('pages once through Better Stack with exactly the pinned event, and posts nothing to Slack', async () => {
    const h = harness()
    h.runs.now = [notInChannel(2)]
    const s = await runSlackRefusalWatch(h.deps)
    expect(h.pages).toEqual([{
      message: SLACK_REFUSED_LINE,
      organization_id: ORG,
      kind: 'destination',
      reason: 'not_in_channel',
      refused: 2,
      since: '2026-10-23T02:05:00.000Z',
      dt: iso(T0),
    }])
    expect(Object.keys(h.pages[0]).sort()).toEqual(['dt', 'kind', 'message', 'organization_id', 'reason', 'refused', 'since'])
    expect(h.allClears).toEqual([])
    expect(s.paged).toEqual([ORG])
    expect(slackRefusalWatchRunFailure(s)).toBeUndefined()
    // The incident is opened from the first refusal, and the page recorded once Better Stack took it.
    expect(h.kv.events().map((e) => [e.type, e.signal, e.subject, e.startedAt])).toEqual([
      ['opened', SLACK_REFUSED_SIGNAL, ORG, '2026-10-23T02:05:00.000Z'],
      ['paged', SLACK_REFUSED_SIGNAL, ORG, '2026-10-23T02:05:00.000Z'],
    ])
    expect(h.recorded.map((r) => r.outcome)).toEqual(['paged'])
  })

  it('does not page again on the next minutes while the run grows, only on its 5 minute re-send', async () => {
    const h = harness()
    for (let m = 0; m < 5; m++) {
      h.clock.now = T0 + m * MIN
      h.runs.now = [notInChannel(2 + 2 * m)]
      await runSlackRefusalWatch(h.deps)
    }
    expect(h.pages).toHaveLength(1)
    expect(h.kv.events().filter((e) => e.type === 'paged')).toHaveLength(1)
  })
})

describe('what does not page', () => {
  it('one isolated 429', async () => {
    const h = harness()
    h.runs.now = [transient(1, '2026-10-23T02:05:00.000Z', '2026-10-23T02:05:00.000Z')]
    const s = await runSlackRefusalWatch(h.deps)
    expect(h.pages).toEqual([])
    expect(s.paged).toEqual([])
    expect(h.kv.store.get(recoveryKey(SLACK_REFUSED_SIGNAL, ORG))).toBeUndefined()
  })

  it('five temporary refusals inside one second', async () => {
    const h = harness()
    h.runs.now = [transient(5, '2026-10-23T02:05:00.000Z', '2026-10-23T02:05:00.900Z', 503)]
    await runSlackRefusalWatch(h.deps)
    expect(h.pages).toEqual([])
  })

  it('four temporary refusals spanning ten minutes', async () => {
    const h = harness()
    h.runs.now = [transient(4, '2026-10-23T01:55:00.000Z', '2026-10-23T02:05:00.000Z')]
    await runSlackRefusalWatch(h.deps)
    expect(h.pages).toEqual([])
  })
})

describe('temporary refusals that do page', () => {
  it('five with no success between, spanning five minutes, page as transient naming the commonest reason', async () => {
    const h = harness()
    h.runs.now = [transient(5, '2026-10-23T02:00:00.000Z', '2026-10-23T02:05:00.000Z')]
    await runSlackRefusalWatch(h.deps)
    expect(h.pages).toEqual([expect.objectContaining({ kind: 'transient', reason: 'HTTP 429', refused: 5, since: '2026-10-23T02:00:00.000Z' })])
  })

  it('an unknown reason is named in the page', async () => {
    const h = harness()
    h.runs.now = [run({ refused: 6, firstRefusedAt: '2026-10-23T02:00:00.000Z', lastRefusedAt: '2026-10-23T02:05:30.000Z', reasons: [{ reason: 'brand_new_error', status: 200, kind: 'transient', refused: 6 }] })]
    await runSlackRefusalWatch(h.deps)
    expect(h.pages[0].reason).toBe('brand_new_error')
  })
})

describe('standing down', () => {
  async function pagedThenDelivered(h: Harness) {
    h.runs.now = [notInChannel(6)]
    await runSlackRefusalWatch(h.deps)
    expect(h.pages).toHaveLength(1)
    // A delivered post at 02:08: the run is gone.
    h.clock.now = T0 + 3 * MIN
    h.runs.now = [delivered('2026-10-23T02:08:00.000Z')]
  }

  it('a delivered post stops the lines, and after 30 clean minutes exactly one Slack all clear with counts by reason and titles', async () => {
    const h = harness()
    await pagedThenDelivered(h)
    // The last sighting was the paging tick at T0, so the all clear is owed from T0 + 30 minutes.
    for (let m = 3; m < RECOVERY_REARM_MINUTES; m++) {
      h.clock.now = T0 + m * MIN
      const s = await runSlackRefusalWatch(h.deps)
      expect(s.allClear).toEqual([])
    }
    expect(h.pages).toHaveLength(1)
    expect(h.allClears).toEqual([])

    let announcedAt = 0
    for (let m = RECOVERY_REARM_MINUTES; m < RECOVERY_REARM_MINUTES + 3; m++) {
      h.clock.now = T0 + m * MIN
      const s = await runSlackRefusalWatch(h.deps)
      if (s.allClear.length > 0) announcedAt = h.clock.now
    }
    expect(announcedAt).toBe(T0 + RECOVERY_REARM_MINUTES * MIN)
    expect(h.pages).toHaveLength(1)
    expect(h.allClears).toHaveLength(1)
    const message = h.allClears[0]
    expect(message.channel).toBe(CHANNEL)
    expect(message.title).toBe('Recovered')
    const text = message.sections.join('\n')
    expect(text).toContain('Slack is taking alert posts again')
    expect(text).toContain('refused 6 posts')
    expect(text).toContain('5 not_in_channel')
    expect(text).toContain('1 HTTP 429')
    expect(text).toContain('Workflow Execution Failed (4)')
    expect(text).toContain('Failure Spike (1)')
    expect(text).toContain('1 untitled')
    expect(text).not.toMatch(LONG_DASHES)
    // The summary is read for the incident's channel, from its start to the announcing tick.
    expect(h.summaries).toEqual([{ channels: [CHANNEL], from: '2026-10-23T02:05:00.000Z', to: iso(announcedAt) }])
    expect(h.kv.events().map((e) => e.type)).toEqual(['opened', 'paged', 'ended'])
    expect(h.kv.events().at(-1)).toMatchObject({ type: 'ended', reason: 'all_clear' })
    expect(h.kv.store.get(recoveryKey(SLACK_REFUSED_SIGNAL, ORG))).toBeUndefined()
  })

  it('holds the all clear while no delivered post has been seen since the last refusal (the run only aged out)', async () => {
    const h = harness()
    h.runs.now = [notInChannel(6)]
    await runSlackRefusalWatch(h.deps)
    h.runs.now = []
    for (let m = 1; m < 40; m++) {
      h.clock.now = T0 + m * MIN
      await runSlackRefusalWatch(h.deps)
    }
    expect(h.allClears).toEqual([])
    expect(h.kv.store.get(recoveryKey(SLACK_REFUSED_SIGNAL, ORG))).toBeDefined()
  })
})

describe('when Better Stack does not take the page', () => {
  it('a 401 then a timeout: a distinct line, no paged record, retried each minute, the run failed, and the all clear says so', async () => {
    const h = harness()
    const answers: BetterStackSendOutcome[] = [{ outcome: 'refused', status: 401 }, { outcome: 'no_answer', deadline_ms: 5_000 }, { outcome: 'sent', status: 202 }]
    h.pageAnswer.next = () => answers.shift()!
    h.runs.now = [notInChannel(4)]

    const first = await runSlackRefusalWatch(h.deps)
    expect(first.pageFailed).toEqual([ORG])
    expect(first.errors.join('\n')).toMatch(/Better Stack refused the Slack refusal page for .* with 401/)
    expect(slackRefusalWatchRunFailure(first)).toBeDefined()
    expect(h.kv.events().filter((e) => e.type === 'paged')).toEqual([])
    expect(h.recorded.at(-1)).toMatchObject({ outcome: 'failed' })

    h.clock.now = T0 + MIN
    const second = await runSlackRefusalWatch(h.deps)
    expect(second.pageFailed).toEqual([ORG])
    expect(second.errors.join('\n')).toMatch(/no answer from Better Stack in 5000 ms/)
    expect(h.kv.events().filter((e) => e.type === 'paged')).toEqual([])

    h.clock.now = T0 + 2 * MIN
    const third = await runSlackRefusalWatch(h.deps)
    expect(third.paged).toEqual([ORG])
    expect(slackRefusalWatchRunFailure(third)).toBeUndefined()
    expect(h.pages).toHaveLength(3)
    expect(h.kv.events().filter((e) => e.type === 'paged')).toHaveLength(1)

    // Recovery: the all clear names the failed page and when.
    h.runs.now = [delivered('2026-10-23T02:09:00.000Z')]
    for (let m = 3; m <= RECOVERY_REARM_MINUTES + 4; m++) {
      h.clock.now = T0 + m * MIN
      await runSlackRefusalWatch(h.deps)
    }
    expect(h.allClears).toHaveLength(1)
    expect(h.allClears[0].sections.join('\n')).toContain('The Better Stack page for this first failed at Oct 22, 10:06 PM EDT; one was accepted at Oct 22, 10:08 PM EDT.')
  })

  it('never accepted: the all clear says nobody was paged', async () => {
    const h = harness()
    h.pageAnswer.next = () => ({ outcome: 'not_configured', missing: ['BETTERSTACK_OUTAGE_TOKEN'] })
    h.runs.now = [notInChannel(4)]
    await runSlackRefusalWatch(h.deps)
    h.runs.now = [delivered('2026-10-23T02:09:00.000Z')]
    for (let m = 3; m <= RECOVERY_REARM_MINUTES + 2; m++) {
      h.clock.now = T0 + m * MIN
      await runSlackRefusalWatch(h.deps)
    }
    expect(h.allClears).toHaveLength(1)
    expect(h.allClears[0].sections.join('\n')).toContain('none was accepted, so nobody was paged')
  })
})

describe('one page, however it is seen', () => {
  it('two refusals arriving together and a doubled tick page once', async () => {
    const claims = memoryClaims()
    const kv = memoryKv()
    const a = harness({ claims, kv })
    const b = harness({ claims, kv })
    // Two refusals landed in the same second: one run, seen by both deliveries of the tick.
    a.runs.now = [notInChannel(2, '2026-10-23T02:05:00.000Z', '2026-10-23T02:05:00.000Z')]
    b.runs.now = a.runs.now
    await Promise.all([runSlackRefusalWatch(a.deps), runSlackRefusalWatch(b.deps)])
    expect(a.pages.length + b.pages.length).toBe(1)
    expect(claims.asked.length).toBeGreaterThan(0)
    expect(claims.asked.every((k) => k.startsWith(`minute-alert:page:${SLACK_REFUSED_SIGNAL}:${ORG}:`))).toBe(true)
  })
})

describe('what cannot be measured is said, never read as no refusals', () => {
  it('a record that cannot be read', async () => {
    const h = harness()
    h.deps.readRuns = () => Promise.reject(new Error('PGRST002 schema cache'))
    const s = await runSlackRefusalWatch(h.deps)
    expect(s.measured).toBe(false)
    expect(s.unmeasured).toMatch(/could not read slack_post_outcomes: PGRST002 schema cache/)
    expect(h.pages).toEqual([])
    expect(slackRefusalWatchRunFailure(s)).toBeDefined()
    expect(h.recorded.at(-1)).toMatchObject({ outcome: 'unmeasured' })
  })

  it('a tail Worker that has written no cron delivery in 10 minutes', async () => {
    const h = harness()
    h.deps.readNewestDelivery = () => Promise.resolve(iso(T0 - 11 * MIN))
    h.runs.now = [notInChannel(2)]
    const s = await runSlackRefusalWatch(h.deps)
    expect(s.measured).toBe(false)
    expect(s.unmeasured).toMatch(/the tail Worker has written no cron delivery since/)
    expect(h.pages).toEqual([])
  })

  it('a tail Worker that has never written a cron delivery', async () => {
    const h = harness()
    h.deps.readNewestDelivery = () => Promise.resolve(null)
    const s = await runSlackRefusalWatch(h.deps)
    expect(s.measured).toBe(false)
    expect(s.unmeasured).toMatch(/no cron delivery on record/)
  })

  it('a delivery record that cannot be read', async () => {
    const h = harness()
    h.deps.readNewestDelivery = () => Promise.reject(new Error('timeout'))
    const s = await runSlackRefusalWatch(h.deps)
    expect(s.unmeasured).toMatch(/could not read cron_tick_deliveries: timeout/)
  })

  it('Slack connections that cannot be read', async () => {
    const h = harness({ connections: null })
    h.runs.now = [notInChannel(2)]
    const s = await runSlackRefusalWatch(h.deps)
    expect(s.measured).toBe(false)
    expect(s.unmeasured).toMatch(/Slack connections/)
    expect(h.pages).toEqual([])
  })

  it('an unmeasured minute neither sends an all clear nor ends an open incident', async () => {
    const h = harness()
    h.runs.now = [notInChannel(4)]
    await runSlackRefusalWatch(h.deps)
    h.runs.now = [delivered('2026-10-23T02:08:00.000Z')]
    h.deps.readNewestDelivery = () => Promise.resolve(null)
    for (let m = 3; m < RECOVERY_REARM_MINUTES + 5; m++) {
      h.clock.now = T0 + m * MIN
      await runSlackRefusalWatch(h.deps)
    }
    expect(h.allClears).toEqual([])
    expect(h.kv.store.get(recoveryKey(SLACK_REFUSED_SIGNAL, ORG))).toBeDefined()
  })
})

describe('a standing incident', () => {
  it('re-sends every 5 minutes, not every minute', async () => {
    const h = harness()
    for (let m = 0; m <= 11; m++) {
      h.clock.now = T0 + m * MIN
      h.runs.now = [notInChannel(2 + 2 * m)]
      await runSlackRefusalWatch(h.deps)
    }
    expect(h.pages.map((p) => p.dt)).toEqual([iso(T0), iso(T0 + RESEND_INTERVAL_MS), iso(T0 + 2 * RESEND_INTERVAL_MS)])
    // Each re-send carries the incident's start, not the minute it was sent.
    expect(new Set(h.pages.map((p) => p.since))).toEqual(new Set(['2026-10-23T02:05:00.000Z']))
    expect(h.pages.map((p) => p.refused)).toEqual([2, 12, 22])
    expect(h.kv.events().filter((e) => e.type === 'paged')).toHaveLength(3)
  })
})

describe('whose incident it is', () => {
  it('a channel no Slack connection names as its default still pages, with no organization, and stands down without a Slack all clear', async () => {
    const h = harness()
    h.runs.now = [{ ...notInChannel(2), channel: 'C0OVERRIDE' }]
    await runSlackRefusalWatch(h.deps)
    expect(h.pages).toEqual([expect.objectContaining({ organization_id: null, kind: 'destination' })])
    expect(h.kv.events()).toEqual([])
    h.runs.now = [{ ...delivered('2026-10-23T02:08:00.000Z'), channel: 'C0OVERRIDE' }]
    for (let m = 1; m <= RECOVERY_REARM_MINUTES + 2; m++) {
      h.clock.now = T0 + m * MIN
      await runSlackRefusalWatch(h.deps)
    }
    expect(h.pages).toHaveLength(1)
    expect(h.allClears).toEqual([])
  })

  it('each organization is paged for its own default channel only', async () => {
    const connections = new Map([[ORG, { bot_token: 'a', default_channel: CHANNEL }], [OTHER_ORG, { bot_token: 'b', default_channel: 'C0OTHER' }]])
    const h = harness({ connections })
    h.runs.now = [notInChannel(2), { ...delivered('2026-10-23T02:06:00.000Z'), channel: 'C0OTHER' }]
    await runSlackRefusalWatch(h.deps)
    expect(h.pages.map((p) => p.organization_id)).toEqual([ORG])
  })
})
