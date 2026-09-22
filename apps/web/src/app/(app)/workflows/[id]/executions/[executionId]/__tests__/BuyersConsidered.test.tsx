/**
 * The Buyers considered table on the execution detail page (#1412, PR 3): for a
 * buyer_select step, every buyer the node looked at in priority order, what
 * happened to each, and why, in the shared vocabulary's words rather than the
 * codes. The header says what the node did as a whole (sold, no sale, not for
 * sale, deferred) and which mode it ran in, so a rehearsal is never read as a
 * sale (L11). The buyer that took the lead is marked; a row that was not
 * reached says so rather than sitting blank (L10).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { BuyersConsidered, type BuyerSelectStep } from '../BuyersConsidered'

vi.mock('@/components/NavLayout', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'wf-1', executionId: 'exec-1' }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/hooks/useExecution', () => ({ useExecution: vi.fn() }))

import ExecutionDetailPage from '../page'
import { useExecution } from '@/hooks/useExecution'

function step(output: Record<string, unknown>, over: Partial<BuyerSelectStep> = {}): BuyerSelectStep {
  return {
    id: 'step-1', step_namespace: 'sell_to_buyer', step_type: 'buyer_select', step_node_id: 'node-1', parallel_group_id: null,
    status: 'completed', input: null, output, logs: null, error_message: null, error_type: null, retries_used: 0,
    started_at: '2027-09-20T15:30:00.000Z', completed_at: '2027-09-20T15:30:01.200Z', duration_ms: 1200, step_order: 4,
    ...over,
  }
}

const sold = {
  _route: 'sold', reason: 'sold', mode_effective: 'live', population: 'engine', lead_key: 'lead-1',
  sale: { skipped: false, accepted: true, buyer_reference: 'L-77', result_code: '1000', partner_slug: 'tripoint' },
  considered: [
    { partner: 'acme', priority: 1, payout_cents: null, outcome: 'ineligible', reason: 'closed' },
    { partner: 'tripoint', priority: 2, payout_cents: 2190, outcome: 'sold' },
    { partner: 'zed', priority: 3, payout_cents: 1800, outcome: 'not_reached', reason: 'not_reached' },
  ],
  live_percent_in_force: 100, caps_in_force: [], duration_ms: 1200,
}

describe('BuyersConsidered', () => {
  it('says the lead was sold, to whom and for how much, and marks that buyer in the table', () => {
    render(<BuyersConsidered step={step(sold)} />)
    expect(screen.getByText(/sold to tripoint for \$21\.90/i)).toBeInTheDocument()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[1]).toHaveTextContent('tripoint')
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    expect(rows[0]).not.toHaveAttribute('aria-current')
  })

  it('shows priority, outcome and the reason in the shared vocabulary words, not the codes', () => {
    render(<BuyersConsidered step={step(sold)} />)
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('1')
    expect(rows[0]).toHaveTextContent('Not eligible')
    expect(rows[0]).toHaveTextContent('Outside operating hours')
    expect(rows[0]).not.toHaveTextContent('closed')
    expect(rows[2]).toHaveTextContent('Not reached')
    expect(rows[2]).toHaveTextContent('An earlier buyer took the lead')
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Priority', 'Buyer', 'Outcome', 'Payout', 'Why'])
  })

  it('says the mode it ran in, so a rehearsal is never read as a sale', () => {
    const rehearsed = {
      ...sold, _route: 'deferred', reason: 'decide_only', mode_effective: 'decide_only',
      sale: { skipped: true, accepted: false, buyer_reference: null, result_code: null, partner_slug: null },
      considered: [{ partner: 'tripoint', priority: 1, payout_cents: 2190, outcome: 'rehearsed' }],
    }
    render(<BuyersConsidered step={step(rehearsed)} />)
    // The mode is said once: the headline does not repeat it as the reason (L605).
    expect(screen.getAllByText(/rehearsed without calling a buyer/i)).toHaveLength(1)
    expect(screen.getByText(/^left to the workflow to decide$/i)).toBeInTheDocument()
    expect(screen.getByText('Would have been offered the lead')).toBeInTheDocument()
    expect(screen.queryByText(/^sold/i)).toBeNull()
  })

  it('names the reason when there was no sale, and when the lead was not for sale at all', () => {
    const noSale = { ...sold, _route: 'no_sale', reason: 'no_eligible_buyer', sale: { ...sold.sale, accepted: false, partner_slug: null }, considered: [sold.considered[0]] }
    const { unmount } = render(<BuyersConsidered step={step(noSale)} />)
    expect(screen.getByText(/no sale: no buyer was eligible for this lead/i)).toBeInTheDocument()
    unmount()
    const notForSale = { ...sold, _route: 'not_applicable', reason: 'sell_off_false', sale: { ...sold.sale, accepted: false, partner_slug: null }, considered: [] }
    render(<BuyersConsidered step={step(notForSale)} />)
    expect(screen.getByText(/not for sale: not a sell off lead/i)).toBeInTheDocument()
    expect(screen.getByText(/no buyer was considered/i)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('shows the detail beside the reason when the node recorded one', () => {
    const withDetail = { ...sold, considered: [{ partner: 'acme', priority: 1, payout_cents: null, outcome: 'skipped', reason: 'circuit_open', detail: 'breaker unreadable: timeout' }] }
    render(<BuyersConsidered step={step(withDetail)} />)
    expect(screen.getByText(/circuit breaker open/i)).toBeInTheDocument()
    expect(screen.getByText(/breaker unreadable: timeout/)).toBeInTheDocument()
  })

  it('an output it cannot read is shown as unreadable, never as an empty healthy table', () => {
    render(<BuyersConsidered step={step({ garbage: true })} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be read/i)
    expect(screen.queryByRole('table')).toBeNull()
  })
})

const pageState = (steps: unknown[]) => ({
  execution: {
    id: 'exec-1', workflow_id: 'wf-1', status: 'completed', started_at: '2027-09-20T15:30:00.000Z', completed_at: '2027-09-20T15:30:02.000Z',
    duration_ms: 2000, trace_id: 't-1', source: 'engine', is_test: false, trigger_payload: {}, response: null, error_message: null,
    resume_from_execution_id: null, replayed_from_execution_id: null, lead_economics: null, steps,
  },
  loading: false, error: null, notFound: false, archiveUnavailable: null, reload: () => {},
})

describe('the execution page places the table', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('renders a Buyers considered section for a run with a buyer_select step, and none without', () => {
    vi.mocked(useExecution).mockReturnValue(pageState([step(sold)]) as never)
    const { unmount } = render(<ExecutionDetailPage />)
    const section = screen.getByRole('region', { name: 'Buyers considered' })
    expect(within(section).getByText(/sold to tripoint/i)).toBeInTheDocument()
    unmount()
    vi.mocked(useExecution).mockReturnValue(pageState([{ ...step(sold), step_type: 'code', output: {} }]) as never)
    render(<ExecutionDetailPage />)
    expect(screen.queryByRole('region', { name: 'Buyers considered' })).toBeNull()
  })
})
