import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { IncidentsSection } from '../IncidentsSection'
import type { Incident, IncidentsResponse } from '@/lib/api'

/**
 * The Incidents card at the bottom of the dashboard (#2101), as settled with Dan
 * on 2026-10-14: closed incidents grouped by ET day, following the page's day
 * switch. Loading, a failed read and an empty record must look different: a
 * failed read shown as "no incidents" would be the record claiming the one thing
 * it exists to make true.
 */

// 6:12 PM ET on Wednesday 14 October 2026; a month later for windows inside the record.
const NOW = Date.parse('2026-10-14T22:12:00.000Z')
const LATER = Date.parse('2026-11-30T17:00:00.000Z')

function incident(over: Partial<Incident>): Incident {
  return {
    id: over.id ?? 'i-1',
    signal: 'failure-rate',
    signal_label: 'Failure rate',
    signal_known: true,
    subject_name: 'Engine Bidding: "ACRO_GATEWAY"',
    scope: 'org',
    started_at: '2026-10-14T18:34:00.000Z',
    ended_at: '2026-10-14T20:06:00.000Z',
    state: 'ended',
    duration: '1 hour 32 minutes',
    pages_sent: 2,
    ...over,
  }
}

function page(incidents: Incident[], more: number | null = null): IncidentsResponse {
  return { incidents, has_more: more !== null, next_offset: more }
}

/** A promise the test settles when it chooses, so no state is waited for by time. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const clock = (at: number) => () => at

describe('IncidentsSection', () => {
  it('shows a loading state, not the empty state, while the first page loads', () => {
    const load = vi.fn(() => new Promise<IncidentsResponse>(() => {}))
    render(<IncidentsSection days={7} load={load} now={clock(NOW)} />)
    expect(screen.getByRole('status')).toHaveTextContent(/loading incidents/i)
    expect(screen.queryByText(/No incidents/)).not.toBeInTheDocument()
    expect(load).toHaveBeenCalledWith(7, 0)
  })

  it('shows a failed read as an error with a retry, never as empty', async () => {
    const first = deferred<IncidentsResponse>()
    const load = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(page([incident({})]))
    render(<IncidentsSection days={7} load={load} now={clock(NOW)} />)
    first.reject(new Error('The incident record could not be read. Try again in a minute.'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Incidents could not be loaded')
    expect(alert).toHaveTextContent('The incident record could not be read')
    expect(screen.queryByText(/No incidents/)).not.toBeInTheDocument()

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Engine Bidding: "ACRO_GATEWAY"')).toBeInTheDocument()
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('names the window when nothing happened in it', async () => {
    render(<IncidentsSection days={30} load={vi.fn().mockResolvedValue(page([]))} now={clock(LATER)} />)
    expect(await screen.findByText('No incidents in the last 30 days')).toBeInTheDocument()
  })

  it('says when recording began when the window reaches back before it', async () => {
    render(<IncidentsSection days={7} load={vi.fn().mockResolvedValue(page([]))} now={clock(NOW)} />)
    expect(await screen.findByText('No incidents since recording began on Oct 14')).toBeInTheDocument()
  })

  it('does not contradict an ongoing incident shown above it', async () => {
    render(<IncidentsSection days={7} hasOngoing load={vi.fn().mockResolvedValue(page([]))} now={clock(LATER)} />)
    expect(await screen.findByText('No other incidents in the last 7 days')).toBeInTheDocument()
  })

  it('groups the incidents under ET day headings, the hour alone on each row', async () => {
    const rows = [
      incident({ id: 'a' }),
      incident({ id: 'b', signal: 'volume-cliff', signal_label: 'Volume cliff', subject_name: 'Main Flow', started_at: '2026-10-14T01:12:00.000Z', ended_at: '2026-10-14T01:41:00.000Z', duration: '29 minutes', pages_sent: 1 }),
      incident({ id: 'c', signal: 'field-presence-drought', signal_label: 'Output field stopped', subject_name: 'Main Flow scout.final', started_at: '2026-10-11T19:00:00.000Z', ended_at: null, state: 'end_not_recorded', duration: null, pages_sent: 1 }),
    ]
    render(<IncidentsSection days={7} load={vi.fn().mockResolvedValue(page(rows))} now={clock(NOW)} />)
    await screen.findByText('Main Flow')
    const card = screen.getByRole('region', { name: 'Incidents' })
    const headings = within(card).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(['Today (times ET)', 'Yesterday', 'Sun, Oct 11'])
    const items = within(card).getAllByRole('listitem').map((li) => li.textContent)
    expect(items).toEqual([
      '2:34 PM to 4:06 PMFailure rateEngine Bidding: "ACRO_GATEWAY"1 hour 32 minutes2 Slack pages',
      '9:12 PM to 9:41 PMVolume cliffMain Flow29 minutes1 Slack page',
      '3:00 PM, end not recordedOutput field stoppedMain Flow scout.final1 Slack page',
    ])
  })

  it('heads each day in the table header treatment, dark enough to read on beige', async () => {
    render(<IncidentsSection days={7} load={vi.fn().mockResolvedValue(page([incident({})]))} now={clock(NOW)} />)
    const heading = await screen.findByRole('heading', { name: 'Today (times ET)' })
    expect(heading.className).toContain('bg-beige')
    expect(heading.className).toContain('text-xs')
    expect(heading.className).toContain('font-semibold')
    expect(heading.className).toContain('text-gray-600')
  })

  it('shows an unrecognised signal with its raw key', async () => {
    render(<IncidentsSection days={7} load={vi.fn().mockResolvedValue(page([incident({ signal: 'retired-check', signal_label: 'Unrecognised signal', signal_known: false })]))} now={clock(NOW)} />)
    expect(await screen.findByText('Unrecognised signal (retired-check)')).toBeInTheDocument()
  })

  it('offers more only when the record says more exist, and appends the next page', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(page([incident({ id: 'a' })], 1))
      .mockResolvedValueOnce(page([incident({ id: 'b', subject_name: 'Second page flow' })]))
    render(<IncidentsSection days={14} load={load} now={clock(NOW)} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(await screen.findByText('Second page flow')).toBeInTheDocument()
    expect(load).toHaveBeenLastCalledWith(14, 1)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
  })

  it('keeps the rows already shown when loading more fails, and says so', async () => {
    const more = deferred<IncidentsResponse>()
    const load = vi.fn().mockResolvedValueOnce(page([incident({ id: 'a' })], 1)).mockReturnValueOnce(more.promise)
    render(<IncidentsSection days={7} load={load} now={clock(NOW)} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Show more' }))
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-busy', 'true')
    more.reject(new Error('Timed out after 30s.'))
    expect(await screen.findByRole('alert')).toHaveTextContent('More incidents could not be loaded: Timed out after 30s.')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Show more' })).not.toHaveAttribute('aria-busy')
  })

  it('reloads from the first page when the page window changes', async () => {
    const load = vi.fn().mockResolvedValueOnce(page([incident({ id: 'a' })])).mockResolvedValueOnce(page([incident({ id: 'b', subject_name: 'Thirty day flow' })]))
    const { rerender } = render(<IncidentsSection days={7} load={load} now={clock(NOW)} />)
    await screen.findByText('Engine Bidding: "ACRO_GATEWAY"')
    rerender(<IncidentsSection days={30} load={load} now={clock(NOW)} />)
    expect(await screen.findByText('Thirty day flow')).toBeInTheDocument()
    expect(load).toHaveBeenLastCalledWith(30, 0)
  })

  it('refreshes in place when the page refreshes, and shows a failed refresh as an error', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(page([incident({ id: 'a' })]))
      .mockResolvedValueOnce(page([incident({ id: 'a' }), incident({ id: 'n', subject_name: 'Just ended flow', started_at: '2026-10-14T21:00:00.000Z' })]))
      .mockRejectedValueOnce(new Error('Timed out after 30s.'))
    const { rerender } = render(<IncidentsSection days={7} load={load} now={clock(NOW)} refreshKey={0} />)
    await screen.findByText('Engine Bidding: "ACRO_GATEWAY"')
    rerender(<IncidentsSection days={7} load={load} now={clock(NOW)} refreshKey={1} />)
    expect(await screen.findByText('Just ended flow')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    rerender(<IncidentsSection days={7} load={load} now={clock(NOW)} refreshKey={2} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Timed out after 30s.')
    expect(screen.queryByText(/No incidents/)).not.toBeInTheDocument()
  })
})
