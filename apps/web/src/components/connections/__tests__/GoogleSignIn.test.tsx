/**
 * Sign in with your own Google account on the Connections page (#2338, build
 * PR 13; R17, R18): the add form's Google button and a Reconnect of an own
 * account connection each ask the Worker for Google's link, show it starting,
 * go to Google once nothing on the page would be lost, and say why when the
 * Worker refuses; and the callback page finishes the sign in once, opens the
 * saved connection, or says why nothing was saved.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import { ConnectionsScreen, type ConnectionsClock, type ConnectionsSource } from '../ConnectionsScreen'
import { GoogleSignInReturn, NO_SIGN_IN, signInReturnOf } from '../GoogleSignInReturn'
import { GoogleSignInPreview } from '@/app/dev/google-sign-in/GoogleSignInPreview'

const T0 = Date.parse('2026-10-20T16:00:00Z')
const LINK = 'https://accounts.google.com/o/oauth2/v2/auth?state=s'

function manualClock() {
  let t = T0
  const timers = new Set<() => void>()
  const clock: ConnectionsClock = { now: () => t, every: (_ms, fn) => { timers.add(fn); return () => timers.delete(fn) } }
  return { clock, advance: (ms: number) => act(() => { t += ms; for (const fn of [...timers]) fn() }) }
}

const row = (over: Partial<ConnectionListRow>): ConnectionListRow => ({
  id: 'mine', name: 'My Google', service: 'google', service_name: 'Google', alert_login: false, acts_as: 'dan@trypennie.com', person_bound: true,
  owner: { user_id: 'u1', name: 'Dan Wright', email: 'dan@trypennie.com' }, target: { own_account: true }, org: null, status: 'reauth', status_word: 'Needs reconnecting',
  health: { ops_status: 'needs_reauth', last_check_ok_at: null, last_check_failed_at: null, last_check_cause: null, needs_reauth_at: '2026-10-20T13:52:00Z', needs_reauth_cause: 'login_refused: invalid_grant' },
  checked_at: null, used_by: 0, workflows: [], created_at: '', updated_at: '', ...over,
})

const LIST: ConnectionList = { connections: [row({})], statuses: { as_of: '2026-10-20T16:00:00Z', stale: false, unavailable: null } }

const refusal = (error: string, message: string) => Object.assign(new Error(error), { status: 503, body: { error, message } })

function source(over: Partial<ConnectionsSource> = {}): ConnectionsSource {
  return {
    list: vi.fn(async () => LIST),
    history: vi.fn(async () => ({ entries: [] })),
    googleSubjects: vi.fn(async () => ({ subjects: [], reached_limit: false })),
    addGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    removeGoogleSubject: vi.fn(async () => { throw new Error('not called') }),
    create: vi.fn(async () => { throw new Error('a sign in never saves through the form') }),
    reconnect: vi.fn(async () => { throw new Error('an own account never reconnects through the form') }),
    remove: vi.fn(async () => ({ outcome: 'removed' as const, ops: { told: true as const } })),
    slackAlerts: vi.fn(async () => ({ connected: false })),
    updateSlackAlerts: vi.fn(async () => ({ ok: true })),
    searchSlackChannels: vi.fn(async () => ({ channels: [] })),
    startGoogleSignIn: vi.fn(async () => ({ url: LINK })),
    goTo: vi.fn(),
    ...over,
  }
}

const part = (name: string) => document.querySelector(`[data-part="${name}"]`) as HTMLElement | null

async function openOwnAccountForm(over: Partial<ConnectionsSource> = {}) {
  const clock = manualClock()
  const s = source(over)
  render(<ConnectionsScreen source={s} clock={clock.clock} initialChosen={{ kind: 'connection', id: 'mine' }} />)
  await waitFor(() => expect(part('add-connection')).not.toBeNull())
  fireEvent.click(part('add-connection')!)
  fireEvent.click(within(part('add-form')!).getByRole('button', { name: /^Google/ }))
  fireEvent.change(within(document.querySelector('[data-part="add-form"] [data-field="Name"]') as HTMLElement).getByRole('textbox'), { target: { value: 'My Google 2' } })
  fireEvent.click(screen.getByRole('radio', { name: 'My own Google account' }))
  return { s, ...clock }
}

describe('Sign in with Google on the add form (R17)', () => {
  it('asks the Worker for Google\'s link with the name typed, says it is opening Google, and goes there once the form has closed', async () => {
    let answer: (v: { url: string }) => void = () => {}
    const startGoogleSignIn = vi.fn(() => new Promise<{ url: string }>((r) => { answer = r }))
    const { s, advance } = await openOwnAccountForm({ startGoogleSignIn })
    const button = within(part('add-form')!).getByRole('button', { name: 'Sign in with Google' })
    fireEvent.click(button)
    expect(startGoogleSignIn).toHaveBeenCalledWith({ name: 'My Google 2' })
    advance(2_000)
    expect(part('save-line')!.textContent).toBe('Opening Google, 2 s')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(startGoogleSignIn).toHaveBeenCalledTimes(1)
    expect(s.goTo).not.toHaveBeenCalled()
    await act(async () => answer({ url: LINK }))
    await waitFor(() => expect(s.goTo).toHaveBeenCalledWith(LINK))
    expect(part('add-form')).toBeNull()
    expect(s.create).not.toHaveBeenCalled()
  })

  it('Cancel while the link is fetched goes nowhere when it arrives', async () => {
    let answer: (v: { url: string }) => void = () => {}
    const { s } = await openOwnAccountForm({ startGoogleSignIn: vi.fn(() => new Promise<{ url: string }>((r) => { answer = r })) })
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Sign in with Google' }))
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Cancel' }))
    await act(async () => answer({ url: LINK }))
    expect(s.goTo).not.toHaveBeenCalled()
  })

  it('a refusal turns the line red with the Worker\'s own sentence, goes nowhere, and the button is ready again', async () => {
    const { s } = await openOwnAccountForm({
      startGoogleSignIn: vi.fn(async () => { throw refusal('google_sign_in_unset', 'Sign in with Google is not set up on Bidspoke yet. Nothing was saved. Ask Dan to set it up.') }),
    })
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Sign in with Google' }))
    await waitFor(() => expect(part('save-line')?.getAttribute('data-state')).toBe('failed'))
    expect(part('save-line')!.textContent).toBe('Sign in with Google is not set up on Bidspoke yet. Nothing was saved. Ask Dan to set it up.')
    expect(s.goTo).not.toHaveBeenCalled()
    expect((within(part('add-form')!).getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('Reconnect of a person\'s own Google account', () => {
  async function openReconnect(over: Partial<ConnectionsSource> = {}) {
    const s = source(over)
    render(<ConnectionsScreen source={s} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: 'mine' }} />)
    await waitFor(() => expect(part('detail')).not.toBeNull())
    fireEvent.click(within(part('detail')!).getAllByRole('button', { name: 'Reconnect' })[0])
    return { s, dialog: screen.getByRole('dialog', { name: 'Reconnect My Google' }) }
  }

  it('says its sign in was revoked or has expired, and that signing in again fixes it', async () => {
    const s = source()
    render(<ConnectionsScreen source={s} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: 'mine' }} />)
    await waitFor(() => expect(part('detail')).not.toBeNull())
    expect(part('detail')!.textContent).toContain('Google has refused its sign in, which was revoked or has expired.')
    expect(part('detail')!.textContent).toContain('Reconnect to sign in with Google again.')
  })

  it('offers Google\'s own button in place of Save, which signs the same connection in again', async () => {
    const { s, dialog } = await openReconnect()
    expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with Google' }))
    expect(s.startGoogleSignIn).toHaveBeenCalledWith({ connection_id: 'mine' })
    await waitFor(() => expect(s.goTo).toHaveBeenCalledWith(LINK))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(s.reconnect).not.toHaveBeenCalled()
  })

  it('Cancel while the link is fetched goes nowhere when it arrives', async () => {
    let answer: (v: { url: string }) => void = () => {}
    const { s, dialog } = await openReconnect({ startGoogleSignIn: vi.fn(() => new Promise<{ url: string }>((r) => { answer = r })) })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with Google' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await act(async () => answer({ url: LINK }))
    expect(s.goTo).not.toHaveBeenCalled()
  })

  it('a refusal stays in the dialog with its sentence', async () => {
    const { s, dialog } = await openReconnect({
      startGoogleSignIn: vi.fn(async () => { throw refusal('google_sign_in_not_owner', 'Only the person this connection signs in as can reconnect it. Nothing was changed. Ask them to reconnect it, or add your own.') }),
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign in with Google' }))
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/^Only the person this connection signs in as/))
    expect(s.goTo).not.toHaveBeenCalled()
  })
})

describe('the callback page', () => {
  const params = (q: string) => new URLSearchParams(q)

  it('reads what Google put on its address', () => {
    expect(signInReturnOf(params('state=s1&code=c1&scope=x'))).toEqual({ kind: 'finish', body: { state: 's1', code: 'c1' } })
    expect(signInReturnOf(params('state=s1&error=access_denied'))).toEqual({ kind: 'finish', body: { state: 's1', error: 'access_denied' } })
    expect(signInReturnOf(params('code=c1'))).toEqual({ kind: 'empty' })
    expect(signInReturnOf(params('state=s1'))).toEqual({ kind: 'empty' })
    expect(signInReturnOf(null)).toEqual({ kind: 'empty' })
  })

  it('finishes once, even when React runs its effect twice, then opens the saved connection', async () => {
    let answer: (v: { connection: { id: string } }) => void = () => {}
    const finish = vi.fn(() => new Promise<{ connection: { id: string } }>((r) => { answer = r }))
    const open = vi.fn()
    render(<StrictMode><GoogleSignInReturn ret={{ kind: 'finish', body: { state: 's1', code: 'c1' } }} finish={finish} open={open} now={() => T0} /></StrictMode>)
    expect(screen.getByRole('status').textContent).toMatch(/^Finishing the sign in with Google/)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledWith({ state: 's1', code: 'c1' })
    await act(async () => answer({ connection: { id: 'new1' } }))
    expect(open).toHaveBeenCalledWith('new1')
  })

  it('says why nothing was saved in the route\'s own sentence, with the way back', async () => {
    const finish = vi.fn(async () => { throw refusal('google_sign_in_denied', 'You did not allow Bidspoke into your Google account. Nothing was saved. Sign in with Google again and allow it to connect.') })
    const open = vi.fn()
    render(<GoogleSignInReturn ret={{ kind: 'finish', body: { state: 's1', error: 'access_denied' } }} finish={finish} open={open} now={() => T0} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/^You did not allow Bidspoke/))
    expect(screen.getByRole('link', { name: 'Back to Connections' }).getAttribute('href')).toBe('/connections')
    expect(open).not.toHaveBeenCalled()
  })

  it.each([
    ['working', /^Finishing the sign in with Google/],
    ['failed', /^You did not allow Bidspoke/],
    ['empty', /^This page holds no sign in/],
  ] as const)('the screenshot preview draws the %s state with no call to the Worker', async (frame, words) => {
    render(<GoogleSignInPreview frame={frame} />)
    await waitFor(() => expect((screen.queryByRole('alert') ?? screen.getByRole('status')).textContent).toMatch(words))
  })

  it('an address with no sign in asks nothing and says so', () => {
    const finish = vi.fn()
    render(<GoogleSignInReturn ret={{ kind: 'empty' }} finish={finish} open={vi.fn()} now={() => T0} />)
    expect(screen.getByRole('alert').textContent).toBe(NO_SIGN_IN)
    expect(finish).not.toHaveBeenCalled()
  })
})
