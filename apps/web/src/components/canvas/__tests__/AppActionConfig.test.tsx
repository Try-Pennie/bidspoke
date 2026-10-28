/**
 * The App Action step's settings form (#2338; settled in
 * docs/design/app-action-step-form.html): Service then Action from the
 * catalogue, the Connection field, the pinned action's fields with "(required)"
 * where the catalogue says so, and the data picker each field's Insert button
 * opens, whose paths are inserted at the cursor and extend the field's {{
 * autocomplete.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { AppActionConfig, LookupDropdown, type UpstreamStep } from '../AppActionConfig'
import { ConnectionListProvider } from '../connection-names'
import { insertReference } from '../DataPicker'
import { api, type ConnectionList, type StepTestResult } from '@/lib/api'

vi.mock('@/lib/api', () => ({
  api: {
    workflows: { testResult: vi.fn() },
    connections: { list: vi.fn(), lookup: vi.fn() },
  },
  CONNECTIONS_LIST_TIMEOUT_MS: 15_000,
}))

const CONN = '00000000-0000-4000-8000-0000000023c1'
const LIST = {
  connections: [{ id: CONN, name: 'Ops mailbox', service: 'google', service_name: 'Google', acts_as: 'ops@trypennie.com', status: 'ok', status_word: 'Working', alert_login: false, person_bound: false, owner: null, target: null, health: null, used_by: 1, workflows: [], created_at: '', updated_at: '' }],
  statuses: { as_of: null, stale: false, unavailable: null },
} as unknown as ConnectionList
const GMAIL = { service: 'google', action: 'google.gmail-send-email', actionVersion: 1, connection: CONN, args: { subject: 'Welcome' } }
const PAYLOAD = { email: 'maria.lopez@example.com', first_name: 'Maria' }

function Harness({ initial, upstream = [], refs = ['trigger.payload'], onConfig, workflowId = 'wf-1' }: {
  initial: Record<string, unknown>
  upstream?: UpstreamStep[]
  refs?: string[]
  onConfig?: (c: Record<string, unknown>) => void
  /** null for a workflow not yet saved. */
  workflowId?: string | null
}) {
  const [config, setConfig] = useState(initial)
  return (
    <ConnectionListProvider load={async () => LIST}>
      <AppActionConfig
        config={config}
        onChange={(patch) => setConfig((c) => { const next = { ...c, ...patch }; onConfig?.(next); return next })}
        workflowId={workflowId ?? undefined}
        upstream={upstream}
        triggerPayload={PAYLOAD}
        refs={refs}
      />
    </ConnectionListProvider>
  )
}

beforeEach(() => { vi.clearAllMocks() })

describe('what the step runs', () => {
  it('reads as Service then Action, each required, then the connection and the action\'s own fields in the catalogue\'s order', async () => {
    render(<Harness initial={GMAIL} />)
    expect(screen.getByLabelText('Service (required)')).toHaveTextContent('Gmail')
    expect(screen.getByLabelText('Action (required)')).toHaveTextContent('Send an email')
    expect(await screen.findByText('Acts as ops@trypennie.com')).toBeInTheDocument()
    const labels = screen.getAllByText(/^(To|Cc|Bcc|Subject|Body|Body type)( \(required\))?$/).map((e) => e.textContent)
    expect(labels).toEqual(['To', 'Cc', 'Bcc', 'Subject', 'Body (required)', 'Body type'])
  })

  it('a step with nothing chosen asks for a service, and shows no connection or fields yet', () => {
    render(<Harness initial={{}} />)
    expect(screen.getByLabelText('Service (required)')).toHaveTextContent('Choose a service')
    expect(screen.getByLabelText('Action (required)')).toBeDisabled()
    expect(screen.queryByText('Connection (required)')).toBeNull()
  })
})

describe('the data picker', () => {
  it('opens under To from its Insert button, headed From Trigger, each value with its sample', () => {
    render(<Harness initial={GMAIL} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert a value into To' }))
    const list = screen.getByRole('listbox', { name: 'Values from earlier steps' })
    expect(within(list).getByText('From Trigger')).toBeInTheDocument()
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Emailmaria.lopez@example.com', 'First nameMaria'])
  })

  it('inserts {{path}} where the cursor was, and closes', async () => {
    const seen: Array<Record<string, unknown>> = []
    render(<Harness initial={GMAIL} onConfig={(c) => seen.push(c)} />)
    const subject = screen.getByLabelText('Subject') as HTMLInputElement
    subject.setSelectionRange(3, 3)
    fireEvent.click(screen.getByRole('button', { name: 'Insert a value into Subject' }))
    fireEvent.mouseDown(screen.getByRole('option', { name: /First name/ }))
    expect(seen.at(-1)?.args).toMatchObject({ subject: 'Wel{{trigger.payload.first_name}}come' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves with the arrow keys and chooses with Enter, and Escape closes it', () => {
    const seen: Array<Record<string, unknown>> = []
    render(<Harness initial={GMAIL} onConfig={(c) => seen.push(c)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert a value into To' }))
    const list = screen.getByRole('listbox')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'Enter' })
    expect(seen.at(-1)?.args).toMatchObject({ to: '{{trigger.payload.first_name}}' })
    fireEvent.click(screen.getByRole('button', { name: 'Insert a value into To' }))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('offers each earlier step\'s kept test result, says when a step has none, and shows a read that failed inside the list with Try again', async () => {
    vi.mocked(api.workflows.testResult)
      .mockResolvedValueOnce({ result: { node_id: 'a', namespace: 'find_lead', tested_at: '', status: 'completed', output: { lead: { id: 7 } }, output_bytes: 10, output_dropped: false, error: null, duration_ms: 1 } })
      .mockResolvedValueOnce({ result: null })
      .mockRejectedValueOnce(new Error('503'))
    const upstream = [{ id: 'a', namespace: 'find_lead', label: 'Find lead' }, { id: 'b', namespace: 'untested' }, { id: 'c', namespace: 'broken', label: 'Broken' }]
    render(<Harness initial={GMAIL} upstream={upstream} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert a value into To' }))
    const list = screen.getByRole('listbox')
    expect(await within(list).findByText('Lead id')).toBeInTheDocument()
    expect(within(list).getByText('From Find lead')).toBeInTheDocument()
    expect(within(list).getByText('No test in the last 7 days. Test the step to pick its values.')).toBeInTheDocument()
    expect(within(list).getByText('Broken\'s last test could not be read.')).toBeInTheDocument()
    vi.mocked(api.workflows.testResult).mockResolvedValueOnce({ result: null })
    fireEvent.click(within(list).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(api.workflows.testResult).toHaveBeenCalledTimes(4))
    expect(vi.mocked(api.workflows.testResult).mock.calls.map((c) => c[1])).toEqual(['a', 'b', 'c', 'c'])
  })

  // What an earlier step's group says when its last test left no values (#2882, docs/design/insert-too-big-answer.html):
  // an answer too big to keep, an answer of nothing, and a test that did not finish are three different facts (L11).
  describe('an earlier step whose last test left no values', () => {
    const FIND_LEAD = [{ id: 'a', namespace: 'find_lead', label: 'Find lead' }]
    const tested = (over: Partial<StepTestResult>): { result: StepTestResult } => ({
      result: { node_id: 'a', namespace: 'find_lead', tested_at: '', status: 'completed', output: null, output_bytes: null, output_dropped: false, error: null, duration_ms: 1, ...over },
    })
    async function groupFor(answer: { result: StepTestResult }) {
      vi.mocked(api.workflows.testResult).mockResolvedValueOnce(answer)
      render(<Harness initial={GMAIL} upstream={FIND_LEAD} />)
      fireEvent.click(screen.getByRole('button', { name: 'Insert a value into To' }))
      const group = within(screen.getByRole('listbox')).getByRole('group', { name: 'From Find lead' })
      await waitFor(() => expect(group).not.toHaveTextContent(/Reading/))
      return group
    }

    it('names the size kept when its finished test answered more than Bidspoke keeps', async () => {
      const group = await groupFor(tested({ output_bytes: 412_000, output_dropped: true }))
      expect(within(group).getByText('Its last test answered more than 160 KB, too much to keep, so it has no values.')).toBeInTheDocument()
      expect(within(group).queryByText(/did not finish/)).toBeNull()
    })

    it('says a finished test that answered nothing answered no values, never that it did not finish', async () => {
      const group = await groupFor(tested({ output: null, output_dropped: false }))
      expect(within(group).getByText('Its last test answered no values.')).toBeInTheDocument()
      expect(within(group).queryByText(/did not finish/)).toBeNull()
    })

    it('says did not finish only of a test that failed', async () => {
      const group = await groupFor(tested({ status: 'failed', error: 'Gmail refused the send.' }))
      expect(within(group).getByText('Its last test did not finish, so it has no values.')).toBeInTheDocument()
    })
  })

  // A workflow not yet saved has no kept tests to read: say so, never "Reading" for ever (L10).
  it('says an unsaved workflow\'s earlier steps have no test, rather than reading for ever', () => {
    render(<Harness initial={GMAIL} upstream={[{ id: 'a', namespace: 'find_lead', label: 'Find lead' }]} workflowId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert a value into To' }))
    const list = screen.getByRole('listbox')
    expect(within(list).getByText('No test in the last 7 days. Test the step to pick its values.')).toBeInTheDocument()
    expect(within(list).queryByText(/Reading/)).toBeNull()
    expect(api.workflows.testResult).not.toHaveBeenCalled()
  })

  it('extends the field\'s {{ autocomplete with the picker\'s paths, keeping what it offered before', () => {
    render(<Harness initial={GMAIL} refs={['trigger.payload', 'env.KEY']} />)
    const to = screen.getByLabelText('To') as HTMLInputElement
    fireEvent.change(to, { target: { value: '{{', selectionStart: 2 } })
    const offered = screen.getAllByRole('option').map((o) => o.textContent)
    expect(offered).toEqual(expect.arrayContaining(['{{trigger.payload}}', '{{env.KEY}}', '{{trigger.payload.email}}', '{{trigger.payload.first_name}}']))
  })
})

describe('a field filled by a lookup on the connection', () => {
  it('lists what the lookup found, through POST /api/connections/:id/lookup/:key with its parents', async () => {
    vi.mocked(api.connections.lookup).mockResolvedValue({ answer: { key: 'objects', entries: [{ name: 'Lead', label: 'Lead' }, { name: 'Contact', label: 'Contact' }] } })
    render(<LookupDropdown id="obj" lookup="objects" connection={CONN} parents={['x']} value="" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(await screen.findByRole('option', { name: 'Contact' })).toBeInTheDocument()
    expect(api.connections.lookup).toHaveBeenCalledWith(CONN, 'objects', ['x'])
  })

  it('shows a lookup that failed inside the dropdown, never as an empty list (L10)', async () => {
    vi.mocked(api.connections.lookup).mockRejectedValue(new Error('Salesforce did not answer.'))
    render(<LookupDropdown id="obj" lookup="objects" connection={CONN} parents={[]} value="" onChange={() => {}} />)
    fireEvent.click(screen.getByRole('combobox'))
    expect(await screen.findByText('Salesforce did not answer.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument()
  })

  it('waits for a connection before it can be read', () => {
    render(<LookupDropdown id="obj" lookup="objects" connection={null} parents={[]} value="" onChange={() => {}} />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(api.connections.lookup).not.toHaveBeenCalled()
  })

  // #2782: a parent not filled yet is not "no parent", so the lookup waits for it.
  it('waits for a parent not filled yet, then reads with exactly the parents once they are', async () => {
    vi.mocked(api.connections.lookup).mockResolvedValue({ answer: { key: 'fields', parent: 'Lead', fields: [{ name: 'Email', label: 'Email', type: 'string' }] } })
    const view = render(<LookupDropdown id="f" lookup="fields" connection={CONN} parents={['Lead', '']} value="" onChange={() => {}} />)
    expect(screen.getByRole('combobox')).toBeDisabled()
    expect(screen.getByRole('combobox')).toHaveTextContent('Choose one')
    await new Promise((r) => setTimeout(r, 0))
    expect(api.connections.lookup).not.toHaveBeenCalled()

    view.rerender(<LookupDropdown id="f" lookup="fields" connection={CONN} parents={['Lead', 'Business']} value="" onChange={() => {}} />)
    await waitFor(() => expect(api.connections.lookup).toHaveBeenCalledTimes(1))
    expect(api.connections.lookup).toHaveBeenCalledWith(CONN, 'fields', ['Lead', 'Business'])
    expect(screen.getByRole('combobox')).not.toBeDisabled()
  })

  it('reads at once when it has no parents', async () => {
    vi.mocked(api.connections.lookup).mockResolvedValue({ answer: { key: 'objects', entries: [] } })
    render(<LookupDropdown id="obj" lookup="objects" connection={CONN} parents={[]} value="" onChange={() => {}} />)
    await waitFor(() => expect(api.connections.lookup).toHaveBeenCalledTimes(1))
    expect(api.connections.lookup).toHaveBeenCalledWith(CONN, 'objects', [])
    expect(screen.getByRole('combobox')).not.toBeDisabled()
  })
})

describe('insertReference', () => {
  it('puts {{path}} in place of the selection and moves the cursor after it', () => {
    expect(insertReference('Hello there', 'trigger.payload.name', 6, 11)).toEqual({ value: 'Hello {{trigger.payload.name}}', cursor: 30 })
    expect(insertReference('', 'a', null, null)).toEqual({ value: '{{a}}', cursor: 5 })
  })
})
