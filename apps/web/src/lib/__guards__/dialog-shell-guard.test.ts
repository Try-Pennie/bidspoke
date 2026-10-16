/**
 * One Dialog shell for the whole app, and no native dialogs (#2134, L613, L607).
 *
 * components/Dialog.tsx is the only dialog in apps/web. Three scans keep it so,
 * each one pass per file over the product source (L297), with positive controls
 * on scratch sources so none of them passes because it matches nothing (L1):
 *
 * 1. Dialog markup: role="dialog", role="alertdialog", aria-modal, a <dialog>
 *    element or showModal(), the retired useFocusTrap, or an import of the Radix
 *    dialog primitives, anywhere but the shell.
 * 2. Native dialogs, in every spelling: window., globalThis. or self. followed
 *    by confirm(, alert( or prompt(, and the bare call. A bare name the file
 *    declares itself (function alert, const confirm) is the file's own function,
 *    not the browser's.
 * 3. Conflict components on the partners page other than MergeDialog: the 409
 *    side by side (ProfileConflictView) and its Take theirs and Save over theirs
 *    were deleted with #2134, and nothing may grow back beside the merge dialog.
 *
 * Product source only: __tests__, __guards__, e2e and *.test files are out of
 * scope (so the local alert helper in drift-alert-state.test.ts is not a
 * native call). The allowlists name PR7 (#2138), which replaces the partners
 * page's leave prompts and its inline click delivery confirmation and empties
 * them; each entry is held to its exact count, so a new call in an allowlisted
 * file still fails.
 *
 * Seen failing: a role="dialog" div added to ConfirmDialog.tsx, a
 * window.confirm added to BidMatrixViewer.tsx, a bare confirm( added to
 * WorkflowCanvas.tsx, and ProfileConflictView.tsx restored.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, sanitizeSource, WEB_SRC } from '../__tests__/_scan-utils'

const rel = (file: string) => path.relative(WEB_SRC, file).split(path.sep).join('/')
const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

// Assembled from fragments, so this guard's own source never holds the spellings it hunts.
const DIALOG = ['dia', 'log'].join('')
const RADIX = ['@radix-ui', `react-${DIALOG}`].join('/')
const TRAP = ['use', 'Focus', 'Trap'].join('')

/** Dialog markup the shell alone may hold. */
const MARKUP: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: `role ${DIALOG}`, re: new RegExp(`role\\s*=\\s*\\{?\\s*(['"\`])(alert)?${DIALOG}\\1`, 'g') },
  { name: 'aria-modal', re: /aria-modal/g },
  { name: `<${DIALOG}> element`, re: new RegExp(`<${DIALOG}[\\s>]`, 'g') },
  { name: 'showModal()', re: /\.showModal\s*\(/g },
  { name: TRAP, re: new RegExp(`\\b${TRAP}\\b`, 'g') },
  { name: 'Radix dialog import', re: new RegExp(`['"]${RADIX.replace('/', '\\/')}['"]|['"]@radix-ui\\/react-alert-${DIALOG}['"]`, 'g') },
]

const SHELL = 'components/Dialog.tsx'

/** Markup allowed outside the shell until the named issue removes it, with how many. */
const MARKUP_ALLOWED: Readonly<Record<string, { count: number; issue: string; what: string }>> = {
  'app/(app)/partners/PartnerForm.tsx': { count: 1, issue: '#2138', what: 'the inline click delivery confirmation (deliveryConfirm), deleted by PR7' },
}

export function dialogMarkupIn(file: string, source: string): string[] {
  if (file === SHELL) return []
  const code = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  for (const { name, re } of MARKUP) {
    for (const m of code.matchAll(re)) found.push(`${file}:${lineOf(code, m.index ?? 0)} ${name}`)
  }
  return found
}

const NATIVE = ['confirm', 'alert', 'prompt'] as const
const PREFIXED = new RegExp(`\\b(?:window|globalThis|self)\\s*\\.\\s*(${NATIVE.join('|')})\\s*\\(`, 'g')
const BARE = new RegExp(`\\b(${NATIVE.join('|')})\\s*\\(`, 'g')

/** The native names a file declares for itself, which its bare calls then mean. */
function declaredNames(code: string): Set<string> {
  const out = new Set<string>()
  for (const name of NATIVE) {
    const declared = new RegExp(`\\b(?:function|const|let|var|class)\\s+${name}\\b|\\bimport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}|[(,]\\s*${name}\\s*[,)=:]`)
    if (declared.test(code)) out.add(name)
  }
  return out
}

export function nativeDialogsIn(file: string, source: string): string[] {
  const code = sanitizeSource(source)
  const found: string[] = []
  for (const m of code.matchAll(PREFIXED)) found.push(`${file}:${lineOf(code, m.index ?? 0)} ${m[0].replace(/\s+/g, '')}`)
  const own = declaredNames(code)
  for (const m of code.matchAll(BARE)) {
    if (own.has(m[1])) continue
    // Not bare when an identifier character or a dot (spaces allowed) comes first:
    // that is a method (api.held.confirm) or another name (myconfirm), and the
    // prefixed spellings are counted above. `function alert(` declares, not calls.
    const before = code.slice(0, m.index ?? 0).trimEnd()
    if (/[\w$.]$/.test(before) && !/\b(?:return|typeof|void|await|new)$/.test(before)) continue
    found.push(`${file}:${lineOf(code, m.index ?? 0)} ${m[1]}(`)
  }
  return found
}

/** Native dialogs allowed until PR7 (#2138) replaces the partners page's leave prompts. */
const NATIVE_ALLOWED: Readonly<Record<string, { count: number; issue: string }>> = {
  'app/(app)/partners/PartnerForm.tsx': { count: 2, issue: '#2138' },
  'app/(app)/partners/page.tsx': { count: 1, issue: '#2138' },
}

const PARTNERS_DIRS = ['app/(app)/partners/', 'components/partners/']
const MERGE_DIALOG = 'components/partners/MergeDialog.tsx'
const CONFLICT_WORDS = ['Take theirs', 'Save over theirs', 'Keep yours', 'Use theirs']

export function conflictComponentsIn(file: string, source: string): string[] {
  if (file === MERGE_DIALOG || !PARTNERS_DIRS.some((d) => file.startsWith(d))) return []
  const code = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  for (const m of code.matchAll(/\b(?:function|const|class)\s+([A-Z]\w*Conflict\w*)/g)) found.push(`${file}:${lineOf(code, m.index ?? 0)} ${m[1]}`)
  for (const word of CONFLICT_WORDS) {
    for (const m of code.matchAll(new RegExp(word, 'g'))) found.push(`${file}:${lineOf(code, m.index ?? 0)} "${word}"`)
  }
  return found
}

const sources = listFiles(WEB_SRC).map((f) => ({ file: rel(f), source: readFileSync(f, 'utf8') }))

/** Findings per file, less what an allowlist entry permits at its exact count. */
function beyondAllowance(found: string[], allowed: Readonly<Record<string, { count: number }>>): string[] {
  const byFile = new Map<string, string[]>()
  for (const f of found) {
    const file = f.slice(0, f.indexOf(':'))
    byFile.set(file, [...(byFile.get(file) ?? []), f])
  }
  const out: string[] = []
  for (const [file, list] of byFile) {
    const allowance = allowed[file]?.count ?? 0
    if (list.length !== allowance) out.push(...list.map((l) => `${l} (allowed here: ${allowance})`))
  }
  for (const [file, { count }] of Object.entries(allowed)) {
    if (!byFile.has(file) && count > 0) out.push(`${file}: allowlisted for ${count} but has none; remove the entry`)
  }
  return out
}

describe('the scans see the product source', () => {
  it('reads the shell and the files it is about, so nothing passes by reading nothing', () => {
    const files = sources.map((s) => s.file)
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain(SHELL)
    expect(files).toContain('components/canvas/WorkflowCanvas.tsx')
    expect(files.some((f) => f.includes('__tests__') || f.includes('__guards__') || /\.test\.tsx?$/.test(f))).toBe(false)
  })
})

describe('dialog markup lives only in the Dialog shell (#2134)', () => {
  it('positive controls: each spelling in a scratch product file is found, and the shell itself is not', () => {
    const scratch = [
      `<div role="${DIALOG}" />`, `<div role={'alert${DIALOG}'} />`, '<div aria-modal="true" />', `<${DIALOG} open />`,
      'ref.current.showModal()', `const r = ${TRAP}(true)`, `import * as D from '${RADIX}'`,
    ]
    for (const line of scratch) expect(dialogMarkupIn('components/Scratch.tsx', line), line).toHaveLength(1)
    expect(dialogMarkupIn(SHELL, `import * as D from '${RADIX}'\n<x aria-modal="true" />`)).toEqual([])
    expect(dialogMarkupIn('components/Scratch.tsx', `// role="${DIALOG}" in a comment`)).toEqual([])
  })

  it('no product file outside the shell holds dialog markup, beyond the PR7 allowlist', () => {
    expect(beyondAllowance(sources.flatMap((s) => dialogMarkupIn(s.file, s.source)), MARKUP_ALLOWED)).toEqual([])
  })

  it('every allowlist entry names the issue that removes it', () => {
    for (const entry of Object.values(MARKUP_ALLOWED)) expect(entry.issue).toMatch(/^#\d+$/)
  })
})

describe('no native dialogs in product source (#2134, L607)', () => {
  it('positive controls: a bare and each prefixed call fail; a file\'s own alert passes', () => {
    for (const call of ['confirm("x")', 'alert(1)', 'prompt("y")', 'window.confirm("x")', 'globalThis.alert(1)', 'self.prompt("y")', 'if (!window . confirm (m)) return']) {
      expect(nativeDialogsIn('components/Scratch.tsx', call), call).toHaveLength(1)
    }
    expect(nativeDialogsIn('components/Scratch.tsx', 'function alert(msg: string) { return msg }\nalert("mine")')).toEqual([])
    expect(nativeDialogsIn('components/Scratch.tsx', 'const confirm = (m: string) => m\nconfirm("mine")')).toEqual([])
    expect(nativeDialogsIn('components/Scratch.tsx', 'api.held.confirm(id)\nsetAlert(x)\nmyconfirm(1)')).toEqual([])
    expect(nativeDialogsIn('components/Scratch.tsx', '// window.confirm(x) in a comment\nconst s = "alert(1)"')).toEqual([])
  })

  it('no product file calls one, beyond the partners page leave prompts PR7 replaces', () => {
    expect(beyondAllowance(sources.flatMap((s) => nativeDialogsIn(s.file, s.source)), NATIVE_ALLOWED)).toEqual([])
  })

  it('the allowlist holds only the partners page, naming PR7', () => {
    expect(Object.keys(NATIVE_ALLOWED).every((f) => f.startsWith('app/(app)/partners/'))).toBe(true)
    for (const entry of Object.values(NATIVE_ALLOWED)) expect(entry.issue).toBe('#2138')
  })
})

describe('MergeDialog is the only conflict component on the partners page (#2134)', () => {
  it('positive controls: a conflict view or its words outside MergeDialog fail, inside it they pass', () => {
    expect(conflictComponentsIn('components/partners/buyer-profile/ProfileConflictView.tsx', 'export function ProfileConflictView() {}')).toHaveLength(1)
    expect(conflictComponentsIn('app/(app)/partners/PartnerForm.tsx', '<button>Take theirs</button>')).toHaveLength(1)
    expect(conflictComponentsIn(MERGE_DIALOG, 'export function MergeConflictRow() {}\n"Keep yours" "Use theirs"')).toEqual([])
    expect(conflictComponentsIn('components/canvas/Other.tsx', 'function SaveConflictView() {}')).toEqual([])
  })

  it('no file on the partners page defines another', () => {
    expect(sources.flatMap((s) => conflictComponentsIn(s.file, s.source))).toEqual([])
  })
})
