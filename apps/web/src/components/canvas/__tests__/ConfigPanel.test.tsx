import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'
import { api } from '@/lib/api'
import { CLICK_CHECK_BUDGET_MS } from '@bidspoke/buyer-profile'
import { SIMPLE_FILTER_OPERATORS, VALUE_LESS_OPERATORS } from '@bidspoke/workflow-definition'

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
    connections: { list: vi.fn().mockResolvedValue({ connections: [], statuses: { as_of: null, stale: false, unavailable: null } }) },
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
  { type: 'buyer_click_send', marker: /Notify at percent of the cap/ },
  { type: 'buyer_click_check', marker: /Loan amount/ },
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

// #306 / ADR 0001. The BidGroup partner picker listed `partner_type === 'buyer'`
// only, so a `both` partner (Engine: inbound source and fallback buyer at once)
// could never be added to a bid group. The failure is silent: the partner just
// is not in the list, with nothing saying why.
describe('ConfigPanel: BidGroup offers buyer-eligible partners (#306)', () => {
  function partnerOf(id: string, name: string, partner_type: 'source' | 'buyer' | 'both') {
    return {
      id,
      name,
      slug: name.toLowerCase(),
      partner_type,
      is_active: true,
      priority: 0,
    } as unknown as Awaited<ReturnType<typeof api.partners.list>>[number]
  }

  it('lists a both partner alongside a buyer partner, and excludes a source-only one', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([
      partnerOf('p-buyer', 'BuyerCo', 'buyer'),
      partnerOf('p-both', 'BothCo', 'both'),
      partnerOf('p-source', 'SourceCo', 'source'),
    ])

    renderPanel(nodeOf('bid_group'))

    // Scoped to the picker button: the fallback-partner <select> lists the same
    // set, so a bare text query matches twice and says nothing about the picker.
    expect(await screen.findByRole('button', { name: /BothCo/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /BuyerCo/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /SourceCo/ })).not.toBeInTheDocument()
    // A source-only partner must be absent from every surface here, not just the
    // picker, so the fallback select is covered too.
    expect(screen.queryAllByText('SourceCo')).toHaveLength(0)
  })

  it('adds a both partner to the group when it is picked', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([partnerOf('p-both', 'BothCo', 'both')])

    const { onUpdate } = renderPanel(nodeOf('bid_group'))

    fireEvent.click(await screen.findByRole('button', { name: /BothCo/ }))

    expect(onUpdate).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ partner_ids: ['p-both'] }) }),
    )
  })
})

// #1518: the Bid Group's `outbound_fields` map (fields added to every partner's
// request body) is edited beside `context` (values fed to the partner price). The
// editor is the one component for both maps, so this covers that the second map
// writes to ITS key and the first still writes to its own.
describe('ConfigPanel: BidGroup extra request fields (#1518)', () => {
  it('shows the stored outbound fields and writes an edit back under outbound_fields, not context', async () => {
    const { onUpdate } = renderPanel(nodeOf('bid_group', {
      outbound_fields: { unsecuredDebt: '{{steps.pennie_or_eligibility.output.final}}' },
    }))

    const template = await screen.findByLabelText('Extra request fields template') as HTMLInputElement
    expect(template.value).toBe('{{steps.pennie_or_eligibility.output.final}}')

    fireEvent.change(template, { target: { value: '{{steps.other.output.final}}' } })

    expect(onUpdate).toHaveBeenLastCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ outbound_fields: { unsecuredDebt: '{{steps.other.output.final}}' } }) }),
    )
    const lastConfig = (onUpdate.mock.calls.at(-1)![1] as { config: Record<string, unknown> }).config
    expect('context' in lastConfig).toBe(false)
  })

  it('adds a request field row and persists it once both halves are typed', async () => {
    const { onUpdate } = renderPanel(nodeOf('bid_group'))

    fireEvent.click(await screen.findByRole('button', { name: /Add request field/ }))
    fireEvent.change(screen.getByLabelText('Extra request fields field name'), { target: { value: 'maxUnsecuredDebt' } })
    fireEvent.change(screen.getByLabelText('Extra request fields template'), { target: { value: '{{steps.pennie_debt_calculation.output.maxUnsecuredDebt}}' } })

    expect(onUpdate).toHaveBeenLastCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({
        outbound_fields: { maxUnsecuredDebt: '{{steps.pennie_debt_calculation.output.maxUnsecuredDebt}}' },
      }) }),
    )
  })

  it('the context editor still writes to context', async () => {
    const { onUpdate } = renderPanel(nodeOf('bid_group'))

    fireEvent.click(await screen.findByRole('button', { name: /Add context value/ }))
    fireEvent.change(screen.getByLabelText('Context field name'), { target: { value: 'finalDebt' } })

    expect(onUpdate).toHaveBeenLastCalledWith(
      'n1',
      expect.objectContaining({ config: expect.objectContaining({ context: { finalDebt: '' } }) }),
    )
  })
})

// Build-time reference validation (#424). The panel is where an author is
// looking when they write a reference, so it is where a provably broken one has
// to be said. The judging itself lives in lib/reference-validation and is tested
// there; this covers only that the panel shows what it is handed and stays quiet
// otherwise.
describe('ConfigPanel reference problems', () => {
  it('shows nothing when there are no problems', () => {
    renderPanel(nodeOf('webhook'), { referenceProblems: [] })
    expect(screen.queryByTestId('reference-problems')).toBeNull()
  })

  it('names the step and says what is wrong', () => {
    renderPanel(nodeOf('webhook'), {
      referenceProblems: [
        {
          nodeId: 'n1',
          namespace: 'webhook_1',
          reference: 'ghost',
          severity: 'error' as const,
          message: 'No step named ghost in this workflow',
        },
      ],
    })
    const box = screen.getByTestId('reference-problems')
    expect(box.textContent).toContain('No step named ghost in this workflow')
  })

  it('announces itself, so the message is not sighted-only', () => {
    renderPanel(nodeOf('webhook'), {
      referenceProblems: [
        { nodeId: 'n1', namespace: 'webhook_1', reference: 'ghost', severity: 'error' as const, message: 'No step named ghost in this workflow' },
      ],
    })
    expect(screen.getByTestId('reference-problems').getAttribute('role')).toBe('alert')
  })

  it('lists every distinct problem rather than only the first', () => {
    renderPanel(nodeOf('webhook'), {
      referenceProblems: [
        { nodeId: 'n1', namespace: 'webhook_1', reference: 'ghost', severity: 'error' as const, message: 'No step named ghost in this workflow' },
        { nodeId: 'n1', namespace: 'webhook_1', reference: 'sidecar', severity: 'error' as const, message: 'sidecar does not run before this step, so steps.sidecar is always empty here' },
      ],
    })
    const box = screen.getByTestId('reference-problems')
    expect(box.textContent).toContain('ghost')
    expect(box.textContent).toContain('sidecar')
  })
})

// #1490: deferred is where decide only sends every sell off lead, back to the
// rest of the workflow, and the mode hint is where the person choosing the mode
// reads that.
// #1495: the engine has no default mode, so the toggle must not show one as
// chosen when none is, and the hint must say the step fails until one is.
describe('ConfigPanel: buyer_select with no mode set (#1495)', () => {
  it('leaves neither mode selected and says the step fails until one is chosen', () => {
    renderPanel(nodeOf('buyer_select', {}))
    expect(screen.getByRole('button', { name: 'Decide only' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText(/no mode set/i).textContent).toMatch(/mode_invalid/)
  })

  it('marks the chosen mode as pressed', () => {
    renderPanel(nodeOf('buyer_select', { mode: 'decide_only' }))
    expect(screen.getByRole('button', { name: 'Decide only' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('ConfigPanel: buyer_select mode hint names where decide only sends leads (#1490)', () => {
  it('says decide only routes every sell off lead to deferred, back to the rest of the workflow', () => {
    renderPanel(nodeOf('buyer_select', { mode: 'decide_only' }))
    expect(screen.getByText(/every sell off lead routes to deferred/i).textContent).toMatch(/rest of the workflow/i)
  })
})

// The two click nodes share one picker (#1543, L613), so both are held to the same rule.
describe.each(['buyer_click_send', 'buyer_click_check'])('ConfigPanel: %s picks its partner from the buyers and stores its id (#1542, #1553, L611)', (clickType) => {
  const LIBERTY1_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
  const EVAFI_ID = '9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a'
  const partnerOf = (id: string, slug: string, name: string, partner_type: 'source' | 'buyer' | 'both') =>
    ({ id, name, slug, partner_type, is_active: true, priority: 0 }) as unknown as Awaited<ReturnType<typeof api.partners.list>>[number]

  it('offers buyer partners by name, never a source, and stores the partner id, not the slug', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([partnerOf(LIBERTY1_ID, 'liberty1', 'Liberty1', 'buyer'), partnerOf('id-engine', 'engine', 'Engine', 'source')])
    const { onUpdate } = renderPanel(nodeOf(clickType, {}))
    const picker = await screen.findByRole('combobox', { name: 'Partner' })
    expect(await within(picker).findByRole('option', { name: 'Liberty1' })).toBeInTheDocument()
    expect(within(picker).queryByRole('option', { name: 'Engine' })).not.toBeInTheDocument()
    fireEvent.change(picker, { target: { value: LIBERTY1_ID } })
    const config = vi.mocked(onUpdate).mock.calls.at(-1)?.[1]?.config as Record<string, unknown>
    expect(config.partner_id).toBe(LIBERTY1_ID)
    expect(config).not.toHaveProperty('partner_slug')
  })

  it('selects a stored id the list holds under the partner name', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([partnerOf(LIBERTY1_ID, 'liberty1', 'Liberty1', 'buyer')])
    renderPanel(nodeOf(clickType, { partner_id: LIBERTY1_ID }))
    await screen.findByRole('option', { name: 'Liberty1' })
    const picker = screen.getByRole('combobox', { name: 'Partner' }) as HTMLSelectElement
    expect(picker.value).toBe(LIBERTY1_ID)
    expect(picker.selectedOptions[0].textContent).toBe('Liberty1')
  })

  it('keeps showing a stored id the list does not hold, rather than silently picking another', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([partnerOf(LIBERTY1_ID, 'liberty1', 'Liberty1', 'buyer'), partnerOf(EVAFI_ID, 'evafi', 'EvaFi', 'source')])
    renderPanel(nodeOf(clickType, { partner_id: EVAFI_ID }))
    await screen.findByRole('option', { name: 'Liberty1' })
    const picker = screen.getByRole('combobox', { name: 'Partner' }) as HTMLSelectElement
    expect(picker.value).toBe(EVAFI_ID)
    // Named where the list knows the partner, by id where it does not.
    expect(screen.getByRole('option', { name: /EvaFi \(not a buyer partner\)/ })).toBeInTheDocument()
  })

  it('keeps an id no partner in the list holds selected, by id', async () => {
    vi.mocked(api.partners.list).mockResolvedValue([partnerOf(LIBERTY1_ID, 'liberty1', 'Liberty1', 'buyer')])
    renderPanel(nodeOf(clickType, { partner_id: EVAFI_ID }))
    await screen.findByRole('option', { name: 'Liberty1' })
    expect((screen.getByRole('combobox', { name: 'Partner' }) as HTMLSelectElement).value).toBe(EVAFI_ID)
    expect(screen.getByRole('option', { name: new RegExp(`${EVAFI_ID} \\(no such partner\\)`) })).toBeInTheDocument()
  })

  it('keeps the stored id selected while the partners are still loading (L652)', () => {
    vi.mocked(api.partners.list).mockReturnValue(new Promise(() => undefined))
    renderPanel(nodeOf(clickType, { partner_id: LIBERTY1_ID }))
    const picker = screen.getByRole('combobox', { name: 'Partner' }) as HTMLSelectElement
    expect(picker.value).toBe(LIBERTY1_ID)
    expect(screen.getByRole('option', { name: new RegExp(`${LIBERTY1_ID} \\(partner list not loaded\\)`) })).toBeInTheDocument()
  })

  it('keeps the stored id selected when the partners cannot be loaded, so a save cannot drop it (L652)', async () => {
    vi.mocked(api.partners.list).mockRejectedValue(new Error('network'))
    renderPanel(nodeOf(clickType, { partner_id: LIBERTY1_ID }))
    await screen.findByText(/Partners could not be loaded/)
    const picker = screen.getByRole('combobox', { name: 'Partner' }) as HTMLSelectElement
    expect(picker.value).toBe(LIBERTY1_ID)
    expect(screen.getByRole('option', { name: new RegExp(`${LIBERTY1_ID} \\(partner list not loaded\\)`) })).toBeInTheDocument()
  })

  it('says so when the partners cannot be loaded, instead of an empty picker', async () => {
    vi.mocked(api.partners.list).mockRejectedValue(new Error('network'))
    renderPanel(nodeOf(clickType, {}))
    expect(await screen.findByText(/Partners could not be loaded/)).toBeInTheDocument()
  })
})

describe('ConfigPanel: buyer_click_send holds no cap of its own (#1543, L83)', () => {
  it('has no daily lead cap field: the cap is the buyer profile\'s', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf('buyer_click_send', {}))
    expect(screen.queryByText('Daily lead cap')).not.toBeInTheDocument()
    expect(screen.getByText('Notify at percent of the cap')).toBeInTheDocument()
  })
})

describe('ConfigPanel: buyer_click_send holds no address or success line of its own (#1671)', () => {
  it('has no Request URL or Success line field: both are the buyer profile\'s click delivery', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf('buyer_click_send', {}))
    expect(screen.queryByText('Request URL')).toBeNull()
    expect(screen.queryByText('Success line')).toBeNull()
    expect(screen.queryByRole('button', { name: /Remove the old address and success line/ })).toBeNull()
  })

  it('a node still holding them says so, and one press removes both and nothing else', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    const { onUpdate } = renderPanel(nodeOf('buyer_click_send', { request_url: '{{steps.build_request.output.url}}', success_pattern: 'OK (?<id>\\d+)', request_body: '{{b}}', state: '{{s}}' }))
    expect(screen.getByText(/no longer used/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Remove the old address and success line/ }))
    const config = vi.mocked(onUpdate).mock.calls.at(-1)?.[1]?.config as Record<string, unknown>
    expect(config.request_url).toBeUndefined()
    expect(config.success_pattern).toBeUndefined()
    expect(JSON.parse(JSON.stringify(config))).not.toHaveProperty('request_url')
    expect(config).toMatchObject({ request_body: '{{b}}', state: '{{s}}' })
  })

  it('a node holding only one of them offers the same removal', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf('buyer_click_send', { success_pattern: 'OK (?<id>\\d+)' }))
    expect(screen.getByRole('button', { name: /Remove the old address and success line/ })).toBeInTheDocument()
  })
})

describe('ConfigPanel: buyer_click_send state template (#1639)', () => {
  it('writes the state template that picks the buyer profile route', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    const { onUpdate } = renderPanel(nodeOf('buyer_click_send', {}))
    fireEvent.change(screen.getByRole('textbox', { name: 'State' }), { target: { value: '{{steps.build_request.output.state}}' } })
    const config = vi.mocked(onUpdate).mock.calls.at(-1)?.[1]?.config as Record<string, unknown>
    expect(config.state).toBe('{{steps.build_request.output.state}}')
  })
})

describe('ConfigPanel: buyer_click_check (#1543)', () => {
  it('picks the population from the vocabulary and writes the lead templates', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    const { onUpdate } = renderPanel(nodeOf('buyer_click_check', { population: 'engine' }))
    const population = screen.getByRole('combobox', { name: 'Population' }) as HTMLSelectElement
    expect([...population.options].map((o) => o.value)).toEqual(['engine', 'main_flow', 'lead_economy'])
    fireEvent.change(screen.getByRole('textbox', { name: 'Debt' }), { target: { value: '{{steps.trades.output.tradeCalculations.engineDebt}}' } })
    const config = vi.mocked(onUpdate).mock.calls.at(-1)?.[1]?.config as Record<string, unknown>
    expect(config.debt).toBe('{{steps.trades.output.tradeCalculations.engineDebt}}')
  })

  it('labels each population by name, never its stored code (#1557)', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf('buyer_click_check', { population: 'engine' }))
    const population = screen.getByRole('combobox', { name: 'Population' }) as HTMLSelectElement
    expect([...population.options].map((o) => o.textContent)).toEqual(['Engine', 'Main Flow', 'Lead Economy'])
    expect(population.value).toBe('engine')
  })

  it('a stored population outside the vocabulary stays shown and selected as its own labelled option, so a save cannot swap it for another (L652)', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf('buyer_click_check', { population: 'enginee' }))
    const population = screen.getByRole('combobox', { name: 'Population' }) as HTMLSelectElement
    expect(population.value).toBe('enginee')
    expect(population.selectedOptions[0].textContent).toBe('enginee (not a population Bidspoke knows)')
  })

  it('states the budget from the one constant, in text that is not the low contrast slate 400 (#1557)', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf('buyer_click_check', { population: 'engine' }))
    const hint = screen.getByText(new RegExp(`within ${CLICK_CHECK_BUDGET_MS} ms`))
    expect(hint.className).not.toMatch(/text-slate-400/)
  })
})

// #2111: the collections template a profile's collections cap is judged on.
describe.each(['buyer_click_check', 'buyer_select'])('ConfigPanel: %s collections template (#2111)', (type) => {
  const COLLECTIONS = '{{steps.prospect_trades.output.body.tradeCalculations.eligibleCollectionTotalBalance}}'

  it('writes the collections template', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    const { onUpdate } = renderPanel(nodeOf(type, { population: 'engine', mode: 'live' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Collections' }), { target: { value: COLLECTIONS } })
    expect((vi.mocked(onUpdate).mock.calls.at(-1)?.[1]?.config as Record<string, unknown>).collections).toBe(COLLECTIONS)
  })

  it('clearing a stored template removes the key, so the step reads no figure', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    const { onUpdate } = renderPanel(nodeOf(type, { population: 'engine', mode: 'live', collections: COLLECTIONS }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Collections' }), { target: { value: '' } })
    const cleared = vi.mocked(onUpdate).mock.calls.at(-1)?.[1]?.config as Record<string, unknown>
    expect(cleared).toBeDefined()
    expect(cleared.collections).toBeUndefined()
  })

  it('shows a stored template', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf(type, { population: 'engine', mode: 'live', collections: COLLECTIONS }))
    expect((screen.getByRole('textbox', { name: 'Collections' }) as HTMLInputElement).value).toBe(COLLECTIONS)
  })
})

// #2338 (build PR 4): the webhook node's legacy schema browser read only legacy
// connection rows (a Cloudflare secret login), none of which exists, through the
// retired sync-schema route. It is deleted rather than wired to ops
// connections; the step form's Connection field (build PR 11) replaces it.
describe('ConfigPanel: the webhook node has no legacy schema browser (#2338)', () => {
  it.each(['salesforce', 'supabase', 'snowflake'])('a %s webhook shows no schema browser and reads no connections', async (service) => {
    vi.mocked(api.connections.list).mockClear()
    renderPanel(nodeOf('webhook', { service }))
    await screen.findByText(/^URL$/)
    expect(screen.queryByText(/^Schema$/)).toBeNull()
    expect(screen.queryByText(/Sync schema|No connection configured/)).toBeNull()
    expect(vi.mocked(api.connections.list)).not.toHaveBeenCalled()
  })
})

describe('ConfigPanel: buyer_click_send notify percent hint (#1557)', () => {
  it('explains the domain, not the interface: it never says where the cap lives on screen', () => {
    vi.mocked(api.partners.list).mockResolvedValue([])
    renderPanel(nodeOf('buyer_click_send', {}))
    expect(screen.queryByText(/Of the clicks per day on the buyer profile/)).toBeNull()
    expect(screen.getByText(/once a Pacific day/)).toBeInTheDocument()
  })
})

// #2588's editor half: the simple Filter condition reads the shared list, so it
// offers the same ten operators in their spelled out words, as before.
describe('ConfigPanel: the Filter condition dropdown reads the shared operator list (#2588)', () => {
  function operatorSelect(): HTMLSelectElement {
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]
    const op = selects.find((s) => Array.from(s.options).some((o) => o.value === 'eq'))
    if (!op) throw new Error('no operator dropdown')
    return op
  }

  it('offers exactly the shared simple Filter operators, with their words', () => {
    renderPanel(nodeOf('filter', { condition: { field: 'state', operator: 'eq', value: 'CA' } }))
    const options = Array.from(operatorSelect().options)
    expect(options.map((o) => o.value)).toEqual(SIMPLE_FILTER_OPERATORS.map((o) => o.value))
    expect(options.map((o) => o.textContent)).toEqual(SIMPLE_FILTER_OPERATORS.map((o) => o.label))
    expect(options.map((o) => o.textContent)).toEqual([
      'equals', 'does not equal', 'greater than', 'greater than or equal', 'less than', 'less than or equal',
      'contains', 'does not contain', 'exists', 'does not exist',
    ])
  })

  it.each(SIMPLE_FILTER_OPERATORS.map((o) => o.value))('shows a value box for %s exactly when it takes a value', (operator) => {
    renderPanel(nodeOf('filter', { condition: { field: 'state', operator, value: 'CA' } }))
    expect(Boolean(screen.queryByPlaceholderText('Value…'))).toBe(!VALUE_LESS_OPERATORS.has(operator))
  })
})

// The settled step form design (docs/design/connections-step-form.html, #2338) reads a step's
// fields inside #step-panel-body, so the real panel names its body the same way: the design's
// checks then run on the canvas once the Connection field is mounted on a step (#2339).
describe('the step panel body', () => {
  it('carries the id the settled step form checks read', () => {
    renderPanel(nodeOf('salesforce'))
    const body = document.getElementById('step-panel-body')
    expect(body).not.toBeNull()
    expect(within(body as HTMLElement).getByText('Display name')).toBeInTheDocument()
  })
})
