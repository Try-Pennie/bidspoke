/**
 * The one set of tabs (#2137): a WAI-ARIA tablist on Radix, every panel kept
 * mounted, exactly one visible. Radix does not hide a force mounted panel, so
 * Tabs sets `hidden` itself; the visibility tests here were seen red with that
 * line removed.
 */
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tabs, TabPanel } from '../Tabs'

type T = 'one' | 'two' | 'three'

function Harness({ onChange, problemOn }: { onChange?: (v: T) => void; problemOn?: T }) {
  const [tab, setTab] = useState<T>('one')
  return (
    <Tabs<T>
      label="Partner settings"
      value={tab}
      onValueChange={(v) => { setTab(v); onChange?.(v) }}
      items={[{ value: 'one', label: 'One', problem: problemOn === 'one' }, { value: 'two', label: 'Two', problem: problemOn === 'two' }, { value: 'three', label: 'Three' }]}
    >
      <TabPanel value="one"><label>Name <input defaultValue="" /></label></TabPanel>
      <TabPanel value="two"><p>Second panel</p></TabPanel>
      <TabPanel value="three"><p>Third panel</p></TabPanel>
    </Tabs>
  )
}

describe('Tabs', () => {
  it('is a named tablist of tabs, the selected one marked', () => {
    render(<Harness />)
    expect(screen.getByRole('tablist', { name: 'Partner settings' })).toBeInTheDocument()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['One', 'Two', 'Three'])
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps every panel mounted with exactly one visible', () => {
    const { container } = render(<Harness />)
    const panels = container.querySelectorAll('[role="tabpanel"]')
    expect(panels).toHaveLength(3)
    expect([...panels].filter((p) => !p.hasAttribute('hidden'))).toHaveLength(1)
    expect(screen.getByText('Second panel')).not.toBeVisible()
    expect(screen.getByLabelText('Name')).toBeVisible()
  })

  it('switches on a click, and an edit on a hidden panel survives', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(screen.getByLabelText('Name'), 'Tripoint')
    await userEvent.click(screen.getByRole('tab', { name: 'Two' }))
    expect(onChange).toHaveBeenLastCalledWith('two')
    expect(screen.getByText('Second panel')).toBeVisible()
    expect(screen.getByLabelText('Name')).not.toBeVisible()
    await userEvent.click(screen.getByRole('tab', { name: 'One' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Tripoint')
  })

  it('moves between tabs with the arrow keys, Home and End', async () => {
    render(<Harness />)
    screen.getByRole('tab', { name: 'One' }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveFocus()
    expect(screen.getByText('Second panel')).toBeVisible()
    await userEvent.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Three' })).toHaveFocus()
    await userEvent.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'One' })).toHaveFocus()
  })

  it('a tab with a problem carries the red mark and says so to a screen reader', () => {
    const { container } = render(<Harness problemOn="two" />)
    expect(screen.getByRole('tab', { name: 'Two, has a problem' })).toBeInTheDocument()
    expect(container.querySelectorAll('[data-problem-mark]')).toHaveLength(1)
  })
})
