import { describe, expect, it, vi, afterEach } from 'vitest'
import { logReadFailure } from '../scheduled-read'

/**
 * Issue #439. The scheduled checks destructured only `{ data }`, so a failed
 * Supabase read came back null, was coalesced to `[]`, and the check reported
 * "nothing to alert on". A transient database error and a genuinely healthy
 * system produced the identical outcome, with nothing in the log either way.
 */
describe('logReadFailure (#439)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('says nothing when the read succeeded', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadFailure('volume-cliff', 'slack connections', null)
    logReadFailure('volume-cliff', 'slack connections', undefined)
    expect(spy).not.toHaveBeenCalled()
  })

  it('names the check, the read, and the cause', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadFailure('volume-cliff', 'slack connections', { message: 'connection reset', code: '08006' })
    const line = spy.mock.calls[0][0] as string
    expect(line).toContain('volume-cliff')
    expect(line).toContain('slack connections')
    expect(line).toContain('connection reset')
    expect(line).toContain('08006')
  })

  it('warns that the run judged incomplete data, not merely that a read failed', () => {
    // The point is the CONSEQUENCE: an all-clear from this run cannot be trusted.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadFailure('failure-rate', 'workflows', { message: 'boom' })
    expect(spy.mock.calls[0][0]).toMatch(/incomplete data/i)
  })

  it('renders a PostgREST error object rather than [object Object]', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadFailure('x', 'y', { message: 'permission denied for table workflows', code: '42501' })
    expect(spy.mock.calls[0][0]).not.toContain('[object Object]')
  })

  it('handles a thrown Error too', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logReadFailure('x', 'y', new Error('socket hang up'))
    expect(spy.mock.calls[0][0]).toContain('socket hang up')
  })
})
