/**
 * The Connections page, part 2 (#2338, build PR 10), rendered: the Add
 * connection form in place of the details, its fields from the catalogue, the
 * save that checks the login (counting, stalling at its deadline, failing with
 * the route's own sentence), the saved connection chosen with no message,
 * leaving with something unsaved, and the Reconnect and Remove dialogs. The
 * clock is the test's, moved by hand.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionList, ConnectionListRow, ConnectionReplaceAnswer } from '@/lib/api'
import { CONNECTION_REMOVE_TIMEOUT_MS, CONNECTION_REPLACE_MOST, CONNECTION_REPLACE_TIMEOUT_MS, CONNECTION_SAVE_TIMEOUT_MS } from '@/lib/api'
import { keptSignInsIn } from '../google-sign-in-kept'
import { ConnectionsScreen, type ConnectionsClock, type ConnectionsSource } from '../ConnectionsScreen'
import { CHANGE_DEADLINES } from '../connections-state'
import { catalogueServices, type CreatedConnection } from '../add-form-model'
import type { DelegationEntry } from '../connection-model'
import { chooseOption, readSelect } from '@/components/ui/__tests__/_select'

vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))

const T0 = Date.parse('2026-10-20T16:00:00Z')

function manualClock() {
  let t = T0
  const timers = new Set<() => void>()
  const clock: ConnectionsClock = { now: () => t, every: (_ms, fn) => { timers.add(fn); return () => timers.delete(fn) } }
  return { clock, advance: (ms: number) => act(() => { t += ms; for (const fn of [...timers]) fn() }) }
}

const row = (over: Partial<ConnectionListRow>): ConnectionListRow => ({
  id: 'pennie', name: 'Pennie Salesforce', service: 'salesforce', service_name: 'Salesforce', alert_login: false, acts_as: 'integration@trypennie.com', person_bound: false,
  owner: null, target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'client-id-of-pennie' }, org: 'trypennie.my.salesforce.com', status: 'ok', status_word: 'Working',
  health: { ops_status: 'healthy', last_check_ok_at: '2026-10-20T15:56:00Z', last_check_failed_at: null, last_check_cause: null, needs_reauth_at: null, needs_reauth_cause: null },
  checked_at: '2026-10-20T15:56:00Z', used_by: 1, workflows: [{ id: 'w1', name: 'Lead Completed sync', deleted: false }],
  created_at: '', updated_at: '', ...over,
})

const LIST: ConnectionList = {
  connections: [
    row({}),
    row({ id: 'spare', name: 'Spare Salesforce', used_by: 0, workflows: [] }),
    row({
      id: 'achieve', name: 'Achieve Salesforce', org: 'achieve.my.salesforce.com', target: { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm' },
      status: 'reauth', status_word: 'Needs reconnecting', used_by: 1, workflows: [{ id: 'w3', name: 'Achieve report import', deleted: false }],
      health: { ops_status: 'needs_reauth', last_check_ok_at: null, last_check_failed_at: '2026-10-20T14:00:00Z', last_check_cause: null, needs_reauth_at: '2026-10-20T13:52:00Z', needs_reauth_cause: 'login_refused: invalid_client' },
    }),
  ],
  statuses: { as_of: '2026-10-20T16:00:00Z', stale: false, unavailable: null },
}

const ENTRY: DelegationEntry = { kind: 'mailbox', subject: 'ops@trypennie.com', display_name: null, added_by: 'Dan Wright', added_at: '2026-10-18T16:00:00Z' }
const CREATED: CreatedConnection = { id: 'new1', name: 'Achieve Salesforce 2', service: 'salesforce', acts_as: 'pennie.api@achieve.example', target: { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm' }, created_at: '2026-10-20T16:00:06Z' }
const REFUSED = Object.assign(new Error('connection_needs_reauth'), { status: 422, body: { error: 'connection_needs_reauth', message: 'Salesforce refused the client secret. Nothing was saved. Check the secret and save again.' } })

function source(over: Partial<ConnectionsSource> = {}): ConnectionsSource {
  return {
    list: vi.fn(async () => LIST),
    history: vi.fn(async () => ({ entries: [] })),
    googleSubjects: vi.fn(async () => ({ subjects: [ENTRY], reached_limit: false })),
    addGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    removeGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    create: vi.fn(async () => ({ connection: CREATED })),
    reconnect: vi.fn(async (id: string) => ({ outcome: 'reconnected' as const, connection: { id, acts_as: 'pennie.api@achieve.example' } })),
    remove: vi.fn(async () => ({ outcome: 'removed' as const, ops: { told: true as const } })),
    replace: vi.fn(async () => { throw new Error('not called') }),
    slackAlerts: vi.fn(async () => ({ connected: true, default_channel: '#bidspoke-alerts' })),
    updateSlackAlerts: vi.fn(async () => ({ ok: true })),
    searchSlackChannels: vi.fn(async () => ({ channels: [] })),
    startGoogleSignIn: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' })),
    goTo: vi.fn(),
    finishGoogleSignIn: vi.fn(async () => { throw new Error('not called') }),
    keptSignIns: keptSignInsIn(null),
    ...over,
  }
}

const part = (name: string) => document.querySelector(`[data-part="${name}"]`) as HTMLElement | null
const field = (label: string) => document.querySelector(`[data-part="add-form"] [data-field="${label}"]`) as HTMLElement

async function openForm(over: Partial<ConnectionsSource> = {}, clock = manualClock()) {
  const s = source(over)
  render(<ConnectionsScreen source={s} clock={clock.clock} orgNames={{ 'achieve.my.salesforce.com': 'Achieve' }} initialChosen={{ kind: 'connection', id: 'pennie' }} />)
  await waitFor(() => expect(part('add-connection')).not.toBeNull())
  fireEvent.click(part('add-connection')!)
  return { s, ...clock }
}

async function fillSalesforce() {
  fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Salesforce/ }))
  fireEvent.change(within(field('Name')).getByRole('textbox'), { target: { value: 'Achieve Salesforce 2' } })
  fireEvent.click(within(field('Org')).getByRole('combobox'))
  await waitFor(() => expect(screen.getByRole('option', { name: /Achieve/ })).toBeTruthy())
  fireEvent.mouseDown(screen.getByRole('option', { name: /Achieve/ }))
  fireEvent.change(within(field('Client id')).getByRole('textbox'), { target: { value: '3MVG9xk2Q7R1s0p0Lm' } })
  fireEvent.change(field('Client secret').querySelector('input')!, { target: { value: 'plainsecrets' } })
}

describe('Add connection (R11, R12, D11, D12)', () => {
  it('opens the form in place of the details with nothing chosen, offering each catalogue service as a tile in its order', async () => {
    await openForm()
    expect(part('detail')).toBeNull()
    expect(part('add-form')!.querySelector('h2')!.textContent).toBe('Add a connection')
    expect(document.querySelector('[data-part="list-item"][data-selected="true"]')).toBeNull()
    const tiles = [...document.querySelectorAll('[data-part="service-tile"]')].map((t) => t.getAttribute('data-service'))
    expect(tiles).toEqual(catalogueServices().map((s) => s.name))
    expect(part('add-form')!.textContent).toContain('An org, signed in as its integration user')
  })

  it("draws a service's fields from its catalogue declaration, Name first, the secret masked, and nothing asking who it acts as (R15)", async () => {
    await openForm()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Salesforce/ }))
    expect([...document.querySelectorAll('[data-part="add-form"] [data-part="field"]')].map((f) => f.getAttribute('data-field'))).toEqual(['Name', 'Org', 'Client id', 'Client secret'])
    expect(field('Client secret').querySelector('input')!.type).toBe('password')
    expect(part('add-form')!.textContent).not.toMatch(/acts as/i)
    // The chosen tile stands alone; pressing it offers the tiles again.
    expect(document.querySelectorAll('[data-part="service-tile"]')).toHaveLength(1)
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Salesforce/ }))
    expect(document.querySelectorAll('[data-part="service-tile"]').length).toBe(catalogueServices().length)
  })

  it('offers the orgs Bidspoke knows by name, with Another org last', async () => {
    await openForm()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Salesforce/ }))
    fireEvent.click(within(field('Org')).getByRole('combobox'))
    await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Achieveachieve.my.salesforce.com', 'trypennie.my.salesforce.com', 'Another org'])
  })

  it('Cancel goes back to the connection that was open', async () => {
    await openForm()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Cancel' }))
    expect(part('detail')!.querySelector('h2')!.textContent).toBe('Pennie Salesforce')
  })
})

describe("a Google connection's mailbox and shared drives (#2572)", () => {
  const drive = (subject: string, display_name: string | null): DelegationEntry => ({ kind: 'drive', subject, display_name, added_by: 'Dan Wright', added_at: '2026-10-19T16:00:00Z' })
  const LISTED = [ENTRY, { ...ENTRY, subject: 'reports@trypennie.com' }, drive('0AFinanceDrive', 'Finance'), drive('0AReportsDrive', null)]

  async function openGoogle(over: Partial<ConnectionsSource> = {}) {
    const opened = await openForm({ googleSubjects: vi.fn(async () => ({ subjects: LISTED, reached_limit: false })), ...over })
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Google/ }))
    await waitFor(() => expect(within(part('add-form')!).queryByRole('combobox', { name: 'The mailbox it acts as' })).not.toBeNull())
    return opened
  }

  it('names the company card a mailbox alone, since drives are ticked below it (Dan, 2026-10-26)', async () => {
    await openGoogle()
    expect(screen.getAllByRole('radio').map((r) => r.closest('[data-part="choice-card"]')?.textContent ?? r.textContent)).toEqual([
      'A company mailboxFrom the company list', 'My own Google accountSigned in as you',
    ])
  })

  it('offers only the mailboxes on the company list under Acts as, never a drive', async () => {
    await openGoogle()
    const trigger = within(part('add-form')!).getByRole('combobox', { name: 'The mailbox it acts as' })
    expect(readSelect(trigger).options).toEqual(['ops@trypennie.com', 'reports@trypennie.com'])
  })

  it('lists each shared drive on the company list to tick, by the name the list shows it under', async () => {
    await openGoogle()
    const drives = field('Shared drives')
    expect(within(drives).getAllByRole('checkbox').map((c) => [c.textContent, c.getAttribute('aria-checked')])).toEqual([['Finance', 'false'], ['0AReportsDrive', 'false']])
  })

  it('sends the mailbox chosen and the drives ticked as a list', async () => {
    const { s } = await openGoogle()
    fireEvent.change(within(field('Name')).getByRole('textbox'), { target: { value: 'Ops mailbox' } })
    chooseOption(within(part('add-form')!).getByRole('combobox', { name: 'The mailbox it acts as' }), 'ops@trypennie.com')
    fireEvent.click(within(field('Shared drives')).getByRole('checkbox', { name: 'Finance' }))
    fireEvent.click(within(field('Shared drives')).getByRole('checkbox', { name: '0AReportsDrive' }))
    expect(within(field('Shared drives')).getByRole('checkbox', { name: 'Finance' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(s.create).toHaveBeenCalledTimes(1))
    expect(s.create).toHaveBeenCalledWith({ service: 'google', name: 'Ops mailbox', fields: { subject: 'ops@trypennie.com', drives: ['0AFinanceDrive', '0AReportsDrive'] } })
  })

  it('says so when the company list holds no shared drive, and asks for no drive', async () => {
    await openGoogle({ googleSubjects: vi.fn(async () => ({ subjects: [ENTRY], reached_limit: false })) })
    expect(within(field('Shared drives')).queryAllByRole('checkbox')).toEqual([])
    expect(field('Shared drives').textContent).toContain('No shared drive is on the company list yet.')
  })

  it('draws no drives for your own Google account, which names none', async () => {
    await openGoogle()
    fireEvent.click(screen.getByRole('radio', { name: 'My own Google account' }))
    expect(field('Shared drives')).toBeNull()
  })
})

describe('a save (R13, R14, R18)', () => {
  it('sends the fields by key, holds Save and counts while the login is checked, then opens the new connection with no message', async () => {
    let finish: (v: { connection: CreatedConnection }) => void = () => {}
    const create = vi.fn(() => new Promise<{ connection: CreatedConnection }>((r) => { finish = r }))
    const { advance } = await openForm({ create })
    await fillSalesforce()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Save' }))
    expect(create).toHaveBeenCalledWith({ service: 'salesforce', name: 'Achieve Salesforce 2', fields: { instance_url: 'https://achieve.my.salesforce.com', client_id: '3MVG9xk2Q7R1s0p0Lm', client_secret: 'plainsecrets' } })
    advance(6_000)
    expect(part('save-line')!.textContent).toBe('Checking the login with Salesforce, 6 s')
    expect(part('save-line')!.querySelector('[data-part="spinner"]')).not.toBeNull()
    expect((within(part('add-form')!).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    // A second press while it checks sends nothing more.
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Save' }))
    expect(create).toHaveBeenCalledTimes(1)
    await act(async () => finish({ connection: CREATED }))
    expect(part('add-form')).toBeNull()
    expect(document.querySelector('[data-part="list-item"][data-selected="true"]')!.getAttribute('data-name')).toBe('Achieve Salesforce 2')
    expect(part('detail')!.querySelector('h2')!.textContent).toBe('Achieve Salesforce 2')
    expect(part('detail')!.textContent).toContain('pennie.api@achieve.example')
    expect(document.body.textContent).not.toMatch(/\bsaved\b/i)
  })

  it("a refusal turns the line red with the route's own sentence, and Save is ready again", async () => {
    await openForm({ create: vi.fn(async () => { throw REFUSED }) })
    await fillSalesforce()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(part('save-line')?.getAttribute('data-state')).toBe('failed'))
    const line = part('save-line')!
    expect(line.textContent).toBe('Salesforce refused the client secret. Nothing was saved. Check the secret and save again.')
    // Red goes through FieldError (.impeccable.md), and the line is announced.
    expect(line).toHaveClass('field-error')
    expect(line).toHaveAttribute('role', 'alert')
    expect((within(part('add-form')!).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a check that stalls past its deadline becomes the failed line saying whether it saved is not known', async () => {
    const { advance } = await openForm({ create: vi.fn(() => new Promise<never>(() => {})) })
    await fillSalesforce()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Save' }))
    advance(CHANGE_DEADLINES.saveDeadlineMs - 1_000)
    expect(part('save-line')!.getAttribute('data-state')).toBe('saving')
    advance(1_000)
    expect(part('save-line')!.getAttribute('data-state')).toBe('failed')
    expect(part('save-line')!.textContent).toBe('The login check with Salesforce did not answer within 120 seconds, so Bidspoke cannot tell whether the connection was saved. Reload the page to see before saving again.')
  })

  it("waits as long as the request's own ceiling, so the line never says stalled while the route may still answer", () => {
    expect(CHANGE_DEADLINES.saveDeadlineMs).toBe(CONNECTION_SAVE_TIMEOUT_MS)
    expect(CHANGE_DEADLINES.removeDeadlineMs).toBe(CONNECTION_REMOVE_TIMEOUT_MS)
  })

  it('Enter in a field never saves', async () => {
    const { s } = await openForm()
    await fillSalesforce()
    fireEvent.keyDown(within(field('Name')).getByRole('textbox'), { key: 'Enter' })
    fireEvent.keyDown(field('Client secret').querySelector('input')!, { key: 'Enter' })
    fireEvent.keyDown(within(field('Client id')).getByRole('textbox'), { key: 'Enter' })
    expect(s.create).not.toHaveBeenCalled()
    expect(part('add-form')!.closest('form')).toBeNull()
  })

  it("sends an org typed as a new one as its address, read out of what was typed", async () => {
    const { s } = await openForm()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Salesforce/ }))
    fireEvent.change(within(field('Name')).getByRole('textbox'), { target: { value: 'Lendco Salesforce' } })
    fireEvent.click(within(field('Org')).getByRole('combobox'))
    await waitFor(() => expect(screen.getByRole('option', { name: 'Another org' })).toBeTruthy())
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Another org' }))
    const box = within(field('Org')).getByRole('combobox') as HTMLInputElement
    fireEvent.change(box, { target: { value: 'https://lendco.lightning.force.com/lightning/page/home' } })
    expect(screen.getByRole('option', { name: 'Use https://lendco.lightning.force.com/lightning/page/home as a new org' })).toBeTruthy()
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.change(within(field('Client id')).getByRole('textbox'), { target: { value: 'c' } })
    fireEvent.change(field('Client secret').querySelector('input')!, { target: { value: 's' } })
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Save' }))
    expect(s.create).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ instance_url: 'https://lendco.my.salesforce.com' }) }))
  })
})

describe('leaving with something unsaved (L608)', () => {
  it('asks before another connection is opened, keeps the form on Keep editing, and opens it on Discard', async () => {
    await openForm()
    await fillSalesforce()
    fireEvent.click(screen.getByRole('button', { name: 'Spare Salesforce' }))
    const ask = screen.getByRole('alertdialog', { name: 'The new connection is not saved' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }))
    expect(part('add-form')).not.toBeNull()
    expect(within(field('Name')).getByRole('textbox')).toHaveValue('Achieve Salesforce 2')
    fireEvent.click(screen.getByRole('button', { name: 'Spare Salesforce' }))
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
    expect(part('add-form')).toBeNull()
    expect(part('detail')!.querySelector('h2')!.textContent).toBe('Spare Salesforce')
  })

  it('the question goes once there is nothing left to lose: a save that lands while it is asked', async () => {
    let finish: (v: { connection: CreatedConnection }) => void = () => {}
    await openForm({ create: vi.fn(() => new Promise<{ connection: CreatedConnection }>((r) => { finish = r })) })
    await fillSalesforce()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Spare Salesforce' }))
    expect(screen.getByRole('alertdialog', { name: 'The login is still being checked' })).toBeTruthy()
    await act(async () => finish({ connection: CREATED }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(part('detail')!.querySelector('h2')!.textContent).toBe('Achieve Salesforce 2')
  })

  it('opens another connection straight away when nothing was typed', async () => {
    await openForm()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Salesforce/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Spare Salesforce' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(part('detail')!.querySelector('h2')!.textContent).toBe('Spare Salesforce')
  })

  it("raises the browser's own warning on a refresh while the form holds something, and not after", async () => {
    await openForm()
    const unload = () => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }
    expect(unload()).toBe(false)
    await fillSalesforce()
    expect(unload()).toBe(true)
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Cancel' }))
    expect(unload()).toBe(false)
  })

  it('asks before a link in the app is followed', async () => {
    await openForm()
    await fillSalesforce()
    // The leave guard holds a same origin link anywhere in the app, the sidebar included.
    const link = document.createElement('a')
    link.href = '/workflows'
    link.textContent = 'Workflows'
    document.body.append(link)
    fireEvent.click(link)
    expect(screen.getByRole('alertdialog', { name: 'The new connection is not saved' })).toBeTruthy()
    link.remove()
  })
})

describe('Reconnect (R19, D19)', () => {
  async function openReconnect(over: Partial<ConnectionsSource> = {}, clock = manualClock()) {
    const s = source(over)
    render(<ConnectionsScreen source={s} clock={clock.clock} initialChosen={{ kind: 'connection', id: 'achieve' }} />)
    await waitFor(() => expect(part('problem-notice')).not.toBeNull())
    fireEvent.click(within(part('problem-notice')!).getByRole('button', { name: 'Reconnect' }))
    return { s, dialog: screen.getByRole('dialog', { name: 'Reconnect Achieve Salesforce' }), ...clock }
  }

  it('keeps the client id and asks for a new client secret, with Save and Cancel', async () => {
    const { dialog } = await openReconnect()
    const id = within(dialog).getByLabelText('Client id') as HTMLInputElement
    expect(id.value).toBe('3MVG9xk2Q7R1s0p0Lm')
    expect(id.readOnly).toBe(true)
    const secret = within(dialog).getByLabelText('New client secret') as HTMLInputElement
    expect([secret.type, secret.value]).toEqual(['password', ''])
    // The box to type into has the focus, not the kept id.
    await waitFor(() => expect(document.activeElement).toBe(secret))
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Save', 'Cancel'])
  })

  it('sends only the new secret, then the connection reads working with no notice, acting as who the check measured', async () => {
    const { s, dialog } = await openReconnect()
    fireEvent.change(within(dialog).getByLabelText('New client secret'), { target: { value: 'plainsecrets' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(s.reconnect).toHaveBeenCalledWith('achieve', { fields: { client_secret: 'plainsecrets' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(part('status')!.textContent).toBe('Working')
    expect(part('problem-notice')).toBeNull()
    expect(part('detail')!.textContent).toContain('pennie.api@achieve.example')
  })

  it('opens for a connection of a service the catalogue does not declare, asks nothing, and says why the check is refused', async () => {
    // Airtable: a service with no catalogue entry (Anthropic, then Supabase, were this example until each shipped, #2337).
    const undeclared = Object.assign(new Error('connection_service_undeclared'), { status: 422, body: { error: 'connection_service_undeclared', message: 'Bidspoke cannot connect to Airtable yet. Nothing was saved. Choose one of the services the form offers.' } })
    const list: ConnectionList = { ...LIST, connections: [row({ id: 'notes', name: 'Lead notes', service: 'airtable', service_name: 'Airtable', org: null, target: null })] }
    const s = source({ list: vi.fn(async () => list), reconnect: vi.fn(async () => { throw undeclared }) })
    render(<ConnectionsScreen source={s} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: 'notes' }} />)
    await waitFor(() => expect(part('actions')).not.toBeNull())
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    const dialog = screen.getByRole('dialog', { name: 'Reconnect Lead notes' })
    expect(within(dialog).queryAllByRole('textbox')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(s.reconnect).toHaveBeenCalledWith('notes', {})
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Bidspoke cannot connect to Airtable yet.'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('with nothing typed, asks to check the stored login again', async () => {
    const { s, dialog } = await openReconnect()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(s.reconnect).toHaveBeenCalledWith('achieve', {})
  })

  it('a Back with a login typed asks first, naming the login, and keeps Reconnect open', async () => {
    const { dialog } = await openReconnect()
    fireEvent.change(within(dialog).getByLabelText('New client secret'), { target: { value: 'typed' } })
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')) })
    const ask = screen.getByRole('alertdialog', { name: 'The new login is not saved' })
    expect(ask).toHaveAccessibleDescription('Leaving discards the login typed into Reconnect.')
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByRole('dialog', { name: 'Reconnect Achieve Salesforce' })).toBeTruthy()
  })

  it("shows a refusal's sentence in the dialog and keeps it open, Save ready again", async () => {
    const { dialog } = await openReconnect({ reconnect: vi.fn(async () => { throw REFUSED }) })
    fireEvent.change(within(dialog).getByLabelText('New client secret'), { target: { value: 'wrong' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Salesforce refused the client secret. Nothing was saved. Check the secret and save again.'))
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('counts while it checks, holding only Save, and Escape never throws a typed secret away', async () => {
    let finish: (v: { outcome: 'reconnected'; connection: { id: string; acts_as: string | null } }) => void = () => {}
    const { dialog, advance } = await openReconnect({ reconnect: vi.fn(() => new Promise<{ outcome: 'reconnected'; connection: { id: string; acts_as: string | null } }>((r) => { finish = r })) })
    fireEvent.change(within(dialog).getByLabelText('New client secret'), { target: { value: 'typed' } })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    advance(4_000)
    expect(within(dialog).getByRole('status').textContent).toBe('Checking the login with Salesforce, 4 s')
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    // Cancel closes it while it checks; the answer still lands.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => finish({ outcome: 'reconnected', connection: { id: 'achieve', acts_as: null } }))
    expect(part('status')!.textContent).toBe('Working')
  })
})

describe('Remove (R21, D21)', () => {
  async function openRemove(over: Partial<ConnectionsSource> = {}) {
    const s = source(over)
    const m = manualClock()
    render(<ConnectionsScreen source={s} clock={m.clock} initialChosen={{ kind: 'connection', id: 'spare' }} />)
    await waitFor(() => expect(part('remove-row')).not.toBeNull())
    fireEvent.click(within(part('remove-row')!).getByRole('button', { name: 'Remove' }))
    return { s, dialog: screen.getByRole('alertdialog', { name: 'Remove Spare Salesforce?' }), ...m }
  }

  it('asks once, saying what is lost, with Cancel and a red Remove; Cancel removes nothing', async () => {
    const { s, dialog } = await openRemove()
    expect(dialog).toHaveAccessibleDescription('Its login is deleted from Bidspoke and cannot be brought back.')
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Cancel', 'Remove'])
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toHaveClass('btn-destructive')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(s.remove).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Spare Salesforce' })).not.toBeNull()
  })

  it('a removed connection leaves the list, and the panel opens the next one', async () => {
    const { s, dialog } = await openRemove()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(s.remove).toHaveBeenCalledWith('spare')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Spare Salesforce' })).toBeNull())
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(part('detail')).not.toBeNull()
  })

  it('refused because a workflow now uses it: says so naming it, and Remove is held', async () => {
    const inUse = Object.assign(new Error('connection_in_use'), { status: 409, body: { error: 'connection_in_use', message: 'Daily cleanup uses this connection, so it cannot be removed. Nothing was removed. Take it out of that workflow first.', workflows: [{ id: 'w9', name: 'Daily cleanup', deleted: false }] } })
    const { dialog } = await openRemove({ remove: vi.fn(async () => { throw inUse }) })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Daily cleanup uses this connection'))
    expect((within(dialog).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(part('remove-row')!.textContent).toContain('Cannot be removed while a workflow uses it.')
  })

  it("says when the workflows server could not be told, since the removal stands", async () => {
    const { dialog } = await openRemove({ remove: vi.fn(async () => ({ outcome: 'removed' as const, ops: { told: false as const, message: 'The connection is removed. The workflows server could not be told straight away.' } })) })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Spare Salesforce' })).toHaveAccessibleDescription('The connection is removed. The workflows server could not be told straight away.'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})


describe('Replace (R20, D20, build PR 12)', () => {
  // Pennie Salesforce: two workflows that can get a new version, and one soft deleted, which cannot.
  const LIVE = [{ id: 'w1', name: 'Lead Completed sync', deleted: false }, { id: 'w2', name: 'Tripoint submission', deleted: false }]
  const withWorkflows = (workflows: NonNullable<ConnectionListRow['workflows']>): ConnectionList => ({
    ...LIST,
    connections: LIST.connections.map((c) => (c.id === 'pennie' ? { ...c, used_by: workflows.length, workflows } : c)),
  })
  const USED = withWorkflows([...LIVE, { id: 'w9', name: 'Old import', deleted: true }])
  const done = (body: { with: string; workflows: string[] }): ConnectionReplaceAnswer => ({
    outcome: 'replaced', connection: { id: 'pennie' }, with: { id: body.with, name: 'Spare Salesforce' },
    workflows: body.workflows.map((id) => ({ id, name: LIVE.find((w) => w.id === id)!.name, outcome: 'replaced' as const, version: 5 })),
  })

  async function openReplace(over: Partial<ConnectionsSource> = {}, list: ConnectionList = USED) {
    const s = source({ list: vi.fn(async () => list), replace: vi.fn(async (_id: string, body: { with: string; workflows: string[] }) => done(body)), ...over })
    const m = manualClock()
    render(<ConnectionsScreen source={s} clock={m.clock} initialChosen={{ kind: 'connection', id: 'pennie' }} />)
    await waitFor(() => expect(part('actions')).not.toBeNull())
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Replace' }))
    return { s, dialog: screen.getByRole('dialog', { name: 'Replace Pennie Salesforce' }), ...m }
  }

  const ticks = (dialog: HTMLElement) => within(dialog).getAllByRole('checkbox') as HTMLButtonElement[]

  it('opens from the panel, with the replacement chosen and each workflow that can get a new version ticked; a deleted one is left out, with nothing said (decision 3)', async () => {
    const { dialog } = await openReplace()
    expect(readSelect(within(dialog).getByRole('combobox')).selected).toBe('Spare Salesforce')
    expect(ticks(dialog).map((t) => [t.textContent, t.getAttribute('aria-checked')])).toEqual([['Lead Completed sync', 'true'], ['Tripoint submission', 'true']])
    expect(dialog.textContent).not.toContain('Old import')
    expect(dialog.textContent).not.toContain('deleted')
    expect(dialog.textContent).toContain('Each ticked workflow gets a new version with Spare Salesforce.')
    expect(within(dialog).getByRole('button', { name: 'Replace in 2 workflows' })).toHaveClass('btn-destructive')
    // It still counts in Used by.
    expect(screen.getByRole('tab', { name: 'Used by (3)', hidden: true })).toBeTruthy()
  })

  it('sends the replacement and the ticked workflows, greys the button and says what it is moving while it runs (decision 1), then closes into a notice (decision 4)', async () => {
    let finish: (v: ConnectionReplaceAnswer) => void = () => {}
    const replace = vi.fn((_id: string, _body: { with: string; workflows: string[] }) => new Promise<ConnectionReplaceAnswer>((r) => { finish = r }))
    const { dialog, advance } = await openReplace({ replace })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace in 2 workflows' }))
    expect(replace).toHaveBeenCalledWith('pennie', { with: 'spare', workflows: ['w1', 'w2'] })
    advance(3_000)
    const line = within(dialog).getByRole('status')
    expect(line.textContent).toBe('Moving 2 workflows to Spare Salesforce, 3 s')
    // Under the buttons, as the add form's working line is.
    const go = within(dialog).getByRole('button', { name: 'Replace in 2 workflows' }) as HTMLButtonElement
    expect(go.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(go.disabled).toBe(true)
    // Only the red button greys out (decision 1); a tick taken off now is for the next press, and the line keeps its words.
    fireEvent.click(ticks(dialog)[1])
    expect(within(dialog).getByRole('status').textContent).toBe('Moving 2 workflows to Spare Salesforce, 3 s')
    fireEvent.click(ticks(dialog)[1])
    // Escape never closes it while it runs.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Replace Pennie Salesforce' })).toBeTruthy()
    await act(async () => finish(done({ with: 'spare', workflows: ['w1', 'w2'] })))
    expect(screen.queryByRole('dialog', { name: 'Replace Pennie Salesforce' })).toBeNull()
    // The deleted one is still on it, so Used by is 1 and nothing more is said.
    expect(screen.getByRole('dialog', { name: 'Pennie Salesforce' })).toHaveAccessibleDescription('Moved 2 workflows to Spare Salesforce.')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('tab', { name: 'Used by (1)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Spare Salesforce' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Used by (2)' })).toBeTruthy())
  })

  it('says nothing uses it now once Used by is 0', async () => {
    const { dialog } = await openReplace({}, withWorkflows(LIVE))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace in 2 workflows' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Pennie Salesforce' })).toHaveAccessibleDescription('Moved 2 workflows to Spare Salesforce. Nothing uses Pennie Salesforce now.'))
  })

  it('a workflow left unticked is not sent, and the count and the working line say one', async () => {
    const { s, dialog } = await openReplace({ replace: vi.fn(() => new Promise<ConnectionReplaceAnswer>(() => {})) })
    fireEvent.click(ticks(dialog)[1])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace in 1 workflow' }))
    expect(s.replace).toHaveBeenCalledWith('pennie', { with: 'spare', workflows: ['w1'] })
    expect(within(dialog).getByRole('status').textContent).toBe('Moving 1 workflow to Spare Salesforce, 0 s')
  })

  it('moved only some: stays open with every workflow listed, the moved one greyed and unticked, the one left ticked, and a red line naming it (decision 2)', async () => {
    const sentence = 'Tripoint submission was saved by someone else while this ran, so it still uses Pennie Salesforce. Replace again to move it.'
    const { dialog } = await openReplace({
      replace: vi.fn(async () => ({
        outcome: 'incomplete' as const, connection: { id: 'pennie' }, with: { id: 'spare', name: 'Spare Salesforce' }, message: sentence,
        workflows: [{ id: 'w1', name: 'Lead Completed sync', outcome: 'replaced' as const, version: 5 }, { id: 'w2', name: 'Tripoint submission', outcome: 'changed' as const }],
      })),
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace in 2 workflows' }))
    const alert = await waitFor(() => within(dialog).getByRole('alert'))
    expect(alert.textContent).toBe(sentence)
    expect(alert).toHaveClass('field-error')
    expect(ticks(dialog).map((t) => [t.textContent, t.getAttribute('aria-checked'), t.disabled])).toEqual([
      ['Lead Completed sync, moved', 'false', true],
      ['Tripoint submission', 'true', false],
    ])
    const again = within(dialog).getByRole('button', { name: 'Replace in 1 workflow' }) as HTMLButtonElement
    expect(again.disabled).toBe(false)
    expect(again.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("a refusal says the route's own sentence and changes nothing", async () => {
    const refused = Object.assign(new Error('replace_with_not_found'), { status: 404, body: { error: 'replace_with_not_found', message: 'The connection chosen to replace it with is not in your organization any more. Nothing was changed. Reload the page and choose another.' } })
    const { dialog } = await openReplace({ replace: vi.fn(async () => { throw refused }) })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace in 2 workflows' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('Nothing was changed.'))
    expect(ticks(dialog).map((t) => t.getAttribute('aria-checked'))).toEqual(['true', 'true'])
  })

  it('stalls at its deadline into a line saying whether the workflows were moved is not known', async () => {
    const { dialog, advance } = await openReplace({ replace: vi.fn(() => new Promise<ConnectionReplaceAnswer>(() => {})) })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace in 2 workflows' }))
    advance(CHANGE_DEADLINES.replaceDeadlineMs)
    expect(within(dialog).getByRole('alert').textContent).toBe(`Bidspoke did not answer within ${CHANGE_DEADLINES.replaceDeadlineMs / 1000} seconds, so it cannot tell whether the workflows were moved. Reload the page to see before replacing again.`)
  })

  describe(`the cap of ${CONNECTION_REPLACE_MOST} workflows a Replace moves at a time`, () => {
    const manyOf = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `Workflow ${String(i + 1).padStart(2, '0')}`, deleted: false }))
    const capLine = (dialog: HTMLElement) => dialog.querySelector('[data-part="replace-cap"]')

    it('at the cap: every workflow ticked, and nothing said of a cap', async () => {
      const { dialog } = await openReplace({}, withWorkflows(manyOf(CONNECTION_REPLACE_MOST)))
      expect(ticks(dialog).every((t) => t.getAttribute('aria-checked') === 'true')).toBe(true)
      expect(capLine(dialog)).toBeNull()
      expect(within(dialog).getByRole('button', { name: `Replace in ${CONNECTION_REPLACE_MOST} workflows` })).toBeEnabled()
    })

    it('past the cap: the first ones ticked, a plain line saying so, and the button held while more are ticked', async () => {
      const { s, dialog } = await openReplace({ replace: vi.fn(() => new Promise<ConnectionReplaceAnswer>(() => {})) }, withWorkflows(manyOf(CONNECTION_REPLACE_MOST + 2)))
      expect(ticks(dialog).map((t) => t.getAttribute('aria-checked'))).toEqual([...Array(CONNECTION_REPLACE_MOST).fill('true'), 'false', 'false'])
      expect(capLine(dialog)?.textContent).toBe(`Replace moves at most ${CONNECTION_REPLACE_MOST} workflows at a time, so the first ${CONNECTION_REPLACE_MOST} are ticked. Replace again to move the rest.`)
      fireEvent.click(ticks(dialog)[CONNECTION_REPLACE_MOST])
      const held = within(dialog).getByRole('button', { name: `Replace in ${CONNECTION_REPLACE_MOST + 1} workflows` }) as HTMLButtonElement
      expect(held.disabled).toBe(true)
      expect(capLine(dialog)?.textContent).toBe(`Replace moves at most ${CONNECTION_REPLACE_MOST} workflows at a time. Untick 1 first.`)
      fireEvent.click(held)
      expect(s.replace).not.toHaveBeenCalled()
      fireEvent.click(ticks(dialog)[0])
      fireEvent.click(within(dialog).getByRole('button', { name: `Replace in ${CONNECTION_REPLACE_MOST} workflows` }))
      expect((s.replace as ReturnType<typeof vi.fn>).mock.calls[0][1].workflows).toHaveLength(CONNECTION_REPLACE_MOST)
    })
  })

  it("waits as long as the request's own ceiling", () => {
    expect(CHANGE_DEADLINES.replaceDeadlineMs).toBe(CONNECTION_REPLACE_TIMEOUT_MS)
  })

  it("appends the route's stored copy warning to the notice, since the replace stands", async () => {
    const warning = 'The change was saved and recorded, but a stored copy of the old version could not be refreshed.'
    const { dialog } = await openReplace({
      replace: vi.fn(async (_id: string, body: { with: string; workflows: string[] }) => ({ ...done(body), stored_copy_warning: warning })),
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Replace in 2 workflows' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Pennie Salesforce' })).toHaveAccessibleDescription(`Moved 2 workflows to Spare Salesforce. ${warning}`))
  })
})
