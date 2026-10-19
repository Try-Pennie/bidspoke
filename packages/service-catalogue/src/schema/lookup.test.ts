import { describe, expect, it } from 'vitest'
import { resolveActionVersion } from './lookup'
import { FIXTURE_RUNTIME_ACTIONS } from '../__fixtures__/catalogue/registry'

/**
 * Actions are looked up by (key, version), never by key alone (#1689 D1). A
 * step stores the version it was saved with and runs exactly that version, so
 * adding version 2 cannot silently change what a step saved on version 1 does,
 * and a step pinned to a version that no longer exists is refused by name rather
 * than run on the newest.
 */
describe('resolveActionVersion', () => {
  it('runs the version a step was pinned to, even after a newer one is registered', async () => {
    const versions = FIXTURE_RUNTIME_ACTIONS.filter((a) => a.key === 'fixture.echo').map((a) => a.version)
    expect(versions).toEqual([1, 2])

    const v1 = resolveActionVersion(FIXTURE_RUNTIME_ACTIONS, 'fixture.echo', 1)
    const v2 = resolveActionVersion(FIXTURE_RUNTIME_ACTIONS, 'fixture.echo', 2)
    if (!v1.ok || !v2.ok) throw new Error('both fixture versions must resolve')

    const ctx = {
      fetch: () => Promise.reject(new Error('the fixture makes no call')),
      signal: new AbortController().signal,
      target: null,
      sleep: () => Promise.reject(new Error('the fixture never waits')),
    }
    const outV1 = await v1.action.run(ctx, { text: 'hi' })
    const outV2 = await v2.action.run(ctx, { text: 'hi' })
    expect(outV1).toEqual({ echo: 'hi' })
    expect(outV2).toEqual({ echo: 'HI', version: 2 })
    expect(outV1).not.toEqual(outV2)
  })

  it('refuses a version that no longer exists by name, listing what does', () => {
    const result = resolveActionVersion(FIXTURE_RUNTIME_ACTIONS, 'fixture.echo', 3)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('action_version_missing')
    expect(result.key).toBe('fixture.echo')
    expect(result.version).toBe(3)
    expect(result.availableVersions).toEqual([1, 2])
    expect(result.message).toContain('fixture.echo')
    expect(result.message).toContain('3')
  })

  it('refuses an action key the catalogue does not have, by a different name', () => {
    const result = resolveActionVersion(FIXTURE_RUNTIME_ACTIONS, 'fixture.nope', 1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('action_unknown')
    expect(result.availableVersions).toEqual([])
  })

  it('never falls back to the newest version when the pinned one is missing', () => {
    // The failure D1 exists to prevent: a lookup that "helpfully" returns the
    // latest version when the stored one is gone.
    for (const missing of [0, -1, 1.5, Number.NaN]) {
      const result = resolveActionVersion(FIXTURE_RUNTIME_ACTIONS, 'fixture.echo', missing)
      expect(result.ok, `version ${missing} must be refused`).toBe(false)
    }
  })
})
