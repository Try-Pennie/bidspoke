/**
 * The hourly check sees a tick that two deliveries both ran (#2284), end to end.
 *
 * Each case drives the real guard (runCronTickOnce) against the real claim
 * object, hands each delivery's own log lines to the tail worker's real parser
 * as Cloudflare would (one trace per delivery), reads the rows back the way the
 * live reader maps them, and runs the real watch over them. So the page is shown
 * to see a REAL second delivery, not a fixture shaped to fire it (L48), and the
 * control case, a second delivery the guard skipped, shows it stays quiet (L1).
 *
 * Covered: a fail-open whose tick a second delivery also ran; a takeover of a
 * run that was still alive because its lease lapsed (2026-10-17 09:00 UTC, the
 * daily tick's renewals failed six times in a row, 09:00:12 to 09:00:37); and
 * the intended retry of a run Cloudflare killed, which must not page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AlertClaimObject, TICK_LEASE_STALE_MS } from '../../durable-objects/alert-claim'
import { runCronTickOnce } from '../cron-once'
import { runCronGuardWatch, deliveryFromRow, type TickDelivery, type CronGuardPage, type CronGuardMessage } from '../cron-guard-watch'
import { deliveriesIn } from '../../../../worker-tail/src/deliveries'

function memoryState(): DurableObjectState {
  const store = new Map<string, unknown>()
  return {
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { store.set(key, value) },
      deleteAll: async () => { store.clear() },
      delete: async (key: string) => store.delete(key),
      setAlarm: async () => undefined,
    },
  } as unknown as DurableObjectState
}

/** One real claim object per name; `unreachable` makes the next N asks fail as the platform does. */
function claimNamespace() {
  const objects = new Map<string, AlertClaimObject>()
  const state = { unreachable: 0 }
  const ns = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      fetch: async (url: string, init?: RequestInit) => {
        if (state.unreachable > 0) {
          state.unreachable--
          throw new Error('Network connection lost.')
        }
        if (!objects.has(name)) objects.set(name, new AlertClaimObject(memoryState()))
        return objects.get(name)!.fetch(new Request(url, init))
      },
    }),
  } as unknown as DurableObjectNamespace
  return { ns, state }
}

let lines: string[]
beforeEach(() => {
  lines = []
  const keep = (...a: unknown[]) => { lines.push(a.join(' ')) }
  vi.spyOn(console, 'log').mockImplementation(keep)
  vi.spyOn(console, 'warn').mockImplementation(keep)
  vi.spyOn(console, 'error').mockImplementation(keep)
})
afterEach(() => { vi.restoreAllMocks() })

/** What Cloudflare hands the tail worker for one delivery: its own lines, and how it ended. */
function traceOf(cron: string, scheduledTime: number, startedAt: number, from: number, outcome: string, to = lines.length): TraceItem {
  return {
    scriptName: 'bidspoke-worker',
    outcome,
    eventTimestamp: startedAt,
    event: { cron, scheduledTime },
    logs: lines.slice(from, to).map((message, i) => ({ timestamp: startedAt + 10 + i, level: 'log', message: [message] })),
  } as unknown as TraceItem
}

const NOW = Date.parse('2026-10-17T12:00:00.000Z')
const H = 60 * 60 * 1000
const MIN = 60_000

/** The rest of the day's record: one delivery a minute of the minute tick, each run once. */
function quietDay(): TickDelivery[] {
  const out: TickDelivery[] = []
  for (let t = NOW - 24 * H + MIN; t <= NOW - MIN; t += MIN) {
    out.push({ id: `bg-${t}`, cron: '* * * * *', scheduledAtMs: t, outcome: 'ran', invocationOutcome: 'ok', atMs: t + 500 })
  }
  return out
}

/** Runs the watch over the day plus the deliveries the tail worker read, and returns what it posted. */
async function watch(recorded: TickDelivery[]) {
  const sent: Array<{ page: CronGuardPage; message: CronGuardMessage }> = []
  const kv = new Map<string, string>()
  await runCronGuardWatch({
    kv: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => { kv.set(k, v) },
      list: async () => ({ keys: [], list_complete: true }),
    },
    now: () => NOW,
    tailFailOpens: async () => ({ events: [], capped: false }),
    deliveries: async () => ({ deliveries: [...quietDay(), ...recorded], capped: false }),
    send: async (page, message) => { sent.push({ page, message }); return true },
    log: () => {},
    error: () => {},
  })
  return sent
}

const rowsToDeliveries = (traces: TraceItem[]) => traces.flatMap(deliveriesIn).map(deliveryFromRow)

describe('a tick two deliveries both ran is paged, from the guard\'s own lines (#2284)', () => {
  const cron = '0 9 * * *'
  const scheduled = Date.parse('2026-10-17T09:00:12.000Z')

  it('a fail-open whose tick a second delivery also ran', async () => {
    const { ns, state } = claimNamespace()
    // First delivery: the claim object cannot be reached, so it runs unguarded.
    state.unreachable = 1
    let from = lines.length
    await runCronTickOnce(ns, { cron, scheduledTime: scheduled }, vi.fn(async () => {}), { now: () => scheduled, every: () => () => {} })
    const first = traceOf(cron, scheduled, scheduled, from, 'ok')
    // Second delivery of the same tick 36 s later: the object answers, nobody holds it, so it runs too.
    from = lines.length
    await runCronTickOnce(ns, { cron, scheduledTime: scheduled + 36_000 }, vi.fn(async () => {}), { now: () => scheduled + 36_000, every: () => () => {} })
    const second = traceOf(cron, scheduled + 36_000, scheduled + 36_000, from, 'ok')

    const recorded = rowsToDeliveries([first, second])
    expect(recorded.map((d) => d.outcome)).toEqual(['failed_open', 'ran'])
    const sent = await watch(recorded)
    expect(sent.map((s) => s.page)).toEqual(['double_run'])
    expect(sent[0].message.errors[0]).toMatch(/could not be reached for one delivery, which ran it without the claim, and another delivery ran it too/)
  })

  it('a takeover of a run that was still alive, because its lease lapsed', async () => {
    const { ns } = claimNamespace()
    const clock = { t: scheduled }
    let finish: () => void = () => {}
    const firstFrom = lines.length
    // The first delivery runs, and its renewals stop reaching the object (every: no-op).
    const firstRun = runCronTickOnce(ns, { cron, scheduledTime: scheduled }, () => new Promise<void>((r) => { finish = r }), { now: () => clock.t, every: () => () => {} })
    await vi.waitFor(() => expect(lines.some((l) => l.includes('"outcome":"ran"'))).toBe(true))
    const firstTo = lines.length
    // A delivery with the SAME scheduled time arrives once the lease is stale, and takes the tick over.
    clock.t = scheduled + TICK_LEASE_STALE_MS + 1
    const from = lines.length
    await runCronTickOnce(ns, { cron, scheduledTime: scheduled }, vi.fn(async () => {}), { now: () => clock.t, every: () => () => {} })
    const second = traceOf(cron, scheduled, clock.t, from, 'ok')
    // The first was alive all along, and finishes normally.
    finish()
    await firstRun
    const first = traceOf(cron, scheduled, scheduled, firstFrom, 'ok', firstTo)

    const recorded = rowsToDeliveries([first, second])
    expect(recorded.map((d) => d.outcome).sort()).toEqual(['ran', 'took_over'])
    const sent = await watch(recorded)
    expect(sent.map((s) => s.page)).toEqual(['double_run'])
    expect(sent[0].message.errors[0]).toMatch(/took it over while the first was still running/)
  })

  it('stays quiet for the retry of a run Cloudflare killed: that is the retry working', async () => {
    const { ns } = claimNamespace()
    const clock = { t: scheduled }
    let from = lines.length
    void runCronTickOnce(ns, { cron, scheduledTime: scheduled }, () => new Promise<void>(() => {}), { now: () => clock.t, every: () => () => {} })
    await vi.waitFor(() => expect(lines.some((l) => l.includes('"outcome":"ran"'))).toBe(true))
    const killed = traceOf(cron, scheduled, scheduled, from, 'canceled')
    clock.t = scheduled + TICK_LEASE_STALE_MS + 1
    from = lines.length
    await runCronTickOnce(ns, { cron, scheduledTime: scheduled }, vi.fn(async () => {}), { now: () => clock.t, every: () => () => {} })
    const retry = traceOf(cron, scheduled, clock.t, from, 'ok')

    const recorded = rowsToDeliveries([killed, retry])
    expect(recorded.map((d) => d.outcome)).toEqual(['ran', 'took_over'])
    expect(await watch(recorded)).toEqual([])
  })

  it('stays quiet for a second delivery the guard skipped (the control: same harness, no doubled run)', async () => {
    const { ns } = claimNamespace()
    let from = lines.length
    await runCronTickOnce(ns, { cron, scheduledTime: scheduled }, vi.fn(async () => {}), { now: () => scheduled, every: () => () => {} })
    const first = traceOf(cron, scheduled, scheduled, from, 'ok')
    from = lines.length
    await runCronTickOnce(ns, { cron, scheduledTime: scheduled + 36_000 }, vi.fn(async () => {}), { now: () => scheduled + 36_000, every: () => () => {} })
    const second = traceOf(cron, scheduled + 36_000, scheduled + 36_000, from, 'ok')

    const recorded = rowsToDeliveries([first, second])
    expect(recorded.map((d) => d.outcome)).toEqual(['ran', 'skipped'])
    expect(await watch(recorded)).toEqual([])
  })
})
