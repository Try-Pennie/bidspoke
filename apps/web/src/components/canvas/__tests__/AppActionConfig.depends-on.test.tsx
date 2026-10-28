/**
 * A dropdown argument whose lookup reads other arguments (`dependsOn`, #2782):
 * while any of them is empty the form sends no lookup, and once all are filled
 * it sends exactly their values in the order `dependsOn` names them. A dropdown
 * with no `dependsOn` is read at once. No catalogue action declares `dependsOn`
 * yet, so the pinned action's schema is stood in for here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { ActionSchema } from '@bidspoke/service-catalogue/schema'
import { AppActionConfig } from '../AppActionConfig'
import { ConnectionListProvider } from '../connection-names'
import { api, type ConnectionList } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    workflows: { testResult: vi.fn() },
    connections: { list: vi.fn(), lookup: vi.fn() },
  },
  CONNECTIONS_LIST_TIMEOUT_MS: 15_000,
}))

const SCHEMA = {
  key: 'google.sheets-add-row',
  name: 'Sheets: add a row',
  version: 1,
  sideEffect: true,
  idempotent: false,
  arguments: [
    { key: 'spreadsheet', type: 'dropdown', required: true, allowsVariables: false, parseJson: false, source: { lookup: 'spreadsheets' } },
    { key: 'tab', type: 'text', required: true, allowsVariables: false, parseJson: false },
    { key: 'column', type: 'dropdown', required: true, allowsVariables: false, parseJson: false, source: { lookup: 'columns' }, dependsOn: ['tab', 'spreadsheet'] },
  ],
} as unknown as ActionSchema

vi.mock('@/lib/app-action-display', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/app-action-display')>()
  return { ...actual, appActionSchema: () => SCHEMA }
})

const CONN = '00000000-0000-4000-8000-0000000023c1'
const LIST = { connections: [], statuses: { as_of: null, stale: false, unavailable: null } } as unknown as ConnectionList

function form(args: Record<string, unknown>) {
  return (
    <ConnectionListProvider load={async () => LIST}>
      <AppActionConfig
        config={{ service: 'google', action: SCHEMA.key, actionVersion: 1, connection: CONN, args }}
        onChange={() => {}}
        workflowId="wf-1"
        upstream={[]}
        triggerPayload={{}}
        refs={[]}
      />
    </ConnectionListProvider>
  )
}

const lookupsFor = (key: string) => vi.mocked(api.connections.lookup).mock.calls.filter((c) => c[1] === key)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.connections.lookup).mockResolvedValue({ answer: { key: 'objects', entries: [] } })
})

describe('a dropdown whose lookup reads other fields', () => {
  it('sends no lookup while a field it reads is empty, then sends their values in dependsOn order', async () => {
    const view = render(form({ spreadsheet: 'sheet-1' }))
    await waitFor(() => expect(lookupsFor('spreadsheets')).toHaveLength(1))
    expect(lookupsFor('columns')).toHaveLength(0)

    view.rerender(form({ spreadsheet: 'sheet-1', tab: 'Leads' }))
    await waitFor(() => expect(lookupsFor('columns')).toHaveLength(1))
    expect(lookupsFor('columns')[0]).toEqual([CONN, 'columns', ['Leads', 'sheet-1']])
  })

  it('reads a dropdown with no dependsOn at once, with no parents', async () => {
    render(form({}))
    await waitFor(() => expect(lookupsFor('spreadsheets')).toHaveLength(1))
    expect(lookupsFor('spreadsheets')[0]).toEqual([CONN, 'spreadsheets', []])
    expect(lookupsFor('columns')).toHaveLength(0)
    expect(screen.getByLabelText('Column (required)')).toBeDisabled()
    expect(screen.getByLabelText('Spreadsheet (required)')).not.toBeDisabled()
  })
})
