import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// NavLayout pulls in nav/auth chrome irrelevant to the controls under test.
vi.mock('@/components/NavLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'wf-1', executionId: 'exec-1' }),
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/hooks/useExecution', () => ({ useExecution: vi.fn() }))

import ExecutionDetailPage from '../page'
import { useExecution } from '@/hooks/useExecution'

/**
 * Issue #398. Every in-app navigation on this page was a
 * `<button onClick={router.push(...)}>`, which is not a link: right-click "open
 * in new tab", cmd/ctrl+click and middle-click all do nothing, and assistive
 * technology announces a button rather than a link to somewhere.
 *
 * Comparing two failed runs side by side is the ordinary way to use this page,
 * and it was the one thing the controls would not let you do.
 *
 * These assert on the rendered ROLE and href rather than on the source, so the
 * test is about what a person and a screen reader actually get.
 */
const state = (over: Record<string, unknown> = {}) =>
  ({
    execution: null,
    loading: false,
    error: null,
    notFound: false,
    // Present, not omitted. Leaving these out meant every run in this file
    // looked archived to the page, which is how the `!== null` bug in #874 was
    // found: a fixture short of a field is a caller the component was not
    // written for (L550).
    archiveUnavailable: null,
    reload: () => {},
    ...over,
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useExecution).mockReturnValue(state({ loading: true }) as never)
})

describe('execution detail header navigation (#398)', () => {
  it('offers "Back to workflow" as a link to the workflow, with the execution selected', () => {
    render(<ExecutionDetailPage />)
    expect(screen.getByRole('link', { name: /back to workflow/i })).toHaveAttribute(
      'href',
      '/workflows/wf-1?execution=exec-1',
    )
  })

  it('offers "View on canvas" as a link', () => {
    render(<ExecutionDetailPage />)
    expect(screen.getByRole('link', { name: /view on canvas/i })).toHaveAttribute(
      'href',
      '/workflows/wf-1?execution=exec-1',
    )
  })

  it('keeps "Copy report" a button, because it is an action and not a destination', () => {
    render(<ExecutionDetailPage />)
    expect(screen.getByRole('button', { name: /copy report/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /copy report/i })).toBeNull()
  })
})

describe('execution detail not-found navigation (#398)', () => {
  it('offers "Back to the workflow" as a link', () => {
    // The notice renders only when BOTH are set (`error && notFound ? ...`).
    vi.mocked(useExecution).mockReturnValue(state({ notFound: true, error: 'not found' }) as never)
    render(<ExecutionDetailPage />)
    const link = screen.getByRole('link', { name: /back to the workflow/i })
    expect(link).toHaveAttribute('href', '/workflows/wf-1')
    // It is a bordered pill with vertical padding in a plain block container, and
    // an anchor is inline by default, so the padding would stop expanding the box
    // without this. The other four either sit in a flex parent or carry no box.
    expect(link).toHaveClass('inline-block')
  })
})

describe('execution detail replay navigation (#398)', () => {
  const execution = {
    id: 'exec-1',
    workflow_id: 'wf-1',
    status: 'completed',
    started_at: '2026-08-14T12:00:00Z',
    completed_at: '2026-08-14T12:00:01Z',
    duration_ms: 1000,
    trace_id: 'trace-1',
    trigger_payload: {},
    steps: [],
    parent_execution_id: 'parent-9',
    child_executions: [{ id: 'child-7' }, { id: 'child-8' }],
  }

  beforeEach(() => {
    vi.mocked(useExecution).mockReturnValue(state({ execution }) as never)
  })

  it('links to the parent execution this one replays', () => {
    render(<ExecutionDetailPage />)
    expect(screen.getByRole('link', { name: /parent-9/i })).toHaveAttribute(
      'href',
      '/workflows/wf-1/executions/parent-9',
    )
  })

  it('links to every child execution', () => {
    render(<ExecutionDetailPage />)
    expect(screen.getByRole('link', { name: /child-7/i })).toHaveAttribute('href', '/workflows/wf-1/executions/child-7')
    expect(screen.getByRole('link', { name: /child-8/i })).toHaveAttribute('href', '/workflows/wf-1/executions/child-8')
  })
})

describe('execution detail long-page navigation (#441)', () => {
  it('mounts the back-to-top control inside the page', () => {
    // The control renders its own button only once scrolled, so what this pins
    // down is that the page includes it at all, and therefore that it sits inside
    // NavLayout's scrolling <main> rather than outside it. Its behaviour, and the
    // fact that it scrolls that container rather than the window, is covered in
    // BackToTop.test.tsx.
    const { container } = render(<ExecutionDetailPage />)
    expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull()
  })
})

/**
 * Issue #497. The bid-attempt rows expanded on a `<tr onClick>` with a purely
 * decorative chevron: no tabIndex, no key handler, no aria-expanded. So the
 * "why didn't this lead get a bid?" detail, which is the whole point of the
 * table, was unreachable by keyboard and invisible to assistive technology,
 * which announced a plain row with no hint that anything could open.
 */
describe('bid attempt rows are keyboard accessible (#497)', () => {
  const withBids = {
    id: 'exec-1',
    workflow_id: 'wf-1',
    status: 'completed',
    started_at: '2026-08-14T12:00:00Z',
    completed_at: '2026-08-14T12:00:01Z',
    duration_ms: 1000,
    trace_id: 'trace-1',
    trigger_payload: {},
    steps: [
      {
        id: 'step-1',
        step_type: 'bid_group',
        step_namespace: 'engine_bids',
        status: 'completed',
        step_node_id: 'node-1',
        started_at: '2026-08-14T12:00:00Z',
        output: {
          mode: 'highest_bid',
          reason: 'winner',
          winner: { partner: 'tripoint', bid: 42 },
          all_bids: [
            { partner: 'tripoint', bid: 42, accepted: true, skipped: false, outcome: 'won', status: 200 },
            { partner: 'm1', bid: null, accepted: false, skipped: true, skip_reason: 'daily cap' },
          ],
        },
      },
    ],
  }

  beforeEach(() => {
    vi.mocked(useExecution).mockReturnValue(state({ execution: withBids }) as never)
  })

  it('offers each row a real control that says whether it is expanded', () => {
    render(<ExecutionDetailPage />)
    const toggles = screen.getAllByRole('button', { name: /details for/i })
    expect(toggles.length).toBe(2)
    expect(toggles[0]).toHaveAttribute('aria-expanded', 'false')
  })

  it('names the partner in the control, so the buttons are told apart', () => {
    render(<ExecutionDetailPage />)
    expect(screen.getByRole('button', { name: /details for tripoint/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /details for m1/i })).toBeInTheDocument()
  })

  it('expands from the keyboard', async () => {
    render(<ExecutionDetailPage />)
    const toggle = screen.getByRole('button', { name: /details for tripoint/i })
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/HTTP status/i)).toBeInTheDocument()
  })

  it('collapses again on a second press', async () => {
    render(<ExecutionDetailPage />)
    const toggle = screen.getByRole('button', { name: /details for tripoint/i })
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('points at the detail it controls', async () => {
    render(<ExecutionDetailPage />)
    const toggle = screen.getByRole('button', { name: /details for tripoint/i })
    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    await userEvent.click(toggle)
    expect(document.getElementById(controls as string)).not.toBeNull()
  })

  it('opens once, not twice, when the control itself is clicked', async () => {
    // The row keeps its own onClick for mouse users, so a click on the button
    // that bubbled would toggle twice and appear to do nothing at all.
    render(<ExecutionDetailPage />)
    const toggle = screen.getByRole('button', { name: /details for m1/i })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('an archived run hides the canvas (#874)', () => {
  const archived = {
    id: 'exec-1',
    workflow_id: 'wf-1',
    status: 'completed',
    started_at: '2026-03-04T09:14:02.000Z',
    steps: [],
    child_executions: [],
    lead_economics: null,
    archived: true,
    archive_day: '2026-03-04',
  }

  it('hides "View on canvas", because the canvas would draw it against today’s graph', () => {
    vi.mocked(useExecution).mockReturnValue(state({ execution: archived }) as never)
    render(<ExecutionDetailPage />)

    // Hidden, not disabled: the banner says why, so its absence is a decision.
    expect(screen.queryByRole('link', { name: /view on canvas/i })).toBeNull()
    expect(screen.getByText(/canvas is not available for archived runs/i)).toBeInTheDocument()
  })

  it('sends "Back to workflow" to the workflow itself, not to the canvas overlay', () => {
    vi.mocked(useExecution).mockReturnValue(state({ execution: archived }) as never)
    render(<ExecutionDetailPage />)

    expect(screen.getByRole('link', { name: /back to workflow/i })).toHaveAttribute(
      'href',
      '/workflows/wf-1'
    )
  })

  it('names the archive day, so the reader knows which record they are looking at', () => {
    vi.mocked(useExecution).mockReturnValue(state({ execution: archived }) as never)
    render(<ExecutionDetailPage />)

    expect(screen.getByText(/2026-03-04/)).toBeInTheDocument()
  })

  it('offers a retry, and does not claim the run never happened, when the archive is unreachable', () => {
    vi.mocked(useExecution).mockReturnValue(
      state({
        error: 'Archive temporarily unavailable',
        archiveUnavailable: { waitingFor: 'the execution archive', detail: 'did not answer' },
      }) as never
    )
    render(<ExecutionDetailPage />)

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.getByText(/does not mean the run never happened/i)).toBeInTheDocument()
    // The not-found screen must not also be on the page saying the opposite.
    expect(screen.queryByText(/No record of this execution/i)).toBeNull()
  })
})
