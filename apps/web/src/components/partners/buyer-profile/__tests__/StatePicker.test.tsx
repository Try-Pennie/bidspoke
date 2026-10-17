/**
 * The state picker (#1412): 51 checkboxes from the shared vocabulary, all and
 * none, and a count, so 51 states is a scannable grid rather than a text box of
 * codes (L611). Since #2324 (PM-21) each state is a chip, as the settled design
 * draws it: navy when chosen, in a white box headed by the count, All and None.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { US_STATES } from '@bidspoke/buyer-profile'
import { StatePicker } from '../StatePicker'

describe('StatePicker', () => {
  it('renders one labelled checkbox per state from the shared vocabulary, checked from the value', () => {
    render(<StatePicker value={['TX', 'FL']} onChange={() => {}} />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(US_STATES.length)
    expect(screen.getByRole('checkbox', { name: 'TX' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'NY' })).not.toBeChecked()
  })

  it('draws each state as a chip, navy when chosen, never a native box (#2324)', () => {
    const { container } = render(<StatePicker value={['TX']} onChange={() => {}} />)
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.getByRole('checkbox', { name: 'TX' })).toHaveClass('chip', 'chip-on')
    expect(screen.getByRole('checkbox', { name: 'NY' })).toHaveClass('chip')
    expect(screen.getByRole('checkbox', { name: 'NY' })).not.toHaveClass('chip-on')
  })

  it('emits a sorted list without duplicates when a state is toggled', () => {
    const onChange = vi.fn()
    render(<StatePicker value={['TX']} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'AL' }))
    expect(onChange).toHaveBeenLastCalledWith(['AL', 'TX'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'TX' }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('All selects every state and None clears them', () => {
    const onChange = vi.fn()
    render(<StatePicker value={['TX']} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(onChange).toHaveBeenLastCalledWith([...US_STATES].sort())
    fireEvent.click(screen.getByRole('button', { name: 'None' }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('states the count once and says that an empty list accepts nothing', () => {
    render(<StatePicker value={[]} onChange={() => {}} />)
    expect(screen.getByText('0 of 51 states')).toBeInTheDocument()
    expect(screen.getByText(/accepts no lead until a state is chosen/i)).toBeInTheDocument()
  })

  it('is a group with an accessible name', () => {
    render(<StatePicker value={[]} onChange={() => {}} />)
    expect(screen.getByRole('group', { name: 'States' })).toBeInTheDocument()
  })
})
