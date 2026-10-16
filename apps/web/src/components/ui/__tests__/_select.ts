/**
 * One way for a component test to read and drive the shared Select (#2137).
 * The Select is a Radix listbox, not a native <select>, so its options exist
 * only while it is open: these open it the way a keyboard does, read or choose,
 * and leave it closed again. Every test that read a native select's options or
 * fired a native change goes through here, so the next change to the control
 * is one change to this file.
 */
import { fireEvent, screen, within } from '@testing-library/react'

export interface SelectReading {
  /** The option labels, in order, as the list shows them. */
  options: string[]
  /** The label of the chosen option, or null when none is chosen. */
  selected: string | null
  /** What the closed control shows: the chosen label, a placeholder, or a missing value. */
  shown: string
}

function open(trigger: HTMLElement): HTMLElement {
  if (trigger.getAttribute('role') !== 'combobox') throw new Error('readSelect was given something that is not the shared Select trigger')
  fireEvent.keyDown(trigger, { key: 'Enter' })
  return screen.getByRole('listbox')
}

function close(listbox: HTMLElement) {
  fireEvent.keyDown(listbox, { key: 'Escape' })
}

/** Opens the Select, reads its options and its choice, and closes it again. */
export function readSelect(trigger: HTMLElement): SelectReading {
  const shown = (trigger.textContent ?? '').trim()
  const listbox = open(trigger)
  const items = within(listbox).getAllByRole('option')
  const reading = {
    options: items.map((o) => (o.textContent ?? '').trim()),
    selected: items.find((o) => o.getAttribute('data-state') === 'checked')?.textContent?.trim() ?? null,
    shown,
  }
  close(listbox)
  return reading
}

/** Opens the Select and chooses the option with this label, as a person would. */
export function chooseOption(trigger: HTMLElement, label: string) {
  const listbox = open(trigger)
  const option = within(listbox).getAllByRole('option').find((o) => (o.textContent ?? '').trim() === label)
  if (!option) {
    const labels = within(listbox).getAllByRole('option').map((o) => o.textContent)
    close(listbox)
    throw new Error(`no option "${label}" in the Select; it offers ${JSON.stringify(labels)}`)
  }
  fireEvent.click(option)
}
