import { describe, it, expect } from 'vitest'
import type { ExecutionStep } from '@/types/workflow'
import { getNodeClasses } from '../execution-status'

describe('getNodeClasses — unconfigured node marker', () => {
  it('returns a prominent pulsing amber ring when the node has a validation error', () => {
    const cls = getNodeClasses(undefined, true)
    expect(cls).toContain('ring-amber-400')
    // Pulses so it draws the eye when scanning a large flow.
    expect(cls).toContain('animate-pulse')
    // Thicker than the old 2px ring so it survives zoom-out.
    expect(cls).toContain('ring-4')
  })

  it('adds no marker when there is no error and no execution', () => {
    expect(getNodeClasses(undefined, false)).toBe('')
  })

  it('lets execution state win over the validation marker', () => {
    const cls = getNodeClasses({ status: 'failed' } as ExecutionStep, true)
    expect(cls).toContain('ring-red-500')
    expect(cls).not.toContain('animate-pulse')
  })
})
