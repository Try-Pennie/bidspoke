/**
 * Guard (#1412, #1458, #2137, L607, L613): every control on the partners page
 * is a design system one from components/ui (form.tsx, with Select.tsx and
 * DateTimeFields.tsx in files of their own for bundle size). They own the
 * classes, the labelling and the Radix base, so a hand rolled copy is a control
 * that looks like the OS pasted into the product and may have no accessible
 * name. Renamed from buyer-profile-controls-guard.test.ts when it grew from the
 * Buyer profile directory to the whole page.
 *
 * Four rules, each with a positive control:
 *   1. No raw control (input, select, textarea, button, datalist, option, and
 *      no radio, checkbox, date or time type in any quote or brace spelling)
 *      in any non test .tsx under the partners page directories, walked
 *      recursively (.test.tsx files and __tests__ folders are not screens and
 *      are skipped), with a check that every such .tsx under them was scanned.
 *   2. No local Field, Input, Toggle or Select there, and no role="switch"
 *      anywhere in the app outside components/ui.
 *   3. No @radix-ui import anywhere in apps/web/src outside components/ui and
 *      the one Dialog shell, components/Dialog.tsx (#2134).
 *   4. A ratchet on the native <select> elements left in the app, which #2198
 *      moves onto the shared Select: the count may fall, never rise.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WEB_SRC, listFiles } from './_scan-utils'

/** The partners page: its route and its components, every subdirectory included. */
const GUARDED_DIRS = ['app/(app)/partners', 'components/partners']
const UI_DIR = 'components/ui'
/**
 * The app's one Dialog shell (#2134), the other place Radix may be imported:
 * it is a shared component every dialog is built from, and its own guard
 * (__guards__/dialog-shell-guard.test.ts) keeps every dialog on it.
 */
const DIALOG_SHELL = 'components/Dialog.tsx'
const PRIMITIVES = 'components/ui/form.tsx'
const SELECT = 'components/ui/Select.tsx'

const RAW_TAG = /<(input|select|textarea|button|datalist|option)\b/g
// The attribute value in every spelling JSX accepts: "x", 'x', {'x'}, {"x"}, {`x`}.
const quoted = (v: string) => `(?:"${v}"|'${v}'|\\{\\s*(?:"${v}"|'${v}'|\`${v}\`)\\s*\\})`
const RAW_TYPE = new RegExp(`\\btype\\s*=\\s*${quoted('(radio|checkbox|date|time)')}`, 'g')
const SWITCH_ROLE = new RegExp(`\\brole\\s*=\\s*${quoted('switch')}`)
const LOCAL_PRIMITIVE = /\b(?:function\s+(Field|Input|Toggle|Select)\b|(?:const|let)\s+(Field|Input|Toggle|Select)\s*[=:])/
const RADIX_IMPORT = /from\s+['"]@radix-ui\/|require\(\s*['"]@radix-ui\/|import\(\s*['"]@radix-ui\//
const NATIVE_SELECT = /<select\b/g

/** A line that is only a comment, in any of the spellings a .tsx uses. */
function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')
}

/** One pass over the lines of a file, comment lines skipped (L297). */
function codeLines(source: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = []
  source.split('\n').forEach((text, i) => { if (!isCommentLine(text)) out.push({ line: i + 1, text }) })
  return out
}

export function rawControlsIn(source: string): Array<{ line: number; what: string }> {
  const out: Array<{ line: number; what: string }> = []
  for (const { line, text } of codeLines(source)) {
    for (const m of text.matchAll(RAW_TAG)) out.push({ line, what: `<${m[1]}>` })
    for (const m of text.matchAll(RAW_TYPE)) {
      const kind = /radio|checkbox|date|time/.exec(m[0])![0]
      out.push({ line, what: `type ${kind}` })
    }
  }
  return out
}

export function localPrimitivesIn(source: string): Array<{ line: number; what: string }> {
  const out: Array<{ line: number; what: string }> = []
  for (const { line, text } of codeLines(source)) {
    const m = LOCAL_PRIMITIVE.exec(text)
    if (m) out.push({ line, what: `local ${m[1] ?? m[2]}` })
  }
  return out
}

const rel = (file: string) => path.relative(WEB_SRC, file)
const insideUi = (file: string) => rel(file).startsWith(`${UI_DIR}/`)

/** Every .tsx under a directory, tests included, read straight off the disk so the walk can be checked. */
function everyTsx(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...everyTsx(full))
    else if (entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

const guardedFiles = () => GUARDED_DIRS.flatMap((d) => listFiles(path.join(WEB_SRC, d), { exts: ['.tsx'] }))
const appFiles = () => listFiles(WEB_SRC, { exts: ['.ts', '.tsx'] })

describe('the partners page uses only the shared controls (L607)', () => {
  it('no guarded component renders a raw control', () => {
    const offenders = guardedFiles().flatMap((file) => rawControlsIn(readFileSync(file, 'utf8')).map((h) => `${rel(file)}:${h.line} ${h.what}`))
    expect(offenders).toEqual([])
  })

  it('no guarded component defines its own Field, Input, Toggle or Select', () => {
    const offenders = guardedFiles().flatMap((file) => localPrimitivesIn(readFileSync(file, 'utf8')).map((h) => `${rel(file)}:${h.line} ${h.what}`))
    expect(offenders).toEqual([])
  })

  it('every .tsx under the guarded directories was scanned, nested ones included, so an empty list is a measurement (L1)', () => {
    const scanned = new Set(guardedFiles())
    for (const dir of GUARDED_DIRS) {
      const onDisk = everyTsx(path.join(WEB_SRC, dir)).filter((f) => !f.endsWith('.test.tsx') && !f.includes(`${path.sep}__tests__${path.sep}`))
      expect(onDisk.length, dir).toBeGreaterThan(1)
      expect(onDisk.filter((f) => !scanned.has(f)), dir).toEqual([])
    }
    expect(scanned.size).toBeGreaterThan(20)
    // The walk reaches the nested Buyer profile directory, which a flat listing missed.
    expect([...scanned].some((f) => rel(f).startsWith('components/partners/buyer-profile/'))).toBe(true)
  })
})

describe('the shared controls live in one place (L613)', () => {
  it('no role="switch" outside components/ui, anywhere in the app', () => {
    const offenders = appFiles().filter((f) => !insideUi(f)).flatMap((file) =>
      codeLines(readFileSync(file, 'utf8')).filter(({ text }) => SWITCH_ROLE.test(text)).map(({ line }) => `${rel(file)}:${line}`))
    expect(offenders).toEqual([])
  })

  it('no @radix-ui import outside components/ui and the one Dialog shell, anywhere in the app: callers import our components', () => {
    const offenders = appFiles().filter((f) => !insideUi(f) && rel(f) !== DIALOG_SHELL).flatMap((file) =>
      codeLines(readFileSync(file, 'utf8')).filter(({ text }) => RADIX_IMPORT.test(text)).map(({ line }) => `${rel(file)}:${line}`))
    expect(offenders).toEqual([])
  })

  it('the primitives render the raw boxes and buttons, and no native select: the one Select is Radix (#2137)', () => {
    // Inverted deliberately in #2137: this asserted form.tsx rendered a raw
    // <select>; the shared Select is now on @radix-ui/react-select, in
    // Select.tsx beside form.tsx so routes without a dropdown stay lighter.
    const tags = new Set(rawControlsIn(readFileSync(path.join(WEB_SRC, PRIMITIVES), 'utf8')).map((h) => h.what))
    for (const t of ['<input>', '<textarea>', '<button>']) expect(tags.has(t), t).toBe(true)
    const uiFiles = listFiles(path.join(WEB_SRC, UI_DIR), { exts: ['.tsx'] })
    expect(uiFiles.flatMap((f) => rawControlsIn(readFileSync(f, 'utf8')).filter((h) => h.what === '<select>').map((h) => `${rel(f)}:${h.line}`))).toEqual([])
    expect(readFileSync(path.join(WEB_SRC, SELECT), 'utf8')).toMatch(/from '@radix-ui\/react-select'/)
  })
})

/**
 * The native selects left in the app, in .tsx (a native select exists only in
 * JSX), counted on main at cc073f0f when #2137 built the shared Select: 40 in
 * 11 files. #2137 took 8 of them: SignalRuleBuilder.tsx 3,
 * ExtraExtractionEditor.tsx 2, BidResolverEditor.tsx 1, BidMatrixViewer.tsx 1
 * and form.tsx 1, leaving the 32 in 6 files below. #2198 moves the rest and
 * takes this to zero; until then a new native select fails here instead of
 * merging.
 */
const NATIVE_SELECT_CEILING: Record<string, number> = {
  'app/(app)/integrations/page.tsx': 2,
  'app/(app)/sources/page.tsx': 2,
  'components/canvas/ConfigPanel.tsx': 24,
  'components/canvas/TriggerConfigPanel.tsx': 2,
  'components/forms/EndpointForm.tsx': 1,
  'components/rule-builder/RuleBuilder.tsx': 1,
}

export function nativeSelectCounts(files: ReadonlyArray<{ name: string; source: string }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const { name, source } of files) {
    let n = 0
    for (const { text } of codeLines(source)) n += [...text.matchAll(NATIVE_SELECT)].length
    if (n > 0) out[name] = n
  }
  return out
}

describe('native selects only fall (#2198 ratchet)', () => {
  it('no file holds more native selects than it did, and no new file holds one', () => {
    const counts = nativeSelectCounts(listFiles(WEB_SRC, { exts: ['.tsx'] }).map((f) => ({ name: rel(f), source: readFileSync(f, 'utf8') })))
    const over = Object.entries(counts).filter(([file, n]) => n > (NATIVE_SELECT_CEILING[file] ?? 0)).map(([file, n]) => `${file}: ${n} native select(s), allowed ${NATIVE_SELECT_CEILING[file] ?? 0}`)
    expect(over).toEqual([])
    // A total over the ceiling's own files: the count is a measurement, not an empty walk.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
  })
})

describe('the detectors fire on what they exist to catch (positive controls)', () => {
  it('a raw control is found in each spelling, and a comment about one is not', () => {
    const smuggled = [
      'const x = (',
      '  <select className="input">',
      '  // a <button> in a comment is fine',
      '  {/* <textarea> in a JSX comment is fine */}',
      '  <input type="text" />',
      '  <datalist id="d"><option value="a" /></datalist>',
      '  <Box type="date" />',
      "  <Box type='time' />",
      "  <Box type={'radio'} />",
      '  <Box type={"checkbox"} />',
      '  <Box type={`date`} />',
      ')',
    ].join('\n')
    expect(rawControlsIn(smuggled)).toEqual([
      { line: 2, what: '<select>' },
      { line: 5, what: '<input>' },
      { line: 6, what: '<datalist>' },
      { line: 6, what: '<option>' },
      { line: 7, what: 'type date' },
      { line: 8, what: 'type time' },
      { line: 9, what: 'type radio' },
      { line: 10, what: 'type checkbox' },
      { line: 11, what: 'type date' },
    ])
  })

  it('a local primitive is found as a function or a const, and a longer name is not', () => {
    expect(localPrimitivesIn('function Toggle({ checked }) {}\nconst Select = () => null\nfunction FieldGroup() {}\nfunction InputRow() {}')).toEqual([
      { line: 1, what: 'local Toggle' },
      { line: 2, what: 'local Select' },
    ])
  })

  it('role switch and a Radix import are found in each spelling', () => {
    for (const text of ['role="switch"', "role='switch'", "role={'switch'}", 'role={"switch"}']) expect(SWITCH_ROLE.test(text), text).toBe(true)
    expect(SWITCH_ROLE.test('role="switcher"')).toBe(false)
    for (const text of ["import * as S from '@radix-ui/react-select'", 'import { Root } from "@radix-ui/react-switch"', "const P = await import('@radix-ui/react-popover')"]) expect(RADIX_IMPORT.test(text), text).toBe(true)
  })

  it('the native select count reads a new one, and ignores one in a comment', () => {
    expect(nativeSelectCounts([
      { name: 'a.tsx', source: '<select>\n// <select> in a comment\n<select value={x}>' },
      { name: 'b.tsx', source: '<Select />' },
    ])).toEqual({ 'a.tsx': 2 })
  })
})
