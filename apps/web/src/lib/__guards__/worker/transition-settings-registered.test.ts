/**
 * Every transition or rollout setting key the Worker or a workspace package reads
 * is declared in apps/worker/src/lib/transition-settings.ts (R9 in discussion
 * #1684, built in #1706).
 *
 * The registry is what the Porting page and the daily lane check read, so a lane
 * whose setting is read somewhere but not declared there is a lane nothing pages
 * on (L96, L735). This scan fails on any read of a `porting.*`, `rollout.*` or
 * `validation.*` key that is not registered, by file and line, and on any such
 * key built from a variable, which no registry can vouch for. Seen red on
 * 2026-10-01 against a probe file holding one unregistered literal and one built
 * key, each named in the failure.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT, WORKER_SRC, listFiles } from '../../__tests__/_scan-utils'
import { isRegisteredTransitionSetting } from '../../../../../worker/src/lib/transition-settings'

const REGISTRY_FILE = path.join(WORKER_SRC, 'lib', 'transition-settings.ts')

const PREFIX = /^(porting|rollout|validation)\./
const FULL_KEY = /^(porting|rollout|validation)\.[a-z0-9_]+$/

// ── The scanner ───────────────────────────────────────────────────────────────

interface KeyRead { line: number; text: string; dynamic: boolean }

/**
 * Every string literal in a source file whose content starts with one of the
 * three prefixes. Comments are skipped, because a sentence ABOUT a key is not a
 * read of it (L103). A template literal that builds the key from a variable is
 * reported as dynamic, because no registry can vouch for a key it cannot see.
 * A literal that starts with a prefix but is prose (a message that begins with
 * the key and carries on) is not a key and is not reported.
 */
function settingKeyLiterals(src: string): KeyRead[] {
  const out: KeyRead[] = []
  let i = 0
  let line = 1
  const n = src.length
  while (i < n) {
    const ch = src[i]
    if (ch === '\n') { line++; i++; continue }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++ }
      i += 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      const startLine = line
      let text = ''
      let dynamic = false
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') { text += src[i + 1] ?? ''; i += 2; continue }
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          dynamic = true
          let depth = 1
          i += 2
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            else if (src[i] === '\n') line++
            i++
          }
          text += '${}'
          continue
        }
        if (src[i] === '\n') line++
        text += src[i]
        i++
      }
      i++
      if (PREFIX.test(text)) {
        if (dynamic && /^(porting|rollout|validation)\.[a-z0-9_]*\$\{\}/.test(text)) {
          out.push({ line: startLine, text, dynamic: true })
        } else if (FULL_KEY.test(text)) {
          out.push({ line: startLine, text, dynamic: false })
        }
      }
      continue
    }
    i++
  }
  return out
}

// The shared walk skips __tests__, __guards__, node_modules and *.test.* files,
// which hold fixtures ABOUT keys rather than reads of them.
const sourceFiles = (root: string): string[] => listFiles(root, { exts: ['.ts', '.tsx', '.mts'] })

function scannedRoots(): string[] {
  const packages = path.join(REPO_ROOT, 'packages')
  const packageSrcs = readdirSync(packages)
    .map((p) => path.join(packages, p, 'src'))
    .filter((p) => { try { return statSync(p).isDirectory() } catch { return false } })
  return [WORKER_SRC, ...packageSrcs]
}

describe('settingKeyLiterals (the scanner itself)', () => {
  it('finds a key read in a string literal, with its line', () => {
    expect(settingKeyLiterals("const a = 1\nreadSetting('porting.tee_enabled')")).toEqual([
      { line: 2, text: 'porting.tee_enabled', dynamic: false },
    ])
  })

  it('finds every prefix and every quote style', () => {
    const found = settingKeyLiterals('x("rollout.new_run_states_enabled"); y(`validation.money_report_only`)')
    expect(found.map((f) => f.text)).toEqual(['rollout.new_run_states_enabled', 'validation.money_report_only'])
  })

  it('reports a key built from a variable as dynamic', () => {
    const found = settingKeyLiterals('read(`porting.${lane}_enabled`)')
    expect(found).toHaveLength(1)
    expect(found[0].dynamic).toBe(true)
  })

  it('does not report a key named in a comment', () => {
    expect(settingKeyLiterals("// see 'porting.tee_enabled'\n/* `rollout.x` */ const a = 1")).toEqual([])
  })

  it('does not report a message that begins with a key and carries on', () => {
    expect(settingKeyLiterals('throw new Error(`porting.recording_enabled has no value before ${t}`)')).toEqual([])
  })

  it('does not report an unrelated dotted string', () => {
    expect(settingKeyLiterals("import x from './porting-registry'; const k = 'validationErrors'")).toEqual([])
  })
})

describe('every setting key read is in the registry', () => {
  it('scans a real tree, not an empty one', () => {
    const files = scannedRoots().flatMap(sourceFiles)
    // apps/worker/src alone holds several hundred source files; a walk that found
    // a handful has lost its root, and its silence would read as a clean tree.
    expect(files.length).toBeGreaterThan(300)
    expect(files).toContain(REGISTRY_FILE)
  })

  it('finds no unregistered or dynamically built setting key', () => {
    const offenders: string[] = []
    for (const file of scannedRoots().flatMap(sourceFiles)) {
      if (file === REGISTRY_FILE) continue
      for (const read of settingKeyLiterals(readFileSync(file, 'utf8'))) {
        const where = `${path.relative(REPO_ROOT, file)}:${read.line}`
        if (read.dynamic) offenders.push(`${where} builds a setting key from a variable: ${read.text}`)
        else if (!isRegisteredTransitionSetting(read.text)) offenders.push(`${where} reads ${read.text}, which is not in lib/transition-settings.ts`)
      }
    }
    expect(offenders).toEqual([])
  })
})
