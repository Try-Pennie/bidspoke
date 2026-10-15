/**
 * The workflow page's run list narrowed to one failure rate incident's failed
 * runs (#2102), as settled with Dan on 2026-10-15 (docs/design/failed-runs-link.html):
 * the list's own title replaces the EXECUTIONS label, with a link back to all
 * runs, the match and the span, and a retention line only when the span reaches
 * back before the runs still kept. The outcome tabs are hidden while narrowed.
 *
 * A failed read must look like a failure with a Retry: an empty list under a
 * "0 failed runs" title would claim the incident had none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { IncidentFailedRuns } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    executions: { list: vi.fn(() => Promise.resolve([])) },
    versions: { list: vi.fn(() => Promise.resolve([])) },
    incidents: { failedRuns: vi.fn() },
  },
}))
vi.mock('@/lib/execution-cache', () => ({ prefetch: vi.fn(), revalidateIfRunning: vi.fn() }))
// jsdom lays nothing out, so the real virtualizer mounts no rows; this one mounts
// every row, which is all a list of a handful of runs would do anyway.
vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: () => [],
  useVirtualizer: (o: { count: number; getItemKey: (i: number) => string }) => ({
    getVirtualItems: () => Array.from({ length: o.count }, (_, i) => ({ index: i, key: o.getItemKey(i), start: i * 56 })),
    getTotalSize: () => o.count * 56,
    measureElement: () => {},
  }),
}))

import { api } from '@/lib/api'
import ExecutionListPanel from '../ExecutionListPanel'

const WF = 'aaaaaaaa-0000-4000-8000-000000000001'
// 6:12 PM ET on Wednesday 14 October 2026.
const NOW = Date.parse('2026-10-14T22:12:00.000Z')
const clock = () => NOW

function run(id: string, startedAt: string, error: string) {
  return {
    id,
    status: 'failed',
    outcome: 'failed' as const,
    final_node_namespace: 'acro_gateway',
    source: 'engine',
    started_at: startedAt,
    duration_ms: 1200,
    error_message: error,
    parent_execution_id: null,
    has_children: false,
  }
}

function body(over: Partial<IncidentFailedRuns> = {}): IncidentFailedRuns {
  const runs = [
    run('r-2', '2026-10-14T20:05:00.000Z', 'ACRO_GATEWAY: upstream returned 502 Bad Gateway'),
    run('r-1', '2026-10-14T18:34:00.000Z', 'ACRO_GATEWAY: connection reset by peer'),
  ]
  return {
    incident: { id: 'inc-1', workflow_id: WF, match: 'ACRO_GATEWAY', started_at: '2026-10-14T18:34:00.000Z', ended_at: '2026-10-14T20:06:00.000Z' },
    kept_since: '2026-10-07T22:12:00.000Z',
    clipped: false,
    count: runs.length,
    runs,
    ...over,
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function narrowed(load: (id: string) => Promise<IncidentFailedRuns>, onClearIncident = vi.fn()) {
  render(
    <ExecutionListPanel
      workflowId={WF}
      onSelect={vi.fn()}
      incidentId="inc-1"
      onClearIncident={onClearIncident}
      loadIncidentRuns={load}
      now={clock}
    />,
  )
  return { onClearIncident }
}

describe('ExecutionListPanel narrowed to an incident (#2102)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("titles the list with the incident's count, names the match and span, and hides the outcome tabs", async () => {
    const load = vi.fn().mockResolvedValue(body())
    narrowed(load)
    expect(await screen.findByText('2 failed runs in this incident')).toBeInTheDocument()
    expect(screen.getByText('"ACRO_GATEWAY", Today 2:34 PM to 4:06 PM ET')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /All runs/ })).toHaveAttribute('href', `/workflows/${WF}`)
    expect(screen.queryByText('Executions')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Failed' })).not.toBeInTheDocument()
    expect(screen.queryByText(/no longer kept/)).not.toBeInTheDocument()
    expect(screen.getByText('ACRO_GATEWAY: upstream returned 502 Bad Gateway')).toBeInTheDocument()
    expect(screen.getByText('ACRO_GATEWAY: connection reset by peer')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith('inc-1')
    expect(api.executions.list).not.toHaveBeenCalled()
  })

  it('counts the title from the rows it sits over, so the two cannot disagree', async () => {
    narrowed(vi.fn().mockResolvedValue(body({ count: 99 })))
    expect(await screen.findByText('2 failed runs in this incident')).toBeInTheDocument()
    expect(screen.queryByText(/99/)).not.toBeInTheDocument()
  })

  it('says runs before the cutoff are no longer kept, only when the span reaches before it', async () => {
    narrowed(vi.fn().mockResolvedValue(body({ clipped: true, kept_since: '2026-10-08T14:00:00.000Z' })))
    expect(await screen.findByText('Runs before Oct 8 are no longer kept.')).toBeInTheDocument()
  })

  it('shows a failed read as an error with a Retry, never as an empty list', async () => {
    const first = deferred<IncidentFailedRuns>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(body())
    narrowed(load)
    first.reject(new Error("The incident's failed runs could not be read. Try again in a minute."))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("The incident's failed runs could not be read")
    expect(screen.queryByText(/failed runs? in this incident/)).not.toBeInTheDocument()
    expect(screen.queryByText(/No executions/)).not.toBeInTheDocument()
    // Still a way back to every run while the narrowed list cannot be read.
    expect(screen.getByRole('link', { name: /All runs/ })).toBeInTheDocument()

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('2 failed runs in this incident')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('clears the narrowing from the All runs link', async () => {
    const { onClearIncident } = narrowed(vi.fn().mockResolvedValue(body()))
    await userEvent.click(await screen.findByRole('link', { name: /All runs/ }))
    expect(onClearIncident).toHaveBeenCalledTimes(1)
  })

  it('keeps the EXECUTIONS label and the outcome tabs when not narrowed', async () => {
    render(<ExecutionListPanel workflowId={WF} onSelect={vi.fn()} />)
    expect(screen.getByText('Executions')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
    expect(screen.queryByText(/in this incident/)).not.toBeInTheDocument()
    expect(api.incidents.failedRuns).not.toHaveBeenCalled()
    expect(api.executions.list).toHaveBeenCalled()
  })

  it('reads an empty incident id as no narrowing', async () => {
    render(<ExecutionListPanel workflowId={WF} onSelect={vi.fn()} incidentId="" />)
    expect(screen.getByText('Executions')).toBeInTheDocument()
    expect(api.incidents.failedRuns).not.toHaveBeenCalled()
  })
})
