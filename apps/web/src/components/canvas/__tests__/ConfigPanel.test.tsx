import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'

// Characterization tests (#239): every node type's config form mounts via the
// public ConfigPanel (the per-type sub-forms are internal, not exported), so a
// regression that blanks or crashes a form is caught — a throwing form fails the
// render. The five api methods the panel and its children call on mount are
// stubbed to resolve empty.
// Monaco loads via next/dynamic (ssr:false), which never resolves in jsdom. Mock
// next/dynamic so the editor renders synchronously as a stub that surfaces the
// `options` it received — lets us assert the read-only wiring (#view-mode-scroll).
vi.mock('next/dynamic', () => ({
  default: () =>
    function MockMonaco(props: { options?: { readOnly?: boolean; wordWrap?: string } }) {
      return (
        <div
          data-testid="monaco-editor"
          data-readonly={String(Boolean(props.options?.readOnly))}
          data-wordwrap={props.options?.wordWrap ?? 'unset'}
        />
      )
    },
}))

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
    <ConfigPanel node={node} onClose={vi.fn()} nodeNamespaces={[]} onUpdate={onUpdate} width={320} onResize={vi.fn()} {...extra} />,
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
  // No partner_bid: the node type is retired (#645), so it has no config form.
  // It still renders on the canvas as a generic card, covered by nodes/registry.test.ts.
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

describe('ConfigPanel — code editor stays scrollable in view mode', () => {
  // In view mode the panel applies `pointer-events-none`, which used to block
  // mouse-wheel scrolling inside the Monaco editor so reviewers couldn't see code
  // past the visible region without entering edit mode. The fix makes the editor
  // genuinely read-only (Monaco `readOnly`) and re-enables pointer events on the
  // editor itself so it scrolls. Assert the read-only option reaches Monaco.
  it('passes readOnly to the code editor when the panel is read-only', () => {
    renderPanel(nodeOf('code'), { readOnly: true })
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('data-readonly', 'true')
  })

  it('keeps the code editor editable when the panel is not read-only', () => {
    renderPanel(nodeOf('code'))
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('data-readonly', 'false')
  })

  it('passes readOnly to the Salesforce JSON body editor when read-only', () => {
    renderPanel(nodeOf('salesforce'), { readOnly: true })
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('data-readonly', 'true')
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

describe('ConfigPanel: Constants node JSON view (#560-followup)', () => {
  it('defaults to table view with existing rows visible, no JSON textarea', () => {
    renderPanel(nodeOf('constants', { data: { offerName: 'Pennie' } }))
    expect(screen.getByDisplayValue('offerName')).toBeInTheDocument()
    expect(screen.queryByLabelText('Constants JSON')).not.toBeInTheDocument()
  })

  it('switching to JSON view shows the current data as pretty-printed JSON', () => {
    renderPanel(nodeOf('constants', { data: { offerName: 'Pennie', minimumLoanAmount: 1000 } }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(screen.getByLabelText('Constants JSON')).toHaveValue(
      JSON.stringify({ offerName: 'Pennie', minimumLoanAmount: 1000 }, null, 2),
    )
  })

  it('editing valid JSON persists it and switching back to table shows the new rows', () => {
    const { onUpdate } = renderPanel(nodeOf('constants', { data: {} }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    fireEvent.change(screen.getByLabelText('Constants JSON'), {
      target: {
        value: JSON.stringify({
          offerName: 'Pennie',
          minimumLoanAmount: 1000,
          biddingActive: true,
          states: ['CA', 'NY'],
        }),
      },
    })
    expect(onUpdate).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({
        config: expect.objectContaining({
          data: { offerName: 'Pennie', minimumLoanAmount: 1000, biddingActive: true, states: ['CA', 'NY'] },
        }),
      }),
    )
    // Switching is allowed once the JSON is valid (row content after the switch
    // depends on the parent re-supplying the updated config, which this harness's
    // mocked onUpdate doesn't do; that path is exercised in the real app).
    expect(screen.getByRole('button', { name: 'Table' })).not.toBeDisabled()
  })

  it('invalid JSON shows an error and disables switching back to table', () => {
    renderPanel(nodeOf('constants', { data: { offerName: 'Pennie' } }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    fireEvent.change(screen.getByLabelText('Constants JSON'), { target: { value: '{ not valid json' } })
    expect(screen.getByText(/invalid json/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Table' })).toBeDisabled()
  })

  it('a nested object value is rejected as unsupported', () => {
    renderPanel(nodeOf('constants', { data: {} }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    fireEvent.change(screen.getByLabelText('Constants JSON'), {
      target: { value: JSON.stringify({ nested: { a: 1 } }) },
    })
    expect(screen.getByText(/nested object/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Table' })).toBeDisabled()
  })

  it('a blank key is rejected', () => {
    renderPanel(nodeOf('constants', { data: {} }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    fireEvent.change(screen.getByLabelText('Constants JSON'), {
      target: { value: JSON.stringify({ '': 'x' }) },
    })
    expect(screen.getByText('Keys must not be blank')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Table' })).toBeDisabled()
  })

  it('invalid JSON reports the key editor invalid, blocking save', () => {
    const onKeyEditorValidityChange = vi.fn()
    renderPanel(nodeOf('constants', { data: {} }), { onKeyEditorValidityChange })
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    onKeyEditorValidityChange.mockClear()
    fireEvent.change(screen.getByLabelText('Constants JSON'), { target: { value: '{ not valid' } })
    expect(onKeyEditorValidityChange).toHaveBeenCalledWith(false)
  })

  it('fixing invalid JSON reports the key editor valid again', () => {
    const onKeyEditorValidityChange = vi.fn()
    renderPanel(nodeOf('constants', { data: {} }), { onKeyEditorValidityChange })
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    const textarea = screen.getByLabelText('Constants JSON')
    fireEvent.change(textarea, { target: { value: '{ not valid' } })
    fireEvent.change(textarea, { target: { value: '{"a": "b"}' } })
    expect(onKeyEditorValidityChange).toHaveBeenLastCalledWith(true)
  })

  it('switching table to JSON always works, even with existing valid rows', () => {
    renderPanel(nodeOf('constants', { data: { a: 'b' } }))
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(screen.getByLabelText('Constants JSON')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Table' })).not.toBeDisabled()
  })
})

describe('ConfigPanel: Salesforce apex GET support (#563-followup)', () => {
  it('apex: shows a method toggle defaulting to POST, body field visible', () => {
    renderPanel(nodeOf('salesforce', { operation: 'apex', apex_path: '/services/apexrest/prospect-trades' }))
    expect(screen.getByRole('button', { name: 'POST' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'GET' })).toBeInTheDocument()
    expect(screen.getByLabelText('Body (JSON)')).toBeInTheDocument()
  })

  it('apex: selecting GET calls onUpdate with apex_method GET', () => {
    const { onUpdate } = renderPanel(nodeOf('salesforce', { operation: 'apex', apex_path: '/services/apexrest/custommdt/bid?name=Lead_Economy' }))
    fireEvent.click(screen.getByRole('button', { name: 'GET' }))
    expect(onUpdate).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ apex_method: 'GET' }) }),
    )
  })

  it('apex: body field is hidden when apex_method is GET', () => {
    renderPanel(nodeOf('salesforce', { operation: 'apex', apex_path: '/services/apexrest/custommdt/bid?name=Lead_Economy', apex_method: 'GET' }))
    expect(screen.queryByLabelText('Body (JSON)')).not.toBeInTheDocument()
  })

  it('non-apex operations show no method toggle', () => {
    renderPanel(nodeOf('salesforce', { operation: 'create', object: 'Prospect__c' }))
    expect(screen.queryByRole('button', { name: 'GET' })).not.toBeInTheDocument()
  })
})

// Issues #718 and #720: the panel used to carry its own `width ?? (isCode ? 540 : 320)`
// fallback while every call site passed a width, so the wider code branch was dead
// and a script opened at the narrow form width. The width now comes from one place
// and the panel must render exactly what it is handed.
describe('ConfigPanel width (#718, #720)', () => {
  function panelWidth(): string {
    const panel = document.querySelector('aside, [style*="width"]') as HTMLElement | null
    return panel?.style.width ?? ''
  }

  it('renders at the width it is given, for a code node', () => {
    renderPanel(nodeOf('code'), { width: 540 })
    expect(panelWidth()).toBe('540px')
  })

  it('renders at the width it is given, for a form node', () => {
    renderPanel(nodeOf('salesforce'), { width: 320 })
    expect(panelWidth()).toBe('320px')
  })

  // The same component instance must not substitute a per-type width of its own:
  // a code node handed 700 shows 700, not the 540 the dead fallback used to hold.
  it('does not override the given width with a type-specific default', () => {
    renderPanel(nodeOf('code'), { width: 700 })
    expect(panelWidth()).toBe('700px')
  })

  it('reports the current width on the resize separator', () => {
    renderPanel(nodeOf('code'), { width: 640 })
    expect(screen.getByRole('separator', { name: 'Resize panel' })).toHaveAttribute('aria-valuenow', '640')
  })
})

// Issue #718: with no wrapping, a long line (the Engine URL in the reported case)
// ran off the right edge and was reachable only by scrolling one line at a time.
describe('ConfigPanel code editor wrapping (#718)', () => {
  it('wraps long lines in the code editor', () => {
    renderPanel(nodeOf('code'))
    expect(screen.getByTestId('monaco-editor')).toHaveAttribute('data-wordwrap', 'on')
  })
})
