/**
 * Issue #719: resizing one canvas side panel must not resize the others, and
 * each kind's width has to survive a remount. Exercised through a probe so the
 * assertions are about what a panel would actually be given.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { usePanelWidths } from '../usePanelWidths'
import { PANEL_WIDTH_DEFAULTS, panelWidthStorageKey } from '@/lib/panel-widths'
import type { PanelKind } from '@/lib/panel-widths'

function Probe() {
  const panels = usePanelWidths()
  const kinds: PanelKind[] = ['form', 'code', 'test', 'execution', 'versions']
  return (
    <div>
      {kinds.map((kind) => (
        <div key={kind}>
          <span data-testid={`width-${kind}`}>{panels.widthFor(kind)}</span>
          <button onClick={() => panels.setWidthFor(kind)(600)}>widen {kind}</button>
          <button onClick={() => panels.setWidthFor(kind)(99999)}>overwiden {kind}</button>
          <button onClick={() => panels.setWidthFor(kind)(Number.NaN)}>break {kind}</button>
        </div>
      ))}
    </div>
  )
}

const widthOf = (kind: PanelKind) => Number(screen.getByTestId(`width-${kind}`).textContent)

describe('usePanelWidths', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('starts each kind at its own default', () => {
    render(<Probe />)
    expect(widthOf('form')).toBe(PANEL_WIDTH_DEFAULTS.form)
    expect(widthOf('code')).toBe(PANEL_WIDTH_DEFAULTS.code)
    expect(widthOf('test')).toBe(PANEL_WIDTH_DEFAULTS.test)
  })

  it('resizing one kind leaves every other kind alone', () => {
    render(<Probe />)
    fireEvent.click(screen.getByText('widen code'))

    expect(widthOf('code')).toBe(600)
    expect(widthOf('form')).toBe(PANEL_WIDTH_DEFAULTS.form)
    expect(widthOf('test')).toBe(PANEL_WIDTH_DEFAULTS.test)
    expect(widthOf('versions')).toBe(PANEL_WIDTH_DEFAULTS.versions)
  })

  it('persists each kind under its own key and reads it back on remount', () => {
    const first = render(<Probe />)
    fireEvent.click(screen.getByText('widen code'))
    expect(window.localStorage.getItem(panelWidthStorageKey('code'))).toBe('600')
    expect(window.localStorage.getItem(panelWidthStorageKey('form'))).toBeNull()

    first.unmount()
    render(<Probe />)
    expect(widthOf('code')).toBe(600)
    expect(widthOf('form')).toBe(PANEL_WIDTH_DEFAULTS.form)
  })

  it('clamps a resize that would go past the bounds', () => {
    render(<Probe />)
    fireEvent.click(screen.getByText('overwiden code'))
    expect(widthOf('code')).toBe(1000)
  })

  // A NaN reaching the state would render as `width: NaNpx` and collapse the
  // panel, so the setter refuses it and the panel keeps the width it had.
  it('ignores a resize to a value that is not a number', () => {
    render(<Probe />)
    fireEvent.click(screen.getByText('widen code'))
    fireEvent.click(screen.getByText('break code'))
    expect(widthOf('code')).toBe(600)
  })
})
