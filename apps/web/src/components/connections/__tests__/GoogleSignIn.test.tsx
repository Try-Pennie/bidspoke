/**
 * Sign in with your own Google account on the Connections page (#2338, build
 * PR 13; R17, R18): the add form's Google button and a Reconnect of an own
 * account connection each ask the Worker for Google's link, show it starting,
 * go to Google once nothing on the page would be lost, and say why when the
 * Worker refuses; the callback route hands what Google said back to
 * Connections, which finishes the sign in once, in the form or Reconnect dialog
 * it started from, opens the saved connection, or says why nothing was saved
 * (D1, D2).
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Component, StrictMode, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import { ConnectionsScreen, type ConnectionsClock, type ConnectionsSource } from '../ConnectionsScreen'
import { NO_SIGN_IN, signInReturnHref, signInReturnOf, type SignInReturn } from '../google-sign-in-return'
import { keptSignInsIn, type KeptSignIns } from '../google-sign-in-kept'
import { catalogueServices } from '../add-form-model'

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

/** Draws what a child threw, as the app's error boundary would, so the test can read it. */
class Caught extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() { return this.state.error ? <p role="alert">{this.state.error.message}</p> : this.props.children }
}

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
    finishGoogleSignIn: vi.fn(async () => { throw new Error('not called') }),
    goTo: vi.fn(),
    keptSignIns: memoryKept(),
    ...over,
  }
}

/** The kept form values in memory, as the page keeps them in the tab's session storage. */
function memoryKept(): KeptSignIns {
  const m = new Map<string, string>()
  return keptSignInsIn({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, removeItem: (k) => { m.delete(k) } })
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

describe('the callback route hands the result back to Connections (D1, Dan 2026-10-23)', () => {
  const params = (q: string) => new URLSearchParams(q)

  it('reads what Google put on its address', () => {
    expect(signInReturnOf(params('state=s1&code=c1&scope=x'))).toEqual({ state: 's1', body: { state: 's1', code: 'c1' } })
    expect(signInReturnOf(params('state=s1&error=access_denied'))).toEqual({ state: 's1', body: { state: 's1', error: 'access_denied' } })
    expect(signInReturnOf(params('code=c1'))).toEqual({ state: null, body: null })
    expect(signInReturnOf(params('state=s1'))).toEqual({ state: 's1', body: null })
    expect(signInReturnOf(null)).toEqual({ state: null, body: null })
  })

  it('sends the browser to Connections carrying only what Google said, so the Connections page finishes it', () => {
    const href = new URL(signInReturnHref(params('state=s1&code=c1&scope=x&authuser=0')), 'https://x.example')
    expect(href.pathname).toBe('/connections')
    expect(Object.fromEntries(href.searchParams)).toEqual({ google_sign_in: 'return', state: 's1', code: 'c1' })
    expect(Object.fromEntries(new URL(signInReturnHref(params('state=s1&error=access_denied')), 'https://x.example').searchParams))
      .toEqual({ google_sign_in: 'return', state: 's1', error: 'access_denied' })
    expect(signInReturnHref(params(''))).toBe('/connections?google_sign_in=return')
  })

  it('keeps a start\'s form values under its state, once, and never throws when storage does', () => {
    const kept = memoryKept()
    kept.keep('s1', { kind: 'new', name: 'My Google 2' })
    expect(kept.take('s1')).toEqual({ kind: 'new', name: 'My Google 2' })
    expect(kept.take('s1')).toBeNull()
    const broken = keptSignInsIn({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } })
    expect(() => broken.keep('s1', { kind: 'new', name: 'x' })).not.toThrow()
    expect(broken.take('s1')).toBeNull()
  })
})

describe('back on Connections from Google (D1, D2, Dan 2026-10-23)', () => {
  const DECLINED = refusal('google_sign_in_denied', 'You did not allow Bidspoke into your Google account. Nothing was saved. Sign in with Google again and allow it to connect.')

  async function cameBack(ret: SignInReturn, over: Partial<ConnectionsSource> = {}, kept?: Parameters<KeptSignIns['keep']>[1]) {
    const clock = manualClock()
    const s = source(over)
    if (kept && ret.state) s.keptSignIns.keep(ret.state, kept)
    render(<ConnectionsScreen source={s} clock={clock.clock} signInReturn={ret} />)
    await waitFor(() => expect(s.list).toHaveBeenCalled())
    return { s, ...clock }
  }
  const field = (label: string) => document.querySelector(`[data-part="add-form"] [data-field="${label}"]`) as HTMLElement

  it('a sign in you declined lands back in the add form you left, everything kept, the reason in red right under the buttons', async () => {
    const { s } = await cameBack({ state: 's1', body: { state: 's1', error: 'access_denied' } }, { finishGoogleSignIn: vi.fn(async () => { throw DECLINED }) }, { kind: 'new', name: 'My Google 2' })
    await waitFor(() => expect(part('save-line')?.getAttribute('data-state')).toBe('failed'))
    expect(s.finishGoogleSignIn).toHaveBeenCalledWith({ state: 's1', error: 'access_denied' })
    const form = part('add-form')!
    expect(form.querySelector('[data-part="service-tile"][data-chosen="true"]')!.getAttribute('data-service')).toBe('Google')
    expect((within(field('Name')).getByRole('textbox') as HTMLInputElement).value).toBe('My Google 2')
    expect(screen.getByRole('radio', { name: 'My own Google account' })).toBeChecked()
    const line = part('save-line')!
    expect(line.textContent).toBe(DECLINED.body.message)
    // D2: the product's error red, FieldError.
    expect(line).toHaveClass('field-error')
    // Directly under the Sign in with Google and Cancel row, with no separate page and no way back to name.
    expect(form.querySelector('.ad-foot')!.nextElementSibling).toBe(line)
    expect(screen.queryByRole('link', { name: 'Back to Connections' })).toBeNull()
    expect((within(form).getByRole('button', { name: 'Sign in with Google' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the finish running in the same spot, counting, then opens the new connection with no message', async () => {
    let answer: (v: unknown) => void = () => {}
    const finishGoogleSignIn = vi.fn(() => new Promise((r) => { answer = r }))
    const { advance } = await cameBack({ state: 's1', body: { state: 's1', code: 'c1' } }, { finishGoogleSignIn: finishGoogleSignIn as ConnectionsSource['finishGoogleSignIn'] }, { kind: 'new', name: 'My Google 2' })
    await waitFor(() => expect(part('save-line')?.getAttribute('data-state')).toBe('saving'))
    advance(3_000)
    expect(part('save-line')!.textContent).toBe('Finishing the sign in with Google, 3 s')
    expect(part('add-form')!.querySelector('.ad-foot')!.nextElementSibling).toBe(part('save-line'))
    await act(async () => answer({ outcome: 'created', connection: { id: 'new-own', name: 'My Google 2', service: 'google', acts_as: 'dan@trypennie.com' } }))
    expect(part('add-form')).toBeNull()
    expect(document.querySelector('[data-part="list-item"][data-selected="true"]')!.getAttribute('data-name')).toBe('My Google 2')
  })

  it('a Reconnect\'s failure lands in that connection\'s Reconnect dialog, where it started', async () => {
    await cameBack({ state: 's2', body: { state: 's2', error: 'access_denied' } }, { finishGoogleSignIn: vi.fn(async () => { throw DECLINED }) }, { kind: 'reconnect', connectionId: 'mine' })
    const dialog = await screen.findByRole('dialog', { name: 'Reconnect My Google' })
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe(DECLINED.body.message))
    expect(part('add-form')).toBeNull()
  })

  it('a return whose kept values are gone still lands in the Google form, own account chosen, with the reason', async () => {
    await cameBack({ state: 's3', body: { state: 's3', error: 'access_denied' } }, { finishGoogleSignIn: vi.fn(async () => { throw DECLINED }) })
    await waitFor(() => expect(part('save-line')?.textContent).toBe(DECLINED.body.message))
    expect(part('add-form')!.querySelector('[data-part="service-tile"][data-chosen="true"]')!.getAttribute('data-service')).toBe('Google')
    expect(screen.getByRole('radio', { name: 'My own Google account' })).toBeChecked()
  })

  it('a return carrying no sign in asks nothing and says so in the form', async () => {
    const { s } = await cameBack({ state: null, body: null })
    await waitFor(() => expect(part('save-line')?.textContent).toBe(NO_SIGN_IN))
    expect(s.finishGoogleSignIn).not.toHaveBeenCalled()
  })

  it('finishes once, however often the page draws', async () => {
    const finishGoogleSignIn = vi.fn(async () => { throw DECLINED })
    const s = source({ finishGoogleSignIn })
    const ret: SignInReturn = { state: 's1', body: { state: 's1', error: 'access_denied' } }
    render(<StrictMode><ConnectionsScreen source={s} clock={manualClock().clock} signInReturn={ret} /></StrictMode>)
    await waitFor(() => expect(part('save-line')?.getAttribute('data-state')).toBe('failed'))
    expect(finishGoogleSignIn).toHaveBeenCalledTimes(1)
  })

  it('a Reconnect whose kept values are gone still ends: the form closes and that connection opens, working', async () => {
    await cameBack({ state: 's4', body: { state: 's4', code: 'c1' } }, {
      finishGoogleSignIn: vi.fn(async () => ({ outcome: 'reconnected' as const, connection: { id: 'mine', acts_as: 'dan@trypennie.com' }, cleared: true })),
    })
    await waitFor(() => expect(part('add-form')).toBeNull())
    const chosen = document.querySelector('[data-part="list-item"][data-selected="true"]')!
    expect(chosen.getAttribute('data-name')).toBe('My Google')
    expect(chosen.textContent).not.toMatch(/reconnecting/i)
  })

  it('a page with no Google to draw fails loudly before it spends the sign in, never finishing into nothing', async () => {
    const s = source({ finishGoogleSignIn: vi.fn(async () => ({ outcome: 'created' as const, connection: { id: 'new-own', name: 'My Google 2', service: 'google', acts_as: 'dan@trypennie.com' } })) })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(<Caught><ConnectionsScreen source={s} clock={manualClock().clock} services={catalogueServices().filter((x) => x.key !== 'google')} signInReturn={{ state: 's5', body: { state: 's5', code: 'c1' } }} /></Caught>)
      expect((await screen.findByRole('alert')).textContent).toBe('The Connections page has no Google service to finish a sign in with')
      expect(s.finishGoogleSignIn).not.toHaveBeenCalled()
    } finally {
      quiet.mockRestore()
    }
  })

  it('finishes once even when the page is drawn again with new props after the list has loaded', async () => {
    // The state is single use, so a second finish would replace the real reason with "already used".
    const finishGoogleSignIn = vi.fn(async () => { throw DECLINED })
    const s = source({ finishGoogleSignIn })
    const ret: SignInReturn = { state: 's1', body: { state: 's1', error: 'access_denied' } }
    const { rerender } = render(<ConnectionsScreen source={s} clock={manualClock().clock} signInReturn={ret} />)
    await waitFor(() => expect(part('save-line')?.getAttribute('data-state')).toBe('failed'))
    rerender(<ConnectionsScreen source={{ ...s }} clock={manualClock().clock} signInReturn={ret} />)
    await act(async () => {})
    expect(finishGoogleSignIn).toHaveBeenCalledTimes(1)
    expect(part('save-line')!.textContent).toBe(DECLINED.body.message)
  })

  it('a start keeps the form\'s values under the state its link names, for the return', async () => {
    const { s } = await openOwnAccountForm()
    fireEvent.click(within(part('add-form')!).getByRole('button', { name: 'Sign in with Google' }))
    await waitFor(() => expect(s.goTo).toHaveBeenCalled())
    expect(s.keptSignIns.take('s')).toEqual({ kind: 'new', name: 'My Google 2' })
  })
})
