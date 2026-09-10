/**
 * Issue #477 (AUD-012): the execution header badge must read as still-alive
 * while running (live elapsed) and convert to a distinct "Stalled" state once a
 * run has been alive past the 60s threshold, instead of a frozen "Running".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { ExecutionStatusBadge } from '../ExecutionStatusBadge'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('ExecutionStatusBadge (#477)', () => {
  it('shows Running with live elapsed and ticks up', () => {
    const startedAt = new Date(Date.now() - 5_000).toISOString()
    render(<ExecutionStatusBadge status="running" startedAt={startedAt} />)
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText(/· 5s/)).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(screen.getByText(/· 7s/)).toBeInTheDocument()
  })

  it('renders Stalled for a run alive past the stall threshold', () => {
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString()
    render(<ExecutionStatusBadge status="running" startedAt={startedAt} />)
    expect(screen.getByText('Stalled')).toBeInTheDocument()
    expect(screen.getByText(/· 3m/)).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })

  it('renders a completed run as a static Done badge with no elapsed', () => {
    const startedAt = new Date(Date.now() - 3 * 60_000).toISOString()
    render(<ExecutionStatusBadge status="completed" startedAt={startedAt} />)
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.queryByText(/· \d/)).not.toBeInTheDocument()
  })

  it('renders an unrecognized status as neutral Unknown, not Running', () => {
    render(<ExecutionStatusBadge status="queued" startedAt={new Date().toISOString()} />)
    expect(screen.getByText('Unknown')).toBeInTheDocument()
    expect(screen.queryByText('Running')).not.toBeInTheDocument()
  })
})

describe('an archived run shows no clock (#874)', () => {
  it('does not render a growing elapsed time for a run that was still going when archived', () => {
    // Six months ago. With a live clock this renders "Stalled, 274075m", a
    // number that grows for ever and tells the reader nothing about the run.
    const longAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
    render(<ExecutionStatusBadge status="running" startedAt={longAgo} live={false} />)

    expect(screen.queryByText(/\d+m \d+s/)).toBeNull()
    expect(screen.queryByText(/·/)).toBeNull()
  })

  it('still shows the live clock for a run that is genuinely running now', () => {
    render(<ExecutionStatusBadge status="running" startedAt={new Date().toISOString()} />)
    expect(screen.getByText(/Running/)).toBeInTheDocument()
  })
})
