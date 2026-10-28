/**
 * A Google company mailbox on the Connections page (#2727, Dan 2026-10-28,
 * docs/design/google-mailbox-reconnect.html). It acts through the ops Worker's
 * own delegation key, so it has nothing to re-enter: its Reconnect checks the
 * login again in one click, with no dialog, and clears the needs reconnecting
 * mark when the check passes (D1, D2); it offers no Replace, working or
 * refused (D1, D3); and a refused one's notice sends the person to the Google
 * Workspace admin (D4). A person's own Google connection, and every other
 * service, keep the Reconnect dialog and Replace they had. The clock is the
 * test's, moved by hand.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import { keptSignInsIn } from '../google-sign-in-kept'
import { ConnectionsScreen, type ConnectionsClock, type ConnectionsSource } from '../ConnectionsScreen'
import { CHANGE_DEADLINES } from '../connections-state'

vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))

const T0 = Date.parse('2026-10-28T16:00:00Z')
const FIX = "Ask the Google Workspace admin to check Bidspoke's access to this mailbox, then Reconnect."

function manualClock() {
  let t = T0
  const timers = new Set<() => void>()
  const clock: ConnectionsClock = { now: () => t, every: (_ms, fn) => { timers.add(fn); return () => timers.delete(fn) } }
  return { clock, advance: (ms: number) => act(() => { t += ms; for (const fn of [...timers]) fn() }) }
}

const HEALTHY = { ops_status: 'healthy', last_check_ok_at: '2026-10-28T15:49:00Z', last_check_failed_at: null, last_check_cause: null, needs_reauth_at: null, needs_reauth_cause: null } as const

const row = (over: Partial<ConnectionListRow>): ConnectionListRow => ({
  id: 'mailbox', name: 'Ops mailbox', service: 'google', service_name: 'Google', alert_login: false, acts_as: 'ops@trypennie.com', person_bound: false,
  owner: null, target: { subject: 'ops@trypennie.com', drives: [] }, org: null, status: 'ok', status_word: 'Working',
  health: HEALTHY, checked_at: '2026-10-28T15:49:00Z', used_by: 1, workflows: [{ id: 'w1', name: 'Daily digest', deleted: false }],
  created_at: '', updated_at: '', ...over,
})

const REFUSED_HEALTH = { ops_status: 'needs_reauth', last_check_ok_at: null, last_check_failed_at: '2026-10-28T13:12:00Z', last_check_cause: null, needs_reauth_at: '2026-10-28T13:12:00Z', needs_reauth_cause: 'login_refused: unauthorized_client' } as const

const LIST: ConnectionList = {
  connections: [
    row({}),
    row({ id: 'refused', name: 'Sales mailbox', acts_as: 'sales@trypennie.com', target: { subject: 'sales@trypennie.com', drives: [] }, status: 'reauth', status_word: 'Needs reconnecting', health: REFUSED_HEALTH }),
    row({
      id: 'mine', name: 'My Google', acts_as: 'dan@trypennie.com', person_bound: true, owner: { user_id: 'u1', name: 'Dan Wright', email: 'dan@trypennie.com' },
      target: { own_account: true }, used_by: 0, workflows: [],
    }),
    row({
      id: 'pennie', name: 'Pennie Salesforce', service: 'salesforce', service_name: 'Salesforce', acts_as: 'integration@trypennie.com',
      target: { instance_url: 'https://trypennie.my.salesforce.com', client_id: 'client-id-of-pennie' }, org: 'trypennie.my.salesforce.com',
    }),
  ],
  statuses: { as_of: '2026-10-28T16:00:00Z', stale: false, unavailable: null },
}

type Rechecked = { outcome: 'reconnected' | 'checked'; connection: { id: string; acts_as: string | null } }

function source(over: Partial<ConnectionsSource> = {}): ConnectionsSource {
  return {
    list: vi.fn(async () => LIST),
    history: vi.fn(async () => ({ entries: [] })),
    googleSubjects: vi.fn(async () => ({ subjects: [], reached_limit: false })),
    addGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    removeGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    create: vi.fn(async () => { throw new Error('not called') }),
    reconnect: vi.fn(async (id: string): Promise<Rechecked> => ({ outcome: 'checked', connection: { id, acts_as: null } })),
    remove: vi.fn(async () => ({ outcome: 'removed' as const, ops: { told: true as const } })),
    replace: vi.fn(async () => { throw new Error('not called') }),
    slackAlerts: vi.fn(async () => ({ connected: false })),
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
const labels = (el: HTMLElement | null) => (el ? within(el).queryAllByRole('button').map((b) => b.textContent) : null)

async function open(id: string, over: Partial<ConnectionsSource> = {}, clock = manualClock()) {
  const s = source(over)
  render(<ConnectionsScreen source={s} clock={clock.clock} initialChosen={{ kind: 'connection', id }} />)
  await waitFor(() => expect(part('detail')).not.toBeNull())
  return { s, ...clock }
}

describe('a working company mailbox (D1, D2)', () => {
  it('offers one Reconnect in its actions row, in the quiet look every connection has, and no Replace', async () => {
    await open('mailbox')
    expect(labels(part('actions'))).toEqual(['Reconnect'])
    expect(within(part('actions')!).getByRole('button', { name: 'Reconnect' }).className).toContain('cx-btn-quiet')
    expect(within(part('detail')!).queryByRole('button', { name: 'Replace' })).toBeNull()
  })

  it('checks the login again on one press, with no dialog: counting while it runs, then checked now', async () => {
    let answer: (v: Rechecked) => void = () => {}
    const { s, advance } = await open('mailbox', { reconnect: vi.fn(() => new Promise<Rechecked>((r) => { answer = r })) })
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(s.reconnect).toHaveBeenCalledWith('mailbox', {})
    advance(3_000)
    expect(within(part('detail')!).getByRole('status').textContent).toBe('Checking the login with Google, 3 s')
    expect((within(part('actions')!).getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => answer({ outcome: 'checked', connection: { id: 'mailbox', acts_as: 'ops@trypennie.com' } }))
    expect(part('save-line')).toBeNull()
    expect(part('status')!.textContent).toBe('Working')
    expect((within(part('actions')!).getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(false)
    expect(document.querySelector('[data-fact="Last checked"]')!.textContent).not.toContain('11 min ago')
  })

  it("a refused check says the route's own sentence in the panel, and Reconnect is ready again", async () => {
    const refusal = Object.assign(new Error('connection_needs_reauth'), { status: 422, body: { error: 'connection_needs_reauth', message: 'Google refused the login. Nothing was changed.' } })
    await open('mailbox', { reconnect: vi.fn(async () => { throw refusal }) })
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    await waitFor(() => expect(within(part('detail')!).getByRole('alert').textContent).toBe('Google refused the login. Nothing was changed.'))
    expect((within(part('actions')!).getByRole('button', { name: 'Reconnect' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a check that has not answered by its deadline says whether the login works is not known', async () => {
    const { advance } = await open('mailbox', { reconnect: vi.fn(() => new Promise<Rechecked>(() => {})) })
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    advance(CHANGE_DEADLINES.saveDeadlineMs)
    expect(within(part('detail')!).getByRole('alert').textContent).toBe(
      'The login check with Google did not answer within 120 seconds, so Bidspoke cannot tell whether the login works. Reload the page to see before reconnecting again.',
    )
  })
})

describe('a company mailbox Google refused (D3, D4)', () => {
  it('sends the person to the Workspace admin, then Reconnect, and offers no Replace', async () => {
    await open('refused')
    const lines = [...part('problem-notice')!.querySelectorAll('p')].map((p) => p.textContent)
    expect(lines).toEqual(['Since 9:12 AM ET, Google has refused its login.', 'Daily digest stops at its Google step.', FIX])
    expect(labels(part('problem-notice'))).toEqual(['Reconnect'])
    expect(within(part('detail')!).queryByRole('button', { name: 'Replace' })).toBeNull()
    // Nothing is left under the facts for an empty actions row to hold.
    expect(part('actions')).toBeNull()
  })

  it("the notice's Reconnect checks again with no dialog, and a check that passes clears the needs reconnecting mark", async () => {
    const { s } = await open('refused')
    fireEvent.click(within(part('problem-notice')!).getByRole('button', { name: 'Reconnect' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(s.reconnect).toHaveBeenCalledWith('refused', {})
    await waitFor(() => expect(part('status')!.textContent).toBe('Working'))
    expect(part('problem-notice')).toBeNull()
    expect(labels(part('actions'))).toEqual(['Reconnect'])
  })
})

describe('every other connection keeps its Reconnect and Replace (D5)', () => {
  it("a person's own Google connection still opens its sign in dialog, and keeps Replace", async () => {
    const { s } = await open('mine')
    expect(labels(part('actions'))).toEqual(['Reconnect', 'Replace'])
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    const dialog = screen.getByRole('dialog', { name: 'Reconnect My Google' })
    expect(within(dialog).getByRole('button', { name: 'Sign in with Google' })).toBeTruthy()
    expect(s.reconnect).not.toHaveBeenCalled()
  })

  it('a Salesforce connection still opens its Reconnect dialog, and keeps Replace', async () => {
    const { s } = await open('pennie')
    expect(labels(part('actions'))).toEqual(['Reconnect', 'Replace'])
    fireEvent.click(within(part('actions')!).getByRole('button', { name: 'Reconnect' }))
    expect(screen.getByRole('dialog', { name: 'Reconnect Pennie Salesforce' })).toBeTruthy()
    expect(s.reconnect).not.toHaveBeenCalled()
  })
})
