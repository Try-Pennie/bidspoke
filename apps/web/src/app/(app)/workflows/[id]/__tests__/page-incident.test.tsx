/**
 * The workflow page reads the incident narrowing from its URL (#2102), so the
 * Incidents card's "12 failed runs" link can be shared and Back returns to it:
 * `?incident=<id>` reaches the run list, and "All runs" takes it off the URL
 * as a history entry, keeping whatever else the URL holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'

let search = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'wf-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => search,
}))

vi.mock('@/lib/api', () => ({
  api: { workflows: { get: vi.fn(() => Promise.resolve({ id: 'wf-1', name: 'Engine Bidding Workflow' })) } },
}))
vi.mock('@/lib/execution-cache', () => ({
  get: vi.fn(() => undefined),
  getStep: vi.fn(),
  fetchExec: vi.fn(() => Promise.resolve()),
  fetchStep: vi.fn(),
  revalidateIfRunning: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}))

const canvasProps: Array<{ incidentId?: string; onClearIncident?: () => void }> = []
vi.mock('@/components/canvas/WorkflowCanvas', () => ({
  default: (props: { incidentId?: string; onClearIncident?: () => void }) => {
    canvasProps.push(props)
    return <div data-testid="canvas">{props.incidentId ?? 'all runs'}</div>
  },
}))

import WorkflowEditorPage from '../page'

describe('the workflow page and the incident narrowing (#2102)', () => {
  beforeEach(() => {
    canvasProps.length = 0
    window.history.replaceState(null, '', '/workflows/wf-1?incident=inc-1&execution=ex-1')
    search = new URLSearchParams('incident=inc-1&execution=ex-1')
  })

  it('hands the incident in the URL to the canvas', async () => {
    render(<WorkflowEditorPage />)
    expect(await screen.findByTestId('canvas')).toHaveTextContent('inc-1')
  })

  it('takes the narrowing off the URL as a new history entry, keeping the rest', async () => {
    const push = vi.spyOn(window.history, 'pushState')
    render(<WorkflowEditorPage />)
    await screen.findByTestId('canvas')
    act(() => { canvasProps[canvasProps.length - 1].onClearIncident?.() })
    expect(screen.getByTestId('canvas')).toHaveTextContent('all runs')
    expect(push).toHaveBeenCalledTimes(1)
    const url = new URL(String(push.mock.calls[0][2]), 'http://localhost')
    expect(url.searchParams.get('incident')).toBeNull()
    expect(url.searchParams.get('execution')).toBe('ex-1')
  })

  it('shows every run when the URL names no incident', async () => {
    search = new URLSearchParams()
    render(<WorkflowEditorPage />)
    expect(await screen.findByTestId('canvas')).toHaveTextContent('all runs')
  })
})
