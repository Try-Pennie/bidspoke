import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OngoingIncidents } from '../OngoingIncidents'
import type { OngoingIncident, OngoingIncidentsResponse } from '@/lib/api'

/**
 * The ongoing incident line under the dashboard header (#2101), as settled with
 * Dan on 2026-10-14: one red line per open incident, above the success rate. A
 * failed read must never read as "no ongoing incident".
 */

// 6:12 PM ET on Wednesday 14 October 2026.
const NOW = Date.parse('2026-10-14T22:12:00.000Z')
const clock = () => NOW

function ongoing(over: Partial<OngoingIncident>): OngoingIncident {
  return {
    id: over.id ?? 'o-1',
    signal: 'partner-reachability',
    signal_label: 'Partner reachability',
    signal_known: true,
    subject_name: 'api.tripoint.com',
    scope: 'platform',
    started_at: '2026-10-14T20:52:00.000Z',
    so_far: '1 hour 20 minutes so far',
    pages_sent: 1,
    ...over,
  }
}

const list = (incidents: OngoingIncident[], has_more = false): OngoingIncidentsResponse => ({ incidents, has_more })

describe('OngoingIncidents', () => {
  it('shows nothing, and claims nothing, while it loads', () => {
    const { container } = render(<OngoingIncidents load={() => new Promise(() => {})} now={clock} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows nothing when no incident is open, and reports none to the page', async () => {
    const onCount = vi.fn()
    const { container } = render(<OngoingIncidents load={vi.fn().mockResolvedValue(list([]))} now={clock} onCount={onCount} />)
    await vi.waitFor(() => expect(onCount).toHaveBeenLastCalledWith(0))
    expect(container).toBeEmptyDOMElement()
  })

  it('gives each open incident one red line, in the order given', async () => {
    const onCount = vi.fn()
    render(
      <OngoingIncidents
        load={vi.fn().mockResolvedValue(list([
          ongoing({ id: 'a' }),
          ongoing({ id: 'b', signal: 'db-unreachable', signal_label: 'Database unreachable', subject_name: 'This organization', started_at: '2026-10-12T20:52:00.000Z', so_far: '2 days so far', pages_sent: 4 }),
        ]))}
        now={clock}
        onCount={onCount}
      />,
    )
    const region = await screen.findByRole('region', { name: 'Ongoing incidents' })
    const lines = within(region).getAllByRole('listitem')
    expect(lines.map((l) => l.textContent)).toEqual([
      'Ongoing incidentPartner reachability on api.tripoint.com, since 4:52 PM ET, 1 hour 20 minutes so far. 1 Slack page.',
      'Ongoing incidentDatabase unreachable on This organization, since Oct 12, 4:52 PM ET, 2 days so far. 4 Slack pages.',
    ])
    expect(lines[0].className).toContain('bg-red-50')
    expect(lines[0].className).toContain('border-red-200')
    expect(within(lines[0]).getByText('Ongoing incident').className).toContain('text-red-700')
    expect(onCount).toHaveBeenLastCalledWith(2)
  })

  it('says when more are open than it lists', async () => {
    render(<OngoingIncidents load={vi.fn().mockResolvedValue(list([ongoing({})], true))} now={clock} />)
    expect(await screen.findByText('More incidents are open than are listed here.')).toBeInTheDocument()
  })

  it('shows a failed read as its own error with a retry, never as no ongoing incident', async () => {
    const onCount = vi.fn()
    const load = vi.fn().mockRejectedValueOnce(new Error('Ongoing incidents could not be read. Try again in a minute.')).mockResolvedValueOnce(list([ongoing({})]))
    render(<OngoingIncidents load={load} now={clock} onCount={onCount} />)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Ongoing incidents could not be checked')
    expect(alert).toHaveTextContent('Ongoing incidents could not be read. Try again in a minute.')
    expect(alert.className).not.toContain('bg-red-50')
    expect(onCount).toHaveBeenLastCalledWith(null)

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('region', { name: 'Ongoing incidents' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the newest answer when an older read answers last', async () => {
    let settleFirst!: (v: OngoingIncidentsResponse) => void
    const load = vi.fn()
      .mockReturnValueOnce(new Promise<OngoingIncidentsResponse>((res) => { settleFirst = res }))
      .mockResolvedValueOnce(list([]))
    const { rerender, container } = render(<OngoingIncidents load={load} now={clock} refreshKey={0} />)
    rerender(<OngoingIncidents load={load} now={clock} refreshKey={1} />)
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    settleFirst(list([ongoing({ subject_name: 'Stale host' })]))
    await Promise.resolve()
    await Promise.resolve()
    expect(screen.queryByText(/Stale host/)).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('refreshes when the page refreshes, so an incident that ended leaves the line', async () => {
    const load = vi.fn().mockResolvedValueOnce(list([ongoing({})])).mockResolvedValueOnce(list([]))
    const { rerender, container } = render(<OngoingIncidents load={load} now={clock} refreshKey={0} />)
    await screen.findByRole('region', { name: 'Ongoing incidents' })
    rerender(<OngoingIncidents load={load} now={clock} refreshKey={1} />)
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(load).toHaveBeenCalledTimes(2)
  })
})
