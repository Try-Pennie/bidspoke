import { describe, it, expect } from 'vitest'
import { shouldCalmWarnings, CALM_WARNINGS_THRESHOLD } from '../warning-glow'

describe('shouldCalmWarnings', () => {
  it('keeps the pulse for a handful of warnings (at or below the threshold)', () => {
    expect(shouldCalmWarnings(0)).toBe(false)
    expect(shouldCalmWarnings(1)).toBe(false)
    expect(shouldCalmWarnings(CALM_WARNINGS_THRESHOLD)).toBe(false)
  })

  it('calms (drops the pulse) once past the threshold', () => {
    expect(shouldCalmWarnings(CALM_WARNINGS_THRESHOLD + 1)).toBe(true)
    expect(shouldCalmWarnings(11)).toBe(true)
  })
})
