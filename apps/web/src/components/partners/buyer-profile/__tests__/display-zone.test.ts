/**
 * Showing a buyer's hours and reset times in its display zone (#2143, PM-10).
 *
 * The hours are stored and judged in Eastern; the page draws them in the zone
 * the profile chooses and turns an edit made there back into Eastern windows.
 * A window that crosses midnight in the display zone is drawn on both days it
 * touches, and the click count's reset, midnight Pacific, is shown as the hour
 * it is in the chosen zone on the night it happens, clock changes included.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { DISPLAY_TIME_ZONES, type BuyerProfileDocument, type ProfileWindowDocument } from '@bidspoke/buyer-profile'
import {
  addDisplayWindow,
  blackoutZoneNote,
  clickCountResetSentence,
  displayWindows,
  easternDayResetSentence,
  profileWithChangedZoneOnly,
  replaceDisplayWindow,
} from '../display-zone'

// Far from every zone, so a local Date getter anywhere shows up as a wrong hour (L504).
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata'
})

const PACIFIC_SHIFT = -180
const w = (day_of_week: number, opens_minute: number, closes_minute: number): ProfileWindowDocument => ({ day_of_week, opens_minute, closes_minute })
const shape = (rows: ReturnType<typeof displayWindows>) => rows.map((r) => [r.day_of_week, r.opens_minute, r.closes_minute])

describe('displayWindows', () => {
  it('draws Eastern hours exactly as stored, one row per window, adjacent windows kept apart', () => {
    const stored = [w(1, 480, 600), w(1, 600, 720), w(3, 540, 1020)]
    const rows = displayWindows(stored, 0)
    expect(shape(rows)).toEqual([[1, 480, 600], [1, 600, 720], [3, 540, 1020]])
    expect(rows.map((r) => r.sources)).toEqual([[stored[0]], [stored[1]], [stored[2]]])
  })

  it('draws a window that crosses midnight in the display zone on both days it touches', () => {
    // Monday 1:00 AM to 9:00 AM Eastern is Sunday 10:00 PM to Monday 6:00 AM Pacific.
    expect(shape(displayWindows([w(1, 60, 540)], PACIFIC_SHIFT))).toEqual([[0, 1320, 1440], [1, 0, 360]])
  })

  it('wraps the week: early Sunday Eastern is late Saturday Pacific', () => {
    expect(shape(displayWindows([w(0, 0, 180)], PACIFIC_SHIFT))).toEqual([[6, 1260, 1440]])
  })

  it('draws an always open week as seven whole days, not two pieces a day', () => {
    const always = [0, 1, 2, 3, 4, 5, 6].map((d) => w(d, 0, 1440))
    for (const shift of [-60, -120, PACIFIC_SHIFT]) {
      expect(shape(displayWindows(always, shift))).toEqual([0, 1, 2, 3, 4, 5, 6].map((d) => [d, 0, 1440]))
    }
  })

  it('keeps a window whose close is not after its open as one row, still flagged by its editor', () => {
    expect(shape(displayWindows([w(1, 600, 600)], PACIFIC_SHIFT))).toEqual([[1, 420, 420]])
  })
})

describe('an edit in the display zone is stored in Eastern', () => {
  it('in Eastern replaces the window in place, untouched windows the same objects', () => {
    const stored = [w(1, 540, 1080), w(3, 600, 900)]
    const rows = displayWindows(stored, 0)
    const next = replaceDisplayWindow(stored, 0, rows[0], { day_of_week: 1, opens_minute: 540, closes_minute: 1050 })
    expect(next).toEqual([w(1, 540, 1050), w(3, 600, 900)])
    expect(next[1]).toBe(stored[1])
  })

  it('shifts an edited Pacific window back to Eastern', () => {
    const stored = [w(2, 540, 1020)]
    const rows = displayWindows(stored, PACIFIC_SHIFT)
    expect(shape(rows)).toEqual([[2, 360, 840]])
    expect(replaceDisplayWindow(stored, PACIFIC_SHIFT, rows[0], { day_of_week: 2, opens_minute: 360, closes_minute: 900 })).toEqual([w(2, 540, 1080)])
  })

  it('an edit to one half of a window split by midnight keeps the other half and joins them again in Eastern', () => {
    const stored = [w(1, 60, 540)]
    const rows = displayWindows(stored, PACIFIC_SHIFT)
    // Move Monday's close from 6:00 AM to 7:00 AM Pacific.
    expect(replaceDisplayWindow(stored, PACIFIC_SHIFT, rows[1], { day_of_week: 1, opens_minute: 0, closes_minute: 420 })).toEqual([w(1, 60, 600)])
  })

  it('removing one half of a split window leaves the other half', () => {
    const stored = [w(1, 60, 540)]
    const rows = displayWindows(stored, PACIFIC_SHIFT)
    expect(replaceDisplayWindow(stored, PACIFIC_SHIFT, rows[0], null)).toEqual([w(1, 180, 540)])
  })

  it('an edit to a day of an always open week changes only the Eastern windows that day is made of', () => {
    const always = [0, 1, 2, 3, 4, 5, 6].map((d) => w(d, 0, 1440))
    const rows = displayWindows(always, PACIFIC_SHIFT)
    const next = replaceDisplayWindow(always, PACIFIC_SHIFT, rows[1], { day_of_week: 1, opens_minute: 0, closes_minute: 1000 })
    expect(next).toEqual([w(0, 0, 1440), w(1, 0, 1180), w(2, 180, 1440), w(3, 0, 1440), w(4, 0, 1440), w(5, 0, 1440), w(6, 0, 1440)])
    expect(shape(displayWindows(next, PACIFIC_SHIFT))).toEqual([[0, 0, 1440], [1, 0, 1000], [2, 0, 1440], [3, 0, 1440], [4, 0, 1440], [5, 0, 1440], [6, 0, 1440]])
  })

  it('a window added late on a Pacific evening is stored on the next Eastern day, across the week too', () => {
    expect(addDisplayWindow([], PACIFIC_SHIFT, { day_of_week: 6, opens_minute: 1320, closes_minute: 1440 })).toEqual([w(0, 60, 180)])
    // Friday 8:00 PM to 10:00 PM Pacific crosses Eastern midnight, so it is two Eastern windows.
    expect(addDisplayWindow([], PACIFIC_SHIFT, { day_of_week: 5, opens_minute: 1200, closes_minute: 1320 })).toEqual([w(5, 1380, 1440), w(6, 0, 60)])
  })

  it('an edit that makes a window close before it opens stays one window that still closes before it opens', () => {
    const stored = [w(2, 540, 1020)]
    const rows = displayWindows(stored, PACIFIC_SHIFT)
    const next = replaceDisplayWindow(stored, PACIFIC_SHIFT, rows[0], { day_of_week: 2, opens_minute: 600, closes_minute: 300 })
    expect(next).toHaveLength(1)
    expect(next[0].closes_minute).toBeLessThanOrEqual(next[0].opens_minute)
    expect(shape(displayWindows(next, PACIFIC_SHIFT))).toEqual([[2, 600, 300]])
  })
})

describe('the reset times, said in the display zone', () => {
  // Each "now" is the evening before, Pacific, so the next reset is that night's midnight Pacific.
  it.each([
    ['an ordinary winter night', '2026-01-15T03:00:00.000Z', ['3:00 AM Eastern', '2:00 AM Central', '1:00 AM Mountain', 'midnight Pacific']],
    ['an ordinary summer night', '2026-07-15T03:00:00.000Z', ['3:00 AM Eastern', '2:00 AM Central', '1:00 AM Mountain', 'midnight Pacific']],
    ['the March spring forward night', '2026-03-08T03:00:00.000Z', ['4:00 AM Eastern', '3:00 AM Central', '1:00 AM Mountain', 'midnight Pacific']],
    ['the November fall back night', '2026-11-01T03:00:00.000Z', ['2:00 AM Eastern', '1:00 AM Central', '1:00 AM Mountain', 'midnight Pacific']],
  ] as const)('the click count resets at midnight Pacific, shown in each zone on %s', (_night, now, shown) => {
    expect(DISPLAY_TIME_ZONES.map((z) => clickCountResetSentence(Date.parse(now), z))).toEqual(shown.map((s) => `The count resets at ${s} time.`))
  })

  it('names the reset that comes next: after the spring forward night it is 3:00 AM Eastern again', () => {
    expect(clickCountResetSentence(Date.parse('2026-03-08T09:00:00.000Z'), 'America/New_York')).toBe('The count resets at 3:00 AM Eastern time.')
  })

  it('an offer buyer\'s day runs from midnight Eastern, shown in each zone', () => {
    expect(DISPLAY_TIME_ZONES.map((z) => easternDayResetSentence(z))).toEqual([
      'A day runs midnight to midnight Eastern time.',
      'A day runs from 11:00 PM to 11:00 PM Central time, starting the evening before.',
      'A day runs from 10:00 PM to 10:00 PM Mountain time, starting the evening before.',
      'A day runs from 9:00 PM to 9:00 PM Pacific time, starting the evening before.',
    ])
  })

  it('says when a blackout date starts only when it is not the zone shown', () => {
    expect(blackoutZoneNote('America/New_York')).toBeNull()
    expect(blackoutZoneNote('America/Los_Angeles')).toBe('Each date is an Eastern day: it starts at 9:00 PM Pacific time the evening before.')
  })
})

describe('the zone is sent only when the person changed it', () => {
  const base: BuyerProfileDocument = { sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: [], debt_min: null, debt_max: null, loan_amount_min: null, hourly_lead_cap: null, daily_lead_cap: 5, hourly_spend_cap_cents: null, daily_spend_cap_cents: null, windows: [], blackout_dates: [], tiers: [] }

  it('leaves the key out when the zone is as stored, so the save keeps what is stored', () => {
    const sent = profileWithChangedZoneOnly({ ...base, daily_lead_cap: 6, display_time_zone: 'America/Chicago' }, { ...base, display_time_zone: 'America/Chicago' })
    expect('display_time_zone' in sent).toBe(false)
    expect(sent.daily_lead_cap).toBe(6)
    // Unset on both sides, spelled either way, is unchanged too.
    expect('display_time_zone' in profileWithChangedZoneOnly({ ...base, display_time_zone: null }, { ...base })).toBe(false)
  })

  it('sends a zone the person chose, and null when they cleared one', () => {
    expect(profileWithChangedZoneOnly({ ...base, display_time_zone: 'America/Denver' }, { ...base, display_time_zone: null }).display_time_zone).toBe('America/Denver')
    expect(profileWithChangedZoneOnly({ ...base, display_time_zone: null }, { ...base, display_time_zone: 'America/Denver' }).display_time_zone).toBeNull()
    // A profile never stored sends a chosen zone.
    expect(profileWithChangedZoneOnly({ ...base, display_time_zone: 'America/Denver' }, null).display_time_zone).toBe('America/Denver')
  })
})
