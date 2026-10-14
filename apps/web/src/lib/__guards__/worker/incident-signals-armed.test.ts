import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every entry in the incident registry (apps/worker/src/lib/incident-signals.ts,
 * #2099) is armed by some check.
 *
 * The compiler holds the other direction: the recovery functions take the
 * registry's type, so a check cannot arm a prefix the registry does not name.
 * Nothing in the type system notices an entry whose check was deleted, and a
 * dead entry would be offered to the dashboard as a signal that can never
 * appear, so this looks for each signal's literal in the worker's own source,
 * outside the registry and the tests.
 */
const REGISTRY = path.join(WORKER_SRC, 'lib', 'incident-signals.ts')

const registered = [...readFileSync(REGISTRY, 'utf8').matchAll(/signal: '([a-z-]+)'/g)].map((m) => m[1])

const sources = listTsFiles(WORKER_SRC)
  .filter((full) => full !== REGISTRY && !full.replace(/\\/g, '/').includes('/__tests__/'))
  .map((full) => sanitizeSource(readFileSync(full, 'utf8'), { blankStrings: false }))
  .join('\n')

describe('incident registry entries are armed', () => {
  it('reads the registry', () => {
    expect(registered.length).toBe(12)
  })

  it.each(registered)('%s is armed outside the registry', (signal) => {
    expect(sources.includes(`'${signal}'`), `${signal} is registered but no check names it`).toBe(true)
  })
})
