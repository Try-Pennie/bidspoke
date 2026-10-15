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
  TAIL_COPY_LAG_MS,
  supabaseTailCopyReader,
  type CronGuardKind,
  type CronGuardSources,
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

function deps(kv: ReturnType<typeof memoryKv>, delivered = true, tail = tailCopy()) {
  const sent: Array<{ kind: CronGuardKind; count: number; capped: boolean }> = []
  const sources: Array<CronGuardSources | undefined> = []
  const lines: string[] = []
  const errs: string[] = []
  return {
    sent,
    sources,
    lines,
    errs,
    d: {
      kv,
      now: () => NOW,
      tailFailOpens: tail,
      send: vi.fn(async (kind: CronGuardKind, count: number, capped: boolean, s?: CronGuardSources) => {
        sent.push({ kind, count, capped })
        sources.push(s)
        return delivered
      }),
      log: (l: string) => { lines.push(l) },
      error: (l: string) => { errs.push(l) },
    },
  }
}

describe('runCronGuardWatch', () => {

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
    // Both records of a fail-open unreadable: nothing to count from.
    const tail = tailCopy()
    tail.mockRejectedValue(new Error('PGRST 503'))
    const t = deps(kv, true, tail)
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'unreadable' })
    expect(r.find((x) => x.kind === 'failed_open')).not.toHaveProperty('count')
    expect(t.errs.join('\n')).toMatch(/could not count failed_open.*KV list 503/)
    expect(t.errs.join('\n')).toMatch(/could not read the tail worker's copy.*PGRST 503/)
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

// #2166: on 2026-10-14 the KV put recording each fail-open failed in the same
// blip that made the guard fail open, so 9 FAILED OPEN lines were counted as 3.
// The tail worker copies every FAILED OPEN line into the database by its event
// id, and the check counts the union of the two records.
describe('runCronGuardWatch counts a fail-open from either record (#2166)', () => {
  const recordWithIds = async (kv: ReturnType<typeof memoryKv>, events: Array<{ id: string; atMs: number }>) => {
    for (const e of events) await recordCronGuardEvent(kv, 'failed_open', e.atMs, e.id)
  }
  const nine = Array.from({ length: 9 }, (_, i) => ({ id: `ev-${i}`, atMs: NOW - (i + 1) * H }))

  it('the measured day: 9 fail-opens logged, only 3 recorded in KV, counts 9 and pages', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, nine.slice(6))
    const t = deps(kv, true, tailCopy(nine))
    const r = await runCronGuardWatch(t.d)
    expect(t.sent).toEqual([{ kind: 'failed_open', count: 9, capped: false }])
    expect(t.sources[0]).toEqual({ guardRecord: 3, tailCopy: 9, onlyInTailCopy: 6, missingFromTailCopy: 0 })
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'over', count: 9, alerted: true })
  })

  it('pages when every KV record failed and only the tail copy holds them', async () => {
    const kv = memoryKv()
    const t = deps(kv, true, tailCopy(nine.slice(0, 3)))
    await runCronGuardWatch(t.d)
    expect(t.sent).toEqual([{ kind: 'failed_open', count: 3, capped: false }])
  })

  it('a fail-open in both records counts once', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, nine.slice(0, 2))
    const t = deps(kv, true, tailCopy(nine.slice(0, 2)))
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'under', count: 2 })
    expect(t.sent).toEqual([])
  })

  it('asks the tail copy for the same 24 hour window the KV count uses', async () => {
    const kv = memoryKv()
    const tail = tailCopy()
    await runCronGuardWatch(deps(kv, true, tail).d)
    expect(tail).toHaveBeenCalledWith(NOW - 24 * H, NOW)
  })

  it('logs both records on every run, so a copy that stops keeping up is visible on a quiet day', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, nine.slice(0, 1))
    const t = deps(kv, true, tailCopy(nine.slice(1, 2)))
    await runCronGuardWatch(t.d)
    expect(t.lines.join('\n')).toMatch(/kind=failed_open count=2 threshold=3 guard_record=1 tail_copy=1 only_in_tail_copy=1 missing_from_tail_copy=1/)
  })

  it('a tail copy it cannot read leaves the KV count standing, says so, and the page calls it a floor', async () => {
    const kv = memoryKv()
    await recordWithIds(kv, nine.slice(0, 3))
    const tail = tailCopy()
    tail.mockRejectedValue(new Error('PGRST 503'))
    const t = deps(kv, true, tail)
    const r = await runCronGuardWatch(t.d)
    expect(t.errs.join('\n')).toMatch(/could not read the tail worker's copy of failed_open.*PGRST 503/)
    expect(t.sent).toEqual([{ kind: 'failed_open', count: 3, capped: true }])
    expect(t.sources[0]).toMatchObject({ guardRecord: 3, unread: { record: 'tail_copy', why: expect.stringMatching(/PGRST 503/) } })
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'over', count: 3, capped: true })
    expect(t.lines.join('\n')).toMatch(/tail_copy=unreadable/)
  })

  it('a KV record it cannot read leaves the tail copy count standing, rather than the whole count going unreadable', async () => {
    const kv = memoryKv()
    kv.list.mockRejectedValue(new Error('KV list 503'))
    const t = deps(kv, true, tailCopy(nine.slice(0, 4)))
    const r = await runCronGuardWatch(t.d)
    expect(r.find((x) => x.kind === 'failed_open')).toMatchObject({ status: 'over', count: 4, capped: true })
    expect(t.sources[0]).toMatchObject({ tailCopy: 4, unread: { record: 'guard_record', why: expect.stringMatching(/KV list 503/) } })
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
    const t = deps(kv, true, tail)
    await runCronGuardWatch(t.d)
    expect(tail).toHaveBeenCalledTimes(1)
    expect(t.sources[0]).toBeUndefined()
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

  // #2166, L11: the page says what it counted and from where when the records disagree.
  it('names the fail-opens whose own record failed, and that they were counted from the tail copy', () => {
    const m = cronGuardMessage('failed_open', 9, false, { guardRecord: 3, tailCopy: 9, onlyInTailCopy: 6, missingFromTailCopy: 0 })
    expect(m.errors).toEqual([
      'The cron guard could not reach its claim store 9 times in the last 24 hours, so those ticks ran without it.',
      'The guard could not write its own record of 6 of them, because its store failed too. They were counted from the copy the tail worker keeps of the guard\'s log lines.',
    ])
  })

  it('says the count is the guard record alone, and a floor, when the tail copy could not be read', () => {
    const m = cronGuardMessage('failed_open', 3, true, { guardRecord: 3, unread: { record: 'tail_copy', why: 'PGRST 503' } })
    expect(m.errors).toEqual([
      'The cron guard could not reach its claim store at least 3 times in the last 24 hours, so those ticks ran without it.',
      'This counts the guard\'s own record alone: the tail worker\'s copy of its log lines could not be read (PGRST 503), so a fail-open whose own record also failed is not in this count.',
    ])
  })

  it('says the count is the tail copy alone when the guard record could not be read', () => {
    const m = cronGuardMessage('failed_open', 4, true, { tailCopy: 4, unread: { record: 'guard_record', why: 'KV list 503' } })
    expect(m.errors[1]).toBe('This counts the tail worker\'s copy of the guard\'s log lines alone: the guard\'s own record could not be read (KV list 503).')
  })

  it('says when the tail copy is missing fail-opens the guard recorded, in the singular for one', () => {
    const m = cronGuardMessage('failed_open', 3, false, { guardRecord: 3, tailCopy: 2, onlyInTailCopy: 0, missingFromTailCopy: 1 })
    expect(m.errors).toEqual([
      'The cron guard could not reach its claim store 3 times in the last 24 hours, so those ticks ran without it.',
      '1 of them is not in the tail worker\'s copy of the guard\'s log lines.',
    ])
  })

  it('adds nothing when both records agree', () => {
    const m = cronGuardMessage('failed_open', 3, false, { guardRecord: 3, tailCopy: 3, onlyInTailCopy: 0, missingFromTailCopy: 0 })
    expect(m.errors).toHaveLength(1)
  })

  it('says "at least" when the count stopped at its page limit, and reads one in the singular', () => {
    expect(cronGuardMessage('skipped_duplicate', 10_000, true).errors[0]).toMatch(/at least 10,000 cron ticks/)
    expect(cronGuardMessage('failed_open', 1, false).errors[0]).toMatch(/claim store once in the last/)
  })
})
