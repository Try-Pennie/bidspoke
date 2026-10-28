/**
 * The earlier App Action steps ConfigPanel hands the App Action form (#2782):
 * worked out once for a given step, nodes and edges, so a re-render of the
 * panel with the same nodes and edges hands the form the same array, and the
 * form's picker groups and autocomplete paths, which read it, are not rebuilt
 * on every render of the panel.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'
import { ConnectionListProvider } from '../connection-names'
import type { UpstreamStep } from '../AppActionConfig'
import type { ConnectionList } from '@/lib/api'

const handed: (readonly UpstreamStep[])[] = []

vi.mock('../AppActionConfig', () => ({
  AppActionConfig: ({ upstream }: { upstream: readonly UpstreamStep[] }) => { handed.push(upstream); return null },
}))
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
const LIST = { connections: [], statuses: { as_of: null, stale: false, unavailable: null } } as unknown as ConnectionList

const NODE = {
  id: 'n2', type: 'app_action', position: { x: 0, y: 0 },
  data: { label: 'Send welcome email', namespace: 'send_welcome_email', config: { service: 'google', action: 'google.gmail-send-email', actionVersion: 1, args: {} } },
} as unknown as PanelProps['node']
const NODE_OPTIONS = [
  { id: 'n1', namespace: 'find_lead', label: 'Find lead', type: 'app_action' },
  { id: 'n2', namespace: 'send_welcome_email', label: 'Send welcome email', type: 'app_action' },
]
const EDGES = [{ id: 'e1', source: 'n1', target: 'n2' }]

function panel(edges: PanelProps['edges'], nodeOptions: PanelProps['nodeOptions'], width = 320) {
  return (
    <ConnectionListProvider load={async () => LIST}>
      <ConfigPanel node={NODE} onClose={vi.fn()} nodeNamespaces={[]} nodeOptions={nodeOptions} edges={edges} width={width} onResize={vi.fn()} />
    </ConnectionListProvider>
  )
}

describe('the earlier steps the App Action form is handed', () => {
  it('is the same array on a re-render with the same nodes and edges', () => {
    handed.length = 0
    const view = render(panel(EDGES, NODE_OPTIONS))
    view.rerender(panel(EDGES, NODE_OPTIONS, 400))
    expect(handed.length).toBeGreaterThanOrEqual(2)
    expect(handed[0]).toEqual([{ id: 'n1', namespace: 'find_lead', label: 'Find lead' }])
    expect(handed[handed.length - 1]).toBe(handed[0])
  })

  it('is the same array on a re-render when the caller leaves out the nodes and edges', () => {
    handed.length = 0
    const view = render(panel(undefined, undefined))
    view.rerender(panel(undefined, undefined, 400))
    expect(handed.length).toBeGreaterThanOrEqual(2)
    expect(handed[0]).toEqual([])
    expect(handed[handed.length - 1]).toBe(handed[0])
  })

  it('is worked out again when the edges change', () => {
    handed.length = 0
    const view = render(panel(EDGES, NODE_OPTIONS))
    view.rerender(panel([], NODE_OPTIONS))
    expect(handed[handed.length - 1]).toEqual([])
    expect(handed[handed.length - 1]).not.toBe(handed[0])
  })
})
