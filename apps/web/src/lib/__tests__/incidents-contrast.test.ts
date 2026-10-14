/**
 * Contrast for the incident record's two surfaces (#2101): the red ongoing line
 * under the dashboard header and the Incidents card's day headings on beige.
 * Text needs 4.5:1 against the ground it actually sits on (L149, L569).
 */
import { describe, it, expect } from 'vitest'
import { contrastRatio } from '../contrast'

/** Tailwind's palette, and the brand tokens from tailwind.config.ts. */
const BEIGE = '#F9F6F0'
const GRAPHITE = '#343434'
const RED_50 = '#FEF2F2'
const RED_700 = '#B91C1C'
const GRAY_500 = '#6B7280'
const GRAY_600 = '#4B5563'

describe('incident record contrast', () => {
  it('reads the ongoing line: the red label and the graphite sentence on red 50', () => {
    expect(contrastRatio(RED_700, RED_50)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(GRAPHITE, RED_50)).toBeGreaterThanOrEqual(4.5)
  })

  it('reads the day headings in gray 600 on beige, where the table header gray 500 falls short', () => {
    // The settled design names the table header treatment, gray 500. On beige it
    // measures 4.49:1, under the minimum, so the headings use gray 600.
    expect(contrastRatio(GRAY_500, BEIGE)).toBeLessThan(4.5)
    expect(contrastRatio(GRAY_600, BEIGE)).toBeGreaterThanOrEqual(4.5)
  })
})
