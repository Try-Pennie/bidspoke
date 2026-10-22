/**
 * Per-kind widths for the canvas side panels (#718, #719, #720).
 *
 * All five panels used to share one persisted width under
 * `bidspoke.sidePanelWidth`, so the width that suits reading a script or a JSON
 * payload was the same width forced onto the short two-column forms, and
 * resizing either silently re-sized the other. Each kind now remembers its own.
 *
 * The width lives in ONE place, the canvas that owns the state. The panels used
 * to carry their own `width ?? default` fallback as well, which is two sources
 * for one value: since every call site passed a width, the code panel's wider
 * branch was unreachable and a script opened at the narrow form width with
 * nothing failing to show it (#720). Those fallbacks are gone and `width` is a
 * required prop, so the compiler now enforces the single source.
 */

export type PanelKind = 'form' | 'code' | 'checks' | 'test' | 'execution' | 'versions'

export const PANEL_KINDS: readonly PanelKind[] = ['form', 'code', 'checks', 'test', 'execution', 'versions']

export const PANEL_MIN_WIDTH = 280
// Raised from 800: a code panel wide enough for a long line is worth allowing
// on a large display, and the ceiling only bounds a deliberate drag.
export const PANEL_MAX_WIDTH = 1000

/**
 * Opening width per kind. Panels showing code or a JSON payload start wide;
 * the two-column forms and the version list start narrow; the lead validation
 * checks panel sits between, at the width its design was drawn at.
 */
export const PANEL_WIDTH_DEFAULTS: Record<PanelKind, number> = {
  form: 320,
  code: 540,
  // The lead validation step's ordered checks and their rule builder (#2595).
  // Its settled design (docs/design/lead-validation-node.html) was drawn with
  // the panel at 469; at the form width the check rows and conditions truncate.
  checks: 469,
  test: 540,
  execution: 420,
  versions: 340,
}

export const LEGACY_PANEL_WIDTH_KEY = 'bidspoke.sidePanelWidth'

export function panelWidthStorageKey(kind: PanelKind): string {
  return `bidspoke.panelWidth.${kind}`
}

/**
 * Hold a width inside the resize bounds, or return null when the value is not a
 * usable number. A width read back from storage is parsed, so it can arrive as
 * NaN, and NaN compares false against both bounds: letting it through would set
 * an inline style of `width: NaNpx` and collapse the panel. Callers map null to
 * the default rather than to a bound.
 */
export function clampPanelWidth(value: number): number | null {
  if (!Number.isFinite(value)) return null
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, value))
}

/** Which panel kind a ConfigPanel is, given the node type it is configuring. */
export function configPanelKind(nodeType: string | undefined): PanelKind {
  if (nodeType === 'code') return 'code'
  if (nodeType === 'lead_validation') return 'checks'
  return 'form'
}

// Kinds that inherit the single width saved before this split. Carrying it onto
// the form-shaped panels keeps an existing arrangement intact; carrying it onto
// the code and payload panels would re-apply the narrow width that made a
// script unreadable, which is the complaint this exists to fix. The checks panel
// postdates that width and truncates at it, so it does not inherit it either.
const KINDS_INHERITING_LEGACY_WIDTH: readonly PanelKind[] = ['form', 'versions']

/**
 * The width a panel of this kind should open at: its own stored value, else the
 * pre-split shared value for the form-shaped kinds, else the kind's default.
 * Takes the storage so it is testable and so a missing/blocked localStorage is
 * an ordinary input rather than a crash.
 */
export function readStoredPanelWidth(
  kind: PanelKind,
  storage: Pick<Storage, 'getItem'> | null | undefined,
): number {
  const own = parseStoredWidth(storage, panelWidthStorageKey(kind))
  if (own !== null) return own

  if (KINDS_INHERITING_LEGACY_WIDTH.includes(kind)) {
    const legacy = parseStoredWidth(storage, LEGACY_PANEL_WIDTH_KEY)
    if (legacy !== null) return legacy
  }

  return PANEL_WIDTH_DEFAULTS[kind]
}

/**
 * A stored width, or null when absent, unparseable, or outside the bounds. Out
 * of bounds is rejected rather than clamped: the value was written by an older
 * build or edited by hand, so the kind's default is the better answer than a
 * bound the person never chose.
 */
function parseStoredWidth(storage: Pick<Storage, 'getItem'> | null | undefined, key: string): number | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    // Storage can throw when disabled by browser settings.
    return null
  }
  if (raw === null || raw.trim() === '') return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  if (parsed < PANEL_MIN_WIDTH || parsed > PANEL_MAX_WIDTH) return null
  return parsed
}
