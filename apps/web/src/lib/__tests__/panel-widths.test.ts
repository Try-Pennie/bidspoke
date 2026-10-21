/**
 * Issues #718, #719, #720. The canvas side panels shared one persisted width, so
 * a width that suits reading a script was the same width forced onto the short
 * two-column forms, and resizing either silently resized the other. Each panel
 * kind now owns its own remembered width.
 */
import { describe, it, expect } from 'vitest'
import {
  PANEL_KINDS,
  PANEL_MIN_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_WIDTH_DEFAULTS,
  LEGACY_PANEL_WIDTH_KEY,
  panelWidthStorageKey,
  clampPanelWidth,
  configPanelKind,
  readStoredPanelWidth,
} from '../panel-widths'
import { NODE_TYPES } from '@/types/workflow'

/** Minimal Storage stand-in: the real one is only reachable in the DOM project. */
function storageOf(entries: Record<string, string> = {}): Pick<Storage, 'getItem'> {
  return { getItem: (key: string) => entries[key] ?? null }
}

describe('panel width defaults', () => {
  it('gives every kind its own storage key', () => {
    const keys = PANEL_KINDS.map(panelWidthStorageKey)
    expect(new Set(keys).size).toBe(PANEL_KINDS.length)
    expect(panelWidthStorageKey('code')).toBe('bidspoke.panelWidth.code')
  })

  it('opens a code panel wider than a form panel', () => {
    expect(PANEL_WIDTH_DEFAULTS.code).toBeGreaterThan(PANEL_WIDTH_DEFAULTS.form)
    expect(PANEL_WIDTH_DEFAULTS.code).toBe(540)
  })

  it('opens the test-run panel wide too, since it shows a JSON payload', () => {
    expect(PANEL_WIDTH_DEFAULTS.test).toBeGreaterThan(PANEL_WIDTH_DEFAULTS.form)
  })

  it('keeps every default inside the resize bounds', () => {
    for (const kind of PANEL_KINDS) {
      expect(PANEL_WIDTH_DEFAULTS[kind]).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH)
      expect(PANEL_WIDTH_DEFAULTS[kind]).toBeLessThanOrEqual(PANEL_MAX_WIDTH)
    }
  })
})

describe('clampPanelWidth', () => {
  it('holds a value inside the bounds', () => {
    expect(clampPanelWidth(600)).toBe(600)
    expect(clampPanelWidth(PANEL_MIN_WIDTH)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(PANEL_MAX_WIDTH)).toBe(PANEL_MAX_WIDTH)
  })

  it('pulls an out-of-bounds value back to the nearest bound', () => {
    expect(clampPanelWidth(10)).toBe(PANEL_MIN_WIDTH)
    expect(clampPanelWidth(99999)).toBe(PANEL_MAX_WIDTH)
  })

  // A width read back from storage is a parsed value, so it can arrive as NaN.
  // Comparing NaN against the bounds is false either way, which would let it
  // through and set an inline style of `width: NaNpx`.
  it('refuses a value that is not a finite number', () => {
    expect(clampPanelWidth(Number.NaN)).toBeNull()
    expect(clampPanelWidth(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('configPanelKind', () => {
  it('routes a code node to the code panel and everything else to a form', () => {
    expect(configPanelKind('code')).toBe('code')
    expect(configPanelKind('salesforce')).toBe('form')
    expect(configPanelKind('bid_group')).toBe('form')
    expect(configPanelKind(undefined)).toBe('form')
  })
})

// Issue #2595. The lead validation settings panel was settled in
// docs/design/lead-validation-node.html drawn at 469 wide; at the 320 form width
// its numbered check rows and the rule builder truncate. It opens at the width
// it was drawn at, through its own kind, so no other step's opening width moves.
describe('the lead validation panel', () => {
  it('has a panel kind of its own', () => {
    expect(configPanelKind('lead_validation')).toBe('checks')
  })

  it('opens at 469, the width its settled design was drawn at', () => {
    expect(PANEL_WIDTH_DEFAULTS.checks).toBe(469)
    expect(readStoredPanelWidth('checks', storageOf())).toBe(469)
  })

  it('leaves every other step type where it opened before', () => {
    for (const type of NODE_TYPES) {
      if (type === 'lead_validation') continue
      expect(configPanelKind(type)).toBe(type === 'code' ? 'code' : 'form')
    }
    expect(PANEL_WIDTH_DEFAULTS.form).toBe(320)
  })

  it('remembers its own width, not the form width', () => {
    const store = storageOf({ 'bidspoke.panelWidth.form': '360', 'bidspoke.panelWidth.checks': '520' })
    expect(readStoredPanelWidth('checks', store)).toBe(520)
    expect(readStoredPanelWidth('form', store)).toBe(360)
  })

  // The width saved before the panels were split is a narrow form width that
  // predates this panel; carrying it over would bring back the truncation.
  it('does not inherit the old shared width', () => {
    const store = storageOf({ [LEGACY_PANEL_WIDTH_KEY]: '320' })
    expect(readStoredPanelWidth('checks', store)).toBe(469)
  })
})

describe('readStoredPanelWidth', () => {
  it('uses the stored width for that kind', () => {
    const store = storageOf({ 'bidspoke.panelWidth.code': '720' })
    expect(readStoredPanelWidth('code', store)).toBe(720)
  })

  it('does not let one kind read another kind key', () => {
    const store = storageOf({ 'bidspoke.panelWidth.code': '720' })
    expect(readStoredPanelWidth('form', store)).toBe(PANEL_WIDTH_DEFAULTS.form)
  })

  it('falls back to the kind default when nothing is stored', () => {
    for (const kind of PANEL_KINDS) {
      expect(readStoredPanelWidth(kind, storageOf())).toBe(PANEL_WIDTH_DEFAULTS[kind])
    }
  })

  it('ignores a stored value that is junk or out of bounds', () => {
    expect(readStoredPanelWidth('code', storageOf({ 'bidspoke.panelWidth.code': 'wide' })))
      .toBe(PANEL_WIDTH_DEFAULTS.code)
    expect(readStoredPanelWidth('code', storageOf({ 'bidspoke.panelWidth.code': '4' })))
      .toBe(PANEL_WIDTH_DEFAULTS.code)
    expect(readStoredPanelWidth('code', storageOf({ 'bidspoke.panelWidth.code': '' })))
      .toBe(PANEL_WIDTH_DEFAULTS.code)
  })

  // Someone who has used the canvas before has one shared width saved. Carrying
  // it onto the form panels keeps their arrangement; carrying it onto the code
  // and payload panels would re-apply the narrow width that made a script
  // unreadable, which is the whole complaint.
  it('inherits the old shared width for the form-shaped panels', () => {
    const store = storageOf({ [LEGACY_PANEL_WIDTH_KEY]: '460' })
    expect(readStoredPanelWidth('form', store)).toBe(460)
    expect(readStoredPanelWidth('versions', store)).toBe(460)
  })

  it('does not inherit the old shared width for the code or payload panels', () => {
    const store = storageOf({ [LEGACY_PANEL_WIDTH_KEY]: '320' })
    expect(readStoredPanelWidth('code', store)).toBe(PANEL_WIDTH_DEFAULTS.code)
    expect(readStoredPanelWidth('test', store)).toBe(PANEL_WIDTH_DEFAULTS.test)
    expect(readStoredPanelWidth('execution', store)).toBe(PANEL_WIDTH_DEFAULTS.execution)
  })

  it('prefers this kind own stored width over the old shared one', () => {
    const store = storageOf({ [LEGACY_PANEL_WIDTH_KEY]: '320', 'bidspoke.panelWidth.form': '600' })
    expect(readStoredPanelWidth('form', store)).toBe(600)
  })

  it('survives a storage that is unavailable', () => {
    expect(readStoredPanelWidth('code', null)).toBe(PANEL_WIDTH_DEFAULTS.code)
  })
})
