/**
 * Every test parses source with TypeScript through _parsed-source.ts (#2619).
 *
 * That module reads each file once and keeps each file's syntax tree for the
 * rest of the test file, so a guard asking its question several times parses
 * the tree once. A guard that calls ts.createSourceFile itself goes back to
 * parsing the whole worker tree per call, which is how one guard parsed it seven
 * or eight times and timed out at vitest's 5 second limit on a busy machine.
 *
 * Seen red on 2026-10-22: with one guard's parse put back to
 * ts.createSourceFile, this named that file and line.
 */
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { REPO_ROOT, WEB_SRC, listFiles, sanitizeSource } from './_scan-utils'
import { sourceText } from './_parsed-source'

const HELPER = path.join(WEB_SRC, 'lib/__tests__/_parsed-source.ts')

/** Files allowed to call it, and why. */
const ALLOWED: Record<string, string> = {
  [HELPER]: 'the helper itself',
  [path.join(WEB_SRC, 'lib/__guards__/worker/_worker-program.ts')]:
    'the compiler host of a type checked program, which must build each file with the language version the program asks for',
}

/** Each `createSourceFile(` call outside comments and strings, by line. */
export function createSourceFileCalls(source: string): number[] {
  if (!source.includes('createSourceFile')) return []
  const code = sanitizeSource(source)
  return [...code.matchAll(/\bcreateSourceFile\s*\(/g)].map((m) => code.slice(0, m.index).split('\n').length)
}

describe('tests parse source through _parsed-source.ts', () => {
  const files = listFiles(WEB_SRC, { skipDirs: ['node_modules'], includeTests: true })
  const offenders = files
    .filter((f) => !Object.hasOwn(ALLOWED, f))
    .flatMap((f) => createSourceFileCalls(sourceText(f)).map((line) => `${path.relative(REPO_ROOT, f)}:${line}`))

  it('reads the test tree, and finds the helper\'s own call, so an empty list is a measurement (L1)', () => {
    expect(files.length).toBeGreaterThan(400)
    expect(files).toContain(path.join(WEB_SRC, 'lib/__guards__/worker/ops-connections-off-money-path.test.ts'))
    expect(createSourceFileCalls(sourceText(HELPER)).length).toBeGreaterThan(0)
  })

  it('no other file calls ts.createSourceFile', () => {
    expect(offenders).toEqual([])
  })

  it('every allowed file exists and still calls it, so no entry is stale', () => {
    for (const file of Object.keys(ALLOWED)) expect(createSourceFileCalls(sourceText(file)).length, path.relative(REPO_ROOT, file)).toBeGreaterThan(0)
  })

  it('sees a call, and not one named in a comment or a string', () => {
    expect(createSourceFileCalls("const a = 1\nconst sf = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true)")).toEqual([2])
    expect(createSourceFileCalls('// ts.createSourceFile(x)\nconst s = "createSourceFile(x)"')).toEqual([])
  })
})
