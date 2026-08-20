/**
 * The 1% capture heartbeat still samples about 1% now that execution ids are
 * time ordered (#869, Phase A1).
 *
 * `shouldLogCapture` samples off a polynomial `h = h * 31 + charCode` hash over
 * the WHOLE execution id string. Under UUIDv4 every character was random. Under
 * UUIDv7 the leading twelve hex characters are a millisecond timestamp, so within
 * any one day they barely move, and the hash's input distribution changes shape.
 *
 * The plan reasoned that the high powers of 31 mod 2^32 mean early characters
 * still contribute enough for the distribution to hold, and required that be
 * MEASURED rather than argued (the reasoning is plausible and the consequence of
 * it being wrong is silent: a rate near zero means the heartbeat stops proving the
 * dark capture write path is alive, and a rate near 100% means half a million log
 * lines a month for a dark feature).
 *
 * Measured here over a day's real volume, ids spread across the day the way
 * executions actually arrive:
 *
 *   v7 ids: 0.965%     v4 ids: 1.048%
 *
 * so it holds. The band below is wide because the point is to catch a collapse or
 * an explosion, not to pin a number: at 105,000 samples the standard deviation of
 * the rate is about 0.03 percentage points, so the bounds sit roughly fifteen
 * standard deviations out and this cannot flake.
 *
 * This is a real measurement of the sampler under v7 input, because the input
 * distribution is entirely determined by the generator being used here. What it
 * cannot speak for is a real day's arrival pattern in production, which is why the
 * issue also asks for one confirmation against live traffic after the soak.
 */
import { describe, expect, it } from 'vitest'
import { uuidv7 } from '@bidspoke/uuidv7'
import { shouldLogCapture } from '../field-presence'

/** Roughly one production day of executions. */
const DAY = 105_000
const DAY_START_MS = Date.UTC(2026, 7, 20)
const DAY_LENGTH_MS = 86_400_000

/** The realised sample rate, as a percentage, over one day of minted ids. */
const measureRate = (): number => {
  let hits = 0
  for (let i = 0; i < DAY; i++) {
    // Spread across the whole day, so the timestamp prefix varies the way it
    // really does. Ids all minted in one millisecond would be a fixture that
    // cannot express the failure being tested for (L165).
    const ms = DAY_START_MS + Math.floor((i / DAY) * DAY_LENGTH_MS)
    if (shouldLogCapture(uuidv7(ms))) hits++
  }
  return (hits / DAY) * 100
}

describe('the capture heartbeat sample rate survives time-ordered ids (#869)', () => {
  it('still fires, so the heartbeat has not gone silent', () => {
    // Separated from the band below because zero is the dangerous outcome and it
    // deserves to fail on its own terms. A heartbeat at zero is indistinguishable
    // from a dark capture write path that has stopped working (L90).
    expect(measureRate()).toBeGreaterThan(0)
  })

  it('samples on the order of 1%, not 0% and not everything', () => {
    const rate = measureRate()
    expect(rate, `sampled ${rate.toFixed(3)}% of a day's executions`).toBeGreaterThan(0.5)
    expect(rate, `sampled ${rate.toFixed(3)}% of a day's executions`).toBeLessThan(2)
  })
})
