/**
 * The cron tick guard's own outcomes reach someone (#1904).
 *
 * The guard from #1899 logs `FAILED OPEN` when its claim object does not answer
 * (the jobs then run unguarded) and `skipped duplicate` for every second copy of
 * a tick it drops. Both lived only in Workers Logs. Each is now recorded in KV,
 * one key per event so two at once cannot overwrite each other's count, and an
 * hourly check pages once a day per kind: 3 fail-opens, or 30 duplicates, in
 * the last 24 hours. A count it cannot read is reported as unreadable, never
 * as zero (L98). KV is the record because a fail-open is the claim object
 * being unreachable, so the object cannot count its own outage (L345).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  recordCronGuardEvent,
  countCronGuardEvents,
  runCronGuardWatch,
  CRON_GUARD_THRESHOLDS,
  cronGuardPagedKey,
  cronGuardMessage,
  type CronGuardKind,
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

  it('throws when the list fails, rather than answering zero', async () => {
    const kv = memoryKv()
    kv.list.mockRejectedValueOnce(new Error('KV list 503'))
    await expect(countCronGuardEvents(kv, 'failed_open', NOW)).rejects.toThrow(/KV list 503/)
  })
})

describe('runCronGuardWatch', () => {
  function deps(kv: ReturnType<typeof memoryKv>, delivered = true) {
    const sent: Array<{ kind: CronGuardKind; count: number; capped: boolean }> = []
    const lines: string[] = []
    const errs: string[] = []
    return {
      sent,
      lines,
      errs,
      d: {
        kv,
        now: () => NOW,
        send: vi.fn(async (kind: CronGuardKind, count: number, capped: boolean) => { sent.push({ kind, count, capped }); return delivered }),
        log: (l: string) => { lines.push(l) },
        error: (l: string) => { errs.push(l) },
      },
    }
  }

  it('holds the thresholds Dan approved: 3 fail-opens, 30 duplicates', () => {
    expect(CRON_GUARD_THRESHOLDS).toEqual({ failed_open: 3, skipped_duplicate: 30 })
  })

  it('pages at 3 fail-opens and not at 2', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', [NOW - H, NOW - 2 * H])
    const below = deps(kv)
    await runCronGuardWatch(below.d)
    expect(below.sent).toEqual([])

    await record(kv, 'failed_open', [NOW - 3 * H])
    const at = deps(kv)
    const r = await runCronGuardWatch(at.d)
    expect(at.sent).toEqual([{ kind: 'failed_open', count: 3, capped: false }])
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'over', count: 3, alerted: true })
  })

  it('pages at 30 duplicates and not at 29', async () => {
    const kv = memoryKv()
    await record(kv, 'skipped_duplicate', Array.from({ length: 29 }, (_, i) => NOW - (i + 1) * 60_000))
    const below = deps(kv)
    await runCronGuardWatch(below.d)
    expect(below.sent).toEqual([])

    await record(kv, 'skipped_duplicate', [NOW - 40 * 60_000])
    const at = deps(kv)
    await runCronGuardWatch(at.d)
    expect(at.sent).toEqual([{ kind: 'skipped_duplicate', count: 30, capped: false }])
  })

  it('pages once a day per kind: a second run inside the day is quiet, the other kind still pages', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', [NOW - H, NOW - H, NOW - H])
    await runCronGuardWatch(deps(kv).d)
    expect(kv.ttls.get(cronGuardPagedKey('failed_open'))).toBe(24 * 60 * 60)

    await record(kv, 'skipped_duplicate', Array.from({ length: 30 }, () => NOW - H))
    const second = deps(kv)
    await runCronGuardWatch(second.d)
    expect(second.sent).toEqual([{ kind: 'skipped_duplicate', count: 30, capped: false }])
  })

  it('arms the daily quiet only on delivery, so a Slack outage does not buy a day of silence', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', [NOW - H, NOW - H, NOW - H])
    await runCronGuardWatch(deps(kv, false).d)
    expect(kv.store.has(cronGuardPagedKey('failed_open'))).toBe(false)
    const retry = deps(kv)
    await runCronGuardWatch(retry.d)
    expect(retry.sent).toHaveLength(1)
  })

  it('reports an unreadable count as unreadable, logs it at error level, and still judges the other kind', async () => {
    const kv = memoryKv()
    await record(kv, 'skipped_duplicate', Array.from({ length: 30 }, () => NOW - H))
    const realList = kv.list.getMockImplementation()!
    kv.list.mockImplementation(async (o: { prefix: string; cursor?: string }) => {
      if (o.prefix.includes('failed_open')) throw new Error('KV list 503')
      return realList(o)
    })
    const t = deps(kv)
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'unreadable' })
    expect(r.find((x) => x.kind === 'failed_open')).not.toHaveProperty('count')
    expect(t.errs.join('\n')).toMatch(/could not count failed_open.*KV list 503/)
    expect(t.sent).toEqual([{ kind: 'skipped_duplicate', count: 30, capped: false }])
  })

  it('logs both counts on every run, a quiet one included, so the thresholds can be checked against real days', async () => {
    const kv = memoryKv()
    await record(kv, 'skipped_duplicate', [NOW - H])
    const t = deps(kv)
    await runCronGuardWatch(t.d)
    expect(t.lines.join('\n')).toMatch(/kind=failed_open count=0 threshold=3/)
    expect(t.lines.join('\n')).toMatch(/kind=skipped_duplicate count=1 threshold=30/)
  })

  it('a send that throws is logged and leaves the quiet unarmed, never aborting the other kind', async () => {
    const kv = memoryKv()
    await record(kv, 'failed_open', [NOW - H, NOW - H, NOW - H])
    await record(kv, 'skipped_duplicate', Array.from({ length: 30 }, () => NOW - H))
    const t = deps(kv)
    t.d.send.mockImplementationOnce(async () => { throw new Error('slack down') })
    const r = await runCronGuardWatch(t.d)
    expect(kv.store.has(cronGuardPagedKey('failed_open'))).toBe(false)
    expect(t.errs.join('\n')).toMatch(/failed_open.*slack down/)
    expect(r.find((x) => x.kind === 'skipped_duplicate')).toMatchObject({ alerted: true })
  })
})

describe('cronGuardMessage', () => {
  it('a fail-open page says the ticks ran unguarded, what that risks, and where to look', () => {
    const m = cronGuardMessage('failed_open', 4, false)
    expect(m.title).toBe('Cron guard ran ticks unguarded')
    expect(m.errors).toEqual(['The cron guard could not reach its claim store 4 times in the last 24 hours, so those ticks ran without it.'])
    expect(m.context).toMatch(/delivered twice in that time may have run its jobs twice/)
    expect(m.fixHint).toMatch(/\[cron-once\] FAILED OPEN/)
  })

  it('a duplicates page says it is Cloudflare doing it and the guard is absorbing it, so nobody hunts for a fix', () => {
    const m = cronGuardMessage('skipped_duplicate', 1440, false)
    expect(m.title).toBe('Cloudflare is delivering cron ticks twice')
    expect(m.errors).toEqual(['Cloudflare delivered 1,440 cron ticks a second time in the last 24 hours.'])
    expect(m.context).toMatch(/guard skipped every second copy, so no job ran twice/)
    expect(m.context).toMatch(/Nothing here needs fixing/)
    expect(m.fixHint).toBeUndefined()
  })

  it('says "at least" when the count stopped at its page limit, and reads one in the singular', () => {
    expect(cronGuardMessage('skipped_duplicate', 10_000, true).errors[0]).toMatch(/at least 10,000 cron ticks/)
    expect(cronGuardMessage('failed_open', 1, false).errors[0]).toMatch(/claim store once in the last/)
  })
})
