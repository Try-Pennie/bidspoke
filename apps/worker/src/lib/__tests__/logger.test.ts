/**
 * Structured log format — PRD Section 3.5 (Logpush archival)
 * Verifies that every log line emitted by `log()` is valid JSON and contains
 * the fields required for trace-id-based querying in R2/Snowflake.
 *
 * Required fields per PRD Section 10.3:
 *   event, trace_id — mandatory on every line
 *   workflow_id, step_type, duration_ms — present on relevant events
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { log } from '../logger'
import type { LogFields } from '../logger'

describe('log()', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let captured: string[]

  beforeEach(() => {
    captured = []
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      captured.push(msg)
    })
  })

  afterEach(() => consoleSpy.mockRestore())

  it('emits valid JSON', () => {
    log({ event: 'execution_start', trace_id: 'tr-1', workflow_id: 'wf-1' })
    expect(() => JSON.parse(captured[0])).not.toThrow()
  })

  it('output includes event and trace_id (required for archival querying)', () => {
    log({ event: 'step_complete', trace_id: 'tr-abc', workflow_id: 'wf-x', step_namespace: 'filter_1', duration_ms: 12 })
    const parsed = JSON.parse(captured[0]) as LogFields
    expect(parsed.event).toBe('step_complete')
    expect(parsed.trace_id).toBe('tr-abc')
  })

  it('includes workflow_id for execution-scoped events', () => {
    log({ event: 'execution_complete', trace_id: 'tr-2', workflow_id: 'wf-2', duration_ms: 300 })
    const parsed = JSON.parse(captured[0]) as LogFields
    expect(parsed.workflow_id).toBe('wf-2')
    expect(parsed.duration_ms).toBe(300)
  })

  it('includes partner_id on partner_bid events', () => {
    log({ event: 'partner_bid', trace_id: 'tr-3', workflow_id: 'wf-3', partner_id: 'tripoint', bid: 650, accepted: true })
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>
    expect(parsed.partner_id).toBe('tripoint')
    expect(parsed.bid).toBe(650)
  })

  it('includes step_type on step events (needed for post-archival filtering)', () => {
    log({ event: 'step_start', trace_id: 'tr-4', workflow_id: 'wf-4', step_type: 'partner_bid', step_namespace: 'bid_1' })
    const parsed = JSON.parse(captured[0]) as LogFields
    expect(parsed.step_type).toBe('partner_bid')
    expect(parsed.step_namespace).toBe('bid_1')
  })

  it('serializes extra fields alongside the standard ones', () => {
    log({ event: 'step_error', trace_id: 'tr-5', workflow_id: 'wf-5', error_type: 'transient', error_message: 'timeout' })
    const parsed = JSON.parse(captured[0]) as LogFields
    expect(parsed.error_type).toBe('transient')
    expect(parsed.error_message).toBe('timeout')
  })
})
