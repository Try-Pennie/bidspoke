/**
 * The cron tick guard's own outcomes reach someone (#1904).
 *
 * The guard from #1899 logs `FAILED OPEN` when its claim object does not answer
 * (the jobs then run unguarded) and `skipped duplicate` for every second copy of
 * a tick it drops. Both lived only in Workers Logs. Each is now recorded in KV,
 * one key per event so two at once cannot overwrite each other's count, and an
 * hourly check pages once a day per kind: 20 fail-opens (#2284, well above the
 * measured 4 a day), or 30 duplicates, in the last 24 hours. A count it cannot
 * read is reported as unreadable, never as zero (L98). KV is the record because
 * a fail-open is the claim object being unreachable, so the object cannot count
 * its own outage (L345).
 *
 * A fail-open does no harm by itself (#2284): harm needs its tick run by a
 * second delivery too. So the check also reads the durable record of every
 * delivery (cron_tick_deliveries) and pages at once for a tick two deliveries
 * both ran, and says so when that record cannot be read or is not whole.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  recordCronGuardEvent,
  countCronGuardEvents,
  runCronGuardWatch,
  CRON_GUARD_THRESHOLDS,
  FAIL_OPENS_PER_DAY_MEASURED,
  cronGuardPagedKey,
  cronGuardMessage,
  doubleRunMessage,
  findDoubledTicks,
  TAIL_COPY_LAG_MS,
  supabaseTailCopyReader,
  supabaseDeliveryReader,
  type CronGuardKind,
  type CronGuardPage,
  type CronGuardMessage,
  type CronGuardResult,
  type TickDelivery,
} from '../cron-guard-watch'

const NOW = Date.parse('2026-10-14T15:00:00.000Z')
const H = 60 * 60 * 1000

/** KV held in a Map, with list by prefix in pages, as the real namespace lists. */
function memoryKv(pageSize = 1000) {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  return {
    store,
    ttls,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, o?: { expirationTtl?: number }) => { store.set(k, v); ttls.set(k, o?.expirationTtl) }),
    list: vi.fn(async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const page = keys.slice(start, start + pageSize)
      const next = start + pageSize
      return next < keys.length
        ? { keys: page.map((name) => ({ name })), list_complete: false, cursor: String(next) }
        : { keys: page.map((name) => ({ name })), list_complete: true }
    }),
  }
}

async function record(kv: ReturnType<typeof memoryKv>, kind: CronGuardKind, times: number[]) {
  for (const t of times) await recordCronGuardEvent(kv, kind, t)
}

describe('recordCronGuardEvent', () => {
  it('writes one key per event, so two events in the same millisecond are both kept', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', [NOW, NOW])
    expect(await countCronGuardEvents(kv, 'failed_open', NOW)).toEqual({ count: 2, capped: false })
  })

  it('expires each record after two days, so the keys never pile up', async () => {
    const kv = memoryKv()
    await recordCronGuardEvent(kv, 'skipped_duplicate', NOW)
    expect([...kv.ttls.values()]).toEqual([2 * 24 * 60 * 60])
  })
})

describe('countCronGuardEvents', () => {
  it('counts only the last 24 hours, and only the kind asked for', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', [NOW - 25 * H, NOW - 23 * H, NOW - 1 * H])
    await record(kv, 'skipped_duplicate', [NOW - 1 * H])
    expect(await countCronGuardEvents(kv, 'failed_open', NOW)).toEqual({ count: 2, capped: false })
  })

  it('follows the list across pages', async () => {
    const kv = memoryKv(2)
    await record(kv, 'skipped_duplicate', [1, 2, 3, 4, 5].map((m) => NOW - m * 60_000))
    expect(await countCronGuardEvents(kv, 'skipped_duplicate', NOW)).toEqual({ count: 5, capped: false })
  })

  it('stops at its page limit and says the count is a floor', async () => {
    const kv = memoryKv(2)
    await record(kv, 'skipped_duplicate', [1, 2, 3, 4, 5].map((m) => NOW - m * 60_000))
    const r = await countCronGuardEvents(kv, 'skipped_duplicate', NOW, { maxPages: 2 })
    expect(r).toEqual({ count: 4, capped: true })
  })

  // Lessons review, 2026-10-14: keys named by ISO time list oldest first, so a
  // capped count read the 24 to 48 hour old keys the window then discarded.
  it('reads the newest first, so a capped count is a floor of the window and never spent on expired keys', async () => {
    const kv = memoryKv(2)
    await record(kv, 'skipped_duplicate', [25, 30, 40, 47].map((h) => NOW - h * H))
    await record(kv, 'skipped_duplicate', [1, 2, 3, 4, 5].map((m) => NOW - m * 60_000))
    expect(await countCronGuardEvents(kv, 'skipped_duplicate', NOW, { maxPages: 2 })).toEqual({ count: 4, capped: true })
  })

  it('stops listing at the first key older than the window', async () => {
    const kv = memoryKv(2)
    await record(kv, 'skipped_duplicate', [25, 30, 40, 47].map((h) => NOW - h * H))
    await record(kv, 'skipped_duplicate', [1, 2].map((m) => NOW - m * 60_000))
    expect(await countCronGuardEvents(kv, 'skipped_duplicate', NOW)).toEqual({ count: 2, capped: false })
    expect(kv.list).toHaveBeenCalledTimes(2)
  })

  it('throws when the list fails, rather than answering zero', async () => {
    const kv = memoryKv()
    kv.list.mockRejectedValueOnce(new Error('KV list 503'))
    await expect(countCronGuardEvents(kv, 'failed_open', NOW)).rejects.toThrow(/KV list 503/)
  })
})


/** The tail worker's copy of the FAILED OPEN lines (#2166), as the live reader returns it. */
function tailCopy(events: Array<{ id: string; atMs: number }> = []) {
  return vi.fn(async (sinceMs: number, nowMs: number) => ({
    events: events.filter((e) => e.atMs > sinceMs && e.atMs <= nowMs),
    capped: false,
  }))
}

const MIN = 60_000

/** One delivery of a tick, as the record of deliveries holds it. */
function delivery(o: Partial<TickDelivery> & { scheduledAtMs: number }): TickDelivery {
  return { id: `d-${o.scheduledAtMs}-${Math.random()}`, cron: '* * * * *', outcome: 'ran', invocationOutcome: 'ok', atMs: o.scheduledAtMs + 500, ...o }
}

/** A whole day of the minute tick, each delivered and run once: the healthy record. */
function wholeDay(): TickDelivery[] {
  const out: TickDelivery[] = []
  for (let t = NOW - 24 * H + MIN; t <= NOW - MIN; t += MIN) out.push(delivery({ scheduledAtMs: t, id: `day-${t}` }))
  return out
}

function deliveryRecord(extra: TickDelivery[] = [], base: TickDelivery[] = wholeDay()) {
  return vi.fn(async (_sinceMs: number, _nowMs: number) => ({ deliveries: [...base, ...extra], capped: false }))
}

function deps(kv: ReturnType<typeof memoryKv>, opts: { delivered?: boolean; tail?: ReturnType<typeof tailCopy>; deliveries?: ReturnType<typeof deliveryRecord> } = {}) {
  const sent: Array<{ page: CronGuardPage; message: CronGuardMessage }> = []
  const lines: string[] = []
  const errs: string[] = []
  return {
    sent,
    pages: () => sent.map((s) => s.page),
    lines,
    errs,
    d: {
      kv,
      now: () => NOW,
      tailFailOpens: opts.tail ?? tailCopy(),
      deliveries: opts.deliveries ?? deliveryRecord(),
      send: vi.fn(async (page: CronGuardPage, message: CronGuardMessage) => {
        sent.push({ page, message })
        return opts.delivered ?? true
      }),
      log: (l: string) => { lines.push(l) },
      error: (l: string) => { errs.push(l) },
    },
  }
}

const hoursAgo = (n: number) => Array.from({ length: n }, (_, i) => NOW - (i + 1) * 60 * MIN + 7_000)

describe('runCronGuardWatch: fail-opens page on their rate alone (#2284)', () => {
  // Measured: about 4 fail-opens a day (6 in 33 hours on 2026-10-15 to 16; 3
  // on 2026-10-16; 2 by 15:30 UTC on 2026-10-17), the highest 24 hours 5, all
  // claim timeouts on ticks that ran once. A claim store that is really down
  // fails the minute tick 60 times an hour.
  it('holds the thresholds: 20 fail-opens, 30 duplicates', () => {
    expect(CRON_GUARD_THRESHOLDS).toEqual({ failed_open: 20, skipped_duplicate: 30 })
    expect(FAIL_OPENS_PER_DAY_MEASURED).toBe(4)
  })

  it('posts nothing for an ordinary day of 5 fail-opens on ticks that ran once, and logs the count', async () => {
    const kv = memoryKv()
    const times = hoursAgo(5)
    await record(kv, 'failed_open', times)
    // Each of those ticks was delivered once, and that delivery failed open.
    const day = wholeDay().map((d) => (times.some((t) => Math.abs(t - d.atMs) < MIN) ? { ...d, outcome: 'failed_open' as const } : d))
    const t = deps(kv, { deliveries: deliveryRecord([], day) })
    const r = await runCronGuardWatch(t.d)
    expect(t.sent).toEqual([])
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'under', count: 5, alerted: false })
    expect(t.lines.join('\n')).toMatch(/kind=failed_open count=5 threshold=20/)
  })

  it('pages at 20 fail-opens in 24 hours and not at 19', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', hoursAgo(19))
    const below = deps(kv)
    await runCronGuardWatch(below.d)
    expect(below.sent).toEqual([])

    await record(kv, 'failed_open', [NOW - 30 * MIN])
    const at = deps(kv)
    const r = await runCronGuardWatch(at.d)
    expect(at.pages()).toEqual(['failed_open'])
    expect(at.sent[0].message.title).toBe('Cron guard keeps failing open')
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'over', count: 20, alerted: true })
  })

  it('pages at 30 duplicates and not at 29', async () => {
    const kv = memoryKv()
    await record(kv, 'skipped_duplicate', Array.from({ length: 29 }, (_, i) => NOW - (i + 1) * MIN))
    const below = deps(kv)
    await runCronGuardWatch(below.d)
    expect(below.sent).toEqual([])

    await record(kv, 'skipped_duplicate', [NOW - 40 * MIN])
    const at = deps(kv)
    await runCronGuardWatch(at.d)
    expect(at.pages()).toEqual(['skipped_duplicate'])
  })

  it('pages once a day per kind: a second run inside the day is quiet, the other kind still pages', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', Array.from({ length: 20 }, () => NOW - H))
    await runCronGuardWatch(deps(kv).d)
    expect(kv.ttls.get(cronGuardPagedKey('failed_open'))).toBe(24 * 60 * 60)

    await record(kv, 'skipped_duplicate', Array.from({ length: 30 }, () => NOW - H))
    const second = deps(kv)
    await runCronGuardWatch(second.d)
    expect(second.pages()).toEqual(['skipped_duplicate'])
  })

  it('arms the daily quiet only on delivery, so a Slack outage does not buy a day of silence', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', Array.from({ length: 20 }, () => NOW - H))
    await runCronGuardWatch(deps(kv, { delivered: false }).d)
    expect(kv.store.has(cronGuardPagedKey('failed_open'))).toBe(false)
    const retry = deps(kv)
    await runCronGuardWatch(retry.d)
    expect(retry.pages()).toEqual(['failed_open'])
  })

  it('reports an unreadable count as unreadable, logs it at error level, and still judges the other kinds', async () => {
    const kv = memoryKv()
    await record(kv, 'skipped_duplicate', Array.from({ length: 30 }, () => NOW - H))
    const realList = kv.list.getMockImplementation()!
    kv.list.mockImplementation(async (o: { prefix: string; cursor?: string }) => {
      if (o.prefix.includes('failed_open')) throw new Error('KV list 503')
      return realList(o)
    })
    const tail = tailCopy()
    tail.mockRejectedValue(new Error('PGRST 503'))
    const t = deps(kv, { tail })
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'unreadable' })
    expect(r.find((x) => x.kind === 'failed_open')).not.toHaveProperty('count')
    expect(t.errs.join('\n')).toMatch(/could not count failed_open.*KV list 503/)
    expect(t.errs.join('\n')).toMatch(/could not read the tail worker's copy.*PGRST 503/)
    expect(t.pages()).toEqual(['skipped_duplicate'])
  })

  it('a send that throws is logged and leaves the quiet unarmed, never aborting the other kinds', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', Array.from({ length: 20 }, () => NOW - H))
    await record(kv, 'skipped_duplicate', Array.from({ length: 30 }, () => NOW - H))
    const t = deps(kv)
    t.d.send.mockImplementationOnce(async () => { throw new Error('slack down') })
    const r = await runCronGuardWatch(t.d)
    expect(kv.store.has(cronGuardPagedKey('failed_open'))).toBe(false)
    expect(t.errs.join('\n')).toMatch(/failed_open.*slack down/)
    expect(r.find((x) => x.kind === 'skipped_duplicate')).toMatchObject({ alerted: true })
  })
})

// #2284: a fail-open does no harm by itself; harm needs the same tick run by a
// second delivery too. So the check pages on that, read from the durable record
// of every delivery (cron_tick_deliveries), never on a skip count or a log search.
describe('runCronGuardWatch: a tick that may have run twice pages at once (#2284)', () => {
  const tick = NOW - 3 * H + 12_000

  it('pages for a fail-open whose tick a second delivery also ran', async () => {
    const t = deps(memoryKv(), { deliveries: deliveryRecord([
      delivery({ scheduledAtMs: tick, cron: '0 9 * * *', outcome: 'failed_open', atMs: tick + 2_100 }),
      delivery({ scheduledAtMs: tick + 36_000, cron: '0 9 * * *', outcome: 'ran', atMs: tick + 36_050 }),
    ]) })
    const r = await runCronGuardWatch(t.d)
    expect(t.pages()).toEqual(['double_run'])
    expect(t.sent[0].message.title).toBe('A cron tick may have run twice')
    expect(r.find((x) => x.kind === 'double_run')).toMatchObject({ status: 'doubled', doubled: 1, alerted: true })
  })

  it('pages for a takeover of a run that was still alive, its lease lapsed (2026-10-17 09:00 UTC renewals)', async () => {
    const t = deps(memoryKv(), { deliveries: deliveryRecord([
      delivery({ scheduledAtMs: tick, cron: '0 9 * * *', outcome: 'ran', invocationOutcome: 'ok', atMs: tick + 100 }),
      delivery({ scheduledAtMs: tick, cron: '0 9 * * *', outcome: 'took_over', atMs: tick + 30_000 }),
    ]) })
    await runCronGuardWatch(t.d)
    expect(t.pages()).toEqual(['double_run'])
    expect(t.sent[0].message.errors[0]).toMatch(/took it over while the first was still running/)
  })

  it('does not page for the retry of a run Cloudflare killed, nor for a second delivery the guard skipped', async () => {
    const t = deps(memoryKv(), { deliveries: deliveryRecord([
      delivery({ scheduledAtMs: tick, cron: '0 9 * * *', outcome: 'ran', invocationOutcome: 'canceled', atMs: tick + 100 }),
      delivery({ scheduledAtMs: tick, cron: '0 9 * * *', outcome: 'took_over', atMs: tick + 40_000 }),
      delivery({ scheduledAtMs: tick + 2 * H, cron: '0 * * * *', outcome: 'ran', atMs: tick + 2 * H + 100 }),
      delivery({ scheduledAtMs: tick + 2 * H + 36_000, cron: '0 * * * *', outcome: 'skipped', atMs: tick + 2 * H + 36_100 }),
    ]) })
    const r = await runCronGuardWatch(t.d)
    expect(t.sent).toEqual([])
    expect(r.find((x) => x.kind === 'double_run')).toMatchObject({ status: 'none', alerted: false })
  })

  it('pages a doubled tick once, and again only for a tick it has not paged', async () => {
    const kv = memoryKv()
    const first = [
      delivery({ id: 'a1', scheduledAtMs: tick, cron: '0 9 * * *', outcome: 'failed_open' }),
      delivery({ id: 'a2', scheduledAtMs: tick + 36_000, cron: '0 9 * * *', outcome: 'ran' }),
    ]
    await runCronGuardWatch(deps(kv, { deliveries: deliveryRecord(first) }).d)
    const again = deps(kv, { deliveries: deliveryRecord(first) })
    await runCronGuardWatch(again.d)
    expect(again.sent).toEqual([])

    const second = [
      delivery({ id: 'b1', scheduledAtMs: tick + H, cron: '23 * * * *', outcome: 'failed_open' }),
      delivery({ id: 'b2', scheduledAtMs: tick + H + 36_000, cron: '23 * * * *', outcome: 'ran' }),
    ]
    const later = deps(kv, { deliveries: deliveryRecord([...first, ...second]) })
    await runCronGuardWatch(later.d)
    expect(later.pages()).toEqual(['double_run'])
    expect(later.sent[0].message.errors).toHaveLength(1)
    expect(later.sent[0].message.errors[0]).toMatch(/every hour at :23/)
  })

  // L90, L98: a record that cannot be read, or holds nothing, must never read as "no tick ran twice".
  it('pages that it could not check when the record of deliveries cannot be read, and says why', async () => {
    const deliveries = deliveryRecord()
    deliveries.mockRejectedValue(new Error('relation "cron_tick_deliveries" does not exist'))
    const t = deps(memoryKv(), { deliveries })
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'double_run')).toMatchObject({ status: 'unreadable' })
    expect(t.pages()).toEqual(['double_run'])
    expect(t.sent[0].message.title).toBe('Cron guard could not check for a tick run twice')
    expect(t.sent[0].message.errors[0]).toMatch(/could not be read \(relation "cron_tick_deliveries" does not exist\)/)
    expect(t.errs.join('\n')).toMatch(/could not read the record of cron deliveries/)
  })

  it('pages that it could not check when the record holds no deliveries at all', async () => {
    const t = deps(memoryKv(), { deliveries: deliveryRecord([], []) })
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'double_run')).toMatchObject({ status: 'incomplete' })
    expect(t.sent[0].message.errors[0]).toMatch(/holds no deliveries/)
  })

  it('pages that it could not check when the record is missing more than a tenth of the minute tick, and not at 90 percent', async () => {
    const day = wholeDay()
    // The span judged is from the first minute held to 10 minutes ago (the tail copy's lag).
    const judged = day.filter((d) => d.scheduledAtMs <= NOW - TAIL_COPY_LAG_MS)
    const expected = judged.length
    const keepEvery = (n: number) => day.filter((_, i) => i === 0 || i % n !== 0)
    // Dropping every 10th minute keeps 90 percent: whole enough.
    const ninety = deps(memoryKv(), { deliveries: deliveryRecord([], keepEvery(10)) })
    await runCronGuardWatch(ninety.d)
    expect(ninety.sent).toEqual([])
    // Dropping every 5th keeps 80 percent.
    const eighty = deps(memoryKv(), { deliveries: deliveryRecord([], keepEvery(5)) })
    const r = await runCronGuardWatch(eighty.d)
    expect(r.find((x) => x.kind === 'double_run')).toMatchObject({ status: 'incomplete' })
    expect(eighty.sent[0].message.errors[0]).toMatch(/holds 1,1\d\d of the last 1,4\d\d minutes/)
    expect(expected).toBeGreaterThan(1_400)
  })

  // The hour #2284 shipped: the table began filling three minutes before the
  // hourly run, every row was inside the tail copy's lag, and the run paged
  // "holds 0 of the last 1,430 minutes".
  it('does not page a record that only started filling inside the tail copy lag', async () => {
    const young: TickDelivery[] = []
    for (let t = NOW - 3 * MIN; t <= NOW - MIN; t += MIN) young.push(delivery({ scheduledAtMs: t }))
    const t = deps(memoryKv(), { deliveries: deliveryRecord([], young) })
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'double_run')).toMatchObject({ status: 'none' })
    expect(t.sent).toEqual([])
    expect(t.lines.join('\n')).toMatch(/minute_coverage=0\/0/)
  })

  it('judges a record that started an hour and more ago on the span since its first minute', async () => {
    const started = NOW - 2 * H
    const since = (keep: (i: number) => boolean) => {
      const out: TickDelivery[] = []
      for (let t = started, i = 0; t <= NOW - MIN; t += MIN, i++) if (keep(i)) out.push(delivery({ scheduledAtMs: t }))
      return out
    }
    const whole = deps(memoryKv(), { deliveries: deliveryRecord([], since(() => true)) })
    await runCronGuardWatch(whole.d)
    expect(whole.sent).toEqual([])
    // Half of the two hours missing pages, measured on those two hours, not the day.
    const half = deps(memoryKv(), { deliveries: deliveryRecord([], since((i) => i % 2 === 0)) })
    await runCronGuardWatch(half.d)
    expect(half.sent[0].message.errors[0]).toMatch(/holds \d\d of the last 11\d minutes/)
  })

  it('pages that it could not check once a day, not every hour', async () => {
    const kv = memoryKv()
    const deliveries = deliveryRecord()
    deliveries.mockRejectedValue(new Error('PGRST 503'))
    await runCronGuardWatch(deps(kv, { deliveries }).d)
    const again = deps(kv, { deliveries })
    await runCronGuardWatch(again.d)
    expect(again.sent).toEqual([])
  })

  // Lessons review on #2284: both signals once shared one quiet key, rewritten
  // with a fresh day on every newly paged tick, so a double run page pushed the
  // "could not check" page back a day each time it fired.
  it('a double run page never delays the could-not-check page: each has its own quiet', async () => {
    // KV that expires keys on the watch's own clock, as the real namespace does.
    const clock = { t: NOW }
    const store = new Map<string, { v: string; until: number }>()
    const kv = {
      get: vi.fn(async (k: string) => { const e = store.get(k); return e && e.until > clock.t ? e.v : null }),
      put: vi.fn(async (k: string, v: string, o?: { expirationTtl?: number }) => { store.set(k, { v, until: clock.t + (o?.expirationTtl ?? 1e9) * 1000 }) }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    }
    const unreadable = deliveryRecord()
    unreadable.mockRejectedValue(new Error('PGRST 503'))
    const run = async (deliveries: ReturnType<typeof deliveryRecord>) => {
      const sent: string[] = []
      await runCronGuardWatch({
        kv, now: () => clock.t, tailFailOpens: tailCopy(), deliveries,
        send: async (_p, m) => { sent.push(m.title); return true },
        log: () => {}, error: () => {},
      })
      return sent
    }
    const doubledAt = (at: number, id: string) => deliveryRecord([
      delivery({ id: `${id}-1`, scheduledAtMs: at, cron: '23 * * * *', outcome: 'failed_open', atMs: at + 100 }),
      delivery({ id: `${id}-2`, scheduledAtMs: at + 36_000, cron: '23 * * * *', outcome: 'ran', atMs: at + 36_100 }),
    ], [])

    expect(await run(unreadable)).toEqual(['Cron guard could not check for a tick run twice'])
    // 23 hours on, a tick runs twice and pages. The record is fine for that run.
    clock.t = NOW + 23 * H
    expect(await run(doubledAt(clock.t - 10 * MIN, 'a'))).toEqual(['A cron tick may have run twice'])
    // 24 hours after the first could-not-check page, the record fails again: it pages again.
    clock.t = NOW + 24 * H + MIN
    expect(await run(unreadable)).toEqual(['Cron guard could not check for a tick run twice'])
  })

  it('logs the record on every run, a quiet one included', async () => {
    const t = deps(memoryKv())
    await runCronGuardWatch(t.d)
    expect(t.lines.join('\n')).toMatch(/kind=double_run deliveries=1439 ran=1439 doubled=0 minute_coverage=\d+\/\d+/)
  })

  it('asks the record for the same 24 hour window the counts use', async () => {
    const deliveries = deliveryRecord()
    await runCronGuardWatch(deps(memoryKv(), { deliveries }).d)
    expect(deliveries).toHaveBeenCalledWith(NOW - 24 * H, NOW)
  })
})

describe('findDoubledTicks', () => {
  it('keys a tick by its cron and scheduled minute, the same key the guard claims', () => {
    const at = Date.parse('2026-10-17T15:15:32.618Z')
    const doubled = findDoubledTicks([
      delivery({ scheduledAtMs: at, cron: '*/5 * * * *', outcome: 'failed_open' }),
      delivery({ scheduledAtMs: at + 20_000, cron: '*/5 * * * *', outcome: 'ran' }),
      // the same minute of a different cron is a different tick
      delivery({ scheduledAtMs: at, cron: '*/15 * * * *', outcome: 'ran' }),
    ])
    expect(doubled.map((d) => [d.tick, d.how, d.runs.length])).toEqual([['cron-tick:*/5 * * * *@2026-10-17T15:15Z', 'failed_open', 2]])
  })

  it('counts a run with no outcome from Cloudflare as one that may have finished', () => {
    const doubled = findDoubledTicks([
      delivery({ scheduledAtMs: NOW - H, outcome: 'ran', invocationOutcome: null, atMs: NOW - H + 1 }),
      delivery({ scheduledAtMs: NOW - H, outcome: 'took_over', atMs: NOW - H + 20_000 }),
    ])
    expect(doubled).toHaveLength(1)
  })
})

// #2166: on 2026-10-14 the KV put recording each fail-open failed in the same
// blip that made the guard fail open, so 9 FAILED OPEN lines were counted as 3.
// The tail worker copies every FAILED OPEN line into the database by its event
// id, and the check counts the union of the two records.
describe('runCronGuardWatch counts a fail-open from either record (#2166)', () => {
  const recordWithIds = async (kv: ReturnType<typeof memoryKv>, events: Array<{ id: string; atMs: number }>) => {
    for (const e of events) await recordCronGuardEvent(kv, 'failed_open', e.atMs, e.id)
  }
  const many = Array.from({ length: 24 }, (_, i) => ({ id: `ev-${i}`, atMs: NOW - (i + 1) * 50 * MIN }))
  const failOpen = (r: CronGuardResult[]) => r.find((x) => x.kind === 'failed_open')

  it('a day of 24 fail-opens, only 3 recorded in KV, counts 24 and pages', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, many.slice(21))
    const t = deps(kv, { tail: tailCopy(many) })
    const r = await runCronGuardWatch(t.d)
    expect(t.pages()).toEqual(['failed_open'])
    expect(failOpen(r)).toMatchObject({ status: 'over', count: 24, alerted: true })
    expect(t.sent[0].message.errors[1]).toMatch(/could not write its own record of 21 of them/)
  })

  it('a fail-open in both records counts once', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, many.slice(0, 2))
    const t = deps(kv, { tail: tailCopy(many.slice(0, 2)) })
    const r = await runCronGuardWatch(t.d)
    expect(failOpen(r)).toMatchObject({ status: 'under', count: 2 })
  })

  it('asks the tail copy for the same 24 hour window the KV count uses', async () => {
    const tail = tailCopy()
    await runCronGuardWatch(deps(memoryKv(), { tail }).d)
    expect(tail).toHaveBeenCalledWith(NOW - 24 * H, NOW)
  })

  it('logs both records on every run, so a copy that stops keeping up is visible on a quiet day', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, many.slice(0, 1))
    const t = deps(kv, { tail: tailCopy(many.slice(1, 2)) })
    await runCronGuardWatch(t.d)
    expect(t.lines.join('\n')).toMatch(/kind=failed_open count=2 threshold=20 guard_record=1 tail_copy=1 only_in_tail_copy=1 missing_from_tail_copy=1/)
  })

  it('a tail copy it cannot read leaves the KV count standing, says so, and calls it a floor', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, many.slice(0, 3))
    const tail = tailCopy()
    tail.mockRejectedValue(new Error('PGRST 503'))
    const t = deps(kv, { tail })
    const r = await runCronGuardWatch(t.d)
    expect(t.errs.join('\n')).toMatch(/could not read the tail worker's copy of failed_open.*PGRST 503/)
    expect(failOpen(r)).toMatchObject({ status: 'under', count: 3, capped: true })
    expect(t.lines.join('\n')).toMatch(/tail_copy=unreadable/)
  })

  it('a KV record it cannot read leaves the tail copy count standing, rather than the whole count going unreadable', async () => {
    const kv = memoryKv()
    kv.list.mockRejectedValue(new Error('KV list 503'))
    const t = deps(kv, { tail: tailCopy(many.slice(0, 4)) })
    const r = await runCronGuardWatch(t.d)
    expect(failOpen(r)).toMatchObject({ status: 'under', count: 4, capped: true })
    expect(t.errs.join('\n')).toMatch(/could not count failed_open.*KV list 503/)
  })

  it('a KV record younger than the tail worker can have copied it is not reported missing from the copy', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, [{ id: 'fresh', atMs: NOW - TAIL_COPY_LAG_MS + 1 }, { id: 'old', atMs: NOW - TAIL_COPY_LAG_MS - 1 }])
    const t = deps(kv)
    await runCronGuardWatch(t.d)
    expect(t.lines.join('\n')).toMatch(/missing_from_tail_copy=1\b/)
  })

  it('never asks the tail copy about skipped duplicates, which it does not keep', async () => {
    const kv = memoryKv()
    await record(kv, 'skipped_duplicate', Array.from({ length: 30 }, () => NOW - H))
    const tail = tailCopy()
    await runCronGuardWatch(deps(kv, { tail }).d)
    expect(tail).toHaveBeenCalledTimes(1)
  })
})


describe('supabaseTailCopyReader (#2166)', () => {
  /** A query builder double that serves `rows` by range, the way PostgREST pages. */
  function fakeSupabase(rows: Array<{ event_id: string; occurred_at: string }>, error: { message: string } | null = null) {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'gt', 'lte', 'order']) {
      builder[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return builder }
    }
    builder.range = async (from: number, to: number) => {
      calls.push({ method: 'range', args: [from, to] })
      return error ? { data: null, error } : { data: rows.slice(from, to + 1), error: null }
    }
    const from = vi.fn(() => builder)
    return { client: { from } as unknown as Parameters<typeof supabaseTailCopyReader>[0], from, calls }
  }
  const row = (i: number) => ({ event_id: `ev-${i}`, occurred_at: new Date(NOW - i * 1000).toISOString() })

  it('reads the window from cron_guard_fail_opens, newest first, by id and time', async () => {
    const f = fakeSupabase([row(1), row(2)])
    const r = await supabaseTailCopyReader(f.client)(NOW - 24 * H, NOW)
    expect(f.from).toHaveBeenCalledWith('cron_guard_fail_opens')
    expect(r).toEqual({ events: [{ id: 'ev-1', atMs: NOW - 1000 }, { id: 'ev-2', atMs: NOW - 2000 }], capped: false })
    expect(f.calls).toContainEqual({ method: 'gt', args: ['occurred_at', new Date(NOW - 24 * H).toISOString()] })
    expect(f.calls).toContainEqual({ method: 'lte', args: ['occurred_at', new Date(NOW).toISOString()] })
    expect(f.calls).toContainEqual({ method: 'order', args: ['occurred_at', { ascending: false }] })
  })

  it('pages past the 1,000 row cap rather than stopping at it silently', async () => {
    const f = fakeSupabase(Array.from({ length: 1500 }, (_, i) => row(i)))
    const r = await supabaseTailCopyReader(f.client)(NOW - 24 * H, NOW)
    expect(r.events).toHaveLength(1500)
    expect(r.capped).toBe(false)
    expect(f.calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])
  })

  it('stops at its page limit and says the count is a floor', async () => {
    const f = fakeSupabase(Array.from({ length: 2500 }, (_, i) => row(i)))
    const r = await supabaseTailCopyReader(f.client, { maxPages: 2 })(NOW - 24 * H, NOW)
    expect(r).toMatchObject({ capped: true })
    expect(r.events).toHaveLength(2000)
  })

  it('throws on a failed read, so it is reported unreadable and never as zero', async () => {
    const f = fakeSupabase([], { message: 'relation "cron_guard_fail_opens" does not exist' })
    await expect(supabaseTailCopyReader(f.client)(NOW - 24 * H, NOW)).rejects.toThrow(/cron_guard_fail_opens.*does not exist/)
  })
})

describe('cronGuardMessage', () => {
  // #2284: the page fires only on a rate well above the measured 4 a day, and
  // points at the durable record, never at a Workers Logs search, which missed
  // two known FAILED OPEN lines (15:15 and 16:59 UTC) when it was followed.
  it('a fail-open rate page says how many, what is normal, and where each one is recorded', () => {
    const m = cronGuardMessage('failed_open', 23, false)
    expect(m.title).toBe('Cron guard keeps failing open')
    expect(m.errors).toEqual(['The cron guard could not reach its claim store 23 times in the last 24 hours, so those ticks ran without it. About 4 a day is normal.'])
    expect(m.context).toBe('A count this high means the claim store itself is failing, not a passing delay. A tick that ran twice is paged on its own.')
    expect(m.fixHint).toBe('Each one is a row in the cron_guard_fail_opens table, with its tick and why the claim did not answer.')
    expect(m.fixHint).not.toMatch(/Workers Logs/)
  })

  it('a duplicates page says it is Cloudflare doing it and the guard is absorbing it, so nobody hunts for a fix', () => {
    const m = cronGuardMessage('skipped_duplicate', 1440, false)
    expect(m.title).toBe('Cloudflare is delivering cron ticks twice')
    expect(m.errors).toEqual(['Cloudflare delivered 1,440 cron ticks a second time in the last 24 hours.'])
    expect(m.context).toMatch(/guard skipped every second copy, so no job ran twice/)
    expect(m.context).toMatch(/Nothing here needs fixing/)
    expect(m.fixHint).toBeUndefined()
  })

  // #2166, L11: the page says what it counted and from where when the records disagree.
  it('names the fail-opens whose own record failed, and that they were counted from the tail copy', () => {
    const m = cronGuardMessage('failed_open', 24, false, { guardRecord: 3, tailCopy: 24, onlyInTailCopy: 21, missingFromTailCopy: 0 })
    expect(m.errors[1]).toBe('The guard could not write its own record of 21 of them, because its store failed too. They were counted from the copy the tail worker keeps of the guard\'s log lines.')
  })

  it('says the count is the guard record alone, and a floor, when the tail copy could not be read', () => {
    const m = cronGuardMessage('failed_open', 20, true, { guardRecord: 20, unread: { record: 'tail_copy', why: 'PGRST 503' } })
    expect(m.errors[0]).toMatch(/at least 20 times/)
    expect(m.errors[1]).toBe('This counts the guard\'s own record alone: the tail worker\'s copy of its log lines could not be read (PGRST 503), so a fail-open whose own record also failed is not in this count.')
  })

  it('says when the tail copy is missing fail-opens the guard recorded, in the singular for one', () => {
    const m = cronGuardMessage('failed_open', 20, false, { guardRecord: 20, tailCopy: 19, onlyInTailCopy: 0, missingFromTailCopy: 1 })
    expect(m.errors[1]).toBe('1 of them is not in the tail worker\'s copy of the guard\'s log lines.')
  })

  it('says "at least" when the count stopped at its page limit', () => {
    expect(cronGuardMessage('skipped_duplicate', 10_000, true).errors[0]).toMatch(/at least 10,000 cron ticks/)
  })
})

describe('doubleRunMessage (#2284)', () => {
  const at = Date.parse('2026-10-17T13:00:12.000Z')
  const run = (o: Partial<TickDelivery>): TickDelivery => ({ id: 'x', cron: '0 13 * * *', scheduledAtMs: at, outcome: 'ran', invocationOutcome: 'ok', atMs: at, ...o })

  it('names each tick in Eastern time, in words, and how it came to run twice', () => {
    const m = doubleRunMessage({ kind: 'doubled', ticks: [
      { tick: 't1', cron: '* * * * *', scheduledAtMs: at, how: 'failed_open', runs: [run({ cron: '* * * * *', outcome: 'failed_open' }), run({ cron: '* * * * *' })] },
      { tick: 't2', cron: '0 * * * *', scheduledAtMs: at, how: 'took_over', runs: [run({ cron: '0 * * * *' }), run({ cron: '0 * * * *', outcome: 'took_over' })] },
    ] })
    expect(m.title).toBe('2 cron ticks may have run twice')
    expect(m.errors).toEqual([
      'The Oct 17, 9:00 AM EDT run of the cron that runs every minute happened twice: the claim store could not be reached for one delivery, which ran it without the claim, and another delivery ran it too.',
      'The Oct 17, 9:00 AM EDT run of the cron that runs every hour on the hour happened twice: a second delivery took it over while the first was still running, because the first had stopped renewing its claim.',
    ])
    expect(m.context).toBe('The jobs on those ticks may have done their work twice, such as an export, a purge or an alert.')
    expect(m.fixHint).toBe('Each delivery is a row in the cron_tick_deliveries table. Check what those jobs wrote at those times.')
  })

  it('names at most five ticks and counts the rest', () => {
    const ticks = Array.from({ length: 7 }, (_, i) => ({ tick: `t${i}`, cron: '* * * * *', scheduledAtMs: at + i * 60_000, how: 'ran_twice' as const, runs: [run({}), run({}), run({})] }))
    const m = doubleRunMessage({ kind: 'doubled', ticks })
    expect(m.title).toBe('7 cron ticks may have run twice')
    expect(m.errors).toHaveLength(6)
    expect(m.errors[0]).toMatch(/happened 3 times\.$/)
    expect(m.errors[5]).toBe('And 2 more.')
  })

  it('says it could not check, and why, when the record could not be read or is not whole', () => {
    const unread = doubleRunMessage({ kind: 'unreadable', why: 'PGRST 503' })
    expect(unread.title).toBe('Cron guard could not check for a tick run twice')
    expect(unread.errors).toEqual(['The record of cron deliveries could not be read (PGRST 503), so a tick that ran twice in the last 24 hours would not be seen.'])
    expect(unread.fixHint).toBe('Check that bidspoke-worker-tail is deployed and is writing rows to the cron_tick_deliveries table.')
    expect(doubleRunMessage({ kind: 'incomplete', present: 1_100, expected: 1_429 }).errors).toEqual([
      'The record of cron deliveries holds 1,100 of the last 1,429 minutes of the every minute cron, so a tick that ran twice could be missed.',
    ])
    expect(doubleRunMessage({ kind: 'incomplete', present: 0, expected: 0 }).errors).toEqual([
      'The record of cron deliveries holds no deliveries for the last 24 hours, so a tick that ran twice would not be seen.',
    ])
  })
})

describe('supabaseDeliveryReader (#2284)', () => {
  function fakeSupabase(rows: Array<Record<string, unknown>>, error: { message: string } | null = null) {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'gt', 'lte', 'order']) {
      builder[m] = (...args: unknown[]) => { calls.push({ method: m, args }); return builder }
    }
    builder.range = async (from: number, to: number) => {
      calls.push({ method: 'range', args: [from, to] })
      return error ? { data: null, error } : { data: rows.slice(from, to + 1), error: null }
    }
    const from = vi.fn(() => builder)
    return { client: { from } as unknown as Parameters<typeof supabaseDeliveryReader>[0], from, calls }
  }
  const row = (i: number) => ({
    delivery_id: `d-${i}`,
    cron: '* * * * *',
    scheduled_at: new Date(NOW - i * 60_000).toISOString(),
    outcome: 'ran',
    invocation_outcome: 'ok',
    occurred_at: new Date(NOW - i * 60_000 + 500).toISOString(),
  })

  it('reads the window from cron_tick_deliveries, newest first, past the 1,000 row cap', async () => {
    const f = fakeSupabase(Array.from({ length: 1500 }, (_, i) => row(i)))
    const r = await supabaseDeliveryReader(f.client)(NOW - 24 * H, NOW)
    expect(f.from).toHaveBeenCalledWith('cron_tick_deliveries')
    expect(r.deliveries).toHaveLength(1500)
    expect(r.deliveries[1]).toEqual({ id: 'd-1', cron: '* * * * *', scheduledAtMs: NOW - 60_000, outcome: 'ran', invocationOutcome: 'ok', atMs: NOW - 60_000 + 500 })
    expect(f.calls).toContainEqual({ method: 'gt', args: ['occurred_at', new Date(NOW - 24 * H).toISOString()] })
    expect(f.calls.filter((c) => c.method === 'range').map((c) => c.args)).toEqual([[0, 999], [1000, 1999]])
  })

  it('throws on a failed read, so it is reported unreadable and never as zero', async () => {
    const f = fakeSupabase([], { message: 'relation "cron_tick_deliveries" does not exist' })
    await expect(supabaseDeliveryReader(f.client)(NOW - 24 * H, NOW)).rejects.toThrow(/cron_tick_deliveries.*does not exist/)
  })

  it('throws on a row whose outcome it does not know, rather than counting it as some other outcome (L50)', async () => {
    const f = fakeSupabase([{ ...row(1), outcome: 'exploded' }])
    await expect(supabaseDeliveryReader(f.client)(NOW - 24 * H, NOW)).rejects.toThrow(/outcome "exploded"/)
  })
})
