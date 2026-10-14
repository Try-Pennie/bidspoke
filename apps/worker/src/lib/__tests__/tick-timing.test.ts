/**
 * Which job held a slow tick up (#2058).
 *
 * Every minute job runs inside one invocation, which has taken 30 s to over
 * 5 minutes with nothing recording which job took the time. Each job is timed
 * from when it is handed over to when it settles, and a tick past the threshold
 * logs one line naming every job, slowest first. The clock is injected (L524).
 */
import { describe, it, expect } from 'vitest'
import { tickTimer, TICK_SLOW_MS, TICK_CHECKPOINT_MS } from '../tick-timing'

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

/** A promise the test settles, so a job's end is decided by the test. */
function deferred() {
  let resolve: () => void = () => {}
  let reject: (e: unknown) => void = () => {}
  const p = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { p, resolve, reject }
}

describe('tickTimer', () => {
  it('names every job slowest first when the tick ran past the threshold', async () => {
    const c = clock()
    const timer = tickTimer(c.now)
    const prewarm = deferred()
    const sweep = deferred()
    // Handed over fast job first, so the order in the line is the sort's doing.
    const b = timer.track('stored-copy-sweep', sweep.p)
    const a = timer.track('prewarm', prewarm.p)
    c.advance(1_200)
    sweep.resolve(); await b
    c.advance(59_536)
    prewarm.resolve(); await a
    expect(timer.report('* * * * *')).toBe('[tick-timing] cron="* * * * *" total_ms=60736 jobs=prewarm:60736,stored-copy-sweep:1200')
  })

  it('says nothing for a tick inside the threshold', async () => {
    const c = clock()
    const timer = tickTimer(c.now)
    const job = deferred()
    const done = timer.track('prewarm', job.p)
    c.advance(TICK_SLOW_MS)
    job.resolve(); await done
    expect(timer.report('* * * * *')).toBeNull()
  })

  it('times a job that failed, and hands its failure on unchanged', async () => {
    const c = clock()
    const timer = tickTimer(c.now)
    const job = deferred()
    const tracked = timer.track('volume-cliff', job.p)
    c.advance(TICK_SLOW_MS + 1)
    job.reject(new Error('boom'))
    await expect(tracked).rejects.toThrow('boom')
    expect(timer.report('* * * * *')).toMatch(/jobs=volume-cliff:20001 failed/)
  })

  it('names a job still running when the report is taken, rather than leaving it out', async () => {
    const c = clock()
    const timer = tickTimer(c.now)
    void timer.track('heartbeat-checks', new Promise(() => {}))
    c.advance(TICK_SLOW_MS + 5)
    expect(timer.report('* * * * *')).toMatch(/jobs=heartbeat-checks:20005 unfinished/)
  })

  // A line naming no job says nothing about where the time went.
  it('says nothing for a slow tick that timed no job', () => {
    const c = clock()
    const timer = tickTimer(c.now)
    c.advance(10 * 60_000)
    expect(timer.report('0 * * * *')).toBeNull()
  })

  // A tick killed past its limit never reaches the end of tick line, so a
  // checkpoint part way names the jobs still running (lessons review).
  it('logs a checkpoint naming the unfinished jobs when the tick is still running at the checkpoint', () => {
    const c = clock()
    const timer = tickTimer(c.now)
    void timer.track('prewarm', new Promise(() => {}))
    const lines: string[] = []
    let fire: () => void = () => {}
    let cleared = false
    const stop = timer.checkpoint('* * * * *', {
      setTimer: (fn, ms) => { expect(ms).toBe(TICK_CHECKPOINT_MS); fire = fn; return 1 },
      clearTimer: () => { cleared = true },
      log: (l) => { lines.push(l) },
    })
    c.advance(TICK_CHECKPOINT_MS)
    fire()
    expect(lines).toEqual([`[tick-timing] cron="* * * * *" total_ms=${TICK_CHECKPOINT_MS} jobs=prewarm:${TICK_CHECKPOINT_MS} unfinished (checkpoint, still running)`])
    stop()
    expect(cleared).toBe(true)
  })

  it('a tick that finished before the checkpoint clears it, and nothing is logged', () => {
    const timer = tickTimer(clock().now)
    let cleared = false
    const lines: string[] = []
    const stop = timer.checkpoint('* * * * *', { setTimer: () => 7, clearTimer: (h) => { cleared = h === 7 }, log: (l) => { lines.push(l) } })
    stop()
    expect(cleared).toBe(true)
    expect(lines).toEqual([])
  })
})
