/**
 * The Connections page, part 1 (#2338, build PR 9), rendered: the loading line
 * counting its seconds, the could not load card at the deadline and its Try
 * again, the list and the chosen connection, the problem notice, Remove held
 * while a workflow uses it, the stale strip, History, and the Google list's
 * adds and refused removes. The clock is the test's, moved by hand.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionList, ConnectionListRow } from '@/lib/api'
import { CONNECTIONS_LIST_TIMEOUT_MS } from '@/lib/api'
import { ConnectionsScreen, LIST_DEADLINE_MS, type ConnectionsClock, type ConnectionsSource } from '../ConnectionsScreen'
import type { DelegationEntry } from '../connection-model'

vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))

const T0 = Date.parse('2026-10-20T16:00:00Z')

function manualClock() {
  let t = T0
  const timers = new Set<() => void>()
  const clock: ConnectionsClock = {
    now: () => t,
    every: (_ms, fn) => {
      timers.add(fn)
      return () => timers.delete(fn)
    },
  }
  return {
    clock,
    advance: (ms: number) => act(() => {
      t += ms
      for (const fn of [...timers]) fn()
    }),
  }
}

const row = (over: Partial<ConnectionListRow>): ConnectionListRow => ({
  id: 'pennie', name: 'Pennie Salesforce', service: 'salesforce', service_name: 'Salesforce', alert_login: false, acts_as: 'integration@trypennie.com', person_bound: false,
  owner: null, target: null, org: 'trypennie.my.salesforce.com', status: 'ok', status_word: 'Working',
  health: { ops_status: 'healthy', last_check_ok_at: '2026-10-20T15:56:00Z', last_check_failed_at: null, last_check_cause: null, needs_reauth_at: null, needs_reauth_cause: null },
  checked_at: '2026-10-20T15:56:00Z', used_by: 2, workflows: [{ id: 'w1', name: 'Lead Completed sync', deleted: false }, { id: 'w2', name: 'Tripoint submission', deleted: false }],
  created_at: '', updated_at: '', ...over,
})

const LIST: ConnectionList = {
  connections: [
    row({}),
    row({ id: 'spare', name: 'Spare Salesforce', used_by: 0, workflows: [] }),
    row({
      id: 'achieve', name: 'Achieve Salesforce', org: 'achieve.my.salesforce.com', status: 'reauth', status_word: 'Needs reconnecting', used_by: 1,
      workflows: [{ id: 'w3', name: 'Achieve report import', deleted: false }],
      health: { ops_status: 'needs_reauth', last_check_ok_at: null, last_check_failed_at: '2026-10-20T14:00:00Z', last_check_cause: null, needs_reauth_at: '2026-10-20T13:52:00Z', needs_reauth_cause: 'login_refused: invalid_client' },
    }),
  ],
  statuses: { as_of: '2026-10-20T16:00:00Z', stale: false, unavailable: null },
}

const ENTRY: DelegationEntry = { kind: 'mailbox', subject: 'ops@trypennie.com', display_name: null, added_by: 'Dan Wright', added_at: '2026-10-18T16:00:00Z' }

function source(over: Partial<ConnectionsSource> = {}): ConnectionsSource {
  return {
    list: vi.fn(async () => LIST),
    history: vi.fn(async () => ({ entries: [] })),
    googleSubjects: vi.fn(async () => ({ subjects: [ENTRY], reached_limit: false })),
    addGoogleSubject: vi.fn(async (b) => ({ outcome: 'added' as const, entry: { ...ENTRY, kind: b.kind, subject: b.subject } })),
    removeGoogleSubject: vi.fn(async () => ({ outcome: 'removed' as const })),
    ...over,
  }
}

const part = (name: string) => document.querySelector(`[data-part="${name}"]`) as HTMLElement | null

describe('the list load', () => {
  it('says it started and counts the seconds, with no Add connection until the list loads', async () => {
    const { clock, advance } = manualClock()
    render(<ConnectionsScreen source={source({ list: () => new Promise(() => {}) })} clock={clock} />)
    expect(screen.getByRole('status').textContent).toBe('Loading, 0 s')
    advance(4_000)
    expect(screen.getByRole('status').textContent).toBe('Loading, 4 s')
    expect(screen.queryByText('Add connection')).toBeNull()
  })

  it("turns into the could not load card at the deadline, and Try again loads the list", async () => {
    const { clock, advance } = manualClock()
    let calls = 0
    const list = vi.fn(() => (++calls === 1 ? new Promise<ConnectionList>(() => {}) : Promise.resolve(LIST)))
    render(<ConnectionsScreen source={source({ list })} clock={clock} />)
    advance(LIST_DEADLINE_MS)
    const card = part('load-failed')!
    expect(card.textContent).toContain("The connections could not be loaded: Bidspoke's server did not answer.")
    expect(screen.queryByText('Add connection')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(part('connection-list')).not.toBeNull())
    expect(list).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Add connection')).toBeTruthy()
  })

  it("waits as long as the request's own ceiling, so the card never says no answer while the call may still answer", () => {
    expect(LIST_DEADLINE_MS).toBe(CONNECTIONS_LIST_TIMEOUT_MS)
  })

  it("shows the route's own sentence when it answered a refusal, never a status code", async () => {
    const refused = Object.assign(new Error('connections_unavailable'), { status: 503, body: { error: 'connections_unavailable', message: 'The connections could not be read: the use counts read failed.' } })
    render(<ConnectionsScreen source={source({ list: () => Promise.reject(refused) })} clock={manualClock().clock} />)
    await waitFor(() => expect(part('load-failed')?.textContent).toContain('The connections could not be read: the use counts read failed.'))
    expect(part('load-failed')!.textContent).not.toContain('503')
  })
})

describe('the list and the chosen connection', () => {
  it('groups Needs attention first and opens its first connection, with its notice built from health', async () => {
    render(<ConnectionsScreen source={source()} clock={manualClock().clock} />)
    await waitFor(() => expect(part('detail')).not.toBeNull())
    const headings = [...document.querySelectorAll('[data-part="group-heading"]')].map((h) => h.textContent)
    expect(headings).toEqual(['Needs attention', 'Google', 'Salesforce'])
    expect(part('item-problem')!.textContent).toBe('Salesforce, needs reconnecting')
    expect(part('detail')!.querySelector('h2')!.textContent).toBe('Achieve Salesforce')
    const notice = part('problem-notice')!
    expect([...notice.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
      'Since 9:52 AM ET, Salesforce has refused its client secret.',
      'Achieve report import stops at its Salesforce step.',
      'Reconnect with a new client secret from the Salesforce admin of achieve.my.salesforce.com.',
    ])
    expect(part('status')!.textContent).toBe('Needs reconnecting')
  })

  it('holds Remove while a workflow uses the connection, naming each as a link, and offers it on an unused one', async () => {
    render(<ConnectionsScreen source={source()} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: 'pennie' }} />)
    await waitFor(() => expect(part('remove-row')).not.toBeNull())
    const remove = within(part('remove-row')!).getByRole('button', { name: 'Remove' }) as HTMLButtonElement
    expect(remove.disabled).toBe(true)
    expect(part('remove-row')!.textContent).toContain('Cannot be removed while a workflow uses it.')
    expect([...part('used-by')!.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([['Lead Completed sync', '/workflows/w1'], ['Tripoint submission', '/workflows/w2']])
    fireEvent.click(screen.getByRole('button', { name: 'Spare Salesforce' }))
    const spare = within(part('remove-row')!).getByRole('button', { name: 'Remove' }) as HTMLButtonElement
    expect(spare.disabled).toBe(false)
    expect(part('used-by')).toBeNull()
  })

  it('reads its History when the tab is opened, saying when it could not', async () => {
    const history = vi.fn(async () => { throw Object.assign(new Error('x'), { body: { message: "The connection's history could not be read." } }) })
    render(<ConnectionsScreen source={source({ history })} clock={manualClock().clock} initialChosen={{ kind: 'connection', id: 'pennie' }} />)
    await waitFor(() => expect(part('detail')).not.toBeNull())
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'History' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("The connection's history could not be read."))
    expect(history).toHaveBeenCalledWith('pennie')
  })
})

describe('the stale strip (R22)', () => {
  it('says the statuses are as of their time, keeps them shown, and Try again counts while it waits', async () => {
    const { clock, advance } = manualClock()
    const stale: ConnectionList = { ...LIST, statuses: { as_of: '2026-10-20T15:52:00Z', stale: true, unavailable: { cause: 'deadline', detail: '' } } }
    let calls = 0
    const list = vi.fn(() => (++calls === 1 ? Promise.resolve(stale) : new Promise<ConnectionList>(() => {})))
    render(<ConnectionsScreen source={source({ list })} clock={clock} />)
    await waitFor(() => expect(part('stale-strip')).not.toBeNull())
    expect(part('stale-strip')!.textContent).toContain('Login checks are not answering. Statuses are as of 11:52 AM ET.')
    expect(part('item-problem')).not.toBeNull()
    fireEvent.click(within(part('stale-strip')!).getByRole('button', { name: 'Try again' }))
    advance(3_000)
    expect(part('stale-strip')!.textContent).toContain('Trying again, 3 s')
    advance(LIST_DEADLINE_MS)
    expect(part('stale-strip')!.textContent).toContain("Trying again did not work: Bidspoke's server did not answer.")
    expect(part('connection-list')).not.toBeNull()
  })
})

describe('the Google list (R10)', () => {
  async function openGoogle(over: Partial<ConnectionsSource> = {}) {
    const s = source(over)
    const m = manualClock()
    render(<ConnectionsScreen source={s} clock={m.clock} initialChosen={{ kind: 'google' }} />)
    await waitFor(() => expect(part('subject-row')).not.toBeNull())
    return { s, ...m }
  }

  it('lists each entry on one row with who added it and when, and explains its term on the term itself', async () => {
    await openGoogle()
    const cells = [...part('subject-row')!.children].map((c) => c.textContent)
    expect(cells).toEqual(['ops@trypennie.com', 'Mailbox', 'Added by Dan Wright, Oct 18', 'Remove'])
    const term = part('term')!
    expect(term.tabIndex).toBe(0)
    expect(document.getElementById(term.getAttribute('aria-describedby')!)!.textContent).toMatch(/service account act as anyone in the company\.$/)
  })

  it('adds a typed address as a mailbox, counting while it waits, then lists it', async () => {
    let finish: (v: { outcome: 'added'; entry: DelegationEntry }) => void = () => {}
    const addGoogleSubject = vi.fn(() => new Promise<{ outcome: 'added'; entry: DelegationEntry }>((r) => { finish = r }))
    const { advance } = await openGoogle({ addGoogleSubject })
    fireEvent.change(screen.getByLabelText('Mailbox address'), { target: { value: 'reports@trypennie.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(addGoogleSubject).toHaveBeenCalledWith({ kind: 'mailbox', subject: 'reports@trypennie.com', display_name: null })
    advance(2_000)
    expect(screen.getByText('Adding reports@trypennie.com, 2 s')).toBeTruthy()
    await act(async () => finish({ outcome: 'added', entry: { ...ENTRY, subject: 'reports@trypennie.com' } }))
    expect(document.querySelectorAll('[data-part="subject-row"]')).toHaveLength(2)
  })

  it('adds a shared drive from its pasted address and a name, and refuses an address with no drive in it without calling the route', async () => {
    const { s } = await openGoogle()
    fireEvent.click(screen.getByRole('radio', { name: 'Shared drive' }))
    expect(screen.queryByLabelText('Mailbox address')).toBeNull()
    fireEvent.change(screen.getByLabelText('Shared drive address, from Google Drive'), { target: { value: 'https://drive.google.com/file/d/0AbCdEfGhIjKlMnOpQ/view' } })
    fireEvent.change(screen.getByLabelText('Drive name, shown on this list'), { target: { value: 'Partner reports' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('alert').textContent).toBe('That is not a Google Drive shared drive address.')
    expect(s.addGoogleSubject).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Shared drive address, from Google Drive'), { target: { value: 'https://drive.google.com/drive/u/0/folders/0AbCdEfGhIjKlMnOpQ?usp=sharing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(s.addGoogleSubject).toHaveBeenCalledWith({ kind: 'drive', subject: '0AbCdEfGhIjKlMnOpQ', display_name: 'Partner reports' })
  })

  it("shows a refused removal's sentence, naming what uses the entry, and keeps the entry", async () => {
    const refusal = Object.assign(new Error('delegation_subject_in_use'), { status: 409, body: { error: 'delegation_subject_in_use', message: 'ops@trypennie.com cannot be removed while the connection Ops mailbox acts as it.' } })
    await openGoogle({ removeGoogleSubject: vi.fn(async () => { throw refusal }) })
    fireEvent.click(screen.getByRole('button', { name: 'Remove ops@trypennie.com' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('ops@trypennie.com cannot be removed while the connection Ops mailbox acts as it.'))
    expect(part('subject-row')).not.toBeNull()
  })

  it('says the list could not be read, never an empty list, with Try again', async () => {
    const googleSubjects = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { timedOut: true, timeoutMs: 30_000 }))
      .mockResolvedValueOnce({ subjects: [ENTRY], reached_limit: false })
    render(<ConnectionsScreen source={source({ googleSubjects })} clock={manualClock().clock} initialChosen={{ kind: 'google' }} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The company list could not be read: the server did not answer within 30 seconds.'))
    fireEvent.click(within(part('google-subjects')!).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(part('subject-row')).not.toBeNull())
  })
})
