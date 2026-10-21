/**
 * The Combobox (#2338 PR 8, R15, L607, L568, L611): the design system's
 * dropdown for a list that is looked up while the page is open, such as the
 * orgs Bidspoke knows for a Salesforce connection. Its list comes from an
 * async loader, so it has states a plain Select does not: loading, slow,
 * failed (with Try again, never an empty list, L10), stalled, and empty. And
 * it can take a typed value as a new option, as round 25 settled for an org
 * Bidspoke does not know.
 *
 * The clock is injected (L524), so the slow and stalled states are driven
 * here by moving a manual clock, never by waiting.
 */
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { useState } from 'react'
import { act, render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Combobox, type ComboboxClock, type ComboboxOption } from '../Combobox'
import { Field } from '../form'

const ORGS: ComboboxOption[] = [
  { value: 'achieve', label: 'Achieve', hint: 'achieve.my.salesforce.com' },
  { value: 'pennie', label: 'Pennie', hint: 'trypennie.my.salesforce.com' },
  { value: 'pathway', label: 'Pathway', hint: 'pathway.my.salesforce.com' },
]

const NEW_ORG = {
  chooseLabel: 'Another org',
  useLabel: (typed: string) => `Use ${typed} as a new org`,
  placeholder: 'name.my.salesforce.com',
}

/** A clock the test moves by hand: timers fire only inside advance(). */
class ManualClock implements ComboboxClock {
  private t = 0
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  now() { return this.t }
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
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

function Harness({ load, newValue, onPicked, clock }: {
  load: (signal: AbortSignal) => Promise<readonly ComboboxOption[]>
  newValue?: typeof NEW_ORG
  onPicked?: (value: string, isNew: boolean) => void
  clock?: ComboboxClock
}) {
  const [v, setV] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault(); throw new Error('the form was submitted') }}>
      <label htmlFor="org">Org</label>
      <Combobox
        id="org"
        value={v}
        onChange={(next, { isNew }) => { setV(next); onPicked?.(next, isNew) }}
        loadOptions={load}
        placeholder="Choose an org"
        emptyMessage="Bidspoke knows no orgs yet."
        newValue={newValue}
        clock={clock}
      />
      <output data-testid="value">{v}</output>
    </form>
  )
}

const menu = () => screen.getByTestId('combobox-menu')

describe('Combobox', () => {
  it('is named by its label, has the combobox and listbox roles, and shows each option with its grey second line', async () => {
    render(<Harness load={async () => ORGS} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    expect(box).toHaveAttribute('aria-haspopup', 'listbox')
    expect(box).toHaveAttribute('aria-expanded', 'false')
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    const list = await screen.findByRole('listbox')
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(box).toHaveAttribute('aria-controls', list.id)
    const achieve = within(list).getByRole('option', { name: /Achieve/ })
    expect(within(achieve).getByText('achieve.my.salesforce.com')).toHaveClass('combobox-item-hint')
  })

  it('names its open list by the field label, not by the chosen value', async () => {
    render(
      <Field id="org2" label="Org">
        <Combobox id="org2" value="pennie" onChange={() => {}} loadOptions={async () => ORGS} />
      </Field>
    )
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    // jsdom names a list labelled by the combobox "Org" through the combobox's
    // label, but Chromium does not (measured 2026-10-21: no name for the button,
    // the typed text for the box), so the list must point at the label itself.
    const list = await screen.findByRole('listbox')
    const by = list.getAttribute('aria-labelledby')
    expect(by).not.toBe('org2')
    expect(document.getElementById(by ?? '')).toHaveTextContent('Org')
    expect(document.getElementById(by ?? '')?.tagName).toBe('LABEL')
  })

  it('arrows move through the list, Enter chooses without submitting the form, and the trigger then reads the choice with its address under it', async () => {
    const onPicked = vi.fn()
    render(<Harness load={async () => ORGS} onPicked={onPicked} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    await screen.findAllByRole('option')
    await userEvent.keyboard('{ArrowDown}')
    const marked = screen.getByRole('option', { name: /Pennie/ })
    expect(box).toHaveAttribute('aria-activedescendant', marked.id)
    expect(marked).toHaveClass('combobox-item-active')
    await userEvent.keyboard('{Enter}')
    expect(onPicked).toHaveBeenCalledWith('pennie', false)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(box).toHaveTextContent('Pennie')
    const hint = screen.getByText('trypennie.my.salesforce.com')
    expect(hint).toHaveClass('text-hint')
    expect(box.getAttribute('aria-describedby')).toContain(hint.id)
  })

  it('type ahead marks the first option starting with the letters typed, and Escape closes the list and keeps the value', async () => {
    const onPicked = vi.fn()
    render(<Harness load={async () => ORGS} onPicked={onPicked} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    await screen.findAllByRole('option')
    await userEvent.keyboard('pat')
    expect(box).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Pathway/ }).id)
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onPicked).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(box)
  })

  it('keeps the marked option in view as the arrows move down a long list', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ value: `f${i}`, label: `Folder ${i}` }))
    const scrolled: string[] = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.textContent ?? '') }
    try {
      render(<Harness load={async () => many} />)
      screen.getByRole('combobox', { name: 'Org' }).focus()
      await userEvent.keyboard('{ArrowDown}')
      await screen.findAllByRole('option')
      await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
      expect(scrolled.at(-1)).toBe('Folder 3')
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('the chosen option is checked in navy, and the marked row is the pale grey highlight, neither navy nor blue (round 27)', async () => {
    render(<Harness load={async () => ORGS} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    await screen.findAllByRole('option')
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('{ArrowDown}')
    const chosen = screen.getByRole('option', { name: /Achieve/ })
    expect(chosen).toHaveAttribute('aria-selected', 'true')
    expect(chosen).toHaveClass('combobox-item-chosen')
    // The rules those classes draw with, read from the one stylesheet.
    const css = readFileSync(path.resolve(__dirname, '../../../app/globals.css'), 'utf8')
    const rules = [...css.matchAll(/\.(combobox-[\w-]+)[^{]*\{([^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(5)
    for (const [, name, body] of rules) {
      // A focus ring is not a selection: it marks where the keyboard is and stays blue.
      const withoutFocus = body.replace(/\bfocus(?:-visible)?:\S+/g, '')
      expect(withoutFocus, name).not.toMatch(/p-blue/)
    }
    // Every rule drawing the marked row, nested ones included, paints the
    // highlight token behind dark text: never navy, never blue, never white text.
    const active = rules.filter(([whole]) => whole.includes('.combobox-item-active'))
    expect(active.length).toBeGreaterThan(0)
    expect(active[0][2]).toMatch(/\bbg-highlight\b/)
    for (const [whole, , body] of active) {
      expect(body, whole).not.toMatch(/navy|p-blue|text-white/)
    }
    const mark = rules.find(([, name]) => name === 'combobox-item-check')
    expect(mark?.[2]).toMatch(/text-navy/)
  })

  it('a failed load shows its error inside the menu with Try again, never an empty list, and Try again recovers', async () => {
    const load = vi.fn<(signal: AbortSignal) => Promise<readonly ComboboxOption[]>>()
      .mockRejectedValueOnce(new Error('Salesforce did not answer.'))
      .mockResolvedValueOnce(ORGS)
    render(<Harness load={load} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    const alert = await within(menu()).findByRole('alert')
    expect(alert).toHaveTextContent('Salesforce did not answer.')
    expect(alert).toHaveClass('field-error')
    expect(screen.queryAllByRole('option')).toEqual([])
    expect(within(menu()).queryByText('Bidspoke knows no orgs yet.')).not.toBeInTheDocument()
    await userEvent.click(within(menu()).getByRole('button', { name: 'Try again' }))
    expect(await screen.findAllByRole('option')).toHaveLength(3)
    expect(load).toHaveBeenCalledTimes(2)
    expect(within(menu()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter on the box retries a failed load, so Try again is reachable from the keyboard', async () => {
    const load = vi.fn<(signal: AbortSignal) => Promise<readonly ComboboxOption[]>>()
      .mockRejectedValueOnce(new Error('Salesforce did not answer.'))
      .mockResolvedValueOnce(ORGS)
    render(<Harness load={load} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    await within(menu()).findByRole('alert')
    await userEvent.keyboard('{Enter}')
    expect(await screen.findAllByRole('option')).toHaveLength(3)
  })

  it('an empty load says so as its own message, not as an error', async () => {
    render(<Harness load={async () => []} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(await within(menu()).findByText('Bidspoke knows no orgs yet.')).toBeInTheDocument()
    expect(within(menu()).queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toEqual([])
  })

  it('offers no typed value unless the caller allows one', async () => {
    render(<Harness load={async () => ORGS} />)
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    const labels = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(labels.some((l) => /Another org/.test(l ?? ''))).toBe(false)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('when allowed, Another org comes last and lets the address be typed into the box, whose menu offers it as a new org', async () => {
    const onPicked = vi.fn()
    render(<Harness load={async () => ORGS} newValue={NEW_ORG} onPicked={onPicked} />)
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    const options = await screen.findAllByRole('option')
    expect(options.at(-1)).toHaveTextContent('Another org')
    await userEvent.click(options.at(-1) as HTMLElement)
    // Now a box to type into, still named Org, still a combobox, with no dropdown button.
    const typed = screen.getByRole('combobox', { name: 'Org' })
    expect(typed.tagName).toBe('INPUT')
    expect(document.activeElement).toBe(typed)
    await userEvent.type(typed, 'lendco.my.salesforce.com')
    const offered = screen.getAllByRole('option')
    expect(offered.map((o) => o.textContent)).toEqual(['Use lendco.my.salesforce.com as a new org'])
    expect(onPicked).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onPicked).toHaveBeenCalledWith('lendco.my.salesforce.com', true)
    expect(screen.getByTestId('value')).toHaveTextContent('lendco.my.salesforce.com')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Org' })).toHaveValue('lendco.my.salesforce.com')
  })

  it('leaving the box keeps what it shows: a typed address is taken as the new org, a known one as that org', async () => {
    const onPicked = vi.fn()
    render(<><Harness load={async () => ORGS} newValue={NEW_ORG} onPicked={onPicked} /><button type="button">Next</button></>)
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.click((await screen.findAllByRole('option')).at(-1) as HTMLElement)
    await userEvent.type(screen.getByRole('combobox', { name: 'Org' }), 'lendco.my.salesforce.com')
    await userEvent.tab()
    expect(onPicked).toHaveBeenLastCalledWith('lendco.my.salesforce.com', true)
    expect(screen.getByRole('combobox', { name: 'Org' })).toHaveValue('lendco.my.salesforce.com')
    await userEvent.clear(screen.getByRole('combobox', { name: 'Org' }))
    await userEvent.type(screen.getByRole('combobox', { name: 'Org' }), 'achieve.my.salesforce.com')
    await userEvent.tab()
    expect(onPicked).toHaveBeenLastCalledWith('achieve', false)
    expect(screen.getByRole('combobox', { name: 'Org' })).toHaveTextContent('Achieve')
  })

  it('leaving the box with nothing typed goes back to the list, showing the value it still holds', async () => {
    const onPicked = vi.fn()
    render(<><Harness load={async () => ORGS} newValue={NEW_ORG} onPicked={onPicked} /><button type="button">Next</button></>)
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await screen.findAllByRole('option')
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('{ArrowDown}{End}{Enter}')
    expect(screen.getByRole('combobox', { name: 'Org' }).tagName).toBe('INPUT')
    await userEvent.tab()
    const box = screen.getByRole('combobox', { name: 'Org' })
    expect(box.tagName).toBe('BUTTON')
    expect(box).toHaveTextContent('Achieve')
    expect(onPicked).toHaveBeenCalledTimes(1)
  })

  it('emptying the box that holds a typed new org and leaving it clears the value, never calling it no longer available', async () => {
    const onPicked = vi.fn()
    render(<><Harness load={async () => ORGS} newValue={NEW_ORG} onPicked={onPicked} /><button type="button">Next</button></>)
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.click((await screen.findAllByRole('option')).at(-1) as HTMLElement)
    await userEvent.type(screen.getByRole('combobox', { name: 'Org' }), 'lendco.my.salesforce.com')
    await userEvent.tab()
    await userEvent.clear(screen.getByRole('combobox', { name: 'Org' }))
    await userEvent.tab()
    expect(onPicked).toHaveBeenLastCalledWith('', false)
    const box = screen.getByRole('combobox', { name: 'Org' })
    expect(box.tagName).toBe('BUTTON')
    expect(box).toHaveTextContent('Choose an org')
    expect(box).not.toHaveTextContent('no longer available')
  })

  it('leaving the box empty keeps a stored org even when the list could not be read', async () => {
    const onChange = vi.fn()
    render(
      <>
        <Combobox id="org" aria-label="Org" value="achieve" onChange={onChange} newValue={NEW_ORG} loadOptions={async () => { throw new Error('Salesforce did not answer.') }} />
        <button type="button">Next</button>
      </>
    )
    const box = screen.getByRole('combobox', { name: 'Org' })
    box.focus()
    await userEvent.keyboard('{ArrowDown}')
    await within(menu()).findByRole('alert')
    await userEvent.click(screen.getByRole('option', { name: 'Another org' }))
    expect(screen.getByRole('combobox', { name: 'Org' }).tagName).toBe('INPUT')
    await userEvent.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox', { name: 'Org' })).toHaveTextContent('achieve')
  })

  it('a stored value is never called no longer available when the list could not be read', async () => {
    render(
      <Combobox id="org" aria-label="Org" value="achieve" onChange={() => {}} loadOptions={async () => { throw new Error('Salesforce did not answer.') }} />
    )
    const box = screen.getByRole('combobox', { name: 'Org' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    await within(menu()).findByRole('alert')
    expect(box).toHaveTextContent('achieve')
    expect(box).not.toHaveTextContent('no longer available')
  })

  it('a typed address Bidspoke already knows offers that org, not a new one', async () => {
    render(<Harness load={async () => ORGS} newValue={NEW_ORG} />)
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.click((await screen.findAllByRole('option')).at(-1) as HTMLElement)
    await userEvent.type(screen.getByRole('combobox', { name: 'Org' }), 'achieve.my.salesforce.com')
    const offered = screen.getAllByRole('option').map((o) => o.textContent)
    expect(offered).toEqual(['Achieveachieve.my.salesforce.com'])
  })

  it('shows elapsed time while a load is slow, and turns a stalled load into the error with Try again at its deadline', async () => {
    const clock = new ManualClock()
    let calls = 0
    let settleFirst: ((v: readonly ComboboxOption[]) => void) | null = null
    const load = (signal: AbortSignal) => {
      calls += 1
      if (calls === 1) {
        return new Promise<readonly ComboboxOption[]>((resolve, reject) => {
          settleFirst = resolve
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }
      return Promise.resolve(ORGS)
    }
    render(<Harness load={load} clock={clock} />)
    const box = screen.getByRole('combobox', { name: 'Org' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(within(menu()).getByRole('status')).toHaveTextContent(/^Loading$/)
    clock.advance(3000)
    expect(within(menu()).getByRole('status')).toHaveTextContent('Loading, 3 s')
    clock.advance(11_999)
    expect(within(menu()).queryByRole('alert')).not.toBeInTheDocument()
    clock.advance(1)
    const alert = within(menu()).getByRole('alert')
    expect(alert).toHaveTextContent('The list did not load within 15 seconds.')
    expect(within(menu()).queryByRole('status')).not.toBeInTheDocument()
    // An answer arriving after the deadline is not taken: the error stands.
    await act(async () => { settleFirst?.(ORGS) })
    expect(screen.queryAllByRole('option')).toEqual([])
    fireEvent.click(within(menu()).getByRole('button', { name: 'Try again' }))
    expect(await screen.findAllByRole('option')).toHaveLength(3)
  })

  it('renders no native select or datalist, in any state, inside a form', async () => {
    const clock = new ManualClock()
    const { unmount } = render(<Harness load={() => new Promise(() => {})} clock={clock} newValue={NEW_ORG} />)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Org' }), { key: 'ArrowDown' })
    expect(document.querySelector('select, datalist, option')).toBeNull()
    clock.advance(15_000)
    expect(document.querySelector('select, datalist, option')).toBeNull()
    unmount()
    render(<Harness load={async () => ORGS} newValue={NEW_ORG} />)
    screen.getByRole('combobox', { name: 'Org' }).focus()
    await userEvent.keyboard('{ArrowDown}')
    await screen.findAllByRole('option')
    expect(document.querySelector('select, datalist, option')).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Org' })).not.toHaveAttribute('list')
  })
})
