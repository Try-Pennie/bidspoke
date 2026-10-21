import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'
import { chooseOption } from '@/components/ui/__tests__/_select'
import { leadValidationFixtureConfig, LEAD_VALIDATION_FIXTURE } from '@/lib/__tests__/_lead-validation-fixture'

// A lead validation setting the panel does not draw survives every edit the
// panel makes (#2594). `include_request_id` is set in config only (Lead
// Economy's unqualified_lead check answers the run trace id as requestId), so a
// save from the panel that dropped it would change what a partner is answered
// with nothing on screen to say so. The panel is mounted through ConfigPanel, as
// the canvas opens it, and each edit is written back the way the canvas does.

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
type Written = { checks: Array<Record<string, unknown>>; lead_id_field: string; [k: string]: unknown }

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

/** The fixture with the setting on its third check, and a node level field the panel does not draw either. */
function renderPanel() {
  const base = leadValidationFixtureConfig()
  const config = { ...base, future_setting: 'kept', checks: base.checks.map((c, i) => (i === 2 ? { ...c, include_request_id: true } : c)) }
  const onUpdate = vi.fn()
  render(<Harness initial={config} onUpdate={onUpdate} />)
  return { onUpdate, label: base.checks[2].label }
}

const written = (onUpdate: ReturnType<typeof vi.fn>) => (onUpdate.mock.calls.at(-1)![1] as { config: Written }).config
const rows = () => within(screen.getByRole('list', { name: 'Checks, in order' })).getAllByRole('button')
const editor = () => screen.getByRole('group', { name: /^Check \d+ of \d+$/ })

/** The checks that hold the setting, by label: it must stay on exactly the check it was set on. */
const holders = (onUpdate: ReturnType<typeof vi.fn>) => written(onUpdate).checks.filter((c) => c.include_request_id === true).map((c) => c.label)

describe('the panel carries a setting it does not draw through every edit (#2594)', () => {
  it('editing the check that holds it: name, condition, reason and missing value choice', () => {
    const { onUpdate, label } = renderPanel()
    fireEvent.click(rows()[2])
    fireEvent.change(within(editor()).getByRole('textbox', { name: 'Check name' }), { target: { value: 'Renamed' } })
    expect(holders(onUpdate)).toEqual(['Renamed'])
    fireEvent.click(within(editor()).getByRole('button', { name: 'Add condition' }))
    expect(holders(onUpdate)).toEqual(['Renamed'])
    chooseOption(within(editor()).getByRole('combobox', { name: 'Rejects with' }), 'missing phone')
    expect(holders(onUpdate)).toEqual(['Renamed'])
    chooseOption(within(editor()).getByRole('combobox', { name: 'If the lead has no value' }), 'Fail the run')
    expect(holders(onUpdate)).toEqual(['Renamed'])
    expect(label).not.toBe('Renamed')
  })

  it('moving it, removing and adding other checks, and editing another check or the lead id field', () => {
    const { onUpdate, label } = renderPanel()
    fireEvent.click(rows()[2])
    fireEvent.click(within(editor()).getByRole('button', { name: 'Move up' }))
    expect(holders(onUpdate)).toEqual([label])
    expect(written(onUpdate).checks[1].label).toBe(label)
    fireEvent.click(rows()[0])
    fireEvent.change(within(editor()).getByRole('textbox', { name: 'Check name' }), { target: { value: 'Other' } })
    expect(holders(onUpdate)).toEqual([label])
    fireEvent.click(within(editor()).getByRole('button', { name: 'Remove check' }))
    expect(holders(onUpdate)).toEqual([label])
    fireEvent.click(screen.getByRole('button', { name: /Add check/ }))
    expect(holders(onUpdate)).toEqual([label])
    fireEvent.change(screen.getByRole('textbox', { name: 'Lead id field' }), { target: { value: 'trigger.payload.id' } })
    expect(holders(onUpdate)).toEqual([label])
    expect(written(onUpdate).future_setting).toBe('kept')
  })
})
