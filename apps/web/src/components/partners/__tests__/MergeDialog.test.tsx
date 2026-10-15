/**
 * The field level merge dialog (#2134, PM-3).
 *
 * Only what both people changed asks a question, grouped by section, each with
 * Keep yours or Use theirs and the value before, yours and theirs. What only one
 * of them changed is named as kept or added. Saving waits for every answer;
 * Keep editing, Escape and a click outside close it and keep the answers.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'
import type { PartnerBody } from '@/lib/api'
import { PARTNER_FIELD_REGISTRY } from '@/app/(app)/partners/partner-draft'
import { mergeThreeWay, type MergeSide, type PageHalves } from '@/lib/partner-page-merge'
import { MergeDialog } from '../MergeDialog'

const partner: PartnerBody = { name: 'Tripoint', is_active: true, accept_signals: [{ field: 'ok', equals: true }], click_url: 'https://trypennie.com/portal/tpl', external_routing_code: 2 }
const profile: BuyerProfileDocument = {
  partner_id: 'p1', version: 3, sold_on: 'offer', is_enabled: true, priority: 1, allowed_states: ['TX'],
  debt_min: 10000, debt_max: null, loan_amount_min: 2000, hourly_lead_cap: null, daily_lead_cap: 500, hourly_spend_cap_cents: null, daily_spend_cap_cents: null,
  windows: [{ day_of_week: 1, opens_minute: 540, closes_minute: 1020 }], blackout_dates: [],
  tiers: [{ population: 'engine', debt_from: 10000, debt_to: null, multiplier: 0.0013 }],
}
const base: PageHalves = { partner, profile }
const mine: PageHalves = { partner: { ...partner, name: 'Tripoint Lending' }, profile: { ...profile, daily_lead_cap: 600, windows: [{ day_of_week: 1, opens_minute: 600, closes_minute: 1020 }] } }
const theirs: PageHalves = { partner: { ...partner, name: 'TPL', is_active: false }, profile: { ...profile, version: 4, daily_lead_cap: 250, windows: [{ day_of_week: 1, opens_minute: 480, closes_minute: 1020 }] } }

/** One question's row: its radio group and the values beside it. */
const question = (name: string) => screen.getByRole('radiogroup', { name }).closest('[data-merge-key]') as HTMLElement

function renderDialog(choices: Record<string, MergeSide> = {}, over: Partial<Parameters<typeof MergeDialog>[0]> = {}) {
  const props = {
    result: mergeThreeWay(base, mine, theirs, PARTNER_FIELD_REGISTRY, choices),
    theirName: 'Editor A',
    onChoose: vi.fn(),
    onSave: vi.fn(),
    onKeepEditing: vi.fn(),
    ...over,
  }
  render(<MergeDialog {...props} />)
  return props
}

describe('MergeDialog', () => {
  it('names who saved, and groups only the both changed fields by section', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Editor A saved this partner while you were editing' })
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Identity', 'Caps', 'Hours'])
    expect(within(dialog).getAllByRole('radiogroup')).toHaveLength(3)
    for (const name of ['Name', 'Leads per day', 'Hours, Monday']) expect(within(dialog).getByRole('radiogroup', { name })).toBeInTheDocument()
  })

  it('does not repeat the section heading on its questions (L605)', () => {
    renderDialog()
    const hours = screen.getByRole('region', { name: 'Hours' })
    expect(within(hours).getByRole('radiogroup', { name: 'Hours, Monday' })).toBeInTheDocument()
    expect(hours.textContent?.match(/Hours/g)).toHaveLength(2)
  })

  it('shows each field\'s value before, yours and theirs, in the words the page uses', () => {
    renderDialog()
    const caps = question('Leads per day')
    expect(caps).toHaveTextContent('Was 500')
    expect(caps).toHaveTextContent('Yours 600')
    expect(caps).toHaveTextContent('Theirs 250')
    expect(question('Hours, Monday')).toHaveTextContent('Yours 10:00 to 17:00')
  })

  it('the choice is described by the values it chooses between, and by the reason when there is one', () => {
    renderDialog()
    expect(screen.getByRole('radiogroup', { name: 'Leads per day' })).toHaveAccessibleDescription(/Was 500.*Yours 600.*Theirs 250/)
  })

  it('names what only one of you changed, kept with no question', () => {
    renderDialog()
    expect(screen.getByText('Their change to Status is added.')).toBeInTheDocument()
  })

  it('Save both waits for every answer, and says how many are left', () => {
    const props = renderDialog({ name: 'mine' })
    expect(screen.getByRole('button', { name: 'Save both' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Choose for 2 more fields.')
    fireEvent.click(screen.getAllByRole('radio', { name: 'Use theirs' })[1])
    expect(props.onChoose).toHaveBeenCalledWith('profile.daily_lead_cap', 'theirs')
  })

  it('every answer given enables Save both', () => {
    const props = renderDialog({ name: 'mine', 'profile.daily_lead_cap': 'theirs', 'profile.windows@1': 'mine' })
    const save = screen.getByRole('button', { name: 'Save both' })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(props.onSave).toHaveBeenCalledTimes(1)
  })

  it('Escape is Keep editing and saves nothing', () => {
    const props = renderDialog({ name: 'mine', 'profile.daily_lead_cap': 'theirs', 'profile.windows@1': 'mine' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(props.onKeepEditing).toHaveBeenCalledTimes(1)
    expect(props.onSave).not.toHaveBeenCalled()
  })

  it('shows the reason a combination was refused beside the field it names', () => {
    const start = { ...base, profile: { ...profile, is_enabled: false } }
    const result = mergeThreeWay(start, { partner, profile: { ...profile, is_enabled: true } }, { partner: { ...partner, accept_signals: [] }, profile: { ...profile, is_enabled: false, version: 4 } }, PARTNER_FIELD_REGISTRY)
    render(<MergeDialog result={result} theirName={null} onChoose={vi.fn()} onSave={vi.fn()} onKeepEditing={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Someone else saved this partner while you were editing' })).toBeInTheDocument()
    expect(question('Accept when all of')).toHaveTextContent(/cannot be saved together/i)
  })
})
