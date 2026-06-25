// WCAG 2.1 relative-luminance and contrast-ratio helpers. Used by the
// accessibility guard test (and available to any UI code) to assert that
// text/background color pairs clear the AA threshold (4.5:1 for normal text,
// 3:1 for large text and graphical objects).
//
// Reference: https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio

/** Parse a `#rgb` or `#rrggbb` hex string into [r, g, b] 0-255 channels. */
export function parseHex(hex: string): [number, number, number] {
  const m = hex.trim().replace(/^#/, '')
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: ${hex}`)
  }
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG relative luminance of an sRGB hex color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const channel = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = parseHex(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two hex colors (1:1 to 21:1). Order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Composite an `#rrggbb` foreground at the given alpha over an opaque
 * background, returning the resulting opaque hex. Mirrors how Tailwind's
 * `text-white/50` renders over a solid backdrop.
 */
export function blendOver(fg: string, bg: string, alpha: number): string {
  const [fr, fgc, fb] = parseHex(fg)
  const [br, bgc, bb] = parseHex(bg)
  const mix = (x: number, y: number) => Math.round(alpha * x + (1 - alpha) * y)
  const hx = (x: number) => x.toString(16).padStart(2, '0')
  return `#${hx(mix(fr, br))}${hx(mix(fgc, bgc))}${hx(mix(fb, bb))}`
}
