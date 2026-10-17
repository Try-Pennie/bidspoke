/**
 * The held clicks panel (#1552, #2139): the clicks a click buyer's send left
 * held, each a card with a person's two releases, and the sales marked sent
 * that stay listed for a Salesforce retry or a lead id still to add.
 *
 * Loading, a failed read and an empty list are three different screens (L10);
 * each button says what it does beside it; a release confirms with the
 * consequence for that card (L180); a destructive control looks destructive at
 * rest and asks first in the app Dialog; the outcome shows on its card; and the
 * key that commits a lead id never also submits the partner form (L596).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { HeldClick } from '@/lib/api'
import type { SaleWrites } from '@bidspoke/buyer-profile'
import { HeldClicksPanel } from '../HeldClicksPanel'

const row = (over: Partial<HeldClick> = {}): HeldClick => ({
  id: 'held-1', prospect_id: 'a0B000000000001AAA', reason: 'outcome_unknown', detail: 'http 503: Service Unavailable', partner_lead_id: null,
  workflow_id: 'wf-1', execution_id: 'exec-1', held_at: '2027-09-20T18:00:00.000Z', last_seen_at: '2027-09-20T18:00:00.000Z',
  claim: { status: 'held', generation: 2 }, salesforce: null, ...over,
})

function panel(props: Partial<Parameters<typeof HeldClicksPanel>[0]> = {}) {
  const handlers = { onMarkSent: vi.fn(), onFree: vi.fn(), onClear: vi.fn(), onRetrySalesforce: vi.fn(), onSetLeadId: vi.fn() }
  render(<HeldClicksPanel partnerName="Liberty1" zone="America/Los_Angeles" held={{ entries: [row()], total: 1 }} error={null} outcomes={{}} {...handlers} {...props} />)
  return handlers
}

const card = () => screen.getAllByRole('listitem')[0]

const allWritten = (buyerLeadId: string | null): SaleWrites => ({
  complete: true,
  records_from: 'step_log',
  buyer_lead_id: buyerLeadId,
  writes: [
    { record: 'prospect', object: 'Prospect__c', id: 'a06Ui00002qCeSaIAK', outcome: 'written' },
    { record: 'submission', object: 'Submission__c', id: 'a0CUi00000abcdeFAA', outcome: 'written' },
    { record: 'lead', object: 'Lead', id: '00QUi00000lead1AAA', outcome: 'written' },
  ],
})
const oneFailed: SaleWrites = {
  complete: false,
  records_from: 'step_log',
  writes: [
    { record: 'prospect', object: 'Prospect__c', id: 'a06Ui00002qCeSaIAK', outcome: 'written' },
    { record: 'submission', object: 'Submission__c', id: 'a0CUi00000abcdeFAA', outcome: 'failed', message: 'Salesforce refused the Submission__c update (400): FIELD_CUSTOM_VALIDATION_EXCEPTION' },
    { record: 'lead', object: 'Lead', id: '00QUi00000lead1AAA', outcome: 'written' },
  ],
}
const soldAs = (id: string | null) => ({ status: 'sold' as const, generation: 4, partner_lead_id: id })

describe('HeldClicksPanel states', () => {
  it('loading says it is reading', () => {
    panel({ held: null })
    expect(screen.getByRole('status')).toHaveTextContent('Reading the held clicks')
  })

  it('a failed read is an alert naming the failure, never the empty statement', () => {
    panel({ held: null, error: 'API 503' })
    expect(screen.getByRole('alert')).toHaveTextContent('The held clicks could not be read: API 503')
    expect(screen.queryByText(/No clicks are held/)).toBeNull()
  })

  it('an empty list says so positively', () => {
    panel({ held: { entries: [], total: 0 } })
    expect(screen.getByText('No clicks are held for Liberty1: every click sent has an outcome.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })

  // #2253: held since and releasable after are shown in the profile's display
  // zone, as the hours are; the day a click counts on stays Pacific.
  it('shows when a click was held in the profile\'s display zone, naming it, and keeps its count day Pacific', () => {
    panel({ zone: 'America/New_York' })
    expect(card()).toHaveTextContent('Sep 20, 2:00 PM EDT')
    expect(card()).not.toHaveTextContent('PDT')
  })

  it('one held click is a card: the prospect links to its execution, since when in Pacific time, and why', () => {
    panel()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    const link = within(card()).getByRole('link', { name: 'a0B000000000001AAA' })
    expect(link).toHaveAttribute('href', '/workflows/wf-1/executions/exec-1')
    expect(card()).toHaveTextContent('Sep 20, 11:00 AM PDT')
    expect(card()).toHaveTextContent('The buyer gave no readable answer')
    expect(card()).toHaveTextContent('http 503: Service Unavailable')
  })

  it('a card without its execution names the prospect without a dead link', () => {
    panel({ held: { entries: [row({ workflow_id: null })], total: 1 } })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('a0B000000000001AAA')).toBeInTheDocument()
  })
})

describe('HeldClicksPanel lead sentence counts only held claims (#2139)', () => {
  it('one held click', () => {
    panel()
    expect(screen.getByText('1 click held. No later click on this prospect is sent until it is released.')).toBeInTheDocument()
  })

  it('a send still inside its window counts as held; a sale on the list does not', () => {
    const entries = [
      row(),
      row({ id: 'held-2', claim: { status: 'sending', generation: 1, releasable_at: '2027-09-20T18:00:40.000Z' } }),
      row({ id: 'held-3', claim: soldAs(null), salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'written' }),
      row({ id: 'held-4', claim: { status: 'free', generation: 3 } }),
    ]
    panel({ held: { entries, total: 4 } })
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByText('2 clicks held. No later click on these prospects is sent until each is released.')).toBeInTheDocument()
  })

  it('a list holding only sales says no click is held', () => {
    panel({ held: { entries: [row({ claim: soldAs(null), salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'written' })], total: 1 } })
    expect(screen.getByText('No clicks are held for Liberty1.')).toBeInTheDocument()
    expect(screen.queryByText(/click held/)).toBeNull()
  })

  it('a list past the rows shown says at least, and how many are shown', () => {
    const entries = [row(), row({ id: 'held-2', prospect_id: 'a0B000000000002AAA' }), row({ id: 'held-3', prospect_id: 'a0B000000000003AAA' })]
    panel({ held: { entries, total: 140 } })
    expect(screen.getByText('At least 3 clicks held. No later click on these prospects is sent until each is released.')).toBeInTheDocument()
    expect(screen.getByText('Showing the oldest 3 of 140.')).toBeInTheDocument()
  })
})

describe('HeldClicksPanel releases', () => {
  it('each button says what it does beside it', () => {
    panel()
    expect(within(card()).getByText('The buyer has it. Counted, and Completed in Salesforce.')).toBeInTheDocument()
    expect(within(card()).getByText('The buyer does not have it. The next click sends again.')).toBeInTheDocument()
  })

  it('Free looks destructive at rest, confirms with the consequence, and frees at the generation shown', () => {
    const h = panel()
    const free = screen.getByRole('button', { name: 'Free' })
    expect(free.className).toMatch(/btn-danger/)
    fireEvent.click(free)
    expect(screen.getByText('Use this only if Liberty1 does not have this lead. The claim is freed, the next click on this prospect sends it to Liberty1 again, and nothing is counted.')).toBeInTheDocument()
    expect(h.onFree).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Free it' }))
    expect(h.onFree).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }), 2)
  })

  it('Mark sent opens an optional lead id box; with nothing typed it says so and marks it sent with no lead id (PM-7)', () => {
    const h = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    const input = screen.getByLabelText("Liberty1's lead id, if you have it")
    expect(input).toHaveAttribute('placeholder', 'Optional')
    expect(input).toHaveAccessibleDescription("The click is counted in Liberty1's clicks for Sep 20 (Pacific), and Salesforce marks the sale Completed with no lead id. A later click on this prospect will not send.")
    const confirm = screen.getByRole('button', { name: 'Mark it sent' })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(h.onMarkSent).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }), 2, null)
  })

  it('a typed lead id is named in the consequence and sent trimmed; spaces alone are no lead id', () => {
    const h = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    const input = screen.getByLabelText("Liberty1's lead id, if you have it")
    fireEvent.change(input, { target: { value: '  a0B5f00000XyZ12AAB ' } })
    expect(input).toHaveAccessibleDescription("The click is counted in Liberty1's clicks for Sep 20 (Pacific), and Salesforce marks the sale Completed with lead id a0B5f00000XyZ12AAB. A later click on this prospect will not send.")
    fireEvent.click(screen.getByRole('button', { name: 'Mark it sent' }))
    expect(h.onMarkSent).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'held-1' }), 2, 'a0B5f00000XyZ12AAB')
  })

  it('spaces alone mark it sent with no lead id', () => {
    const h = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    fireEvent.change(screen.getByLabelText("Liberty1's lead id, if you have it"), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark it sent' }))
    expect(h.onMarkSent).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }), 2, null)
  })

  it('a lead id with a space inside, or too long, is refused on the card before anything is sent', () => {
    const h = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    const input = screen.getByLabelText("Liberty1's lead id, if you have it")
    fireEvent.change(input, { target: { value: 'L1F 778' } })
    expect(screen.getByRole('alert')).toHaveTextContent('A lead id has no spaces and is at most 200 characters.')
    expect(input).toHaveAccessibleDescription('A lead id has no spaces and is at most 200 characters.')
    expect(screen.getByRole('button', { name: 'Mark it sent' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.change(input, { target: { value: 'x'.repeat(201) } })
    expect(screen.getByRole('button', { name: 'Mark it sent' })).toBeDisabled()
    expect(h.onMarkSent).not.toHaveBeenCalled()
  })

  it('the lead id the buyer already gave is filled in', () => {
    panel({ held: { entries: [row({ reason: 'sold_mark_failed', partner_lead_id: 'a0B5f00000XyZ12AAB' })], total: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    expect(screen.getByLabelText("Liberty1's lead id, if you have it")).toHaveValue('a0B5f00000XyZ12AAB')
  })

  it('Enter in the lead id confirms the mark and never submits the form around it', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault())
    const onMarkSent = vi.fn()
    render(
      <form onSubmit={onSubmit}>
        <HeldClicksPanel partnerName="Liberty1" zone="America/Los_Angeles" held={{ entries: [row()], total: 1 }} error={null} outcomes={{}} onMarkSent={onMarkSent} onFree={vi.fn()} onClear={vi.fn()} onRetrySalesforce={vi.fn()} onSetLeadId={vi.fn()} />
      </form>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    const input = screen.getByLabelText("Liberty1's lead id, if you have it")
    fireEvent.change(input, { target: { value: 'a0B5f00000XyZ12AAB' } })
    // jsdom does not perform implicit submission, so the proof is the default
    // being prevented: false from dispatch means preventDefault was called.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(onMarkSent).toHaveBeenCalledTimes(1)
    expect(onMarkSent).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }), 2, 'a0B5f00000XyZ12AAB')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Cancel releases nothing', () => {
    const h = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Free' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(h.onFree).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Free' })).toBeInTheDocument()
  })

  it('the outcome of a release shows on its card in place of the controls', () => {
    panel({ outcomes: { 'held-1': { kind: 'done', message: 'Freed. The next click on this prospect sends it to Liberty1.' } } })
    expect(screen.getByRole('status')).toHaveTextContent('Freed. The next click on this prospect sends it to Liberty1.')
    expect(screen.queryByRole('button', { name: 'Free' })).toBeNull()
  })

  it('a failed release keeps the controls and says why', () => {
    panel({ outcomes: { 'held-1': { kind: 'failed', message: 'This click changed since the page was read, so nothing was done. Reload to see where it stands.' } } })
    expect(screen.getByRole('alert')).toHaveTextContent('changed since the page was read')
    expect(screen.getByRole('button', { name: 'Free' })).toBeInTheDocument()
  })
})

describe('HeldClicksPanel claim states other than held', () => {
  it('a send still inside its window offers nothing yet and says when it can be released', () => {
    panel({ held: { entries: [row({ claim: { status: 'sending', generation: 1, releasable_at: '2027-09-20T18:00:40.000Z' } })], total: 1 } })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Still sending. It can be released after 11:00 AM PDT.')).toBeInTheDocument()
  })

  it('a freed claim says so and is removed without a question', () => {
    const h = panel({ held: { entries: [row({ claim: { status: 'free', generation: 3 } })], total: 1 } })
    expect(screen.getByText('No longer held: the claim is free.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from the list' }))
    expect(h.onClear).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }))
  })

  it('a claim that could not be read is an alert on its card, with nothing to press', () => {
    panel({ held: { entries: [row({ claim: { status: 'unreadable', message: 'The claim did not answer: timeout' } })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('The claim did not answer: timeout')
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('HeldClicksPanel a sale marked sent (#2139)', () => {
  it('with a lead id and every update landed: marked sent, its id, Completed, no retry, removed without a question', () => {
    const h = panel({ held: { entries: [row({ claim: soldAs('a0B5f00000XyZ12AAB'), counted: true, salesforce: { status: 'recorded', at: 'x', writes: allWritten('a0B5f00000XyZ12AAB') }, salesforce_standing: 'written' })], total: 1 } })
    // #2325: "Counted." as the design words the header of a marked sent card, once the page knows the count landed.
    expect(card()).toHaveTextContent("Marked sent Counted. Liberty1's lead id: a0B5f00000XyZ12AAB. Completed in Salesforce.")
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry Salesforce' })).toBeNull()
    expect(screen.getByRole('button', { name: "Correct Liberty1's lead id" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from the list' }))
    expect(h.onClear).toHaveBeenCalledTimes(1)
  })

  // Before #2139 the panel wrote "already marked sent as <id>": with no id it must not say "as".
  it('with no lead id: says none was given, never "as", and offers to add one', () => {
    panel({ held: { entries: [row({ claim: soldAs(null), counted: true, salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'written' })], total: 1 } })
    expect(card()).toHaveTextContent("Marked sent Counted. Liberty1's lead id: none given. Completed in Salesforce.")
    expect(card()).not.toHaveTextContent(/ as /)
    expect(screen.getByRole('button', { name: "Add Liberty1's lead id" })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Correct/ })).toBeNull()
  })

  // #2325: the card says Counted only when this page's Mark sent was told the count
  // landed. A count that did not land, or a sale read after a reload, when the Worker
  // keeps no record of the count, claims nothing (L11).
  it.each([['told the count did not land', false], ['read after a reload', undefined]] as const)('a sale %s does not say Counted', (_, counted) => {
    panel({ held: { entries: [row({ claim: soldAs(null), counted, salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'written' })], total: 1 } })
    expect(card()).toHaveTextContent("Marked sent Liberty1's lead id: none given.")
    expect(card()).not.toHaveTextContent('Counted.')
  })

  it('Add lead id: the box needs an id, names the consequence, and adds it at the generation shown', () => {
    const h = panel({ held: { entries: [row({ claim: soldAs(null), salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'written' })], total: 1 } })
    fireEvent.click(screen.getByRole('button', { name: "Add Liberty1's lead id" }))
    const input = screen.getByLabelText("Liberty1's lead id")
    const confirm = screen.getByRole('button', { name: 'Add the lead id' })
    expect(confirm).toBeDisabled()
    expect(input).toHaveAccessibleDescription('Enter the lead id Liberty1 shows for this prospect.')
    fireEvent.change(input, { target: { value: 'L1F-778' } })
    expect(input).toHaveAccessibleDescription('Records lead id L1F-778 for this sale and writes it to Salesforce.')
    fireEvent.click(confirm)
    expect(h.onSetLeadId).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }), 4, 'L1F-778')
  })

  it('Correct lead id: starts from the id it has, refuses the same id, and names both in the consequence', () => {
    const h = panel({ held: { entries: [row({ claim: soldAs('L1F-77'), salesforce: { status: 'recorded', at: 'x', writes: allWritten('L1F-77') }, salesforce_standing: 'written' })], total: 1 } })
    fireEvent.click(screen.getByRole('button', { name: "Correct Liberty1's lead id" }))
    const input = screen.getByLabelText("Liberty1's lead id")
    expect(input).toHaveValue('L1F-77')
    expect(screen.getByRole('button', { name: 'Correct the lead id' })).toBeDisabled()
    expect(input).toHaveAccessibleDescription('This sale already has lead id L1F-77.')
    fireEvent.change(input, { target: { value: 'L1F-778' } })
    expect(input).toHaveAccessibleDescription('Replaces lead id L1F-77 with L1F-778 for this sale and writes it to Salesforce.')
    // Enter commits it, as the button does.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(h.onSetLeadId).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }), 4, 'L1F-778')
  })

  it('a lead id with a space inside is refused on the card', () => {
    const h = panel({ held: { entries: [row({ claim: soldAs(null), salesforce: { status: 'none' }, salesforce_standing: 'not_recorded' })], total: 1 } })
    fireEvent.click(screen.getByRole('button', { name: "Add Liberty1's lead id" }))
    fireEvent.change(screen.getByLabelText("Liberty1's lead id"), { target: { value: 'L1F 778' } })
    expect(screen.getByText('A lead id has no spaces and is at most 200 characters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add the lead id' })).toBeDisabled()
    expect(h.onSetLeadId).not.toHaveBeenCalled()
  })

  it('removing a sale with no lead id asks first in the Dialog, because the list is where its id can be added', () => {
    const h = panel({ held: { entries: [row({ claim: soldAs(null), salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'written' })], total: 1 } })
    const remove = screen.getByRole('button', { name: 'Remove from the list' })
    expect(remove.className).toMatch(/btn-danger/)
    fireEvent.click(remove)
    const dialog = screen.getByRole('alertdialog', { name: 'Remove a0B000000000001AAA from the list?' })
    expect(dialog).toHaveAccessibleDescription("This list is the only place Liberty1's lead id can be added to this sale; after this it can be added only in Salesforce. The sale stays marked sent.")
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(h.onClear).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from the list' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove it' }))
    expect(h.onClear).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }))
  })

  it('a removed entry shows only its outcome: no retry and no lead id action for an entry gone from the list', () => {
    const entry = row({ claim: soldAs(null), salesforce: { status: 'recorded', at: 'x', writes: oneFailed }, salesforce_standing: 'incomplete', cleared: true })
    panel({ held: { entries: [entry], total: 1 }, outcomes: { 'held-1': { kind: 'done', message: 'Removed from the list.' } } })
    expect(screen.getByText('Removed from the list.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('the outcome of Mark sent stays on the card above what is left to do', () => {
    panel({
      held: { entries: [row({ claim: soldAs(null), salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'written' })], total: 1 },
      outcomes: { 'held-1': { kind: 'done', message: 'Marked sent with no lead id from Liberty1.' } },
    })
    expect(screen.getByRole('status')).toHaveTextContent('Marked sent with no lead id from Liberty1.')
    expect(screen.getByRole('button', { name: "Add Liberty1's lead id" })).toBeInTheDocument()
  })
})

describe('HeldClicksPanel Salesforce retry list (PM-8), driven by salesforce_standing', () => {
  const sold = soldAs('L1F-778')

  it('incomplete: every record with its result in Salesforce\'s own words, then Retry Salesforce', () => {
    const h = panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: oneFailed }, salesforce_standing: 'incomplete' })], total: 1 } })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Salesforce was not fully updated.')
    expect(alert).toHaveTextContent('Prospect a06Ui00002qCeSaIAK: updated')
    expect(alert).toHaveTextContent('Submission a0CUi00000abcdeFAA: not updated. Salesforce refused the Submission__c update (400): FIELD_CUSTOM_VALIDATION_EXCEPTION')
    expect(alert).toHaveTextContent('Lead 00QUi00000lead1AAA: updated')
    fireEvent.click(screen.getByRole('button', { name: 'Retry Salesforce' }))
    expect(h.onRetrySalesforce).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }))
  })

  it('removing an entry whose updates did not land looks destructive, asks first in the Dialog, and names the retry it takes', () => {
    const h = panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: oneFailed }, salesforce_standing: 'incomplete' })], total: 1 } })
    const remove = screen.getByRole('button', { name: 'Remove from the list' })
    expect(remove.className).toMatch(/btn-danger/)
    fireEvent.click(remove)
    expect(h.onClear).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog', { name: 'Remove a0B000000000001AAA from the list?' })
    expect(dialog).toHaveAccessibleDescription('Its Salesforce retry goes with it, so whatever Salesforce is missing for this sale must be fixed there by hand. The sale stays marked sent.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove it' }))
    expect(h.onClear).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }))
  })

  it('an entry with no lead id and a failed update names both losses', () => {
    panel({ held: { entries: [row({ claim: soldAs(null), salesforce: { status: 'recorded', at: 'x', writes: oneFailed }, salesforce_standing: 'incomplete' })], total: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove from the list' }))
    expect(screen.getByRole('alertdialog')).toHaveAccessibleDescription("Its Salesforce retry goes with it, so whatever Salesforce is missing for this sale must be fixed there by hand. This list is the only place Liberty1's lead id can be added to this sale; after this it can be added only in Salesforce. The sale stays marked sent.")
  })

  it('a removal that did not clear the entry keeps its retry', () => {
    const entry = row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: oneFailed }, salesforce_standing: 'incomplete' })
    panel({ held: { entries: [entry], total: 1 }, outcomes: { 'held-1': { kind: 'done', message: 'The entry was not removed from this list; reload to see it as it stands.' } } })
    expect(screen.getByRole('button', { name: 'Retry Salesforce' })).toBeInTheDocument()
  })

  it('updates that were never attempted for one reason state it once, not once per record', () => {
    const reason = 'the run exec-1 is in neither the step log nor the execution archive, so which records the click was for is not known'
    const none: SaleWrites = { complete: false, records_from: null, writes: (['prospect', 'submission', 'lead'] as const).map((record) => ({ record, object: record, id: null, outcome: 'not_attempted' as const, message: reason })) }
    panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: none }, salesforce_standing: 'incomplete' })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent(`Salesforce was not updated: ${reason}`)
    expect(screen.getAllByText(new RegExp(reason.slice(0, 20)))).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Retry Salesforce' })).toBeInTheDocument()
  })

  it('a record the click did not name is said to be not part of the click, not a failure', () => {
    const partial: SaleWrites = { complete: false, records_from: 'archive', writes: [
      { record: 'prospect', object: 'Prospect__c', id: 'a06Ui00002qCeSaIAK', outcome: 'failed', message: 'Salesforce token fetch failed (503)' },
      { record: 'submission', object: 'Submission__c', id: null, outcome: 'not_named' },
      { record: 'lead', object: 'Lead', id: null, outcome: 'not_named' },
    ] }
    panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: partial }, salesforce_standing: 'incomplete' })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('Submission: not part of this click')
  })

  it('not_recorded: no update is recorded for this sale, with a retry', () => {
    const h = panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'none' }, salesforce_standing: 'not_recorded' })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('No Salesforce update is recorded for this sale.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry Salesforce' }))
    expect(h.onRetrySalesforce).toHaveBeenCalled()
  })

  it('unreadable is its own error state, with a retry', () => {
    panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'unreadable', message: 'The last Salesforce update could not be read: timeout' }, salesforce_standing: 'unreadable' })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('The last Salesforce update could not be read: timeout')
    expect(screen.getByRole('button', { name: 'Retry Salesforce' })).toBeInTheDocument()
  })

  it('lead_id_not_written: Salesforce was last written with another id than the sale holds, with a retry', () => {
    panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: allWritten(null) }, salesforce_standing: 'lead_id_not_written' })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('Salesforce does not have lead id L1F-778 yet: its last updates carried no lead id.')
    expect(screen.getByRole('button', { name: 'Retry Salesforce' })).toBeInTheDocument()
    expect(card()).not.toHaveTextContent('Completed in Salesforce')
  })

  it('the standing is read from the entry, not worked out again from the writes', () => {
    // Complete writes carrying the id the claim holds, yet the Worker says otherwise: the page follows the Worker.
    panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: allWritten('L1F-778') }, salesforce_standing: 'not_recorded' })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('No Salesforce update is recorded for this sale.')
  })

  it('an entry from a Worker older than #2139, with no standing, is read from its writes by the same rule', () => {
    panel({ held: { entries: [row({ claim: sold, salesforce: { status: 'recorded', at: 'x', writes: oneFailed } })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('Salesforce was not fully updated.')
  })

  it('a click still held never shows Salesforce updates, whatever it carries, and keeps its releases', () => {
    panel({ held: { entries: [row({ salesforce: { status: 'none' } }), row({ id: 'held-2', salesforce: { status: 'recorded', at: 'x', writes: oneFailed } })], total: 2 } })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry Salesforce' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Mark sent' })).toHaveLength(2)
  })

  it('a freed click whose outcome is on its card shows no Salesforce updates either', () => {
    panel({
      held: { entries: [row({ claim: { status: 'free', generation: 3 }, salesforce: { status: 'none' } })], total: 1 },
      outcomes: { 'held-1': { kind: 'done', message: 'Freed. The next click on this prospect sends it to Liberty1.' } },
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry Salesforce' })).toBeNull()
  })
})
