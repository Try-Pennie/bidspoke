/**
 * Every navigation the app starts itself is judged by the leave guard or named
 * here with its reason (#2138, PM-5, L247, L621).
 *
 * The partners page can lose a draft or a save not yet confirmed, and the leave
 * guard (lib/leave-guard.ts) is what asks first. A navigation the app starts in
 * code (router.push, router.replace, router.back or forward, history.back,
 * forward or go, an assignment to location, location.assign or
 * location.replace) does not pass through a link click the guard can hold,
 * so each one is either inside the guard's own module, or allowlisted here with
 * the reason it cannot lose a guarded draft. An entry marked `consults` names
 * the guard function its file calls before navigating, and the file must call
 * it, so a site that stops asking fails here.
 *
 * Product source only (__tests__, __guards__ and *.test files are out of scope),
 * one pass per file (L297), each entry held to its exact count so a new call in
 * an allowlisted file still fails. Seen failing with a scratch router.push in
 * PartnerForm.tsx, a scratch `window.location.href =` in NavLayout.tsx, and
 * holdAuthRedirect removed from api.ts.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listFiles, sanitizeSource, WEB_SRC } from '../__tests__/_scan-utils'

const rel = (file: string) => path.relative(WEB_SRC, file).split(path.sep).join('/')
const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

const GUARD_MODULE = 'lib/leave-guard.ts'

/** Each spelling of a navigation started in code. */
const NAVIGATIONS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'router.push', re: /\brouter\s*\.\s*push\s*\(/g },
  { name: 'router.replace', re: /\brouter\s*\.\s*replace\s*\(/g },
  // location, or any of its parts, set: every one but the hash loads another
  // page (the hash is a jump within this one). Named by exclusion, so a part
  // nobody listed is still caught.
  { name: 'location assignment', re: /\blocation(?:\s*\.\s*(?!hash\b)[A-Za-z]+)?\s*=(?!=)/g },
  { name: 'location.assign', re: /\blocation\s*\.\s*assign\s*\(/g },
  { name: 'location.replace', re: /\blocation\s*\.\s*replace\s*\(/g },
  // Moving through history leaves the page too.
  { name: 'router.back or forward', re: /\brouter\s*\.\s*(?:back|forward)\s*\(/g },
  { name: 'history.back, forward or go', re: /\bhistory\s*\.\s*(?:back|forward|go)\s*\(/g },
]

/**
 * Spellings that need the string literals kept: window.open into this tab
 * ('_self') leaves the page, while into another tab it loses nothing.
 */
const NAVIGATIONS_IN_STRINGS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "window.open into '_self'", re: /\bwindow\s*\.\s*open\s*\([^)]*(['"`])_self\1/g },
]

export function navigationsIn(file: string, source: string): string[] {
  if (file === GUARD_MODULE) return []
  const found: string[] = []
  for (const [code, list] of [[sanitizeSource(source), NAVIGATIONS], [sanitizeSource(source, { blankStrings: false }), NAVIGATIONS_IN_STRINGS]] as const) {
    for (const { name, re } of list) {
      for (const m of code.matchAll(re)) found.push(`${file}:${lineOf(code, m.index ?? 0)} ${name}`)
    }
  }
  return found
}

interface Allowed {
  count: number
  reason: string
  /** The leave guard function this file calls before each navigation; the file must call it. */
  consults?: 'leaveThen' | 'holdAuthRedirect'
}

/** Navigations started in code outside the guard, each with why it cannot lose a guarded draft. */
const ALLOWED: Readonly<Record<string, Allowed>> = {
  'components/NavLayout.tsx': { count: 1, consults: 'leaveThen', reason: 'Sign out: signs out and opens /login only inside leaveThen, so a page with a draft asks first.' },
  'lib/api.ts': { count: 2, consults: 'holdAuthRedirect', reason: 'The 401 and 403 redirects: held by holdAuthRedirect while a page would lose something, which then says the session expired.' },
  'app/(app)/workflows/page.tsx': { count: 3, reason: 'The workflows list opening a workflow: the list holds no draft, and no leave guard is mounted there.' },
  'app/(app)/workflows/[id]/page.tsx': { count: 1, reason: 'The workflow page switching the canvas between view and edit on the same workflow: it leaves nothing.' },
  'app/(app)/workflows/[id]/versions/page.tsx': { count: 2, reason: 'The version history page returning to its workflow: it holds nothing editable.' },
  'app/(app)/dashboard/page.tsx': { count: 2, reason: 'The dashboard opening a failed run: the dashboard holds no draft.' },
  'components/canvas/WorkflowCanvas.tsx': { count: 5, reason: 'The canvas: mode and run switches on the same workflow, clearing a run, its back link, and its own leave dialog\'s Discard (LeaveCanvasDialog, #2134), which guards its own edits.' },
}

const sources = listFiles(WEB_SRC).map((f) => ({ file: rel(f), source: readFileSync(f, 'utf8') }))

function beyondAllowance(found: string[]): string[] {
  const byFile = new Map<string, string[]>()
  for (const f of found) {
    const file = f.slice(0, f.indexOf(':'))
    byFile.set(file, [...(byFile.get(file) ?? []), f])
  }
  const out: string[] = []
  for (const [file, list] of byFile) {
    const allowance = ALLOWED[file]?.count ?? 0
    if (list.length !== allowance) out.push(...list.map((l) => `${l} (allowed here: ${allowance})`))
  }
  for (const [file, { count }] of Object.entries(ALLOWED)) {
    if (!byFile.has(file)) out.push(`${file}: allowlisted for ${count} but has none; remove the entry`)
  }
  return out
}

describe('the scan sees the product source', () => {
  it('reads the guard and the files it is about, so nothing passes by reading nothing', () => {
    const files = sources.map((s) => s.file)
    expect(files.length).toBeGreaterThan(150)
    expect(files).toContain(GUARD_MODULE)
    expect(files).toContain('app/(app)/partners/PartnerForm.tsx')
    expect(files.some((f) => f.includes('__tests__') || f.includes('__guards__') || /\.test\.tsx?$/.test(f))).toBe(false)
  })
})

describe('navigations started in code go through the leave guard (#2138)', () => {
  it('positive controls: each spelling in a scratch product file is found; the guard module and comments are not', () => {
    const scratch = [
      "router.push('/x')", 'router . replace(`/y`)', "window.location.href = '/login'", 'location = next',
      "window.location.assign('/a')", "location.replace('/b')",
      'router.back()', 'router.forward()', 'window.history.back()', 'history.forward()', 'window.history.go(-2)',
      "window.location.pathname = '/x'", "location.search = '?a=1'", "window.open('/x', '_self')",
      "location.host = 'x.example'", "window.location.hostname = 'x'", "location.port = '8080'", "location.protocol = 'http:'",
    ]
    for (const line of scratch) expect(navigationsIn('app/(app)/partners/PartnerForm.tsx', line), line).toHaveLength(1)
    expect(navigationsIn(GUARD_MODULE, "window.location.assign('/a')")).toEqual([])
    // Another tab, or a jump within the page, leaves nothing behind.
    expect(navigationsIn('components/Scratch.tsx', "window.open('/docs', '_blank')\nlocation.hash = '#top'")).toEqual([])
    expect(navigationsIn('components/Scratch.tsx', "// router.push('/x') in a comment\nconst s = \"location.href = '/'\"\nif (location.href === x) {}")).toEqual([])
  })

  it('no product file starts one outside the guard, beyond the allowlist at its exact count', () => {
    expect(beyondAllowance(sources.flatMap((s) => navigationsIn(s.file, s.source)))).toEqual([])
  })

  it('every allowlist entry says why, and an entry that consults the guard calls it', () => {
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect(entry.reason.length, file).toBeGreaterThan(20)
      if (!entry.consults) continue
      const code = sanitizeSource(sources.find((s) => s.file === file)?.source ?? '')
      // A boolean, not the source, so a failure prints the sentence rather than the file (L445).
      expect(new RegExp(`\\b${entry.consults}\\s*\\(`).test(code), `${file} no longer calls ${entry.consults}`).toBe(true)
    }
  })

  it('the partners page starts no navigation of its own: it asks through leaveThen', () => {
    for (const file of ['app/(app)/partners/page.tsx', 'app/(app)/partners/PartnerForm.tsx']) expect(ALLOWED[file], file).toBeUndefined()
    const page = sanitizeSource(sources.find((s) => s.file === 'app/(app)/partners/page.tsx')?.source ?? '')
    expect(/\bleaveThen\s*\(/.test(page), 'partners/page.tsx no longer asks through leaveThen').toBe(true)
  })
})
