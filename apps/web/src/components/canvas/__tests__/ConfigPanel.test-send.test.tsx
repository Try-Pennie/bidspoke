/**
 * The tick box before a test that sends for real (#2339; settled in
 * docs/design/app-action-test-send.html): an App Action step whose action
 * changes something in its service shows, above the test buttons, a tick box
 * naming what the test sends and the connection it sends from. Run cold waits
 * for the tick, the tick is sent as confirm_send on that one test and cleared
 * after it, and a read shows none.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ConfigPanel from '../ConfigPanel'
import { ConnectionListProvider } from '../connection-names'
import type { ConnectionList } from '@/lib/api'

vi.mock('next/dynamic', () => ({ default: () => function MockMonaco() { return <div /> } }))
vi.mock('@/lib/api', () => ({
  api: {
    connections: { list: vi.fn().mockRejectedValue(new Error('not in this test')) },
    partners: { list: vi.fn().mockResolvedValue([]) },
    executions: {
      stepDurationStats: vi.fn().mockResolvedValue({
        p50: null, p95: null, p99: null, max_ms: null, sample_size: 0, suggested_ms: null, floor_ms: null, floor_reason: null,
        window_days: 7, source: 'history', subtype: null, retries_assumed: 2,
      }),
    },
  },
}))

type PanelProps = React.ComponentProps<typeof ConfigPanel>
const CONN = '00000000-0000-4000-8000-0000000023c1'
const LIST = { connections: [{ id: CONN, name: 'Ops mailbox' }], statuses: { as_of: null, stale: false, unavailable: null } } as unknown as ConnectionList
const WORDS = 'Send for real. This sends a real email from Ops mailbox. It cannot be taken back.'

function step(action: string, id = 'n1', namespace = 'send_welcome_email'): PanelProps['node'] {
  return {
    id, type: 'app_action', position: { x: 0, y: 0 },
    data: { label: 'Send welcome email', namespace, config: { service: 'google', action, actionVersion: 1, connection: CONN, args: {} } },
  } as unknown as PanelProps['node']
}

function panel(node: PanelProps['node'], onNodeTest: PanelProps['onNodeTest'], load: () => Promise<ConnectionList>, canBuildFromRun = false) {
  return (
    <ConnectionListProvider load={load}>
      <ConfigPanel node={node} onClose={vi.fn()} nodeNamespaces={[]} width={320} onResize={vi.fn()} onNodeTest={onNodeTest} canBuildFromRun={canBuildFromRun} />
    </ConnectionListProvider>
  )
}

function renderTest(action: string, load: () => Promise<ConnectionList> = async () => LIST, canBuildFromRun = false) {
  const onNodeTest = vi.fn().mockResolvedValue(undefined)
  const view = render(panel(step(action), onNodeTest, load, canBuildFromRun))
  fireEvent.click(screen.getByText('Test this node'))
  return { onNodeTest, view }
}

describe('testing a step that sends for real', () => {
  it('asks first with a tick box naming what it sends and the connection, and Run cold waits for it', async () => {
    renderTest('google.gmail-send-email')
    const tick = await screen.findByRole('checkbox', { name: WORDS })
    expect(tick).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: /Run cold/ })).toBeDisabled()
    fireEvent.click(tick)
    expect(tick).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: /Run cold/ })).toBeEnabled()
  })

  it('sends the agreement with that one test, then clears it, so the next real send is agreed to again', async () => {
    const { onNodeTest } = renderTest('google.gmail-send-email')
    fireEvent.click(await screen.findByRole('checkbox', { name: WORDS }))
    fireEvent.click(screen.getByRole('button', { name: /Run cold/ }))
    await waitFor(() => expect(onNodeTest).toHaveBeenCalledTimes(1))
    expect(onNodeTest).toHaveBeenCalledWith('send_welcome_email', { triggerPayload: {}, useLastRun: false, confirmSend: true })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: WORDS })).toHaveAttribute('aria-checked', 'false'))
    expect(screen.getByRole('button', { name: /Run cold/ })).toBeDisabled()
  })

  // An agreement is to one step's send: a tick given on one step must never let
  // another step's test send for real (lessons review of the tick box branch).
  it('clears the tick when another step is opened, so its send is agreed to on its own', async () => {
    const { onNodeTest, view } = renderTest('google.gmail-send-email')
    fireEvent.click(await screen.findByRole('checkbox', { name: WORDS }))
    expect(screen.getByRole('checkbox', { name: WORDS })).toHaveAttribute('aria-checked', 'true')
    view.rerender(panel(step('google.gmail-send-email', 'n2', 'send_reminder_email'), onNodeTest, async () => LIST))
    if (!screen.queryByRole('checkbox', { name: WORDS })) fireEvent.click(screen.getByText('Test this node'))
    expect(await screen.findByRole('checkbox', { name: WORDS })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('button', { name: /Run cold/ })).toBeDisabled()
  })

  it('Build from run, which sends for real too, waits for the tick as Run cold does', async () => {
    const { onNodeTest } = renderTest('google.gmail-send-email', async () => LIST, true)
    const tick = await screen.findByRole('checkbox', { name: WORDS })
    expect(screen.getByRole('button', { name: /Build from run/ })).toBeDisabled()
    fireEvent.click(tick)
    fireEvent.click(screen.getByRole('button', { name: /Build from run/ }))
    await waitFor(() => expect(onNodeTest).toHaveBeenCalledWith('send_welcome_email', { triggerPayload: {}, useLastRun: true, confirmSend: true }))
  })

  it('names this step\'s connection when the list cannot be read, never another', async () => {
    renderTest('google.gmail-send-email', async () => { throw new Error('refused') })
    expect(await screen.findByRole('checkbox', { name: 'Send for real. This sends a real email from this step\'s connection. It cannot be taken back.' })).toBeInTheDocument()
  })

  it('a read asks nothing: no tick box, and Run cold works at once', async () => {
    const { onNodeTest } = renderTest('google.drive-list-files')
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Run cold/ }))
    await waitFor(() => expect(onNodeTest).toHaveBeenCalledWith('send_welcome_email', { triggerPayload: {}, useLastRun: false, confirmSend: false }))
  })
})
