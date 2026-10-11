/**
 * The Slack wording the database memory check posts (#1928). Each sentence claims only what
 * the readings measured (L11): the swap sentence appears only when swapping was seen, and
 * every message names what to do next.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendDatabaseMemoryShortAlert, sendDatabaseMemoryUnreadableAlert } from '../slack'

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: '1.1' }) })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const text = () =>
  (JSON.parse(fetchMock.mock.calls[0][1].body).blocks as Array<{ text?: { text?: string } }>)
    .map((b) => b.text?.text ?? '')
    .join('\n')

const base = {
  totalBytes: 4.009828352e9,
  freeFloor: 0.15,
  lowestAvailableBytes: 401_000_000,
  swapUsedBytes: 0,
  since: '2026-10-09T13:00:00.000Z',
  repeat: null,
  at: Date.parse('2026-10-09T13:15:00Z'),
}

describe('the memory short alert', () => {
  it('names the size, the lowest free figure as a share, and since when, in Eastern time', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowFree: true, swapping: false })
    expect(text()).toMatch(/short of memory/)
    // A failed read does not break the stretch, so it may claim only the readings taken.
    expect(text()).toMatch(/every reading that could be taken/)
    expect(text()).toMatch(/401 MB/)
    expect(text()).toMatch(/10 percent of its 4\.0 GB/)
    expect(text()).toMatch(/9:00 AM EDT/)
    expect(text()).toMatch(/How to fix/)
    expect(text()).toMatch(/Compute and Disk/)
    expect(text()).not.toMatch(/moving to disk/)
    expect(text()).not.toMatch(/undefined|NaN/)
  })

  it('says it was moving memory to disk only when swapping was seen, with how much is there now', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowestAvailableBytes: 2_400_000_000, lowFree: false, swapping: true, swapUsedBytes: 536_870_912 })
    expect(text()).toMatch(/memory moving to disk/)
    expect(text()).toMatch(/537 MB/)
    expect(text()).not.toMatch(/less than 15 percent/)
  })

  // #1928 follow-up: swapping alone, with free memory well above the floor, is not
  // the memory exhaustion that caused Oct 8. The alert must not say "short of memory"
  // and must not tell someone to resize when they have most of their memory free.
  it('does not claim memory is short, nor recommend a resize, when only swap grew and free memory stayed healthy', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowestAvailableBytes: 1_900_000_000, lowFree: false, swapping: true, swapUsedBytes: 290_000_000 })
    const t = text()
    expect(t).not.toMatch(/short of memory/)
    expect(t).not.toMatch(/next compute size up/)
    expect(t).toContain('memory moving to disk, with 290 MB there now')
    expect(t).toContain('Free memory stayed healthy over that stretch')
    // Accurate to what lowFree=false means: no reading went under the floor, not "well above".
    expect(t).toContain('no reading went under the 15 percent floor')
    expect(t).toContain('This is not the memory exhaustion that caused the Oct 8 stall')
    // It frames the remedy on what was measured (a resize does not address swap when
    // free memory is healthy), not on an unmeasured cause guess (L11).
    expect(t).toMatch(/a resize would not address this/)
    expect(t).not.toMatch(/usually a heavy query/)
    // It does not overclaim that EVERY reading swapped, only that readings found it.
    expect(t).not.toMatch(/every reading .* moving to disk/)
    expect(t).not.toMatch(/undefined|NaN/)
  })

  // When free memory DID go low, swapping beside it is the serious case: keep the
  // short-of-memory wording and the resize path even though swapping is also true.
  it('keeps the short-of-memory, resize wording when free memory went low, even with swapping', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowFree: true, swapping: true, swapUsedBytes: 1_073_741_824 })
    const t = text()
    expect(t).toMatch(/short of memory/)
    expect(t).toMatch(/next compute size up/)
    expect(t).toMatch(/memory moving to disk/)
  })

  it('states the floor the check judged by, not a copy of it', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, freeFloor: 0.2, lowFree: true, swapping: false })
    expect(text()).toMatch(/less than 20 percent/)
  })

  it('carries the reminder sentence when one is given', async () => {
    await sendDatabaseMemoryShortAlert({ bot_token: 't' }, '#ops', { ...base, lowFree: true, swapping: false, repeat: 'This is reminder 2.' })
    expect(text()).toMatch(/This is reminder 2\./)
  })
})

describe('the memory unreadable alert', () => {
  it('says memory cannot be measured, why, and what to check', async () => {
    await sendDatabaseMemoryUnreadableAlert({ bot_token: 't' }, '#ops', {
      reason: 'the metrics feed answered HTTP 401', since: '2026-10-09T13:00:00.000Z', repeat: null, at: Date.parse('2026-10-09T13:30:00Z'),
    })
    expect(text()).toMatch(/cannot read/)
    expect(text()).toMatch(/HTTP 401/)
    expect(text()).toMatch(/event=database_memory/)
    expect(text()).toMatch(/API Keys/)
    expect(text()).not.toMatch(/short of memory/)
  })
})
