/**
 * The held clicks panel (#1552): the clicks a click buyer's send left held,
 * each with a person's two releases. Loading, a failed read and an empty list
 * are three different screens (L10); a release confirms with the consequence
 * for that row (L180); a destructive release looks destructive at rest; the
 * outcome of a release shows on its row; and the key that confirms the lead id
 * never also submits the partner form around it (L596).
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { HeldClick } from '@/lib/api'
import { HeldClicksPanel } from '../HeldClicksPanel'

const row = (over: Partial<HeldClick> = {}): HeldClick => ({
  id: 'held-1', prospect_id: 'a0B000000000001AAA', reason: 'outcome_unknown', detail: 'http 503: Service Unavailable', partner_lead_id: null,
  workflow_id: 'wf-1', execution_id: 'exec-1', held_at: '2027-09-20T18:00:00.000Z', last_seen_at: '2027-09-20T18:00:00.000Z',
  claim: { status: 'held', generation: 2 }, ...over,
})

function panel(props: Partial<Parameters<typeof HeldClicksPanel>[0]> = {}) {
  const handlers = { onMarkSent: vi.fn(), onFree: vi.fn(), onClear: vi.fn() }
  render(<HeldClicksPanel partnerName="Liberty1" held={{ entries: [row()], total: 1 }} error={null} outcomes={{}} {...handlers} {...props} />)
  return handlers
}

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
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('one held click: the prospect links to its execution, since when in Pacific time, and why', () => {
    panel()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    const link = within(rows[0]).getByRole('link', { name: 'a0B000000000001AAA' })
    expect(link).toHaveAttribute('href', '/workflows/wf-1/executions/exec-1')
    expect(rows[0]).toHaveTextContent('Sep 20, 11:00 AM PDT')
    expect(rows[0]).toHaveTextContent('The buyer gave no readable answer')
    expect(rows[0]).toHaveTextContent('http 503: Service Unavailable')
  })

  it('many held clicks: one row each, and a total past the rows shown is stated', () => {
    const entries = [row(), row({ id: 'held-2', prospect_id: 'a0B000000000002AAA' }), row({ id: 'held-3', prospect_id: 'a0B000000000003AAA' })]
    panel({ held: { entries, total: 140 } })
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(3)
    expect(screen.getByText('Showing the oldest 3 of 140 held clicks.')).toBeInTheDocument()
  })

  it('a row without its execution names the prospect without a dead link', () => {
    panel({ held: { entries: [row({ workflow_id: null })], total: 1 } })
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('a0B000000000001AAA')).toBeInTheDocument()
  })
})

describe('HeldClicksPanel releases', () => {
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

  it('Mark sent asks for the lead id, names the consequence with it and the Pacific day it counts on, and refuses an empty id', () => {
    const h = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    const input = screen.getByLabelText('Lead id in Liberty1')
    const confirm = screen.getByRole('button', { name: 'Mark it sent' })
    expect(confirm).toBeDisabled()
    fireEvent.change(input, { target: { value: 'a0B5f00000XyZ12AAB' } })
    expect(screen.getByText("Records this prospect as sent to Liberty1 as lead a0B5f00000XyZ12AAB and adds it to Liberty1's clicks for Sep 20 (Pacific). A later click on it will not send.")).toBeInTheDocument()
    fireEvent.click(confirm)
    expect(h.onMarkSent).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }), 2, 'a0B5f00000XyZ12AAB')
  })

  it('the lead id the buyer already gave is filled in', () => {
    panel({ held: { entries: [row({ reason: 'sold_mark_failed', partner_lead_id: 'a0B5f00000XyZ12AAB' })], total: 1 } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    expect(screen.getByLabelText('Lead id in Liberty1')).toHaveValue('a0B5f00000XyZ12AAB')
  })

  it('Enter in the lead id confirms the mark and never submits the form around it', () => {
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault())
    const onMarkSent = vi.fn()
    render(
      <form onSubmit={onSubmit}>
        <HeldClicksPanel partnerName="Liberty1" held={{ entries: [row()], total: 1 }} error={null} outcomes={{}} onMarkSent={onMarkSent} onFree={vi.fn()} onClear={vi.fn()} />
      </form>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mark sent' }))
    const input = screen.getByLabelText('Lead id in Liberty1')
    fireEvent.change(input, { target: { value: 'a0B5f00000XyZ12AAB' } })
    // jsdom does not perform implicit submission, so the proof is the default
    // being prevented: false from dispatch means preventDefault was called.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false)
    expect(onMarkSent).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Cancel releases nothing', () => {
    const h = panel()
    fireEvent.click(screen.getByRole('button', { name: 'Free' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(h.onFree).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Free' })).toBeInTheDocument()
  })

  it('the outcome of a release shows on its row in place of the controls', () => {
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

  it('a claim no longer held says what it is now and offers only removing the entry', () => {
    const h = panel({ held: { entries: [row({ claim: { status: 'sold', generation: 4, partner_lead_id: 'a0B5f00000XyZ12AAB' } })], total: 1 } })
    expect(screen.getByText('No longer held: already marked sent as a0B5f00000XyZ12AAB.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Free' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Remove from the list' }))
    expect(h.onClear).toHaveBeenCalledWith(expect.objectContaining({ id: 'held-1' }))
  })

  it('a claim that could not be read is an alert on its row, with nothing to press', () => {
    panel({ held: { entries: [row({ claim: { status: 'unreadable', message: 'The claim did not answer: timeout' } })], total: 1 } })
    expect(screen.getByRole('alert')).toHaveTextContent('The claim did not answer: timeout')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
