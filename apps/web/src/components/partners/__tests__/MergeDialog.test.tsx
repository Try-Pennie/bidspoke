/**
 * The field level merge dialog (#2134, PM-3).
 *
 * As the settled design draws it (#2322): what only you changed (kept), what
 * only they changed (added), each with its value before and after, then what you
 * both changed, one line each with Keep yours chosen to start. A combination the
 * save would refuse is never chosen for the person. Keep editing, Escape and a
 * click outside close it and keep the answers.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { BuyerProfileDocument } from '@bidspoke/buyer-profile'
import type { PartnerBody } from '@/lib/api'
import { PARTNER_FIELD_REGISTRY } from '@/app/(app)/partners/partner-draft'
import { mergeThreeWay, type MergeSide, type PageHalves } from '@/lib/partner-page-merge'
import { describeMergeValue, MergeDialog } from '../MergeDialog'

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
  it('names who saved, says nothing is lost, and groups by what happens to each change (#2322)', () => {
    renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Editor A saved this partner while you were editing' })
    expect(dialog).toHaveAccessibleDescription("Nothing is lost. Saving keeps your changes and adds Editor's. Only where you both changed the same field do you choose.")
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Only Editor changed', 'You both changed'])
    expect(within(dialog).getAllByRole('radiogroup')).toHaveLength(3)
    for (const name of ['Name', 'Leads per day', 'Hours (Eastern), Monday']) expect(within(dialog).getByRole('radiogroup', { name })).toBeInTheDocument()
  })

  it('a field you both changed is one line, yours then theirs, with the choice beside it', () => {
    renderDialog()
    expect(question('Leads per day')).toHaveTextContent('Leads per dayyours 600, Editor\'s 250')
    expect(question('Hours (Eastern), Monday')).toHaveTextContent('yours 10:00 AM to 5:00 PM, Editor\'s 8:00 AM to 5:00 PM')
    expect(within(question('Leads per day')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Keep yours', "Use Editor's"])
  })

  it('the choice is described by the values it chooses between, and by the reason when there is one', () => {
    renderDialog()
    expect(screen.getByRole('radiogroup', { name: 'Leads per day' })).toHaveAccessibleDescription("yours 600, Editor's 250")
  })

  it('a change only one of you made shows its value before and after, and what happens to it', () => {
    renderDialog()
    const row = screen.getByText('Active', { selector: 'span' }).closest('[data-merge-change]') as HTMLElement
    expect(row).toHaveTextContent('ActiveOn \u2192 Offadded')
  })

  it('Keep yours is chosen to start, so Save both is ready at once', () => {
    const props = renderDialog()
    for (const group of screen.getAllByRole('radiogroup')) expect(within(group).getByRole('radio', { name: 'Keep yours' })).toHaveAttribute('aria-checked', 'true')
    const save = screen.getByRole('button', { name: 'Save both' })
    expect(save).toBeEnabled()
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getAllByRole('radio', { name: "Use Editor's" })[1])
    expect(props.onChoose).toHaveBeenCalledWith('profile.daily_lead_cap', 'theirs')
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
    // A combination the save would refuse is never chosen for the person: Save both waits on it.
    expect(within(question('Accept when all of')).getByRole('radio', { name: 'Keep yours' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: 'Save both' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Choose for 1 more field.')
  })

  it('a row group side that is not a list reads as none of it, never throwing while the dialog renders', () => {
    for (const key of ['profile.windows@1', 'profile.tiers@engine', 'profile.blackout_dates', 'profile.click_delivery.routes']) {
      expect(() => describeMergeValue(key, null), key).not.toThrow()
      expect(() => describeMergeValue(key, { not: 'a list' }), key).not.toThrow()
    }
    expect(describeMergeValue('profile.windows@1', null)).toBe('closed')
    expect(describeMergeValue('profile.click_delivery.routes', undefined)).toBe('no routes')
  })
})
