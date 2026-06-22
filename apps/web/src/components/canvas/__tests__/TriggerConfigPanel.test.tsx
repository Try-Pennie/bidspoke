import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TriggerConfigPanel from '../TriggerConfigPanel'
import type { TriggerDef } from '@/types/workflow'

vi.mock('@/lib/api', () => ({
  api: {
    endpoints: { list: vi.fn().mockResolvedValue([]) },
    sources: {
      list: vi.fn().mockResolvedValue([]),
      listAssignments: vi.fn().mockResolvedValue([]),
      assignWorkflow: vi.fn().mockResolvedValue(undefined),
      unassignWorkflow: vi.fn().mockResolvedValue(undefined),
    },
  },
}))
// Child forms only render when adding; stub to keep the tree light.
vi.mock('@/components/forms/EndpointCreateForm', () => ({ default: () => null }))
vi.mock('@/components/forms/SourceCreateForm', () => ({ default: () => null }))

const baseTrigger: TriggerDef = {
  type: 'http_webhook',
  config: { method: 'POST', auth_method: 'api_key' },
}

function renderPanel(trigger: TriggerDef = baseTrigger) {
  const onChange = vi.fn()
  render(
    <TriggerConfigPanel
      workflowId="wf-1"
      workflowName="Main Flow"
      trigger={trigger}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  )
  return { onChange }
}

beforeEach(() => vi.clearAllMocks())

describe('TriggerConfigPanel — muted failure signals (#248)', () => {
  it('adds a muted failure signal row via onChange', async () => {
    const { onChange } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: /add muted signal/i }))
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const next = onChange.mock.calls.at(-1)![0] as TriggerDef
    expect(next.config.muted_failure_signals).toHaveLength(1)
  })

  it('edits the match string of an existing signal', async () => {
    const trigger: TriggerDef = {
      type: 'http_webhook',
      config: {
        method: 'POST',
        auth_method: 'api_key',
        muted_failure_signals: [{ match: '', count: 10, window_minutes: 5 }],
      },
    }
    const { onChange } = renderPanel(trigger)
    fireEvent.change(await screen.findByPlaceholderText(/error contains/i), {
      target: { value: 'ACRO_GATEWAY' },
    })
    const next = onChange.mock.calls.at(-1)![0] as TriggerDef
    expect(next.config.muted_failure_signals![0].match).toBe('ACRO_GATEWAY')
  })

  it('removes a signal', async () => {
    const trigger: TriggerDef = {
      type: 'http_webhook',
      config: {
        method: 'POST',
        auth_method: 'api_key',
        muted_failure_signals: [{ match: 'ACRO_GATEWAY', count: 10, window_minutes: 5 }],
      },
    }
    const { onChange } = renderPanel(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /remove muted signal/i }))
    const next = onChange.mock.calls.at(-1)![0] as TriggerDef
    expect(next.config.muted_failure_signals).toHaveLength(0)
  })
})
