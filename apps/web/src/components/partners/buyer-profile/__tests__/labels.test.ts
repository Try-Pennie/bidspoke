/**
 * The save refusal names each refused field by the words on screen (#1464).
 *
 * The validator's paths are the profile's camelCase field names; the form's
 * labels are keyed by the snake_case paths the diff and history use. One
 * function joins them so the refusal beside the Save button, the marker beside
 * the control and the history list all use one word for one field (L118).
 */
import { describe, expect, it } from 'vitest'
import { describeProfileErrors, profileErrorLabel, SECTION_LABELS, FIELD_LABELS } from '../labels'

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
