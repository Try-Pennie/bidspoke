/**
 * #310: a degraded execution (lead served, post-response writeback failed) must
 * render a distinct icon, not the normal completed/successful one. The list
 * colors by outcome, and a degraded run has a non-failed outcome, so the status
 * check has to win over the outcome fallback or it would render as completed.
 */
import { describe, it, expect } from 'vitest'
import { AlertTriangle, CheckCircle2, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { iconFor } from '../ExecutionListPanel'

describe('iconFor (#310 degraded)', () => {
  it('renders the degraded (AlertTriangle) icon even though the outcome is non-failed', () => {
    const r = iconFor({ status: 'degraded', outcome: 'completed' })
    expect(r.icon).toBe(AlertTriangle)
    expect(r.color).toMatch(/amber/)
  })

  it('still renders successful/completed/failed by outcome for normal runs', () => {
    expect(iconFor({ status: 'completed', outcome: 'successful' }).icon).toBe(CheckCircle2)
    expect(iconFor({ status: 'completed', outcome: 'completed' }).icon).toBe(CheckCircle)
    expect(iconFor({ status: 'failed', outcome: 'failed' }).icon).toBe(XCircle)
  })

  it('renders the running spinner for in-flight runs', () => {
    expect(iconFor({ status: 'running', outcome: null }).icon).toBe(Loader2)
  })
})
