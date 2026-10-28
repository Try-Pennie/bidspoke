/**
 * The settled design for an earlier step whose test answer was too big to keep (#2882,
 * docs/design/insert-too-big-answer.html): D1's check passes on the Insert list as AppActionConfig
 * draws it. lib/__tests__/insert-too-big-answer-settled-design.test.ts holds its checks to its map.
 *
 * The development preview has no picker-too-big frame: drawing one needs an earlier App Action step
 * on the preview canvas, which changes the captured picture, and a kept test result served without
 * network. So D1's check is run here, on the component, and fails on the sentence it replaced (L1).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { AppActionConfig } from '../AppActionConfig'
import { ConnectionListProvider } from '../connection-names'
import { api, type ConnectionList, type StepTestResult } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    workflows: { testResult: vi.fn() },
    connections: { list: vi.fn(), lookup: vi.fn() },
  },
  CONNECTIONS_LIST_TIMEOUT_MS: 15_000,
}))

type RunnableCheck = { id: string; frames: string[]; check: (doc: Document) => { ok: boolean; detail: string } }

function d1(): RunnableCheck {
  const sandbox: { window: { DESIGN_CHECKS?: RunnableCheck[] } } = { window: {} }
  vm.runInNewContext(readFileSync(path.resolve(__dirname, '../../../../../../docs/design/insert-too-big-answer.checks.js'), 'utf8'), sandbox)
  const check = sandbox.window.DESIGN_CHECKS?.find((c) => c.id === 'D1')
  if (!check) throw new Error('no D1 check')
  return check
}

const LIST = { connections: [], statuses: { as_of: null, stale: false, unavailable: null } } as unknown as ConnectionList
const GMAIL = { service: 'google', action: 'google.gmail-send-email', actionVersion: 1, args: {} }

async function openWithFindLead(result: StepTestResult) {
  vi.mocked(api.workflows.testResult).mockResolvedValueOnce({ result })
  render(
    <ConnectionListProvider load={async () => LIST}>
      <AppActionConfig config={GMAIL} onChange={() => {}} workflowId="wf-1" upstream={[{ id: 'a', namespace: 'find_lead', label: 'Find lead' }]} triggerPayload={{ email: 'maria.lopez@example.com' }} refs={[]} />
    </ConnectionListProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Insert a value into To' }))
  const group = within(screen.getByRole('listbox')).getByRole('group', { name: 'From Find lead' })
  await waitFor(() => expect(group).not.toHaveTextContent(/Reading/))
}

const finished = (over: Partial<StepTestResult>): StepTestResult => ({
  node_id: 'a', namespace: 'find_lead', tested_at: '', status: 'completed', output: null, output_bytes: null, output_dropped: false, error: null, duration_ms: 1, ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('the settled design for a test answer too big to keep (#2882)', () => {
  it('D1 passes on the Insert list the step form draws for a dropped answer', async () => {
    await openWithFindLead(finished({ output_bytes: 412_000, output_dropped: true }))
    expect(d1().check(document)).toEqual({ ok: true, detail: 'Its last test answered more than 160 KB, too much to keep, so it has no values.' })
  })

  it('D1 fails on the sentence it replaced', async () => {
    await openWithFindLead(finished({ status: 'failed', error: 'Refused.' }))
    expect(d1().check(document).ok).toBe(false)
  })
})
