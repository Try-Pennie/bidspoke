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
import ts from 'typescript'
import { REPO_ROOT, WORKER_SRC, listFiles } from '../../__tests__/_scan-utils'
import { isRegisteredTransitionSetting } from '../../../../../worker/src/lib/transition-settings'

const REGISTRY_FILE = path.join(WORKER_SRC, 'lib', 'transition-settings.ts')

const PREFIX = /^(porting|rollout|validation)\./
// One character rule for every check: a whole key, and the known part of a key
// built at run time, so the three cannot drift apart (review of #1715).
const KEY_CHARS = '[A-Za-z0-9_.-]'
const FULL_KEY = new RegExp(`^(porting|rollout|validation)\\.${KEY_CHARS}+$`)
const KEY_HEAD = new RegExp(`^(porting|rollout|validation)\\.${KEY_CHARS}*$`)

// ── The scanner ───────────────────────────────────────────────────────────────

interface KeyRead { line: number; text: string; dynamic: boolean }

/**
 * Every string literal in a source file whose content starts with one of the
 * three prefixes. The file is parsed by the TypeScript compiler, so comments,
 * regex literals and division are told apart from strings by the same grammar
 * the build uses; a hand rolled character scan cannot, and a quote inside a
 * regex once shifted every later literal in the file out of view (review of
 * #1715). A comment is never a read, because a sentence ABOUT a key is not one
 * (L103). A template literal that builds the key from a variable is reported as
 * dynamic, because no registry can vouch for a key it cannot see. A literal that
 * starts with a prefix but is prose (a message that begins with the key and
 * carries on) is not a key and is not reported.
 */
function settingKeyLiterals(src: string, fileName = 'source.ts'): KeyRead[] {
  const out: KeyRead[] = []
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // `'porting.' + lane`: the literal is the left of a join, so the key it
      // starts is built at run time, and no registry can vouch for it (#1715 review).
      const parent = node.parent
      const joinedOn = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken && parent.left === node
      if (joinedOn && KEY_HEAD.test(node.text)) {
        out.push({ line: lineOf(node), text: `${node.text}\${}`, dynamic: true })
      } else if (FULL_KEY.test(node.text)) out.push({ line: lineOf(node), text: node.text, dynamic: false })
    } else if (ts.isTemplateExpression(node)) {
      // The head is the text before the first substitution: `porting.${x}` has
      // head "porting.", which no registry can resolve.
      const head = node.head.text
      if (PREFIX.test(head) && KEY_HEAD.test(head)) {
        out.push({ line: lineOf(node), text: `${head}\${}${node.templateSpans.map((sp) => sp.literal.text).join('${}')}`, dynamic: true })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
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

  it('reports a key built by joining a prefix to a variable as dynamic', () => {
    for (const src of ["read('porting.' + lane)", "read('rollout.' + lane + '_enabled')", 'read("validation.money_" + mode)']) {
      const found = settingKeyLiterals(src)
      expect(found, src).toHaveLength(1)
      expect(found[0].dynamic, src).toBe(true)
    }
  })

  it('does not report a joined prefix that is prose, not a key', () => {
    expect(settingKeyLiterals("log('porting. starting ' + n)")).toEqual([])
  })

  it('finds a key spelled with capitals, hyphens or a second dot', () => {
    const found = settingKeyLiterals("a('porting.Tee-Enabled'); b('rollout.new.lane')")
    expect(found.map((f) => f.text)).toEqual(['porting.Tee-Enabled', 'rollout.new.lane'])
  })

  it('reports a built key as dynamic whatever characters its known part uses', () => {
    for (const src of ["read('rollout.new.' + lane)", "read('porting.Tee-' + lane)", 'read(`porting.Tee-${x}`)', 'read(`rollout.new.${x}`)']) {
      const found = settingKeyLiterals(src)
      expect(found, src).toHaveLength(1)
      expect(found[0].dynamic, src).toBe(true)
    }
  })

  it('does not report a key named in a comment', () => {
    expect(settingKeyLiterals("// see 'porting.tee_enabled'\n/* `rollout.x` */ const a = 1")).toEqual([])
  })

  it('does not report a message that begins with a key and carries on', () => {
    expect(settingKeyLiterals('throw new Error(`porting.recording_enabled has no value before ${t}`)')).toEqual([])
  })

  // A quote inside a regex literal is not a string start. Read character by
  // character it is, and everything after it on the file shifts: the key below
  // was then read as code and the guard went silent on it (review of #1715).
  it('still finds a key after a regex literal holding a quote', () => {
    const found = settingKeyLiterals("const q = /'/g\nexport const k = read('porting.unregistered_lane')\n")
    expect(found.map((f) => [f.line, f.text])).toEqual([[2, 'porting.unregistered_lane']])
  })

  it('still finds a key after a regex literal holding a backtick, and after a division', () => {
    const src = 'const t = /`/\nconst half = total / 2\nconst k = "rollout.unregistered_lane"\n'
    expect(settingKeyLiterals(src).map((f) => f.text)).toEqual(['rollout.unregistered_lane'])
  })

  it('finds a key used inside a template expression', () => {
    const found = settingKeyLiterals('const m = `value ${read(\'validation.unregistered_lane\')}`')
    expect(found.map((f) => f.text)).toEqual(['validation.unregistered_lane'])
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
      for (const read of settingKeyLiterals(readFileSync(file, 'utf8'), file)) {
        const where = `${path.relative(REPO_ROOT, file)}:${read.line}`
        if (read.dynamic) offenders.push(`${where} builds a setting key from a variable: ${read.text}`)
        else if (!isRegisteredTransitionSetting(read.text)) offenders.push(`${where} reads ${read.text}, which is not in lib/transition-settings.ts`)
      }
    }
    expect(offenders).toEqual([])
  })
})
