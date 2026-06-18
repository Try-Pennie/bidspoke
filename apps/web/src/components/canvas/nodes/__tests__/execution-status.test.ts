import { describe, it, expect } from 'vitest'
import type { ExecutionStep } from '@/types/workflow'
import { getNodeClasses } from '../execution-status'

describe('getNodeClasses — unconfigured node marker', () => {
  it('returns the throbbing node-warning marker when the node has a validation error', () => {
    // A custom class (globals.css) animates the border glow so it stands out at
    // any zoom — Tailwind's animate-pulse only dims the whole card, too subtle.
    expect(getNodeClasses(undefined, true)).toBe('node-warning')
  })

  it('adds no marker when there is no error and no execution', () => {
    expect(getNodeClasses(undefined, false)).toBe('')
  })

  it('lets execution state win over the validation marker', () => {
    const cls = getNodeClasses({ status: 'failed' } as ExecutionStep, true)
    expect(cls).toContain('ring-red-500')
    expect(cls).not.toContain('node-warning')
  })
})
