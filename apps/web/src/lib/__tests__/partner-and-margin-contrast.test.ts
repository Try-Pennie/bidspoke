/**
 * Contrast for the two surfaces added with the per-lead margin work (#1035, #1160).
 *
 * Both were unit tested against their rendered text and both looked fine in a
 * fixture, which is exactly how a contrast fault ships: a colour is picked for
 * how it reads on a white card and the surface it actually lands on is a hover
 * tint or a selected row (L569, a surface token is one half of a pair with the
 * ground behind it).
 *
 * The partner list marker is the sharper case. A row has THREE grounds, rest,
 * hover and selected, and a graphical object needs 3:1 against each. Measuring
 * only the resting state passes a marker that disappears the moment somebody
 * points at the row they are trying to read.
 */
import { describe, it, expect } from 'vitest'
import { contrastRatio } from '../contrast'

/** Tailwind's palette, and the brand tokens from tailwind.config.ts. */
const WHITE = '#FFFFFF'
const BEIGE = '#F9F6F0'      // brand `beige`, the row hover tint
const GRAY_100 = '#F3F4F6'   // the selected row
const GRAPHITE = '#343434'   // brand `graphite`
const GRAY_600 = '#4B5563'
const GREEN_700 = '#15803D'
const RED_700 = '#B91C1C'
const AMBER_600 = '#D97706'
const AMBER_700 = '#B45309'

/** Every ground a partner list row can present behind its marker. */
const ROW_GROUNDS = { rest: WHITE, hover: BEIGE, selected: GRAY_100 }

describe('partner list credential marker (#1035)', () => {
  it('clears 3:1 as a graphical object on EVERY row ground, not just at rest', () => {
    for (const [state, ground] of Object.entries(ROW_GROUNDS)) {
      expect(
        contrastRatio(AMBER_700, ground),
        `marker on a ${state} row`,
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('POSITIVE CONTROL: amber-600 is the shade this guard exists to refuse', () => {
    // Without this the test above could pass on a palette where every amber
    // clears the bar, and would then be measuring nothing (L1).
    const worst = Math.min(...Object.values(ROW_GROUNDS).map((g) => contrastRatio(AMBER_600, g)))
    expect(worst).toBeLessThan(3)
  })
})

describe('lead margin panel figures (#1160)', () => {
  // The panel is a white card, so white is the only ground for its text.
  const cases: Array<[string, string]> = [
    ['label', GRAY_600],
    ['neutral figure', GRAPHITE],
    ['gain', GREEN_700],
    ['loss', RED_700],
    ['not recorded', GRAY_600],
  ]

  it.each(cases)('%s clears 4.5:1 as normal text', (_name, color) => {
    expect(contrastRatio(color, WHITE)).toBeGreaterThanOrEqual(4.5)
  })

  it('the gain and loss colours are distinguishable from the neutral one', () => {
    // Colour is not the only carrier here (each figure is labelled), but a gain
    // that renders indistinguishably from a plain figure makes the tone useless.
    expect(contrastRatio(GREEN_700, GRAPHITE)).toBeGreaterThan(1.2)
    expect(contrastRatio(RED_700, GRAPHITE)).toBeGreaterThan(1.2)
  })
})
