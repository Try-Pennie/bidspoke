/**
 * The Workflow values tab (#2142, PM-15): each value with the exact name
 * workflows read it by and which workflows read it, from the workflow values
 * read, in its three states. Tripoint's and Sofi's answers are the e2e fixture,
 * measured from production's workflows (read only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', () => ({ api: { partners: { workflowValues: vi.fn() } } }))

import { api } from '@/lib/api'
import type { PartnerWorkflowValue, PartnerWorkflowValues } from '@/lib/api'
import { WorkflowValuesPanel } from '../WorkflowValuesPanel'
import { LiveNotesContext } from '../live/PartnerLive'
import { PARTNER_VALUE_KINDS } from '@/app/(app)/partners/workflow-values-text'
import fixture from '../../../../e2e/fixtures/partners/workflow-values.json'

const answers = fixture as unknown as Record<string, PartnerWorkflowValues>
const bySlug = (slug: string) => Object.values(answers).find((a) => a.partner.slug === slug)!

const props = { slug: 'tripoint', refreshKey: '3', isBuyer: true, isSource: false, isActive: true, partnerName: 'Tripoint', controls: {} }
const section = (title: string) => screen.getByRole('heading', { name: title }).closest('section') as HTMLElement
const findSection = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement

beforeEach(() => { vi.clearAllMocks() })

describe('the Workflow values tab, from the measured answers', () => {
  it('Tripoint: its click URL read by name by Engine Bidding, and by buyer selection, the click check and the click alert', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('tripoint'))
    render(<WorkflowValuesPanel {...props} partnerId={bySlug('tripoint').partner.id} controls={{ click_url: <input aria-label="Click URL" /> }} />)
    const click = await findSection('Click URL')
    expect(within(click).getByRole('textbox', { name: 'Click URL' })).toBeVisible()
    expect(within(click).getByText('constants.TripointClickUrl')).toBeVisible()
    expect(within(click).getByText('steps.constants.output.TripointClickUrl')).toBeVisible()
    expect(within(click).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Engine Bidding Workflow, in Build Response Body and Tripoint Ping.',
      'Buyer selection sends a lead it sells to this partner to the click URL.',
      'The click check offers a lead to a click sold partner at the click URL, and refuses to when it carries no {prospect_id}.',
      'The click alert pages when the click URL carries no {prospect_id}.',
    ])
    expect(api.partners.workflowValues).toHaveBeenCalledWith(bySlug('tripoint').partner.id)
  })

  it('Tripoint: its minimum bids are named by no workflow, said as what was searched', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('tripoint'))
    render(<WorkflowValuesPanel {...props} partnerId="t" />)
    await findSection('Click URL')
    expect(within(section('Sub-account minimum bids')).getByText('No workflow names this value. Searched 11 workflows, 7 of them with a Constants step.')).toBeVisible()
  })

  it('Active: the entry Engine Bidding reads for every partner, from Active on the Partner tab', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('tripoint'))
    render(<WorkflowValuesPanel {...props} partnerId="t" />)
    const active = await findSection('Active')
    expect(within(active).getByText('constants.activeBidding.tripoint')).toBeVisible()
    expect(within(active).getByText('Engine Bidding Workflow reads this value for every partner, in Validate.')).toBeVisible()
    expect(within(active).getByText('Tripoint is active, so workflows read true. Active is set on the Partner tab.')).toBeVisible()
  })

  it('Sofi: the sell-off offer read by name, and its sub-account IDs read for every partner', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('sofi'))
    render(<WorkflowValuesPanel {...props} slug="sofi" partnerName="Sofi" isBuyer={false} isSource partnerId="s" />)
    const sell = await findSection('Sell-off offer')
    expect(within(sell).getByText('constants.SofiSellOffOfferTitle')).toBeVisible()
    expect(within(sell).getByText('constants.SofiSellOffOfferDetails')).toBeVisible()
    // The title and details share their readers, so they are said once.
    expect(within(sell).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Engine Bidding Workflow, in Build Response Body.'])
    const ids = section('Sub-account IDs')
    expect(within(ids).getByText('Engine Bidding Workflow reads this value for every partner, in Validate and Build Response Body.')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Click URL' })).toBeNull()
  })
})

describe('every value the answer can carry has a row', () => {
  it('a partner that buys and sends, with every kind set, shows each one by its name', async () => {
    const values: PartnerWorkflowValue[] = PARTNER_VALUE_KINDS.map((kind) => {
      const name = kind === 'subAccountIdsMap' || kind === 'activeBidding' ? kind : `Acme${kind}`
      return { constant_name: name, kind, map: name === kind, access: { template: `steps.constants.output.${name}`, code: `constants.${name}` }, emitted: true, value: 'x', readers: [], shadowed_data_keys: [], readers_outside_workflows: [] }
    })
    vi.mocked(api.partners.workflowValues).mockResolvedValue({ partner: { id: 'a', slug: 'acme' }, values, searched: { workflows: 1, with_constants_node: 1 } })
    render(<WorkflowValuesPanel {...props} slug="acme" partnerName="Acme" isSource partnerId="a" />)
    await findSection('Click URL')
    for (const v of values) {
      const code = v.kind === 'activeBidding' ? 'constants.activeBidding.acme' : v.access.code
      expect(screen.getByText(code)).toBeVisible()
    }
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent))
      .toEqual(['Click URL', 'Sell-off offer', 'Sub-account minimum bids', 'Sub-account IDs', 'Active'])
  })
})

describe('the read\'s other states', () => {
  it('while the read runs it says so, and never that no workflow names a value', () => {
    vi.mocked(api.partners.workflowValues).mockReturnValue(new Promise(() => {}))
    render(<WorkflowValuesPanel {...props} partnerId="t" />)
    expect(screen.getByRole('status')).toHaveTextContent('Checking which workflows read these values…')
    expect(screen.queryByText(/No workflow names this value/)).toBeNull()
  })

  it('a failed read says it failed, once, never as empty, and Try again reads again', async () => {
    vi.mocked(api.partners.workflowValues).mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(bySlug('tripoint'))
    render(<WorkflowValuesPanel {...props} partnerId="t" controls={{ click_url: <input aria-label="Click URL" /> }} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load which workflows read this. Try again.')
    expect(screen.getByRole('textbox', { name: 'Click URL' })).toBeVisible()
    expect(screen.queryByText(/No workflow names this value/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(api.partners.workflowValues).toHaveBeenCalledTimes(2)
    expect(within(section('Click URL')).getByText('constants.TripointClickUrl')).toBeVisible()
  })

  it('a new partner reads nothing and says when the readers will show', () => {
    render(<WorkflowValuesPanel {...props} partnerId={null} />)
    expect(api.partners.workflowValues).not.toHaveBeenCalled()
    expect(screen.getByText('Which workflows read these values shows once the partner is saved.')).toBeVisible()
  })

  it('a re-read (a save, or a sub-account ID added) keeps the answer on screen until the new one lands, never flashing Checking', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValueOnce(bySlug('tripoint'))
    let land: (a: PartnerWorkflowValues) => void = () => {}
    const { rerender } = render(<WorkflowValuesPanel {...props} partnerId="t" />)
    await findSection('Click URL')
    vi.mocked(api.partners.workflowValues).mockReturnValueOnce(new Promise((res) => { land = res }))
    rerender(<WorkflowValuesPanel {...props} partnerId="t" refreshKey="4" />)
    await waitFor(() => expect(api.partners.workflowValues).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('status')).toBeNull()
    expect(within(section('Click URL')).getByText('Engine Bidding Workflow, in Build Response Body and Tripoint Ping.')).toBeVisible()
    const next = structuredClone(bySlug('tripoint'))
    next.values[0].readers = []
    land(next)
    await waitFor(() => expect(within(section('Click URL')).queryByText('Engine Bidding Workflow, in Build Response Body and Tripoint Ping.')).toBeNull())
    expect(within(section('Click URL')).getByText('Buyer selection sends a lead it sells to this partner to the click URL.')).toBeVisible()
  })

  it('a re-read that fails keeps the last answer on screen and says beside it that it is from the last read', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValueOnce(bySlug('tripoint')).mockRejectedValueOnce(new Error('503'))
    const { rerender } = render(<WorkflowValuesPanel {...props} partnerId="t" />)
    await findSection('Click URL')
    rerender(<WorkflowValuesPanel {...props} partnerId="t" refreshKey="4" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load which workflows read this. Try again. What is shown is from the last read.')
    expect(within(section('Click URL')).getByText('Engine Bidding Workflow, in Build Response Body and Tripoint Ping.')).toBeVisible()
  })

  it('reads again when the partner is saved', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('tripoint'))
    const { rerender } = render(<WorkflowValuesPanel {...props} partnerId="t" />)
    await findSection('Click URL')
    rerender(<WorkflowValuesPanel {...props} partnerId="t" refreshKey="4" />)
    await waitFor(() => expect(api.partners.workflowValues).toHaveBeenCalledTimes(2))
  })
})

describe('live notes (#2135)', () => {
  it('each value section shows the live notes of its registry section, and only those', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('tripoint'))
    const notes = [
      { sections: ['Click URL'], text: 'Updated by Editor A.' },
      { sections: ['Sub-account minimum bids'], text: 'Changed directly in the database at 9:12 AM ET.' },
    ]
    render(
      <LiveNotesContext.Provider value={notes}>
        <WorkflowValuesPanel {...props} partnerId="t" controls={{ click_url: <input aria-label="Click URL" />, min_bids: <input aria-label="Minimum bid" /> }} />
      </LiveNotesContext.Provider>,
    )
    const click = await findSection('Click URL')
    expect(within(click).getByText('Updated by Editor A.')).toBeVisible()
    expect(within(click).queryByText('Changed directly in the database at 9:12 AM ET.')).toBeNull()
    expect(within(section('Sub-account minimum bids')).getByText('Changed directly in the database at 9:12 AM ET.')).toBeVisible()
  })

  it('a Sofi sell-off offer note lands in its section', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('sofi'))
    render(
      <LiveNotesContext.Provider value={[{ sections: ['Sell-off offer'], text: 'Updated by Editor B.' }]}>
        <WorkflowValuesPanel {...props} slug="sofi" partnerName="Sofi" isBuyer={false} isSource partnerId="s" />
      </LiveNotesContext.Provider>,
    )
    expect(within(await findSection('Sell-off offer')).getByText('Updated by Editor B.')).toBeVisible()
  })
})

describe('a value the workflows cannot see as it is', () => {
  it('flags a workflow data key the partner value replaces', async () => {
    const a = structuredClone(bySlug('tripoint'))
    a.values[0].shadowed_data_keys = [{ workflow_id: 'w', workflow_name: 'Main Flow', is_active: true, node_id: 'c', namespace: 'constants' }]
    vi.mocked(api.partners.workflowValues).mockResolvedValue(a)
    render(<WorkflowValuesPanel {...props} partnerId="t" />)
    const click = await findSection('Click URL')
    expect(within(click).getByText('Main Flow also sets TripointClickUrl in its Constants step (constants), and this value replaces it there.')).toBeVisible()
  })

  it('says a value not saved yet is found by no workflow', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('tripoint'))
    render(<WorkflowValuesPanel {...props} partnerId="t" controls={{ click_url: <input aria-label="Click URL" />, min_bids: <input aria-label="Minimum bid" /> }} />)
    await findSection('Click URL')
    expect(within(section('Sub-account minimum bids')).getByText('Until a value is saved, workflows find nothing under this name.')).toBeVisible()
    expect(within(section('Click URL')).queryByText('Until a value is saved, workflows find nothing under this name.')).toBeNull()
  })

  it('the notice follows what the partner type edits here, not whether a control was handed in', async () => {
    vi.mocked(api.partners.workflowValues).mockResolvedValue(bySlug('tripoint'))
    render(<WorkflowValuesPanel {...props} partnerId="t" controls={{}} />)
    await findSection('Click URL')
    expect(within(section('Sub-account minimum bids')).getByText('Until a value is saved, workflows find nothing under this name.')).toBeVisible()
    // Active is set on the Partner tab, so it never carries the notice.
    expect(within(section('Active')).queryByText('Until a value is saved, workflows find nothing under this name.')).toBeNull()
  })
})
