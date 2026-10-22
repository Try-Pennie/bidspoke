/**
 * Issues #718, #719, #720.
 *
 * The defect was never in the width logic, it was in the composition: the canvas
 * fed every panel one shared width, ConfigPanel carried a wider code default of
 * its own that the passed width made unreachable, and a code node therefore
 * opened at the narrow form width with nothing failing to show it.
 *
 * So this test exercises the composition rather than either half: the same
 * usePanelWidths instance, the kind chosen by configPanelKind from the open
 * node's type, feeding a real ConfigPanel. WorkflowCanvas itself is not
 * mountable in jsdom yet (#737 tracks real canvas interaction coverage), so the
 * remaining unproven link is the three lines that call configPanelKind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import ConfigPanel from '../ConfigPanel'
import { usePanelWidths } from '@/hooks/usePanelWidths'
import { configPanelKind, PANEL_WIDTH_DEFAULTS } from '@/lib/panel-widths'

vi.mock('next/dynamic', () => ({
  default: () => function MockMonaco() { return <div data-testid="monaco-editor" /> },
}))

vi.mock('@/lib/api', () => ({
  api: {
    partners: { list: vi.fn().mockResolvedValue([]) },
    servicePresets: { list: vi.fn().mockResolvedValue([]) },
    executions: {
      stepDurationStats: vi.fn().mockResolvedValue({
        p50: null, p95: null, p99: null, max_ms: null, sample_size: 0,
        suggested_ms: null, floor_ms: null, floor_reason: null,
        window_days: 7, source: 'history', subtype: null, retries_assumed: 2,
      }),
    },
  },
}))

type CanvasNode = React.ComponentProps<typeof ConfigPanel>['node']

function nodeOf(type: string): CanvasNode {
  return {
    id: `n-${type}`,
    type,
    position: { x: 0, y: 0 },
    data: { config: {}, namespace: `${type}_1`, label: type },
  } as unknown as CanvasNode
}

/**
 * Stands in for the canvas: owns the widths, picks the kind from the selected
 * node's type, and hands the result to ConfigPanel. This is the wiring the bug
 * lived in.
 */
function CanvasStandIn({ initialType = 'code' }: { initialType?: string }) {
  const panelWidths = usePanelWidths()
  const [type, setType] = useState(initialType)
  const kind = configPanelKind(type)
  return (
    <div>
      <button onClick={() => setType('code')}>select code node</button>
      <button onClick={() => setType('salesforce')}>select form node</button>
      <ConfigPanel
        node={nodeOf(type)}
        onClose={vi.fn()}
        nodeNamespaces={[]}
        onUpdate={vi.fn()}
        width={panelWidths.widthFor(kind)}
        onResize={panelWidths.setWidthFor(kind)}
      />
    </div>
  )
}

const renderedWidth = () =>
  Number(screen.getByRole('separator', { name: 'Resize panel' }).getAttribute('aria-valuenow'))

describe('the width a canvas actually gives an open node panel', () => {
  beforeEach(() => window.localStorage.clear())

  it('opens a code node at the code width, wider than the form width', () => {
    render(<CanvasStandIn initialType="code" />)
    expect(renderedWidth()).toBe(PANEL_WIDTH_DEFAULTS.code)
    expect(renderedWidth()).toBeGreaterThan(PANEL_WIDTH_DEFAULTS.form)
  })

  it('opens a non-code node at the form width', () => {
    render(<CanvasStandIn initialType="salesforce" />)
    expect(renderedWidth()).toBe(PANEL_WIDTH_DEFAULTS.form)
  })

  // #2595: the lead validation panel was settled drawn at 469 wide, and its
  // check rows and rule builder truncate at the 320 form width.
  it('opens a lead validation step at the width its design was drawn at, and moves no other step', () => {
    render(<CanvasStandIn initialType="lead_validation" />)
    expect(renderedWidth()).toBe(PANEL_WIDTH_DEFAULTS.checks)

    fireEvent.click(screen.getByText('select form node'))
    expect(renderedWidth()).toBe(PANEL_WIDTH_DEFAULTS.form)

    fireEvent.click(screen.getByText('select code node'))
    expect(renderedWidth()).toBe(PANEL_WIDTH_DEFAULTS.code)
  })

  it('remembers the two widths separately as the selection moves between nodes', () => {
    render(<CanvasStandIn initialType="code" />)

    // Widen while a code node is open.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize panel' }), { key: 'ArrowLeft' })
    const widenedCode = renderedWidth()
    expect(widenedCode).toBeGreaterThan(PANEL_WIDTH_DEFAULTS.code)

    // Switching to a form node must not carry the code width over.
    fireEvent.click(screen.getByText('select form node'))
    expect(renderedWidth()).toBe(PANEL_WIDTH_DEFAULTS.form)

    // Narrowing the form panel must not follow back to the code panel.
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize panel' }), { key: 'ArrowRight' })
    const narrowedForm = renderedWidth()
    expect(narrowedForm).toBeLessThan(PANEL_WIDTH_DEFAULTS.form)

    fireEvent.click(screen.getByText('select code node'))
    expect(renderedWidth()).toBe(widenedCode)
  })
})
