import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'

// Characterization tests (#239): every node type's config form mounts via the
// public ConfigPanel (the per-type sub-forms are internal, not exported), so a
// regression that blanks or crashes a form is caught — a throwing form fails the
// render. The five api methods the panel and its children call on mount are
// stubbed to resolve empty.
vi.mock('@/lib/api', () => ({
  api: {
    connections: { list: vi.fn().mockResolvedValue([]), syncSchema: vi.fn().mockResolvedValue({}) },
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

type PanelProps = React.ComponentProps<typeof ConfigPanel>
type CanvasNode = PanelProps['node']

function nodeOf(type: string, config: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'n1',
    type,
    position: { x: 0, y: 0 },
    data: { config, namespace: `${type}_1`, label: type },
  } as unknown as CanvasNode
}

function renderPanel(node: CanvasNode, extra: Partial<PanelProps> = {}) {
  const onUpdate = vi.fn()
  render(
    <ConfigPanel node={node} onClose={vi.fn()} nodeNamespaces={[]} onUpdate={onUpdate} {...extra} />,
  )
  return { onUpdate }
}

// One distinctive marker per node-type form, proving the RIGHT form mounted (not
// just any panel). `null` = the form has no stable text (code loads Monaco
// async), so we assert only that it mounted without crashing.
const CASES: { type: string; marker: RegExp | null }[] = [
  { type: 'filter', marker: /Continue if condition is met/ },
  { type: 'branch', marker: /Branches/ },
  { type: 'response', marker: /Status code/ },
  { type: 'exit', marker: /Response body/ },
  { type: 'transform', marker: /Field mappings/ },
  { type: 'webhook', marker: /^URL$/ },
  { type: 'partner_bid', marker: /Select a partner/ },
  { type: 'bid_group', marker: null },
  { type: 'constants', marker: /Workflow constants/ },
  { type: 'salesforce', marker: /SObject API name/ },
  { type: 'data_store', marker: /Which KV namespace/ },
  { type: 'latency_gate', marker: /Correlation key/ },
  { type: 'achieve_offers', marker: /Hold for inline offers/ },
  { type: 'parallel', marker: /First to succeed/ },
  { type: 'parallel_end', marker: /join point for the parallel/ },
  { type: 'branch_end', marker: /Convergence point for the branch/ },
  { type: 'code', marker: null },
]

describe('ConfigPanel — every node type mounts its form', () => {
  it.each(CASES)('renders the $type config form', ({ type, marker }) => {
    renderPanel(nodeOf(type))
    // The panel root always renders; a form that threw would fail the render above.
    expect(document.querySelector('aside')).toBeTruthy()
    if (marker) expect(screen.getByText(marker)).toBeInTheDocument()
  })
})

describe('ConfigPanel — response 4xx warning (#325)', () => {
  const warning = /treat any 4xx as a permanent rejection/

  it('warns when a Response node hard-codes a 4xx status', () => {
    renderPanel(nodeOf('response', { status_code: 404 }))
    expect(screen.getByText(warning)).toBeInTheDocument()
  })

  it('does not warn for a 2xx status', () => {
    renderPanel(nodeOf('response', { status_code: 200 }))
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
  })

  it('does not warn for a 5xx status', () => {
    renderPanel(nodeOf('response', { status_code: 503 }))
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
  })

  it('does not warn for a templated status (resolved at run time)', () => {
    renderPanel(nodeOf('response', { status_code: '{{steps.x.output.status}}' }))
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
  })
})

describe('ConfigPanel — editing a field saves through onUpdate', () => {
  it('filter: changing the operation calls onUpdate with the new config', () => {
    const { onUpdate } = renderPanel(nodeOf('filter', { operation: 'continue_if' }))
    // The Operation select is the first combobox in the filter form.
    const operation = screen.getAllByRole('combobox')[0]
    fireEvent.change(operation, { target: { value: 'end_if' } })
    expect(onUpdate).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ operation: 'end_if' }) }),
    )
  })
})
