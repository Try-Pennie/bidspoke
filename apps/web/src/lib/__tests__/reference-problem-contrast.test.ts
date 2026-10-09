import { describe, it, expect } from 'vitest'
import { contrastRatio } from '../contrast'

// The colours the reference-problem notice is drawn in (#424).
//
// The reference validator itself moved to @bidspoke/workflow-definition (#1698);
// this file keeps only what is web-specific: whether the notice that renders a
// reference problem is readable. Asserted here rather than eyeballed because a
// token that clears the level for a BORDER does not thereby clear it for TEXT:
// an interface component needs 3:1 and body text needs 4.5:1, and every check
// that merely measures whether something DREW reports an under-contrast label as
// fine (L149).
describe('reference-problem notice contrast', () => {
  // Tailwind's red-50 / red-900 / red-300, which the notice uses.
  const RED_50 = '#fef2f2'
  const RED_900 = '#7f1d1d'
  // red-500. red-300 was the first choice and measures 1.90:1 on white, so the
  // box's outline would have been all but invisible against the panel.
  const RED_BORDER = '#ef4444'

  it('the message text clears 4.5:1 on its own background', () => {
    expect(contrastRatio(RED_900, RED_50)).toBeGreaterThanOrEqual(4.5)
  })

  it('the border clears 3:1 against the panel background it sits on', () => {
    // The panel is white, not the notice fill, so the border is judged against
    // white or it is judged against the wrong thing.
    expect(contrastRatio(RED_BORDER, '#ffffff')).toBeGreaterThanOrEqual(3)
  })

  it('the control level is not mistaken for the text level', () => {
    // A guard that only asserted 3:1 would pass a text colour that is unreadable,
    // so prove the two thresholds actually separate here.
    expect(contrastRatio(RED_BORDER, RED_50)).toBeLessThan(4.5)
  })
})
