/**
 * The post-response budget (#1850).
 *
 * Cloudflare cancels waitUntil work 30 seconds after the response is sent (or
 * the client disconnects), and that 30 seconds is shared by every waitUntil of
 * the request. The finalize retry ladder used to span 112 seconds, so in a real
 * outage its later rungs and the dead letter behind them were cancelled before
 * they ran: the one record that a served lead was lost was the thing that never
 * got written.
 */
import { describe, it, expect } from 'vitest'
import {
  WAIT_UNTIL_LIMIT_MS,
  POST_RESPONSE_BUDGET_MS,
  DEAD_LETTER_RESERVE_MS,
  FINALIZE_RESERVE_MS,
  PostResponseBudget,
  waitToRetry,
  withinBudget,
  realClock,
} from '../post-response-budget'
import { DB_WRITE_RETRY_DELAYS_MS } from '../db-retry'
import { CREATE_RETRY_DELAYS_MS, FLUSH_RETRY_DELAYS_MS, UPDATE_RETRY_DELAYS_MS } from '../../engine/step-logger'
import { VirtualClock } from './_virtual-clock'

const span = (delays: readonly number[]) => delays.reduce((a, b) => a + b, 0)

describe('the budget constants', () => {
  it('sits comfortably under Cloudflare\'s 30 second waitUntil limit', () => {
    expect(WAIT_UNTIL_LIMIT_MS).toBe(30_000)
    // Comfortably: the response leaves a moment after the engine returns, and
    // the Slack alert after a dead letter needs time of its own.
    expect(WAIT_UNTIL_LIMIT_MS - POST_RESPONSE_BUDGET_MS).toBeGreaterThanOrEqual(5_000)
  })

  it('keeps a tail for the dead letter, and a larger one ahead of finalize', () => {
    expect(DEAD_LETTER_RESERVE_MS).toBeGreaterThan(0)
    expect(FINALIZE_RESERVE_MS).toBeGreaterThan(DEAD_LETTER_RESERVE_MS)
    expect(FINALIZE_RESERVE_MS).toBeLessThan(POST_RESPONSE_BUDGET_MS)
  })

  // Every ladder, run on its own, fits with its dead letter behind it. Run
  // together they share one deadline, which the tests below drive.
  it.each([
    ['execution record create', CREATE_RETRY_DELAYS_MS, FINALIZE_RESERVE_MS],
    ['step log flush', FLUSH_RETRY_DELAYS_MS, FINALIZE_RESERVE_MS],
    ['execution finalize', UPDATE_RETRY_DELAYS_MS, DEAD_LETTER_RESERVE_MS],
    ['outcome writes and reconstruction (withDbRetry)', DB_WRITE_RETRY_DELAYS_MS, DEAD_LETTER_RESERVE_MS],
  ])('the %s ladder plus what must follow it fits inside the budget', (_name, delays, reserve) => {
    expect(span(delays) + reserve).toBeLessThanOrEqual(POST_RESPONSE_BUDGET_MS)
  })
})

describe('waitToRetry', () => {
  it('waits the requested delay through the injected clock', async () => {
    const clock = new VirtualClock()
    const p = waitToRetry(2_000, { clock })
    await clock.run()
    expect(await p).toBe(true)
    expect(clock.sleeps).toEqual([2_000])
    expect(clock.now()).toBe(2_000)
  })

  it('waits without limit before the response has gone out', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    const p = waitToRetry(60_000, { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS })
    await clock.run()
    expect(await p).toBe(true)
  })

  it('refuses a wait that would end inside the reserved tail, without sleeping', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    const cutoff = POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS
    const passed = clock.delay(cutoff - 1_000)
    await clock.run()
    await passed
    expect(await waitToRetry(1_001, { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS })).toBe(false)
    expect(clock.sleeps).toEqual([])
    const ok = waitToRetry(1_000, { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS })
    await clock.run()
    expect(await ok).toBe(true)
  })

  it('answers false after a wait that began before the response and ended past the cut-off', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    const p = waitToRetry(30_000, { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS })
    budget.arm()
    await clock.run()
    expect(await p).toBe(false)
  })
})

describe('withinBudget', () => {
  it('hands back the work\'s value when it settles in time', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    const p = withinBudget(clock.delay(1_000).then(() => 'landed'), { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS })
    await clock.run()
    expect(await p).toEqual({ settled: true, value: 'landed' })
  })

  it('stops waiting at the cut-off for work that never answers', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    const p = withinBudget(clock.hang(), { clock, budget, reserveMs: DEAD_LETTER_RESERVE_MS })
    await clock.run()
    expect(await p).toEqual({ settled: false })
    expect(clock.now()).toBe(POST_RESPONSE_BUDGET_MS - DEAD_LETTER_RESERVE_MS)
  })

  it('counts from the response, not from when the work began', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    const p = withinBudget(clock.hang(), { clock, budget, reserveMs: FINALIZE_RESERVE_MS })
    const passed = clock.delay(5_000)
    await clock.run(5_000)
    await passed
    budget.arm()
    await clock.run()
    expect(await p).toEqual({ settled: false })
    expect(clock.now()).toBe(5_000 + POST_RESPONSE_BUDGET_MS - FINALIZE_RESERVE_MS)
  })

  it('leaves no timer behind once the work has settled', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    const p = withinBudget(Promise.resolve(1), { clock, budget, reserveMs: 0 })
    expect(await p).toEqual({ settled: true, value: 1 })
    // Nothing left to fire: the clock does not move.
    expect(await clock.run()).toBe(0)
  })

  it('passes a rejection through rather than reporting a timeout', async () => {
    const clock = new VirtualClock()
    const budget = new PostResponseBudget(clock)
    budget.arm()
    await expect(withinBudget(Promise.reject(new Error('boom')), { clock, budget })).rejects.toThrow('boom')
  })
})

describe('realClock', () => {
  it('resolves an aborted deadline timer at once', async () => {
    const stop = new AbortController()
    const p = realClock.timer(60_000, stop.signal)
    stop.abort()
    await expect(p).resolves.toBeUndefined()
  })
})
