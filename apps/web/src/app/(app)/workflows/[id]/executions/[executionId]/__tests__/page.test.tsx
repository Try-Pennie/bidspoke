import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

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
  ({ execution: null, loading: false, error: null, notFound: false, ...over })

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
