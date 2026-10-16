/**
 * The save refusal names each refused field by the words on screen (#1464).
 *
 * The validator's paths are the profile's camelCase field names; the form's
 * labels are keyed by the snake_case paths the diff and history use. One
 * function joins them so the refusal beside the Save button, the marker beside
 * the control and the history list all use one word for one field (L118).
 */
import { describe, expect, it } from 'vitest'
import { SOLD_ON } from '@bidspoke/buyer-profile'
import { alsoSellTo, describeProfileErrors, formatProfileValue, profileErrorLabel, profileFieldLabel, SECTION_LABELS, FIELD_LABELS, SOLD_ON_LABELS } from '../labels'

describe('profileErrorLabel', () => {
  it('maps every path the shared validator can emit to the words on the form', () => {
    expect(profileErrorLabel('priority')).toBe('Priority')
    expect(profileErrorLabel('allowedStates')).toBe('States')
    expect(profileErrorLabel('debtMin')).toBe('Debt minimum')
    expect(profileErrorLabel('debtMax')).toBe('Debt maximum')
    expect(profileErrorLabel('loanAmountMin')).toBe('Loan amount minimum')
    expect(profileErrorLabel('hourlyLeadCap')).toBe('Leads per hour')
    expect(profileErrorLabel('dailyLeadCap')).toBe('Leads per day')
    expect(profileErrorLabel('hourlySpendCapCents')).toBe('Spend per hour')
    expect(profileErrorLabel('dailySpendCapCents')).toBe('Spend per day')
    expect(profileErrorLabel('isEnabled')).toBe('Enabled')
    expect(profileErrorLabel('windows')).toBe(SECTION_LABELS.windows)
    expect(profileErrorLabel('blackoutDates')).toBe(SECTION_LABELS.blackout_dates)
    expect(profileErrorLabel('tiers')).toBe(SECTION_LABELS.tiers)
    expect(profileErrorLabel('acceptSignals')).toBe(SECTION_LABELS.accept_signals)
    // The two partner record fields an enabled profile needs (#1416), named as the form names them.
    expect(profileErrorLabel('clickUrl')).toBe('Click URL')
    expect(profileErrorLabel('externalRoutingCode')).toBe('Salesforce routing code')
  })

  it('is one vocabulary with the field labels the history list uses, not a second copy', () => {
    for (const [snake, label] of Object.entries(FIELD_LABELS)) {
      const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      expect(profileErrorLabel(camel), snake).toBe(label)
    }
  })

  it('falls back to the path itself rather than to nothing, so a new validator path is visibly unlabelled', () => {
    expect(profileErrorLabel('somethingNew')).toBe('somethingNew')
  })

  // #1541: the kind, and the one cap a click buyer has, named as its form names them.
  it('names the kind Sold on, and the daily cap Clicks per day for a click buyer only', () => {
    expect(profileErrorLabel('soldOn')).toBe('Sold on')
    expect(profileErrorLabel('dailyLeadCap', 'click')).toBe('Clicks per day')
    expect(profileErrorLabel('dailyLeadCap', 'offer')).toBe('Leads per day')
    expect(describeProfileErrors([{ code: 'enabled_without_daily_cap', path: 'dailyLeadCap', message: 'Set the clicks per day before enabling.' }], 'click'))
      .toBe('Clicks per day: Set the clicks per day before enabling.')
  })
})

describe('the sold_on vocabulary on screen (#1541)', () => {
  it('labels every kind the package defines, and the history shows the label, not the stored word', () => {
    for (const kind of SOLD_ON) expect(SOLD_ON_LABELS[kind].length).toBeGreaterThan(0)
    expect(profileFieldLabel('sold_on')).toBe('Sold on')
    expect(formatProfileValue('sold_on', 'click')).toBe(SOLD_ON_LABELS.click)
    expect(formatProfileValue('sold_on', 'offer')).toBe(SOLD_ON_LABELS.offer)
  })
})

describe('alsoSellTo (#1557): one sentence for both usage panels, grammatical for one seller or many', () => {
  it('agrees with one seller, two, and three', () => {
    expect(alsoSellTo([{ name: 'Main Flow' }], 'Tripoint')).toBe('Main Flow also sells to Tripoint')
    expect(alsoSellTo([{ name: 'Main Flow' }, { name: 'Lead Economy' }], 'Tripoint')).toBe('Main Flow and Lead Economy also sell to Tripoint')
    expect(alsoSellTo([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 'Tripoint')).toBe('A, B and C also sell to Tripoint')
  })
})

describe('describeProfileErrors', () => {
  it('names each refused field and carries the validator message, never a direction word', () => {
    const text = describeProfileErrors([
      { code: 'hourly_cap_above_daily', path: 'hourlyLeadCap', message: 'The hourly lead cap is above the daily lead cap.' },
      { code: 'enabled_without_states', path: 'allowedStates', message: 'Choose at least one state before enabling. An empty list accepts no leads.' },
    ])
    expect(text).toBe(
      'Leads per hour: The hourly lead cap is above the daily lead cap. States: Choose at least one state before enabling. An empty list accepts no leads.',
    )
    expect(text).not.toMatch(/below|above the button|marked/i)
  })

  it('states one field once when the validator refuses it twice', () => {
    const text = describeProfileErrors([
      { code: 'tiers_overlap', path: 'tiers', message: 'Two price tiers cover the same debt.' },
      { code: 'tiers_gap', path: 'tiers', message: 'The price tiers leave part of the accepted debt range without a price.' },
    ])
    expect(text).toBe('Pricing: Two price tiers cover the same debt. The price tiers leave part of the accepted debt range without a price.')
  })
})

describe('click delivery words (#1639)', () => {
  it('names the validator paths as the section names its controls', () => {
    expect(profileErrorLabel('clickDelivery')).toBe('Click delivery')
    expect(profileErrorLabel('clickDelivery.routes')).toBe('Routes')
    expect(profileErrorLabel('clickDelivery.routes[1].url')).toBe('Route 2 address')
    expect(profileErrorLabel('clickDelivery.routes[0].name')).toBe('Route 1 name')
    expect(profileErrorLabel('clickDelivery.routes[0].states')).toBe('Route 1 states')
    expect(profileErrorLabel('clickDelivery.successPattern')).toBe('Success reply')
  })

  it('names the history paths and shows a route by its address and states', () => {
    expect(profileFieldLabel('click_delivery.success_pattern')).toBe('Success reply')
    expect(profileFieldLabel('click_delivery.routes[DV1]')).toBe('Route DV1')
    expect(formatProfileValue('click_delivery.routes[DV1]', { url: 'https://a.example/dv1', states: ['WA', 'OR'] })).toBe('https://a.example/dv1 for OR, WA')
    expect(formatProfileValue('click_delivery.routes[DI4]', { url: 'https://a.example/di4', states: [] })).toBe('https://a.example/di4 for every state no other route lists')
    expect(formatProfileValue('click_delivery.routes[DI4]', null)).toBe('none')
  })
})

/**
 * #1672: the history reads audit_log rows that save_buyer_profile writes through
 * buyer_profile_flatten, whose paths are DOTTED (`windows.1.660`), not the
 * bracket keys diff.ts uses for the conflict view (`windows[1:660]`). The rows
 * below are copied from real audit_log changes (read 2026-10-02): Liberty1's
 * hours move on 2026-10-01, Tripoint's pricing edit on 2026-09-23, and the
 * click delivery save on 2026-09-30 (route addresses replaced by example ones).
 * No blackout date has ever been saved, so that row is built from the flatten's
 * own shape: `'blackout_dates.' || date`, valued by the note.
 */
describe('history paths in the dotted form buyer_profile_flatten writes (#1672)', () => {
  const realRows: Record<string, { old: unknown; new: unknown }> = {
    'windows.1.660': { old: 1260, new: null },
    'windows.1.540': { old: null, new: 1260 },
    'windows.0.0': { old: null, new: 1440 },
    'tiers.engine.10000.debt_to': { old: null, new: 12500 },
    'tiers.engine.10000.multiplier': { old: null, new: 0.0009 },
    'tiers.engine.0.multiplier': { old: 0.0009, new: null },
    'click_delivery.success_pattern': { old: null, new: '(?<id>\\w+)' },
    'click_delivery.routes[DV1]': { old: null, new: { url: 'https://a.example/dv1', states: ['DE', 'HI'] } },
  }

  it('labels every real row in the form\'s words, never as the raw path', () => {
    for (const path of Object.keys(realRows)) expect(profileFieldLabel(path), path).not.toBe(path)
  })

  it('names an hours row by its day and opening time, valued by its closing time', () => {
    expect(profileFieldLabel('windows.1.660')).toBe('Monday hours from 11:00 AM')
    expect(profileFieldLabel('windows.0.0')).toBe('Sunday hours from 12:00 AM')
    expect(formatProfileValue('windows.1.540', 1260)).toBe('open until 9:00 PM')
    expect(formatProfileValue('windows.1.660', null)).toBe('none')
  })

  it('names a pricing row by its tier and the field that moved', () => {
    expect(profileFieldLabel('tiers.engine.10000.multiplier')).toBe('Engine tier from $10,000 multiplier')
    expect(profileFieldLabel('tiers.engine.10000.debt_to')).toBe('Engine tier from $10,000 upper bound')
    expect(profileFieldLabel('tiers.main_flow.0.multiplier')).toBe('Main Flow tier from $0 multiplier')
    expect(profileFieldLabel('tiers.lead_economy.12500.debt_to')).toBe('Lead Economy tier from $12,500 upper bound')
    expect(formatProfileValue('tiers.engine.10000.multiplier', 0.0009)).toBe('0.0009')
    expect(formatProfileValue('tiers.engine.10000.debt_to', 12500)).toBe('$12,500.00')
    expect(formatProfileValue('tiers.engine.0.multiplier', null)).toBe('none')
  })

  it('names a blackout row by its date, valued by its note', () => {
    expect(profileFieldLabel('blackout_dates.2026-12-25')).toBe('Blackout 2026-12-25 note')
    expect(formatProfileValue('blackout_dates.2026-12-25', 'Christmas')).toBe('Christmas')
    expect(formatProfileValue('blackout_dates.2026-12-25', null)).toBe('none')
  })

  it('labels every scalar key the flatten passes through from buyer_profile_document', () => {
    const documentScalars = ['sold_on', 'is_enabled', 'priority', 'allowed_states', 'debt_min', 'debt_max', 'loan_amount_min', 'hourly_lead_cap', 'daily_lead_cap', 'hourly_spend_cap_cents', 'daily_spend_cap_cents']
    for (const key of documentScalars) expect(profileFieldLabel(key), key).not.toBe(key)
  })

  it('still reads the bracket keys the conflict view diff produces', () => {
    expect(profileFieldLabel('windows[1:660]')).toBe('Monday hours from 11:00 AM')
    expect(profileFieldLabel('tiers[engine:10000]')).toBe('Engine tier from $10,000')
    expect(profileFieldLabel('blackout_dates[2026-12-25]')).toBe('Blackout 2026-12-25')
    expect(formatProfileValue('windows[1:660]', { day_of_week: 1, opens_minute: 660, closes_minute: 1260 })).toBe('11:00 AM to 9:00 PM')
    expect(formatProfileValue('tiers[engine:10000]', { multiplier: 0.0009, debt_to: 12500 })).toBe('0.0009 with up to $12,500')
    expect(formatProfileValue('blackout_dates[2026-12-25]', { date: '2026-12-25', note: null })).toBe('off')
  })
})
