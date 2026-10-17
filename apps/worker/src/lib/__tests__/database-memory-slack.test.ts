/**
 * The Slack wording the database memory check posts (#1928). Each sentence claims only what
 * the readings measured (L11): the swap sentence appears only when swapping was seen, and
 * every message names what to do next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendDatabaseMemoryShortAlert, sendDatabaseMemoryUnreadableAlert } from '../slack'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, ts: '1.1' }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const text = async () =>
  ((await slackPostOf(fetchMock.mock.calls[0])).blocks as Array<{ text?: { text?: string } }>)
    .map((b) => b.text?.text ?? '')
    .join('\n')

const base = {
  totalBytes: 4.009828352e9,
  freeFloor: 0.15,
  lowestAvailableBytes: 401_000_000,
  swapUsedBytes: 0,
  swapConcernBytes: 600 * 1000 * 1000,
  since: '2026-10-09T13:00:00.000Z',
  repeat: null,
  at: Date.parse('2026-10-09T13:15:00Z'),
}

describe('the memory short alert', () => {
  it('names the size, the lowest free figure as a share, and since when, in Eastern time', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowFree: true, swapping: false })
    expect((await text())).toMatch(/short of memory/)
    // A failed read does not break the stretch, so it may claim only the readings taken.
    expect((await text())).toMatch(/every reading that could be taken/)
    expect((await text())).toMatch(/401 MB/)
    expect((await text())).toMatch(/10 percent of its 4\.0 GB/)
    expect((await text())).toMatch(/9:00 AM EDT/)
    expect((await text())).toMatch(/How to fix/)
    expect((await text())).toMatch(/Compute and Disk/)
    expect((await text())).not.toMatch(/moving to disk/)
    expect((await text())).not.toMatch(/undefined|NaN/)
  })

  it('says it was moving memory to disk only when swapping was seen, with how much is there now', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowestAvailableBytes: 2_400_000_000, lowFree: false, swapping: true, swapUsedBytes: 734_003_200 })
    expect((await text())).toMatch(/memory moving to disk/)
    expect((await text())).toMatch(/734 MB/)
    expect((await text())).not.toMatch(/less than 15 percent/)
  })

  // #1928 follow-up (Dan 2026-10-12): swap high while free memory stayed healthy is an
  // early warning, not the Oct 8 exhaustion. The alert must not say "short of memory",
  // must name the level and frame the resize as conditional, not immediate.
  it('frames swap-high with healthy free memory as an early warning, naming the level and a conditional resize', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowestAvailableBytes: 1_900_000_000, lowFree: false, swapping: true, swapUsedBytes: 734_003_200 })
    const t = (await text())
    expect(t).not.toMatch(/short of memory/)
    expect(t).toContain('memory moving to disk, with 734 MB there now')
    expect(t).toContain('should keep swap under 600 MB, and it has climbed past that line')
    expect(t).toContain('Free memory is still healthy')
    // Accurate to what lowFree=false means: no reading went under the floor.
    expect(t).toContain('no reading went under the 15 percent floor')
    expect(t).toMatch(/early warning/)
    expect(t).toContain('this is the shape that preceded the Oct 8 stall')
    // The resize is the remedy only if it keeps climbing, not an immediate instruction.
    expect(t).toMatch(/If the swap keeps climbing.*next compute size up/)
    // It does not overclaim that EVERY reading swapped, only that readings found it.
    expect(t).not.toMatch(/every reading .* moving to disk/)
    expect(t).not.toMatch(/undefined|NaN/)
  })

  // Hysteresis keeps swap latched between the 500 MB clear line and the 600 MB concern line,
  // so the latest reading can be 550 MB while still reported. The copy must not then claim
  // the current figure is past 600 MB; it reports the figure and says it HAS climbed past.
  it('does not claim the latest swap is past the line when hysteresis holds it just below', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowestAvailableBytes: 1_900_000_000, lowFree: false, swapping: true, swapUsedBytes: 550_000_000 })
    const t = (await text())
    expect(t).toContain('with 550 MB there now')
    expect(t).toContain('should keep swap under 600 MB, and it has climbed past that line')
    // Guards against the earlier wording that put the figure and "past the N MB" in one
    // breath, which read as a contradiction once hysteresis holds the latest figure below.
    expect(t).not.toMatch(/there now, past the \d+ MB/)
    expect(t).not.toMatch(/undefined|NaN/)
  })

  // When free memory DID go low, swapping beside it is the serious case: keep the
  // short-of-memory wording and the resize path even though swapping is also true.
  it('keeps the short-of-memory, resize wording when free memory went low, even with swapping', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowFree: true, swapping: true, swapUsedBytes: 1_073_741_824 })
    const t = (await text())
    expect(t).toMatch(/short of memory/)
    expect(t).toMatch(/next compute size up/)
    expect(t).toMatch(/memory moving to disk/)
  })

  it('states the floor the check judged by, not a copy of it', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, freeFloor: 0.2, lowFree: true, swapping: false })
    expect((await text())).toMatch(/less than 20 percent/)
  })

  it('carries the reminder sentence when one is given', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowFree: true, swapping: false, repeat: 'This is reminder 2.' })
    expect((await text())).toMatch(/This is reminder 2\./)
  })
})

describe('the memory unreadable alert', () => {
  it('says memory cannot be measured, why, and what to check', async () => {
    await sendDatabaseMemoryUnreadableAlert({ bot_token: 't' }, '#ops', {
      reason: 'the metrics feed answered HTTP 401', since: '2026-10-09T13:00:00.000Z', repeat: null, at: Date.parse('2026-10-09T13:30:00Z'),
    })
    expect((await text())).toMatch(/cannot read/)
    expect((await text())).toMatch(/HTTP 401/)
    expect((await text())).toMatch(/event=database_memory/)
    expect((await text())).toMatch(/API Keys/)
    expect((await text())).not.toMatch(/short of memory/)
  })
})
