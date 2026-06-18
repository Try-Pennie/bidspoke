import { describe, it, expect } from 'vitest'
import type { ExecutionStep } from '@/types/workflow'
import { getNodeClasses } from '../execution-status'

describe('getNodeClasses', () => {
  it('no longer owns the validation glow (moved to the NodeWarningGlow HOC)', () => {
    // The pulsing .node-warning glow is applied by withNodeBadges now, so the
    // class helper returns nothing for a plain unconfigured node.
    expect(getNodeClasses(undefined, true)).toBe('')
    expect(getNodeClasses(undefined, false)).toBe('')
  })

  it('still reflects execution state, which takes precedence', () => {
    const cls = getNodeClasses({ status: 'failed' } as ExecutionStep, true)
    expect(cls).toContain('ring-red-500')
    expect(cls).not.toContain('node-warning')
  })
})
