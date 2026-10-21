import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'
import { LEAD_REJECTION_REASONS } from '@bidspoke/workflow-definition'
import { readSelect, chooseOption } from '@/components/ui/__tests__/_select'
import { leadValidationFixtureConfig, LEAD_VALIDATION_FIXTURE } from '@/lib/__tests__/_lead-validation-fixture'

// The lead validation step's settings, as Dan settled them on 2026-10-21
// (docs/design/lead-validation-node.html, D1 to D8 and D12 to D15). The panel is
// mounted through the public ConfigPanel, so what is tested is what the canvas
// opens. The checks file beside the design measures the same decisions in a
// browser; these pin the behaviour behind them: what each edit writes.

vi.mock('next/dynamic', () => ({ default: () => function MockMonaco() { return null } }))
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
type StoredCheck = ReturnType<typeof leadValidationFixtureConfig>['checks'][number]

/** The panel as the canvas holds it: each edit is written back to the node, as onUpdate does there. */
function Harness({ initial, onUpdate }: { initial: Record<string, unknown>; onUpdate: (id: string, d: { config?: Record<string, unknown> }) => void }) {
  const [config, setConfig] = useState(initial)
  const node = {
    id: 'v',
    type: 'lead_validation',
    position: { x: 0, y: 0 },
    data: { config, namespace: LEAD_VALIDATION_FIXTURE.node.id, label: LEAD_VALIDATION_FIXTURE.node.title },
  } as unknown as PanelProps['node']
  return (
    <ConfigPanel
      node={node}
      onClose={vi.fn()}
      nodeNamespaces={[]}
      onUpdate={(id, d) => { onUpdate(id, d as { config?: Record<string, unknown> }); if (d.config) setConfig(d.config) }}
      width={420}
      onResize={vi.fn()}
    />
  )
}

function renderPanel(config: Record<string, unknown> = leadValidationFixtureConfig()) {
  const onUpdate = vi.fn()
  render(<Harness initial={config} onUpdate={onUpdate} />)
  return { onUpdate }
}

/** The config the last edit wrote. */
const written = (onUpdate: ReturnType<typeof vi.fn>) => (onUpdate.mock.calls.at(-1)![1] as { config: { checks: StoredCheck[]; lead_id_field: string } }).config

const list = () => screen.getByRole('list', { name: 'Checks, in order' })
const rows = () => within(list()).getAllByRole('button')
const row = (n: number) => rows()[n - 1]
const editor = () => screen.getByRole('group', { name: /^Check \d+ of \d+$/ })

describe('the checks list (D1 to D3, D8)', () => {
  it('lists every check in order by its number, name and short condition', () => {
    renderPanel()
    expect(rows().map((r) => r.textContent)).toEqual([
      '1Bidding is onbiddingActive is true',
      '2State is allowedstate in list states',
      '3Name has lettersfirstName contains a letter and 1 more',
      '4Loan within maximumloanAmount ≤ maximumLoanAmount',
      '5Not militaryemploymentStatus ≠ military',
      '6Self employedemploymentStatus = self_employed',
      '7Phone givenprimaryPhone is not empty',
    ])
  })

  it('opens the first check, and marks the row it opened as the current one', () => {
    renderPanel()
    expect(row(1)).toHaveAttribute('aria-current', 'true')
    fireEvent.click(row(3))
    expect(row(3)).toHaveAttribute('aria-current', 'true')
    expect(rows().filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1)
  })

  it('adds a blank check at the end and opens it', () => {
    const { onUpdate } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Add check' }))
    const checks = written(onUpdate).checks
    expect(checks).toHaveLength(8)
    expect(checks[7]).toMatchObject({ id: 'check_8', label: '', reason: '', on_missing: 'reject' })
    expect(within(editor()).getByText('Check 8 of 8')).toBeInTheDocument()
  })

  it('says so when the step has no checks yet', () => {
    renderPanel({ lead_id_field: 'trigger.payload.leadUuid', checks: [] })
    expect(screen.getByText('No checks yet.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /^Check / })).toBeNull()
  })
})

describe('the chosen check (D4 to D7, D13, D14)', () => {
  it('says which check it holds and edits its name', () => {
    const { onUpdate } = renderPanel()
    fireEvent.click(row(3))
    expect(within(editor()).getByText('Check 3 of 7')).toBeInTheDocument()
    const name = within(editor()).getByRole('textbox', { name: 'Check name' })
    expect(name).toHaveValue('Name has letters')
    fireEvent.change(name, { target: { value: 'Names have letters' } })
    expect(written(onUpdate).checks[2].label).toBe('Names have letters')
  })

  it('moves the check up and down, and removes it, keeping the rest in order', () => {
    const { onUpdate } = renderPanel()
    fireEvent.click(row(3))
    const labels = () => written(onUpdate).checks.map((c) => c.label)
    fireEvent.click(within(editor()).getByRole('button', { name: 'Move up' }))
    expect(labels().slice(0, 3)).toEqual(['Bidding is on', 'Name has letters', 'State is allowed'])
    expect(within(editor()).getByText('Check 2 of 7')).toBeInTheDocument()
    fireEvent.click(within(editor()).getByRole('button', { name: 'Move down' }))
    fireEvent.click(within(editor()).getByRole('button', { name: 'Move down' }))
    expect(labels().slice(1, 4)).toEqual(['State is allowed', 'Loan within maximum', 'Name has letters'])
    expect(within(editor()).getByText('Check 4 of 7')).toBeInTheDocument()
    fireEvent.click(within(editor()).getByRole('button', { name: 'Remove check' }))
    expect(labels()).toEqual(['Bidding is on', 'State is allowed', 'Loan within maximum', 'Not military', 'Self employed', 'Phone given'])
    expect(within(editor()).getByText('Check 4 of 6')).toBeInTheDocument()
    expect(within(editor()).getByRole('textbox', { name: 'Check name' })).toHaveValue('Not military')
  })

  it('cannot move the first check up or the last one down', () => {
    renderPanel()
    expect(within(editor()).getByRole('button', { name: 'Move up' })).toBeDisabled()
    fireEvent.click(row(7))
    expect(within(editor()).getByRole('button', { name: 'Move down' })).toBeDisabled()
  })

  it('edits the condition with the rule builder', () => {
    const { onUpdate } = renderPanel()
    fireEvent.click(row(3))
    expect(within(editor()).getAllByRole('button', { name: 'Remove condition' })).toHaveLength(2)
    fireEvent.click(within(editor()).getByRole('button', { name: 'Add condition' }))
    expect(written(onUpdate).checks[2].condition.groups[0].conditions).toHaveLength(3)
  })

  it('picks the reason from the one list, never a text box', () => {
    const { onUpdate } = renderPanel()
    fireEvent.click(row(3))
    const reason = within(editor()).getByRole('combobox', { name: 'Rejects with' })
    expect(readSelect(reason)).toMatchObject({ shown: 'invalid name', options: [...LEAD_REJECTION_REASONS] })
    chooseOption(reason, 'missing phone')
    expect(written(onUpdate).checks[2].reason).toBe('missing phone')
  })

  it('picks what a lead missing a value does, in the settled words', () => {
    const { onUpdate } = renderPanel()
    const missing = within(editor()).getByRole('combobox', { name: 'If the lead has no value' })
    expect(readSelect(missing)).toMatchObject({ shown: 'Reject with this reason', options: LEAD_VALIDATION_FIXTURE.missing.map((m) => m.label) })
    chooseOption(missing, 'Fail the run')
    expect(written(onUpdate).checks[0].on_missing).toBe('fail_run')
  })

  it('shows a blank check unfinished: no reason chosen yet', () => {
    renderPanel({ lead_id_field: '', checks: [{ id: 'check_1', label: '', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: '', operator: 'eq', value: '' }] }] }, reason: '', on_missing: 'reject' }] })
    expect(within(editor()).getByRole('combobox', { name: 'Rejects with' })).toHaveTextContent('Choose a reason')
    expect(row(1)).toHaveTextContent('1Unnamed checkno condition yet')
  })
})

describe('the rest of the panel (D12, D15)', () => {
  it('edits the lead id field, ahead of the checks, saying what it is for', () => {
    const { onUpdate } = renderPanel()
    const box = screen.getByRole('textbox', { name: 'Lead id field' })
    expect(box).toHaveValue('trigger.payload.leadUuid')
    expect(box).toHaveAccessibleDescription('Sent back as lead_id when a lead is rejected.')
    fireEvent.change(box, { target: { value: 'trigger.payload.id' } })
    expect(written(onUpdate).lead_id_field).toBe('trigger.payload.id')
  })

  it('keeps Advanced collapsed', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Retries')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByText('Retries')).toBeInTheDocument()
  })
})
