/**
 * isWorkerNotFoundError decides whether a failed code-node dispatch may fall back
 * to the legacy per-node worker. A wrong `true` runs stale orphaned code on a live
 * lead (#475), so the contract is deliberately conservative (#604): ONLY a genuine
 * Error whose message says "Worker not found" authorizes the fallback. Anything
 * else is treated as a transient dispatch failure and fails the node.
 *
 * The old implementation did `err instanceof Error ? err.message : String(err)`,
 * which let a bare string throw (and any object with a custom toString) authorize
 * the fallback, and rendered a plain object as the useless "[object Object]".
 */
import { describe, it, expect } from 'vitest'
import { isWorkerNotFoundError } from '../code-node-deployer'

describe('isWorkerNotFoundError', () => {
  it('authorizes the fallback for a genuine "Worker not found" Error', () => {
    expect(isWorkerNotFoundError(new Error('Worker not found: bs-wf-abc123'))).toBe(true)
  })

  it('is case-insensitive on a genuine Error', () => {
    expect(isWorkerNotFoundError(new Error('worker not found'))).toBe(true)
  })

  it('refuses a transient Error', () => {
    expect(isWorkerNotFoundError(new Error('binding resolve failed'))).toBe(false)
  })

  // The live bug: a bare string throw was run through String(), matched the regex,
  // and authorized the fallback. A throw we cannot positively identify as the
  // platform's not-found Error must never run stale code on a live lead.
  it('refuses a bare string throw even when it says "Worker not found"', () => {
    expect(isWorkerNotFoundError('Worker not found: bs-wf-abc123')).toBe(false)
  })

  // Same hole, reached through a custom toString rather than a string primitive.
  it('refuses an object whose toString says "Worker not found"', () => {
    expect(isWorkerNotFoundError({ toString: () => 'Worker not found: bs-wf-abc123' })).toBe(false)
  })

  it('refuses a plain object error, whatever its message field says', () => {
    expect(isWorkerNotFoundError({ message: 'Worker not found: bs-wf-abc123' })).toBe(false)
  })

  it('refuses null and undefined without throwing', () => {
    expect(isWorkerNotFoundError(null)).toBe(false)
    expect(isWorkerNotFoundError(undefined)).toBe(false)
  })
})
