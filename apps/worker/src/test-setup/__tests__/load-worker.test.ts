/**
 * loadWorker preloads every module the Worker entry imports lazily (#2619). A
 * lazy import it fails to list is not an error, only a test that pays for the
 * load again, so the list is held against the entry's own text.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import ENTRY_SOURCE from '../../index.ts?raw'
import { fromHere, lazyImportsOf, loadWorker } from '../load-worker'

const source = ENTRY_SOURCE as string

describe('lazyImportsOf', () => {
  it('lists every distinct relative module the entry imports with import()', () => {
    const written = new Set([...source.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]))
    const found = lazyImportsOf(source)
    expect(written.size).toBeGreaterThan(20)
    expect(new Set(found)).toEqual(written)
    expect(found).toContain('./lib/ops-connection-owner-check')
  })

  it('reads both quote styles, and lists a module imported twice once', () => {
    expect(lazyImportsOf(`const a = await import('./lib/a')\nconst b = await import("../b")\nconst c = await import('./lib/a')`)).toEqual(['./lib/a', '../b'])
  })

  it('rewrites a specifier from src/ for src/test-setup/', () => {
    expect(fromHere('./lib/a')).toBe('../lib/a')
    expect(fromHere('../b')).toBe('../../b')
  })
})

// Loaded while the file is collected, as every caller does; a specifier it
// rewrote wrongly fails this file here, naming the module it could not load.
const entry = await loadWorker()

describe('loadWorker', () => {
  it('returns the entry, every module its crons import lazily having loaded (a wrong specifier fails this file while it is collected)', async () => {
    expect(typeof entry.default.scheduled).toBe('function')
    const owner = await import('../../lib/ops-connection-owner-check')
    expect(typeof owner.runOpsConnectionOwnerCheckForEnv).toBe('function')
  })
})
