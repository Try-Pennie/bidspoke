import { describe, it, expect } from 'vitest'
// The hook-side typecheck filter (issue #27): full-project tsc, but only
// errors in git-tracked files block. Pinning the parser/partition logic so
// untracked parallel-session debris can never block a clean commit again.
import { partitionTscErrors } from '../../../../../scripts/typecheck-tracked.mjs'

const tracked = new Set([
  'apps/worker/src/engine/retry.ts',
  'apps/web/src/lib/api.ts',
])

describe('partitionTscErrors', () => {
  it('blocks on errors in tracked files', () => {
    const { trackedErrors, untrackedErrors } = partitionTscErrors(
      ['src/engine/retry.ts(12,3): error TS2345: nope'],
      'apps/worker',
      tracked
    )
    expect(trackedErrors).toHaveLength(1)
    expect(untrackedErrors).toHaveLength(0)
  })

  it('warns (not blocks) on errors in untracked files', () => {
    const { trackedErrors, untrackedErrors } = partitionTscErrors(
      ['src/__tests__/docs-coverage.test.ts(3,1): error TS2307: Cannot find module'],
      'apps/worker',
      tracked
    )
    expect(trackedErrors).toHaveLength(0)
    expect(untrackedErrors).toHaveLength(1)
    expect(untrackedErrors[0]).toContain('apps/worker')
  })

  it('ignores non-error output lines', () => {
    const { trackedErrors, untrackedErrors } = partitionTscErrors(
      ['', 'Files: 312', '> tsc --noEmit', 'src/lib/api.ts:100 some note without error marker'],
      'apps/web',
      tracked
    )
    expect(trackedErrors).toHaveLength(0)
    expect(untrackedErrors).toHaveLength(0)
  })

  it('resolves package-relative paths against the package dir', () => {
    const { trackedErrors } = partitionTscErrors(
      ['src/lib/api.ts(5,1): error TS1005: comma expected'],
      'apps/web',
      tracked
    )
    expect(trackedErrors).toHaveLength(1)
  })
})
