/**
 * The Slack alerts login's panel on the Connections page (#2338, build PR 14):
 * round 36's alert settings under its facts, saved through the routes the
 * Integrations page used, and Reconnect asking for a new bot token, as every
 * other login's does. Rendered through the page (ConnectionsScreen), so the
 * reducer, the source calls and the layout are proven together.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SLACK_ALERT_LOGIN_LINK_ID } from '@bidspoke/service-catalogue/schema'
import type { ConnectionList, ConnectionListRow, SlackAlertSettingsAnswer } from '@/lib/api'
import { keptSignInsIn } from '../google-sign-in-kept'
import { ConnectionsScreen, type ConnectionsClock, type ConnectionsSource } from '../ConnectionsScreen'

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
  owner: null, target: null, org: 'trypennie.my.salesforce.com', status: 'ok', status_word: 'Working', health: null,
  checked_at: '2026-10-20T15:56:00Z', used_by: 0, workflows: [], created_at: '', updated_at: '', ...over,
})

const ALERT_ROW = row({ id: 'alert-row-id', name: 'Bidspoke Alerts', service: 'slack', service_name: 'Slack', alert_login: true, acts_as: 'Bidspoke Alerts in Pennie', org: null, checked_at: '2026-10-20T15:58:00Z' })
const LIST: ConnectionList = { connections: [row({}), ALERT_ROW], statuses: { as_of: '2026-10-20T16:00:00Z', stale: false, unavailable: null } }
const SETTINGS: SlackAlertSettingsAnswer = { connected: true, default_channel: '#bidspoke-alerts', volume_alerts_enabled: true, config_alerts_enabled: true, backup_alerts_enabled: true, matrix_alerts_enabled: true }

function source(over: Partial<ConnectionsSource> = {}): ConnectionsSource {
  return {
    list: vi.fn(async () => LIST),
    history: vi.fn(async () => ({ entries: [] })),
    googleSubjects: vi.fn(async () => ({ subjects: [], reached_limit: false })),
    addGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    removeGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    create: vi.fn(async () => { throw new Error('not called') }),
    reconnect: vi.fn(async (id: string) => ({ outcome: 'reconnected' as const, connection: { id, acts_as: 'Bidspoke Alerts in Pennie' } })),
    remove: vi.fn(async () => { throw new Error('not called') }),
    slackAlerts: vi.fn(async () => SETTINGS),
    updateSlackAlerts: vi.fn(async () => ({ ok: true })),
    searchSlackChannels: vi.fn(async (q: string) => ({ channels: ['ops-alerts', 'ops-bidding'].filter((c) => c.includes(q)).map((name) => ({ id: name, name })) })),
    startGoogleSignIn: vi.fn(async () => { throw new Error('not called') }),
    goTo: vi.fn(),
    finishGoogleSignIn: vi.fn(async () => { throw new Error('not called') }),
    keptSignIns: keptSignInsIn(null),
    ...over,
  }
}

const part = (name: string) => document.querySelector(`[data-part="${name}"]`) as HTMLElement | null
const switchRow = (key: string) => document.querySelector(`[data-part="alert-switch"][data-switch="${key}"]`) as HTMLElement

async function openAlertLogin(src: ConnectionsSource, clock = manualClock().clock) {
  render(<ConnectionsScreen source={src} clock={clock} initialChosen={{ kind: 'connection', id: 'alert-row-id' }} />)
  await waitFor(() => expect(part('alert-channel')).not.toBeNull())
}

describe('the Slack alerts login\'s panel (round 36)', () => {
  it('draws Service, Acts as and Last checked, Reconnect, then Alerts: Posts to with Change and the four switches in order, with no Integrations link', async () => {
    await openAlertLogin(source())
    const detail = part('detail')!
    expect([...detail.querySelectorAll('[data-part="fact"]')].map((f) => f.getAttribute('data-fact'))).toEqual(['Service', 'Acts as', 'Last checked'])
    expect(within(part('actions')!).getByRole('button', { name: 'Reconnect' })).toBeTruthy()
    expect(part('alerts-heading')!.textContent).toBe('Alerts')
    expect(part('alert-channel')!.textContent).toContain('Posts to')
    expect(part('alert-channel')!.textContent).toContain('#bidspoke-alerts')
    expect(within(part('alert-channel')!).getByRole('button', { name: 'Change' })).toBeTruthy()
    const switches = [...document.querySelectorAll('[data-part="alert-switch"]')]
    expect(switches.map((s) => within(s as HTMLElement).getByRole('switch').getAttribute('aria-label'))).toEqual([
      'Volume anomaly alerts', 'Configuration warning alerts', 'Backup failure alerts', 'Bid matrix change alerts',
    ])
    expect(switches.every((s) => within(s as HTMLElement).getByRole('switch').getAttribute('aria-checked') === 'true')).toBe(true)
    expect(detail.textContent).not.toMatch(/Integrations/)
    expect(detail.querySelector('a[href="/integrations"]')).toBeNull()
    // Replace and Remove stay refused for this login, so neither is offered.
    expect(within(detail).queryByRole('button', { name: 'Replace' })).toBeNull()
    expect(within(detail).queryByRole('button', { name: 'Remove' })).toBeNull()
  })

  it('a switch says it started and counts, then says what it did, saved alone through the settings route', async () => {
    let answer: () => void = () => {}
    const updateSlackAlerts = vi.fn(() => new Promise<unknown>((resolve) => { answer = () => resolve({ ok: true }) }))
    const { clock, advance } = manualClock()
    await openAlertLogin(source({ updateSlackAlerts }), clock)
    fireEvent.click(within(switchRow('volume_alerts_enabled')).getByRole('switch'))
    expect(updateSlackAlerts).toHaveBeenCalledWith({ volume_alerts_enabled: false })
    expect(within(switchRow('volume_alerts_enabled')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    advance(3_000)
    expect(switchRow('volume_alerts_enabled').textContent).toContain('Turning off volume anomaly alerts, 3 s')
    await act(async () => answer())
    expect(switchRow('volume_alerts_enabled').textContent).toContain('Turned off. These alerts no longer post.')
  })

  it('a switch whose save fails turns back, with a plain red sentence on its row', async () => {
    const updateSlackAlerts = vi.fn(async () => { throw Object.assign(new Error('x'), { status: 404, body: { error: 'Slack is not connected' } }) })
    await openAlertLogin(source({ updateSlackAlerts }))
    fireEvent.click(within(switchRow('backup_alerts_enabled')).getByRole('switch'))
    await waitFor(() => expect(within(switchRow('backup_alerts_enabled')).getByRole('alert').textContent).toBe('Backup failure alerts was not turned off: Slack is not connected. It is still on.'))
    expect(within(switchRow('backup_alerts_enabled')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('Change searches Slack\'s channels as it is typed into, and Save moves the alerts and says so', async () => {
    const src = source()
    await openAlertLogin(src)
    fireEvent.click(within(part('alert-channel')!).getByRole('button', { name: 'Change' }))
    const box = within(part('channel-editor')!).getByRole('combobox')
    const save = within(part('channel-editor')!).getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'ops' } })
    await waitFor(() => expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['#ops-alerts', '#ops-bidding']))
    expect(src.searchSlackChannels).toHaveBeenCalledWith('ops')
    fireEvent.mouseDown(screen.getByRole('option', { name: '#ops-alerts' }))
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(src.updateSlackAlerts).toHaveBeenCalledWith({ default_channel: '#ops-alerts' })
    await waitFor(() => expect(part('channel-line')!.textContent).toBe('Alerts now post to #ops-alerts.'))
    expect(part('alert-channel-value')!.textContent).toBe('#ops-alerts')
  })

  it('a channel save that fails keeps the editor open with its sentence, and the channel shown stays the saved one', async () => {
    const updateSlackAlerts = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    await openAlertLogin(source({ updateSlackAlerts }))
    fireEvent.click(within(part('alert-channel')!).getByRole('button', { name: 'Change' }))
    const box = within(part('channel-editor')!).getByRole('combobox')
    fireEvent.focus(box)
    fireEvent.change(box, { target: { value: 'ops' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))
    fireEvent.mouseDown(screen.getByRole('option', { name: '#ops-bidding' }))
    fireEvent.click(within(part('channel-editor')!).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(part('channel-line')!.textContent).toBe('Alerts may not have been moved to #ops-bidding: the server could not be reached. Reload the page to see where they post.'))
    fireEvent.click(within(part('channel-editor')!).getByRole('button', { name: 'Cancel' }))
    expect(part('alert-channel-value')!.textContent).toBe('#bidspoke-alerts')
  })

  it('settings that could not be read say why, with Try again, which reads them again', async () => {
    let calls = 0
    const slackAlerts = vi.fn(async () => { if (++calls === 1) throw new TypeError('Failed to fetch'); return SETTINGS })
    render(<ConnectionsScreen source={source({ slackAlerts })} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: 'alert-row-id' }} />)
    await waitFor(() => expect(screen.getByText('The alert settings could not be read: the server could not be reached.')).toBeTruthy())
    // A failed line, as D25 reads it in the settled design: marked failed where it is drawn, and an alert.
    const line = part('alerts-line')!
    expect(line.getAttribute('data-state')).toBe('failed')
    expect(line.getAttribute('role')).toBe('alert')
    fireEvent.click(within(part('alert-settings')!).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(part('alert-channel')).not.toBeNull())
    expect(slackAlerts).toHaveBeenCalledTimes(2)
  })
})

describe('Reconnect on the Slack alerts login (Dan\'s decision 4)', () => {
  it('opens the same dialog, asking for a new bot token, and sends it as bot_token', async () => {
    const src = source()
    await openAlertLogin(src)
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    const dialog = screen.getByRole('dialog', { name: 'Reconnect Bidspoke Alerts' })
    const token = within(dialog).getByLabelText('New bot token')
    expect(token.getAttribute('type')).toBe('password')
    fireEvent.change(token, { target: { value: 'plainsecrets' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(src.reconnect).toHaveBeenCalledWith('alert-row-id', { fields: { bot_token: 'plainsecrets' } })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a refusal is the route\'s own plain sentence, inside the dialog', async () => {
    const refused = Object.assign(new Error('slack_token_refused'), { status: 422, body: { error: 'slack_token_refused', message: 'Slack did not accept this token (invalid_auth). Nothing was saved. Check the token in the Slack app and save again.' } })
    await openAlertLogin(source({ reconnect: vi.fn(async () => { throw refused }) }))
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    const dialog = screen.getByRole('dialog', { name: 'Reconnect Bidspoke Alerts' })
    fireEvent.change(within(dialog).getByLabelText('New bot token'), { target: { value: 'plainsecrets' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Slack did not accept this token (invalid_auth). Nothing was saved. Check the token in the Slack app and save again.'))
  })

  it('a problem notice on the alert login holds Reconnect, as every login\'s does', async () => {
    const list: ConnectionList = { ...LIST, connections: [row({}), { ...ALERT_ROW, status: 'reauth', status_word: 'Needs reconnecting' }] }
    render(<ConnectionsScreen source={source({ list: vi.fn(async () => list) })} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: 'alert-row-id' }} />)
    await waitFor(() => expect(part('problem-notice')).not.toBeNull())
    expect(part('problem-notice')!.textContent).toContain('Reconnect with a new token from the Slack app.')
    expect(within(part('problem-notice')!).getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  })
})

describe('the Slack alerts login\'s link (the /integrations redirect, the Slack alerts)', () => {
  it(`?connection=${SLACK_ALERT_LOGIN_LINK_ID} opens the Slack alerts login, whatever its id`, async () => {
    render(<ConnectionsScreen source={source()} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: SLACK_ALERT_LOGIN_LINK_ID }} />)
    await waitFor(() => expect(part('detail')?.getAttribute('aria-label')).toBe('Bidspoke Alerts'))
    expect(document.querySelector('[data-part="list-item"][data-selected="true"]')?.getAttribute('data-name')).toBe('Bidspoke Alerts')
  })
})
