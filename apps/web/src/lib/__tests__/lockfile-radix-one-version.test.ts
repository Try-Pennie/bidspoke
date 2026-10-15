import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * Every @radix-ui package resolves to exactly one version (#2134).
 *
 * Radix packages share internals (focus scope, dismissable layer, portal,
 * presence), each pinned to an exact version by the package that uses it. Two
 * copies of one internal break nesting: a Select opened inside the Dialog shell
 * would have its option clicks read as clicks outside the dialog, and the two
 * focus traps fight. So every Radix package the app adds comes from ONE Radix
 * release, the one components/Dialog.tsx was pinned from (2026-07-24: dialog
 * 1.1.23, select 2.3.7, tabs 1.1.21, switch 1.3.7, popover 1.1.23, all on
 * primitive 1.1.7, focus-scope 1.1.16, dismissable-layer 1.1.19), and this
 * fails the day a second version of any of them enters the lockfile.
 */
const LOCKFILE = path.join(REPO_ROOT, 'pnpm-lock.yaml')

/** Each @radix-ui package named in the lockfile's packages section, with every version it resolves to. */
export function radixVersions(lock: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  let section = ''
  for (const line of lock.split('\n')) {
    const top = /^([a-z][a-zA-Z]*):$/.exec(line)
    if (top) { section = top[1]; continue }
    if (section !== 'packages') continue
    const m = /^ {2}'?(@radix-ui\/[^@]+)@([^(':]+)/.exec(line)
    if (!m) continue
    out.set(m[1], (out.get(m[1]) ?? new Set()).add(m[2]))
  }
  return out
}

const twoOf = (versions: Map<string, Set<string>>) => [...versions].filter(([, v]) => v.size > 1).map(([name, v]) => `${name}: ${[...v].join(', ')}`)

describe('one version of each Radix package (#2134)', () => {
  it('sees a second version of an internal in a lockfile that has one', () => {
    const lock = [
      'packages:',
      "  '@radix-ui/react-focus-scope@1.1.16':",
      '    resolution: {}',
      "  '@radix-ui/react-focus-scope@1.1.17':",
      '    resolution: {}',
      "  '@radix-ui/react-dialog@1.1.23':",
      'snapshots:',
      "  '@radix-ui/react-focus-scope@1.1.18(react@18.3.1)':",
    ].join('\n')
    expect(twoOf(radixVersions(lock))).toEqual(['@radix-ui/react-focus-scope: 1.1.16, 1.1.17'])
  })

  it('the lockfile resolves every @radix-ui package to one version', () => {
    const versions = radixVersions(readFileSync(LOCKFILE, 'utf8'))
    expect(versions.get('@radix-ui/react-dialog'), 'the Dialog shell is built on @radix-ui/react-dialog').toBeDefined()
    expect(versions.size).toBeGreaterThan(10)
    expect(twoOf(versions)).toEqual([])
  })
})
