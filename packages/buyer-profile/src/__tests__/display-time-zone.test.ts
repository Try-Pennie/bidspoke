/**
 * The display time zone (#2143, PM-10): a closed list of four zones a buyer
 * profile's hours and reset times are shown in. Stored per profile, carried by
 * the document parser (L425), refused outside the list by the parser and by
 * validateProfile (L611), and never read by anything that judges a lead.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_DISPLAY_TIME_ZONE,
  DISPLAY_TIME_ZONE_LABELS,
  DISPLAY_TIME_ZONES,
  isDisplayTimeZone,
  PACIFIC,
  zonedDayStartUtc,
} from '../clock'
import { documentToProfile, parseProfileDocument, type BuyerProfileDocument } from '../document'
import { flattenProfileDocument, diffProfileDocuments } from '../diff'
import { registryPathOf } from '../paths'
import { validateProfile, type PartnerRulesForValidation } from '../validate'

// Far from every zone, so a local Date getter anywhere shows up as a wrong hour (L504).
beforeAll(() => {
  process.env.TZ = 'Asia/Kolkata'
})

const fixtures = path.resolve(__dirname, '../../fixtures')

const doc: BuyerProfileDocument = {
  sold_on: 'offer',
  is_enabled: false,
  priority: null,
  allowed_states: [],
  debt_min: null,
  debt_max: null,
  loan_amount_min: null,
  hourly_lead_cap: null,
  daily_lead_cap: null,
  hourly_spend_cap_cents: null,
  daily_spend_cap_cents: null,
  windows: [],
  blackout_dates: [],
  tiers: [],
}

const partner: PartnerRulesForValidation = { acceptSignals: [], clickUrl: null, externalRoutingCode: null }

describe('DISPLAY_TIME_ZONES', () => {
  it('is the four continental zones, shown by name, defaulting to the zone the hours are stored in', () => {
    expect([...DISPLAY_TIME_ZONES]).toEqual(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'])
    expect(DISPLAY_TIME_ZONES.map((z) => DISPLAY_TIME_ZONE_LABELS[z])).toEqual(['Eastern', 'Central', 'Mountain', 'Pacific'])
    expect(DEFAULT_DISPLAY_TIME_ZONE).toBe('America/New_York')
    expect(isDisplayTimeZone('America/Denver')).toBe(true)
    expect(isDisplayTimeZone('America/Phoenix')).toBe(false)
    expect(isDisplayTimeZone(null)).toBe(false)
  })

  // The SQL suite reads this file and compares it with the CHECK on
  // buyer_profiles.display_time_zone, so the list is written once (L41).
  it('is the list the generated SQL suite fixture carries', () => {
    const file = JSON.parse(readFileSync(path.join(fixtures, 'display-time-zones.json'), 'utf8')) as { zones: string[] }
    expect(file.zones, `regenerate packages/buyer-profile/fixtures/display-time-zones.json with "zones": ${JSON.stringify(DISPLAY_TIME_ZONES)}`).toEqual([...DISPLAY_TIME_ZONES])
  })

  // The click count resets at midnight Pacific whatever is chosen; shown in
  // another zone that instant is a different hour, and on the change nights a
  // different hour again. These pin the instant the page formats.
  it.each([
    ['2026-01-15', [3, 2, 1, 0]],
    ['2026-07-15', [3, 2, 1, 0]],
    // Spring forward: Eastern and Central have already moved, Mountain has not.
    ['2026-03-08', [4, 3, 1, 0]],
    // Fall back: Eastern and Central have already moved back, Mountain has not.
    ['2026-11-01', [2, 1, 1, 0]],
  ] as const)('midnight Pacific on %s is %j o\'clock in Eastern, Central, Mountain, Pacific', (date, hours) => {
    const reset = zonedDayStartUtc(date, PACIFIC)
    const shown = DISPLAY_TIME_ZONES.map((zone) => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(reset))
      return Number(parts.find((p) => p.type === 'hour')?.value) + Number(parts.find((p) => p.type === 'minute')?.value) / 60
    })
    expect(shown).toEqual([...hours])
  })
})

describe('the document carries the display time zone (L425)', () => {
  it('keeps a listed zone through the parser and into the evaluator shape', () => {
    const parsed = parseProfileDocument({ ...doc, display_time_zone: 'America/Los_Angeles' })
    expect(parsed).toMatchObject({ ok: true, document: { display_time_zone: 'America/Los_Angeles' } })
    if (parsed.ok) expect(documentToProfile(parsed.document).displayTimeZone).toBe('America/Los_Angeles')
  })

  it('leaves the key absent when the sender did not speak about it, so the save keeps what is stored', () => {
    const parsed = parseProfileDocument(doc)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect('display_time_zone' in parsed.document).toBe(false)
      expect('displayTimeZone' in documentToProfile(parsed.document)).toBe(false)
    }
  })

  it('carries null, which clears the choice back to Eastern', () => {
    const parsed = parseProfileDocument({ ...doc, display_time_zone: null })
    expect(parsed).toMatchObject({ ok: true, document: { display_time_zone: null } })
  })

  it('refuses a zone outside the list by name, and a value that is not text', () => {
    expect(parseProfileDocument({ ...doc, display_time_zone: 'America/Phoenix' })).toEqual({
      ok: false,
      errors: [{ path: 'display_time_zone', message: `display_time_zone must be one of ${DISPLAY_TIME_ZONES.join(', ')}.` }],
    })
    expect(parseProfileDocument({ ...doc, display_time_zone: 5 })).toMatchObject({ ok: false, errors: [{ path: 'display_time_zone' }] })
  })

  it('flattens as a scalar, so a change shows in the history and the conflict view', () => {
    expect(flattenProfileDocument({ ...doc, display_time_zone: 'America/Chicago' }).get('display_time_zone')).toBe('America/Chicago')
    expect(flattenProfileDocument(doc).get('display_time_zone')).toBeNull()
    expect(diffProfileDocuments({ ...doc, display_time_zone: 'America/Chicago' }, { ...doc, display_time_zone: 'America/Denver' })).toEqual([
      { path: 'display_time_zone', mine: 'America/Chicago', theirs: 'America/Denver' },
    ])
  })
})

describe('validateProfile and the display time zone (L611)', () => {
  const profile = documentToProfile({ ...doc, partner_id: 'p' })

  it('accepts every listed zone, null and an absent one', () => {
    for (const zone of DISPLAY_TIME_ZONES) expect(validateProfile({ ...profile, displayTimeZone: zone }, partner)).toEqual({ ok: true })
    expect(validateProfile({ ...profile, displayTimeZone: null }, partner)).toEqual({ ok: true })
    expect(validateProfile(profile, partner)).toEqual({ ok: true })
  })

  it('refuses anything else, on the registry field the page shows it at', () => {
    const result = validateProfile({ ...profile, displayTimeZone: 'America/Phoenix' as never }, partner)
    expect(result).toEqual({
      ok: false,
      errors: [{ code: 'display_time_zone_invalid', path: 'displayTimeZone', message: 'Choose Eastern, Central, Mountain or Pacific.' }],
    })
    expect(registryPathOf('displayTimeZone')).toBe('profile.display_time_zone')
  })
})
