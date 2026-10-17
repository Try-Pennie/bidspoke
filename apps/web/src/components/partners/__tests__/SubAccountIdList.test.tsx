/**
 * A source partner's sub-account IDs as the settled design draws them (#2327,
 * PM-24, design frame 21): one mono box per ID with a grey minus, then
 * "+ Add sub-account ID". Each ID is written the moment it is committed (Enter,
 * or leaving the box), so the list says when a write is running and why one
 * failed, and keeps what was typed after a failure so it can be tried again.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SubAccountIdList, type SubAccountId } from '../SubAccountIdList'

const A = '189b30c2-b93c-42dd-945a-e88246d0362a'
const B = '026f93f3-3d57-44b0-b52f-82426c91e547'
const NEW = 'dd56c162-0b24-4c53-a76c-a6b2f717051b'
const IDS: SubAccountId[] = [{ key: 'k1', uuid: A }, { key: 'k2', uuid: B }]

function setup(over: Partial<Parameters<typeof SubAccountIdList>[0]> = {}) {
  const props = {
    ids: IDS,
    onAdd: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onChange: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  const view = render(<SubAccountIdList {...props} />)
  return { ...props, ...view }
}

describe('the sub-account IDs, as drawn', () => {
  it('shows each ID in its own mono box with a minus, then the add link', () => {
    setup()
    const first = screen.getByLabelText('Sub-account ID 1')
    expect(first).toHaveValue(A)
    expect(first).toHaveClass('font-mono')
    expect(screen.getByLabelText('Sub-account ID 2')).toHaveValue(B)
    expect(screen.getByRole('button', { name: 'Remove sub-account ID 1' })).toHaveClass('btn-remove')
    expect(screen.getByRole('button', { name: 'Remove sub-account ID 2' })).toHaveClass('btn-remove')
    // A dark add link, never the old blue Add button beside an "Enter UUID" box.
    expect(screen.getByRole('button', { name: 'Add sub-account ID' })).toHaveClass('btn-quiet')
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
    expect(screen.queryByPlaceholderText('Enter UUID')).toBeNull()
  })

  it('the add link opens an empty box, focused, and Enter writes what is typed', async () => {
    const { onAdd } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    const box = screen.getByLabelText('New sub-account ID')
    expect(box).toHaveValue('')
    expect(box).toHaveFocus()
    await userEvent.type(box, `  ${NEW} {Enter}`)
    expect(onAdd).toHaveBeenCalledWith(NEW)
    await waitFor(() => expect(screen.queryByLabelText('New sub-account ID')).toBeNull())
  })

  it('leaving a new box with something in it writes it too', async () => {
    const { onAdd } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    fireEvent.change(screen.getByLabelText('New sub-account ID'), { target: { value: NEW } })
    fireEvent.blur(screen.getByLabelText('New sub-account ID'))
    await waitFor(() => expect(onAdd).toHaveBeenCalledWith(NEW))
  })

  it('Enter and then leaving the box writes the ID once, not twice', async () => {
    let finish!: () => void
    const onAdd = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    setup({ onAdd })
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    const box = screen.getByLabelText('New sub-account ID')
    fireEvent.change(box, { target: { value: NEW } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.blur(box)
    finish()
    await waitFor(() => expect(screen.queryByLabelText('New sub-account ID')).toBeNull())
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  // Lessons review on the PR: pressing a box's own minus moves focus out of the
  // box first, which must not write what was typed (nor, on a saved row, a change).
  it('the minus on a new box with text in it closes the box and writes nothing', async () => {
    const { onAdd } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    await userEvent.type(screen.getByLabelText('New sub-account ID'), NEW)
    await userEvent.click(screen.getByRole('button', { name: 'Remove new sub-account ID' }))
    expect(screen.queryByLabelText('New sub-account ID')).toBeNull()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('the minus on a saved ID being edited removes it, without first writing the edit', async () => {
    const { onChange, onRemove } = setup()
    await userEvent.type(screen.getByLabelText('Sub-account ID 2'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Remove sub-account ID 2' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(onRemove).toHaveBeenCalledWith('k2')
  })

  it('a pointer press on a minus keeps focus in the box, so a browser that never focuses a clicked button (Safari) does not commit either', async () => {
    setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    // fireEvent returns false when the press's default (moving focus) was prevented.
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Remove new sub-account ID' }))).toBe(false)
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'Remove sub-account ID 1' }))).toBe(false)
  })

  it('Tab from a new box to its own minus writes nothing either', async () => {
    const { onAdd } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    await userEvent.type(screen.getByLabelText('New sub-account ID'), NEW)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'Remove new sub-account ID' })).toHaveFocus()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('leaving a new box empty takes it away and writes nothing', async () => {
    const { onAdd } = setup()
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    fireEvent.blur(screen.getByLabelText('New sub-account ID'))
    expect(screen.queryByLabelText('New sub-account ID')).toBeNull()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('a write that is running says so, and one that fails says why and keeps what was typed', async () => {
    let fail!: (e: Error) => void
    const onAdd = vi.fn(() => new Promise<void>((_, reject) => { fail = reject }))
    setup({ onAdd })
    await userEvent.click(screen.getByRole('button', { name: 'Add sub-account ID' }))
    await userEvent.type(screen.getByLabelText('New sub-account ID'), `${NEW}{Enter}`)
    expect(screen.getByRole('status')).toHaveTextContent('Adding the sub-account ID')
    fail(new Error(`UUID "${NEW}" already exists`))
    expect(await screen.findByRole('alert')).toHaveTextContent(`UUID "${NEW}" already exists`)
    expect(screen.getByLabelText('New sub-account ID')).toHaveValue(NEW)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('changing a saved ID and leaving the box writes the change', async () => {
    const { onChange } = setup()
    const box = screen.getByLabelText('Sub-account ID 2')
    fireEvent.change(box, { target: { value: NEW } })
    fireEvent.blur(box)
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('k2', NEW))
  })

  it('a saved ID left unchanged, or emptied, writes nothing: emptied, it shows the saved ID again', () => {
    const { onChange, onRemove } = setup()
    const box = screen.getByLabelText('Sub-account ID 1')
    fireEvent.blur(box)
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.blur(box)
    expect(box).toHaveValue(A)
    expect(onChange).not.toHaveBeenCalled()
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('the minus removes that ID, and a failed removal says why and keeps the row', async () => {
    const onRemove = vi.fn().mockRejectedValue(new Error('Failed to remove UUID'))
    setup({ onRemove })
    await userEvent.click(screen.getByRole('button', { name: 'Remove sub-account ID 2' }))
    expect(onRemove).toHaveBeenCalledWith('k2')
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to remove UUID')
    expect(screen.getByLabelText('Sub-account ID 2')).toHaveValue(B)
  })
})
