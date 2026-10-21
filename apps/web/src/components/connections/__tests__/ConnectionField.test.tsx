/**
 * The step form's Connection field (#2338 build PR 11, R8, D8), rendered: the
 * app's dropdown showing the chosen connection's name with who it acts as under
 * it, nothing about status while it works, one red line with its status and a
 * link to where it is fixed when it has a problem; and the list's own states
 * (loading with its seconds, failed with Try again, the deadline, empty), a
 * connection the list no longer holds, and nothing chosen. The clock is the
 * test's, moved by hand (L524).
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CONNECTION_STATUS_WORDS } from '@bidspoke/service-catalogue/schema'
import { CONNECTIONS_LIST_TIMEOUT_MS, type ConnectionList, type ConnectionListRow } from '@/lib/api'
import type { ComboboxClock } from '@/components/ui/Combobox'
import { ConnectionField } from '../ConnectionField'

vi.mock('next/link', () => ({ default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => <a href={href} className={className}>{children}</a> }))
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), api: { connections: { list: () => { throw new Error('the field called the live list') } } } }))

/** A clock the test moves by hand: timers fire only inside advance(). */
class ManualClock implements ComboboxClock {
  private t = 0
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  now() { return this.t }
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.timers.set(id, { at: this.t + ms, fn }); return id }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number) }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.t = due[1].at
      act(() => due[1].fn())
    }
    this.t = end
  }
}

const row = (over: Partial<ConnectionListRow>): ConnectionListRow => ({
  id: 'c-pennie', name: 'Pennie Salesforce', service: 'salesforce', service_name: 'Salesforce', alert_login: false, acts_as: 'integration@trypennie.com', person_bound: false,
  owner: null, target: null, org: 'trypennie.my.salesforce.com', status: 'ok', status_word: 'Working', health: null, used_by: 1, workflows: [],
  created_at: '', updated_at: '', ...over,
})

const LIST: ConnectionList = {
  connections: [
    row({}),
    row({ id: 'c-achieve', name: 'Achieve Salesforce', acts_as: 'pennie.api@achieve.example', status: 'reauth', status_word: 'Needs reconnecting' }),
    row({ id: 'c-lendco', name: 'Lendco Salesforce', acts_as: 'api@lendco.example', status: 'failing', status_word: 'Check failing' }),
    row({ id: 'c-warehouse', name: 'Warehouse', service: 'snowflake', service_name: 'Snowflake', acts_as: 'BIDSPOKE' }),
    row({ id: 'c-slack', name: 'Bidspoke Alerts', service: 'slack', service_name: 'Slack', alert_login: true, acts_as: null, status: null, status_word: null }),
  ],
  statuses: { as_of: null, stale: false, unavailable: null },
}

function Step({ value: start = null, loadList = async () => LIST, clock, onPicked }: {
  value?: string | null
  loadList?: () => Promise<ConnectionList>
  clock?: ComboboxClock
  onPicked?: (id: string) => void
}) {
  const [value, setValue] = useState<string | null>(start)
  return (
    <form onSubmit={(e) => { e.preventDefault(); throw new Error('the form was submitted') }}>
      <ConnectionField id="step-connection" service="salesforce" value={value} onChange={(id) => { setValue(id); onPicked?.(id) }} loadList={loadList} clock={clock} />
      <output data-testid="stored">{value ?? ''}</output>
    </form>
  )
}

const box = () => screen.getByRole('combobox', { name: 'Connection' })
const field = () => document.querySelector('[data-part="connection-field"]') as HTMLElement
/** Each line under the dropdown as read, the dropdown's own text and the label left out. */
const lines = () => [...field().querySelectorAll('p, [data-part]')]
  .filter((e) => !e.closest('button') && e.textContent?.trim() && e.getAttribute('data-part') !== 'connection-field' && e.tagName !== 'LABEL')
  .map((e) => e.textContent?.replace(/\s+/g, ' ').trim())
const settle = () => act(async () => {})

describe('the step form Connection field', () => {
  it("a working connection: the dropdown reads its name, with only who it acts as under it", async () => {
    render(<Step value="c-pennie" />)
    await settle()
    expect(box()).toHaveTextContent('Pennie Salesforce')
    expect(lines()).toEqual(['Acts as integration@trypennie.com'])
    expect(field().querySelector('a')).toBeNull()
    expect(field().querySelector('[data-part="connection-problem"]')).toBeNull()
  })

  it("a connection needing reconnecting adds one red line, the catalogue's word then where it is fixed, linking to that connection", async () => {
    render(<Step value="c-achieve" />)
    await settle()
    expect(box()).toHaveTextContent('Achieve Salesforce')
    const want = `${CONNECTION_STATUS_WORDS.reauth} on the Connections page`
    expect(lines()).toEqual(['Acts as pennie.api@achieve.example', want])
    const problem = field().querySelector('[data-part="connection-problem"]') as HTMLElement
    expect(problem).toHaveClass('field-error')
    expect(problem).toHaveTextContent(want)
    const link = within(problem).getByRole('link', { name: 'Connections page' })
    expect(link).toHaveAttribute('href', '/connections?connection=c-achieve')
    // The dropdown is described by the line, so a screen reader hears the status with the field.
    expect(box().getAttribute('aria-describedby')?.split(' ')).toContain(problem.id)
  })

  it('a connection whose check is failing reads "Check failing on the Connections page" (Dan, 2026-10-20)', async () => {
    render(<Step value="c-lendco" />)
    await settle()
    expect(lines()).toEqual(['Acts as api@lendco.example', `${CONNECTION_STATUS_WORDS.failing} on the Connections page`])
    expect(within(field()).getByRole('link', { name: 'Connections page' })).toHaveAttribute('href', '/connections?connection=c-lendco')
  })

  it("offers the service's connections only, by name with who each acts as, and stores the chosen one's id", async () => {
    const onPicked = vi.fn()
    render(<Step onPicked={onPicked} />)
    await settle()
    expect(box()).toHaveTextContent('Choose a connection')
    expect(lines()).toEqual([])
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    const options = within(screen.getByRole('listbox')).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Achieve SalesforceActs as pennie.api@achieve.example',
      'Lendco SalesforceActs as api@lendco.example',
      'Pennie SalesforceActs as integration@trypennie.com',
    ])
    fireEvent.mouseDown(options[2])
    expect(onPicked).toHaveBeenCalledWith('c-pennie')
    expect(screen.getByTestId('stored')).toHaveTextContent('c-pennie')
    expect(box()).toHaveTextContent('Pennie Salesforce')
    expect(lines()).toEqual(['Acts as integration@trypennie.com'])
  })

  it('loads the list once, the menu showing the same load as the field', async () => {
    const loadList = vi.fn(async () => LIST)
    render(<Step value="c-pennie" loadList={loadList} />)
    await settle()
    fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(loadList).toHaveBeenCalledTimes(1)
  })

  it('while the list loads, says so with the seconds counted, and never shows the stored id', () => {
    const clock = new ManualClock()
    render(<Step value="c-pennie" loadList={() => new Promise(() => {})} clock={clock} />)
    expect(box()).toHaveTextContent(/^$/)
    expect(field()).not.toHaveTextContent('c-pennie')
    expect(within(field()).getByRole('status')).toHaveTextContent('Loading the connections, 0 s')
    clock.advance(6000)
    expect(within(field()).getByRole('status')).toHaveTextContent('Loading the connections, 6 s')
  })

  it("at the list's deadline the wait becomes the error, in the page's words, with Try again", async () => {
    const clock = new ManualClock()
    let calls = 0
    const loadList = () => { calls += 1; return calls === 1 ? new Promise<ConnectionList>(() => {}) : Promise.resolve(LIST) }
    render(<Step value="c-pennie" loadList={loadList} clock={clock} />)
    clock.advance(CONNECTIONS_LIST_TIMEOUT_MS - 1)
    expect(within(field()).queryByRole('alert')).toBeNull()
    clock.advance(1)
    expect(within(field()).getByRole('alert')).toHaveTextContent("The connections could not be loaded: Bidspoke's server did not answer.")
    expect(within(field()).queryByRole('status')).toBeNull()
    fireEvent.click(within(field()).getByRole('button', { name: 'Try again' }))
    await settle()
    expect(box()).toHaveTextContent('Pennie Salesforce')
    expect(within(field()).queryByRole('alert')).toBeNull()
  })

  it("a refused load says the route's own sentence; one with no answer says the server did not answer; never a raw error", async () => {
    const refused = Object.assign(new Error('HTTP 401'), { body: { message: 'Your sign in has ended. Sign in again.' } })
    const { unmount } = render(<Step value="c-pennie" loadList={async () => { throw refused }} />)
    await settle()
    expect(within(field()).getByRole('alert')).toHaveTextContent(/^Your sign in has ended\. Sign in again\.$/)
    unmount()
    render(<Step value="c-pennie" loadList={async () => { throw new TypeError('Failed to fetch') }} />)
    await settle()
    const alert = within(field()).getByRole('alert')
    expect(alert).toHaveTextContent("The connections could not be loaded: Bidspoke's server did not answer.")
    expect(alert).not.toHaveTextContent('fetch')
    expect(box()).toHaveTextContent(/^$/)
  })

  it('with no connection of the service yet, says where one is added', async () => {
    render(<Step loadList={async () => ({ ...LIST, connections: LIST.connections.filter((c) => c.service !== 'salesforce') })} />)
    await settle()
    expect(lines()).toEqual(['No Salesforce connection yet. Add one on the Connections page.'])
    expect(within(field()).getByRole('link', { name: 'Connections page' })).toHaveAttribute('href', '/connections')
    expect(field().querySelector('.field-error')).toBeNull()
  })

  it('a chosen connection the list no longer holds says so in red, with the placeholder and never the id', async () => {
    render(<Step value="c-removed" />)
    await settle()
    expect(box()).toHaveTextContent('Choose a connection')
    expect(lines()).toEqual(['The connection this step used no longer exists. Choose another.'])
    expect(field().querySelector('.field-error')).not.toBeNull()
    expect(field()).not.toHaveTextContent('c-removed')
  })

  it('never calls the live list when given its own loader, and holds Enter from submitting the step form', async () => {
    render(<Step value="c-pennie" />)
    await settle()
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(screen.getByTestId('stored')).toHaveTextContent('c-pennie')
  })
})
