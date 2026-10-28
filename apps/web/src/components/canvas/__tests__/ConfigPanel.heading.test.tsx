/**
 * The step panel's heading line (#2765; settled in
 * docs/design/app-action-panel-heading.html): an App Action step's line names its
 * service and action as its card does, never the raw type app_action, and keeps
 * the size, capitals, spacing and grey every step's line has (D2).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'

vi.mock('next/dynamic', () => ({ default: () => function MockMonaco() { return <div /> } }))
vi.mock('@/lib/api', () => ({
  api: {
    connections: { list: vi.fn().mockRejectedValue(new Error('not in this test')), lookup: vi.fn() },
    workflows: { testResult: vi.fn() },
    partners: { list: vi.fn().mockResolvedValue([]) },
    executions: {
      stepDurationStats: vi.fn().mockResolvedValue({
        p50: null, p95: null, p99: null, max_ms: null, sample_size: 0, suggested_ms: null, floor_ms: null, floor_reason: null,
        window_days: 7, source: 'history', subtype: null, retries_assumed: 2,
      }),
    },
  },
  CONNECTIONS_LIST_TIMEOUT_MS: 15_000,
}))

type PanelProps = React.ComponentProps<typeof ConfigPanel>
const LINE_CLASSES = 'text-xs font-medium uppercase tracking-wide text-gray-500'

function node(type: string, config: Record<string, unknown>): PanelProps['node'] {
  return { id: 'n1', type, position: { x: 0, y: 0 }, data: { label: 'Send welcome email', namespace: 'send_welcome_email', config } } as unknown as PanelProps['node']
}

/** The line just above the step's display name in the panel's header. */
function headingLine(type: string, config: Record<string, unknown>): HTMLElement {
  render(<ConfigPanel node={node(type, config)} onClose={vi.fn()} nodeNamespaces={[]} width={320} onResize={vi.fn()} readOnly />)
  const name = screen.getAllByText('Send welcome email').find((e) => e.tagName === 'P' && e.closest('aside'))
  const line = name?.previousElementSibling
  if (!(line instanceof HTMLElement)) throw new Error('no line above the step name')
  return line
}

describe('the step panel heading line', () => {
  it('reads Gmail, Send an email for a Gmail Send an email step, in the same line as every step (D1, D2)', () => {
    const line = headingLine('app_action', { service: 'google', action: 'google.gmail-send-email', actionVersion: 1, args: {} })
    expect(line.tagName).toBe('P')
    expect(line.textContent).toBe('Gmail, Send an email')
    expect(line.className).toBe(LINE_CLASSES)
  })

  it('reads App action for a step with no service yet (D3)', () => {
    expect(headingLine('app_action', {}).textContent).toBe('App action')
  })

  it('keeps another step type\'s line as it was', () => {
    const line = headingLine('code', { script: 'return 1' })
    expect(line.textContent).toBe('code')
    expect(line.className).toBe(LINE_CLASSES)
  })
})
