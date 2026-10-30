import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { LIVE_MISS_CAUSES } from '@bidspoke/partner-page-live'
import {
  LIVE_MISS_INITIAL_WATERMARK,
  LIVE_MISS_NOTICE_BATCH,
  LIVE_MISS_TEST_PARTNER_ID,
  LIVE_MISS_WATERMARK_KEY,
  PARTNER_LIVE_MISS_NOTICE_JOB,
  PARTNER_LIVE_MISS_SIGNAL,
  causeSentence,
  composeLiveMissNotice,
  liveMissNoticeRunFailure,
  liveMissSentKey,
  readLiveMisses,
  runLiveMissNotice,
  type LiveMissNoticeDeps,
  type LiveMissReading,
  type LiveMissRow,
  type LiveMissWatermark,
  type NoticePost,
} from '../partner-live-miss-notice'
import { incidentSignal } from '../incident-signals'
import { cronJob } from '../cron-heartbeat'
import { countsFailedRuns, isFailedRun } from '../minute-job-failures'
import { outboxEvents, transitions } from './_incident-events'

/**
 * #2220, Dan's decisions of 2026-10-26: no threshold, every recorded live miss
 * posts one non urgent notice to its organization's alert channel, a miss on
 * the throwaway test partner says plainly that it is a test, a doubled tick
 * posts once, a failed post is retried and never marked sent, and a failed read
 * is recorded as unmeasured rather than as no misses.
 */

const NOW = Date.parse('2026-10-26T18:00:00.000Z')
const ORG = '0b4c6a2e-6f3e-4d8a-9a51-1d1c4a0f7a11'
const PARTNER = '5d0e1f2a-3b4c-4d5e-8f60-718293a4b5c6'
/** An em or en dash, or a hyphen standing alone between words: punctuation the copy must not use. */
const DASH_PUNCTUATION = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]|\\s-\\s`)

/**
 * The deliberate miss, as the issue's comment of 2026-10-26 records it: row
 * 6461826f on the 'Live miss test' partner, cause direct_sql, noticed partner
 * version 2, observed 3, no notice heard since the tab opened, reported by Dan,
 * observed 1:11:54 PM ET (17:11:54 UTC). The profile versions are not stated
 * there; the partner has no buyer profile, which the page counts as version 0.
 */
const DELIBERATE_MISS: LiveMissRow = {
  id: '6461826f-f588-4171-988c-59aa5ac9f8a5',
  organizationId: ORG,
  partnerId: LIVE_MISS_TEST_PARTNER_ID,
  partnerName: 'Live miss test',
  reporterName: 'Dan Hankins-Wright',
  cause: 'direct_sql',
  noticed: { partnerVersion: 2, profileVersion: 0 },
  observed: { partnerVersion: 3, profileVersion: 0 },
  sinceLastNoticeMs: null,
  observedAt: '2026-10-26T17:11:54.481233+00:00',
}

let seq = 0
function miss(over: Partial<LiveMissRow> = {}): LiveMissRow {
  seq += 1
  const n = String(seq).padStart(12, '0')
  return {
    id: `aaaaaaaa-bbbb-4ccc-8ddd-${n}`,
    organizationId: ORG,
    partnerId: PARTNER,
    partnerName: 'Acme Lending',
    reporterName: 'Pat Rivera',
    cause: 'delivery',
    noticed: { partnerVersion: 7, profileVersion: 2 },
    observed: { partnerVersion: 8, profileVersion: 2 },
    sinceLastNoticeMs: 4 * 60_000,
    observedAt: new Date(Date.parse('2026-10-26T17:30:00.000Z') + seq * 1000).toISOString(),
    ...over,
  }
}

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

/** A strongly consistent claim object, as ALERT_CLAIM is: one holder per key. */
function fakeClaims() {
  const held = new Set<string>()
  return {
    held,
    claim: vi.fn(async (key: string) => {
      await Promise.resolve()
      if (held.has(key)) return false
      held.add(key)
      return true
    }),
    release: vi.fn(async (key: string) => { held.delete(key) }),
  }
}

/** Rows strictly after the watermark, in (observed_at, id) order, at most `limit`: what the live query asks for. */
function tableReader(rows: LiveMissRow[]) {
  const calls: Array<{ after: LiveMissWatermark; limit: number }> = []
  const read = vi.fn(async (after: LiveMissWatermark, limit: number): Promise<LiveMissReading> => {
    calls.push({ after, limit })
    const t = (r: { observedAt: string }) => Date.parse(r.observedAt)
    const sorted = [...rows].sort((a, b) => t(a) - t(b) || a.id.localeCompare(b.id))
    const later = sorted.filter((r) => t(r) > Date.parse(after.observedAt) || (t(r) === Date.parse(after.observedAt) && r.id > after.id))
    return { ok: true, rows: later.slice(0, limit) }
  })
  return { read, calls }
}

interface Posted {
  organizationId: string
  title: string
  sections: string[]
}

function harness(rows: LiveMissRow[], opts: { kv?: ReturnType<typeof fakeKv>; claims?: ReturnType<typeof fakeClaims>; post?: (orgId: string, n: { title: string; sections: string[] }) => Promise<NoticePost> } = {}) {
  const kv = opts.kv ?? fakeKv()
  const claims = opts.claims ?? fakeClaims()
  const reader = tableReader(rows)
  const posted: Posted[] = []
  const post = vi.fn(async (organizationId: string, notice: { title: string; sections: string[] }): Promise<NoticePost> => {
    if (opts.post) return opts.post(organizationId, notice)
    await Promise.resolve()
    posted.push({ organizationId, title: notice.title, sections: notice.sections })
    return { kind: 'posted' }
  })
  const records: Array<{ outcome: string; summary: Record<string, unknown> }> = []
  const record = vi.fn(async (outcome: string, summary: Record<string, unknown>) => { records.push({ outcome, summary }) })
  const deps = (over: Partial<LiveMissNoticeDeps> = {}): LiveMissNoticeDeps => ({
    kv,
    claims,
    read: reader.read,
    post,
    record,
    now: () => NOW,
    log: () => {},
    ...over,
  })
  return { kv, claims, reader, posted, post, records, record, deps, run: (over: Partial<LiveMissNoticeDeps> = {}) => runLiveMissNotice(deps(over)) }
}

const text = (n: { title: string; sections: string[] }) => [n.title, ...n.sections].join('\n')

describe('one new live miss', () => {
  it('posts exactly one notice naming the partner, the cause in plain words, whose page saw it and the version gap', async () => {
    const row = miss({ cause: 'delivery' })
    const h = harness([row])
    const s = await h.run()
    expect(h.post).toHaveBeenCalledTimes(1)
    expect(h.posted[0].organizationId).toBe(ORG)
    const body = text(h.posted[0])
    expect(h.posted[0].title).toBe('A partners page missed a live update')
    expect(body).toContain('Acme Lending')
    expect(body).toContain('Pat Rivera')
    expect(body).toContain(causeSentence('delivery'))
    expect(body).toContain('partner version 7')
    expect(body).toContain('version 8')
    // The buyer profile did not move, so it is not reported as a gap.
    expect(body).not.toContain('buyer profile version')
    // The time is Eastern: 17:30 UTC is 1:30 PM EDT.
    expect(body).toContain('1:30 PM ET')
    // Never the raw cause value, and no dash used as punctuation.
    expect(body).not.toContain('delivery')
    expect(body).not.toMatch(DASH_PUNCTUATION)
    expect(s.posted).toEqual([row.id])
    expect(h.kv.store.get(liveMissSentKey(row.id))).toBeTruthy()
    expect(JSON.parse(h.kv.store.get(LIVE_MISS_WATERMARK_KEY)!)).toEqual({ observedAt: row.observedAt, id: row.id })
    expect(h.records).toEqual([{ outcome: 'ok', summary: expect.objectContaining({ read: 1, posted: 1, failed: 0, more: false }) }])
    // Read again on the next tick: nothing new, nothing posted twice.
    await h.run()
    expect(h.post).toHaveBeenCalledTimes(1)
    expect(h.reader.calls[1].after).toEqual({ observedAt: row.observedAt, id: row.id })
    expect(h.records[1]).toEqual({ outcome: 'no_misses', summary: expect.objectContaining({ read: 0, posted: 0 }) })
  })

  it('records the miss as one incident of its own, opened, paged and stood down, under its organization and named by its partner', async () => {
    const row = miss()
    const h = harness([row])
    await h.run()
    const subject = `${PARTNER}:${row.id}`
    expect(transitions(h.kv.store)).toEqual([`opened ${subject}`, `paged ${subject}`, `ended ${subject} stood_down_by_design`])
    const events = outboxEvents(h.kv.store)
    expect(events.map((e) => [e.signal, e.scope, e.organizationId, e.subjectLabel])).toEqual(Array(3).fill([PARTNER_LIVE_MISS_SIGNAL, 'org', ORG, 'Acme Lending']))
    // A single event: it starts and ends when the page saw it.
    const at = new Date(Date.parse(row.observedAt)).toISOString()
    expect(events.every((e) => e.startedAt === at)).toBe(true)
    const ended = events[2]
    expect(ended.type === 'ended' && ended.endedAt).toBe(at)
  })

  it('registers its signal as an organization signal keyed on a partner', () => {
    expect(incidentSignal(PARTNER_LIVE_MISS_SIGNAL)).toMatchObject({ scope: 'org', subject: 'partner', windowMinutes: null })
  })

  it('says whose page saw it even when that person cannot be named, and names a partner that is gone', async () => {
    const row = miss({ reporterName: null, partnerName: null })
    const h = harness([row])
    await h.run()
    const body = text(h.posted[0])
    expect(body).toContain('Someone')
    expect(body).toContain('no longer in Bidspoke')
    expect(body).not.toContain('null')
  })

  it('records a miss of an organization with no Slack, or with alerts off, without posting or holding up the rest', async () => {
    const a = miss()
    const b = miss({ organizationId: '7e2f9c10-3b6d-4f55-8c2a-5a9e0d3b6c22' })
    const h = harness([a, b], { post: async (orgId) => (orgId === ORG ? { kind: 'not_posted', reason: 'no_slack' } : { kind: 'not_posted', reason: 'alerts_off' }) })
    const s = await h.run()
    expect(s.notPosted).toEqual([a.id, b.id])
    expect(JSON.parse(h.kv.store.get(LIVE_MISS_WATERMARK_KEY)!)).toEqual({ observedAt: b.observedAt, id: b.id })
    // Opened and stood down, never paged: nobody was told.
    expect(transitions(h.kv.store).filter((t) => t.startsWith('paged'))).toEqual([])
    expect(transitions(h.kv.store)).toHaveLength(4)
    expect(h.records[0]).toEqual({ outcome: 'ok', summary: expect.objectContaining({ not_posted: 2, posted: 0 }) })
  })
})

describe('a doubled tick', () => {
  it('posts once when two runs read the same miss at the same time', async () => {
    const row = miss()
    const kv = fakeKv()
    const claims = fakeClaims()
    const h = harness([row], { kv, claims })
    const [s1, s2] = await Promise.all([h.run(), h.run()])
    expect(h.post).toHaveBeenCalledTimes(1)
    expect([...s1.posted, ...s2.posted]).toEqual([row.id])
    expect([...s1.waiting, ...s2.waiting]).toEqual([row.id])
    // The winner moved the watermark past it, so the next tick reads nothing.
    const s3 = await h.run()
    expect(h.post).toHaveBeenCalledTimes(1)
    expect(s3.read).toBe(0)
    expect(JSON.parse(kv.store.get(LIVE_MISS_WATERMARK_KEY)!)).toEqual({ observedAt: row.observedAt, id: row.id })
  })

  it('does not post a miss another tick already sent once the claim lapsed (read again after claiming)', async () => {
    const row = miss()
    const h = harness([row])
    // Sent by a tick whose claim has since lapsed, between this tick's first read of the marker and its claim.
    let reads = 0
    h.kv.get.mockImplementation(async (k: string) => {
      if (k === liveMissSentKey(row.id)) {
        reads += 1
        return reads === 1 ? null : '{"at":"2026-10-26T17:59:00.000Z"}'
      }
      return h.kv.store.get(k) ?? null
    })
    const s = await h.run()
    expect(h.post).not.toHaveBeenCalled()
    expect(s.alreadySent).toEqual([row.id])
  })
})

describe('a miss on the test partner', () => {
  it('posts, and says first and plainly that it is a test alert needing no action', async () => {
    const row = miss({ partnerId: LIVE_MISS_TEST_PARTNER_ID, partnerName: 'Live miss test' })
    const h = harness([row])
    await h.run()
    expect(h.post).toHaveBeenCalledTimes(1)
    const n = h.posted[0]
    expect(n.title.startsWith('Test alert:')).toBe(true)
    expect(n.sections[0]).toMatch(/test alert/i)
    expect(n.sections[0]).toContain('#2220')
    expect(n.sections[0]).toContain('needs no action')
    // A test needs no fix.
    expect(text(n)).not.toContain('Fix:')
  })

  it('never says test on any other partner', () => {
    for (const cause of [...LIVE_MISS_CAUSES, 'something_new']) {
      const n = composeLiveMissNotice(miss({ cause }))
      expect(text(n), cause).not.toMatch(/test/i)
      expect(n.test).toBe(false)
    }
  })

  it('names the test partner in one constant', () => {
    expect(LIVE_MISS_TEST_PARTNER_ID).toBe('c21765df-776a-41a9-a291-9547afce4186')
  })
})

describe('the first run after deploy', () => {
  it('posts the deliberate miss of 2026-10-26 (row 6461826f) as a test alert: the initial watermark does not skip it', async () => {
    const h = harness([DELIBERATE_MISS])
    expect(h.kv.store.has(LIVE_MISS_WATERMARK_KEY)).toBe(false)
    const s = await h.run()
    expect(h.reader.calls[0].after).toEqual(LIVE_MISS_INITIAL_WATERMARK)
    expect(Date.parse(LIVE_MISS_INITIAL_WATERMARK.observedAt)).toBeLessThan(Date.parse(DELIBERATE_MISS.observedAt))
    expect(s.posted).toEqual([DELIBERATE_MISS.id])
    const n = h.posted[0]
    expect(n.title).toBe('Test alert: a partners page missed a live update')
    const body = text(n)
    expect(body).toContain('Live miss test')
    expect(body).toContain('Dan Hankins-Wright')
    expect(body).toContain(causeSentence('direct_sql'))
    expect(body).toContain('partner version 2')
    expect(body).toContain('version 3')
    expect(body).toContain('since it opened')
    expect(body).toContain('1:11 PM ET')
    expect(body).not.toMatch(DASH_PUNCTUATION)
  })
})

describe('a failed post', () => {
  it.each([
    // Slack's refusal is recorded as not delivered, against the miss's open incident (#3056).
    ['Slack refused it (ok:false)', async (): Promise<NoticePost> => ({ kind: 'failed', reason: 'Slack did not accept the post', refused: true }), ['opened', 'undelivered']],
    // A connection that could not be read was never tried, so it records nothing either.
    ['its Slack connection could not be read', async (): Promise<NoticePost> => ({ kind: 'failed', reason: 'the Slack connection could not be read: timeout' }), []],
    // A post that threw may have landed, so it is recorded as neither.
    ['the network failed (it threw)', async (): Promise<NoticePost> => { throw new Error('Network connection lost.') }, []],
  ])('is not marked sent when %s, and is posted on the next tick', async (_label, failing, recorded) => {
    const row = miss()
    let fail = true
    const sent: string[] = []
    const h = harness([row], {
      post: async (_org, n) => {
        if (fail) return failing()
        sent.push(n.title)
        return { kind: 'posted' }
      },
    })
    const s1 = await h.run()
    expect(s1.failed).toEqual([row.id])
    expect(h.kv.store.has(liveMissSentKey(row.id))).toBe(false)
    expect(h.kv.store.has(LIVE_MISS_WATERMARK_KEY)).toBe(false)
    expect(h.claims.held.size).toBe(0)
    expect(transitions(h.kv.store).map((t) => t.split(' ')[0])).toEqual(recorded)
    expect(h.records[0].outcome).toBe('post_failed')
    expect(isFailedRun(liveMissNoticeRunFailure(s1))).toBe(true)

    fail = false
    const s2 = await h.run()
    expect(s2.posted).toEqual([row.id])
    expect(sent).toHaveLength(1)
    expect(JSON.parse(h.kv.store.get(LIVE_MISS_WATERMARK_KEY)!)).toEqual({ observedAt: row.observedAt, id: row.id })
    expect(liveMissNoticeRunFailure(s2)).toBeUndefined()
  })

  it('holds the watermark at the failed miss while the misses after it still post', async () => {
    const a = miss()
    const b = miss({ organizationId: '7e2f9c10-3b6d-4f55-8c2a-5a9e0d3b6c22' })
    const c = miss()
    const h = harness([a, b, c], { post: async (orgId) => (orgId === ORG ? { kind: 'posted' } : { kind: 'failed', reason: 'refused' }) })
    const s = await h.run()
    expect(s.posted).toEqual([a.id, c.id])
    expect(s.failed).toEqual([b.id])
    expect(JSON.parse(h.kv.store.get(LIVE_MISS_WATERMARK_KEY)!)).toEqual({ observedAt: a.observedAt, id: a.id })
    // Next tick: b posts, c is already sent, and the watermark reaches c.
    const h2 = harness([a, b, c], { kv: h.kv, claims: h.claims })
    const s2 = await h2.run()
    expect(s2.posted).toEqual([b.id])
    expect(s2.alreadySent).toEqual([c.id])
    expect(JSON.parse(h.kv.store.get(LIVE_MISS_WATERMARK_KEY)!)).toEqual({ observedAt: c.observedAt, id: c.id })
  })
})

describe('a failed read', () => {
  it.each([
    ['the read answers an error', async (): Promise<LiveMissReading> => ({ ok: false, error: 'canceling statement due to statement timeout' })],
    ['the read throws', async (): Promise<LiveMissReading> => { throw new Error('fetch failed') }],
  ])('is recorded as unmeasured, never as no misses, when %s', async (_label, read) => {
    const h = harness([miss()])
    const s = await h.run({ read })
    expect(h.post).not.toHaveBeenCalled()
    expect(s.outcome).toBe('unmeasured')
    expect(h.records).toEqual([{ outcome: 'unmeasured', summary: expect.objectContaining({ reason: expect.stringMatching(/timeout|fetch failed/) }) }])
    expect(h.records[0].summary).not.toHaveProperty('read')
    expect(h.kv.store.has(LIVE_MISS_WATERMARK_KEY)).toBe(false)
    expect(isFailedRun(liveMissNoticeRunFailure(s))).toBe(true)
  })

  it('is unmeasured when the watermark cannot be read, rather than starting again from the beginning', async () => {
    const h = harness([miss()])
    h.kv.get.mockImplementation(async (k: string) => {
      if (k === LIVE_MISS_WATERMARK_KEY) throw new Error('KV unavailable')
      return null
    })
    const s = await h.run()
    expect(h.reader.read).not.toHaveBeenCalled()
    expect(h.post).not.toHaveBeenCalled()
    expect(s.outcome).toBe('unmeasured')
    expect(h.records[0].outcome).toBe('unmeasured')
  })

  it('is unmeasured when the stored watermark does not read as one', async () => {
    const h = harness([miss()])
    h.kv.store.set(LIVE_MISS_WATERMARK_KEY, '{"observedAt":"not a time","id":null}')
    const s = await h.run()
    expect(h.post).not.toHaveBeenCalled()
    expect(s.outcome).toBe('unmeasured')
  })
})

describe('the cause in plain words', () => {
  it('maps every cause the page writes to its own sentence, never the raw value', () => {
    const sentences = LIVE_MISS_CAUSES.map((c) => causeSentence(c))
    expect(new Set(sentences).size).toBe(LIVE_MISS_CAUSES.length)
    for (const [i, cause] of LIVE_MISS_CAUSES.entries()) {
      expect(sentences[i], cause).not.toContain(cause)
      expect(sentences[i], cause).toMatch(/^[A-Z].*\.$/)
    }
    expect(causeSentence('direct_sql')).toMatch(/directly in the database/)
    expect(causeSentence('delivery')).toMatch(/Realtime lost/)
    expect(causeSentence('missing_partition')).toMatch(/live channel was missing/)
  })

  it('names an unknown cause as it is', () => {
    expect(causeSentence('socket_gremlin')).toContain('"socket_gremlin"')
    const n = composeLiveMissNotice(miss({ cause: 'socket_gremlin' }))
    expect(text(n)).toContain('socket_gremlin')
  })

  it('says nothing about versions for a page that could not join, since it compared none', () => {
    const n = composeLiveMissNotice(miss({ cause: 'missing_partition', observed: { partnerVersion: null, profileVersion: null }, sinceLastNoticeMs: null }))
    expect(text(n)).not.toMatch(/version/)
    expect(text(n)).toContain(causeSentence('missing_partition'))
  })
})

describe('the bound on one tick', () => {
  it(`reads at most ${LIVE_MISS_NOTICE_BATCH} misses a tick; the rest wait for the next`, async () => {
    const rows = Array.from({ length: LIVE_MISS_NOTICE_BATCH + 5 }, () => miss())
    const h = harness(rows)
    const s1 = await h.run()
    expect(h.reader.calls[0].limit).toBe(LIVE_MISS_NOTICE_BATCH)
    expect(s1.posted).toHaveLength(LIVE_MISS_NOTICE_BATCH)
    expect(s1.more).toBe(true)
    const s2 = await h.run()
    expect(s2.posted).toEqual(rows.slice(LIVE_MISS_NOTICE_BATCH).map((r) => r.id))
    expect(s2.more).toBe(false)
    expect(h.post).toHaveBeenCalledTimes(rows.length)
  })

  it('posts no more than the bound even when a read hands back more than it asked for', async () => {
    const rows = Array.from({ length: LIVE_MISS_NOTICE_BATCH + 5 }, () => miss())
    const h = harness(rows)
    const s = await h.run({ read: async () => ({ ok: true, rows }) })
    expect(s.posted).toHaveLength(LIVE_MISS_NOTICE_BATCH)
    expect(s.more).toBe(true)
    expect(JSON.parse(h.kv.store.get(LIVE_MISS_WATERMARK_KEY)!).id).toBe(rows[LIVE_MISS_NOTICE_BATCH - 1].id)
  })

  it('asks the database for a bounded, ordered page strictly after the watermark', async () => {
    const q = fakeQuery({ data: [], error: null })
    await readLiveMisses(q.client, LIVE_MISS_INITIAL_WATERMARK, LIVE_MISS_NOTICE_BATCH)
    expect(q.calls).toContainEqual(['from', 'partner_page_live_misses'])
    const w = LIVE_MISS_INITIAL_WATERMARK
    expect(q.calls).toContainEqual(['or', `observed_at.gt."${w.observedAt}",and(observed_at.eq."${w.observedAt}",id.gt.${w.id})`])
    expect(q.calls).toContainEqual(['order', 'observed_at', { ascending: true }])
    expect(q.calls).toContainEqual(['order', 'id', { ascending: true }])
    expect(q.calls).toContainEqual(['limit', LIVE_MISS_NOTICE_BATCH])

    const q2 = fakeQuery({ data: [], error: null })
    await readLiveMisses(q2.client, { observedAt: DELIBERATE_MISS.observedAt, id: DELIBERATE_MISS.id }, 5)
    expect(q2.calls).toContainEqual(['or', `observed_at.gt."${DELIBERATE_MISS.observedAt}",and(observed_at.eq."${DELIBERATE_MISS.observedAt}",id.gt.${DELIBERATE_MISS.id})`])
  })

  it('reads the partner name and the reporter inside the miss\'s own organization', async () => {
    const q = fakeQuery({
      data: [{
        id: DELIBERATE_MISS.id, organization_id: ORG, partner_id: LIVE_MISS_TEST_PARTNER_ID, reported_by: 'u1', cause: 'direct_sql',
        noticed_partner_version: 2, noticed_profile_version: 0, observed_partner_version: 3, observed_profile_version: 0,
        since_last_notice_ms: null, observed_at: DELIBERATE_MISS.observedAt,
      }],
      error: null,
    }, {
      partner_configs: [{ id: LIVE_MISS_TEST_PARTNER_ID, name: 'Live miss test', organization_id: ORG }],
      users: [{ id: 'u1', display_name: 'Dan Hankins-Wright', email: 'dan@example.com', organization_id: ORG }],
    })
    const r = await readLiveMisses(q.client, LIVE_MISS_INITIAL_WATERMARK, 20)
    expect(r).toEqual({ ok: true, rows: [DELIBERATE_MISS] })

    // A name held by another organization is never shown.
    const q2 = fakeQuery({ data: q.data, error: null }, {
      partner_configs: [{ id: LIVE_MISS_TEST_PARTNER_ID, name: 'Elsewhere', organization_id: 'other' }],
      users: [{ id: 'u1', display_name: null, email: 'dan@example.com', organization_id: ORG }],
    })
    const r2 = await readLiveMisses(q2.client, LIVE_MISS_INITIAL_WATERMARK, 20)
    expect(r2.ok && r2.rows[0]).toMatchObject({ partnerName: null, reporterName: 'dan@example.com' })
  })

  it('answers a failed read of any of its three tables as a failed reading', async () => {
    for (const failing of ['partner_page_live_misses', 'partner_configs', 'users']) {
      const q = fakeQuery({
        data: [{ id: 'm1', organization_id: ORG, partner_id: PARTNER, reported_by: 'u1', cause: 'delivery', noticed_partner_version: 1, noticed_profile_version: 0, observed_partner_version: 2, observed_profile_version: 0, since_last_notice_ms: 5, observed_at: '2026-10-26T17:30:00+00:00' }],
        error: null,
      }, { partner_configs: [], users: [] }, failing)
      const r = await readLiveMisses(q.client, LIVE_MISS_INITIAL_WATERMARK, 20)
      expect(r.ok, failing).toBe(false)
    }
  })
})

describe('the run around it', () => {
  it('is a five minute job the heartbeat watches and whose failed runs are counted', () => {
    const job = cronJob(PARTNER_LIVE_MISS_NOTICE_JOB)
    expect(job?.triggerCron).toBe('*/5 * * * *')
    expect(countsFailedRuns(PARTNER_LIVE_MISS_NOTICE_JOB)).toBe(true)
  })

  it('posts nothing from local dev, which shares the production database', async () => {
    const h = harness([miss()])
    const s = await h.run({ localDev: true })
    expect(h.reader.read).not.toHaveBeenCalled()
    expect(h.post).not.toHaveBeenCalled()
    expect(s.mode).toBe('silent')
  })
})

// A recording fake of the supabase query builder: every call in order, and the
// answer each table gives (or an error for the one named failing).
function fakeQuery(misses: { data: unknown; error: unknown }, lookups: Record<string, unknown[]> = {}, failing?: string) {
  const calls: unknown[][] = []
  const client = {
    from(table: string) {
      calls.push(['from', table])
      const answer = () => {
        if (table === failing) return { data: null, error: { message: `${table} read failed` } }
        if (table === 'partner_page_live_misses') return misses
        return { data: lookups[table] ?? [], error: null }
      }
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'or', 'order', 'limit', 'in', 'eq']) {
        builder[m] = (...args: unknown[]) => {
          calls.push([m, ...args])
          return builder
        }
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject)
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls, data: misses.data }
}
