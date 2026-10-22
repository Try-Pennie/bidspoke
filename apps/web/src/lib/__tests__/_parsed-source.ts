/**
 * The one way a guard reads and parses source with TypeScript (#2619).
 *
 * A guard that judges the worker's source by its syntax tree parses every file
 * it scans, and the worker alone is about 460 files and 6 MB: one parse of the
 * tree takes about a quarter of a second on a quiet laptop and several seconds
 * on one with a load average above 100. Guards did that parse once per call,
 * so a file that asked its question again for each planted case parsed the
 * whole tree seven or eight times (ops-connections-off-money-path), and its
 * tests timed out at vitest's 5 second limit on a busy machine while passing
 * alone.
 *
 * Here a file is read once and parsed at most once per test file (vitest gives
 * each test file a fresh module registry, so nothing is shared between files
 * and nothing can go stale between runs). A guard calls its scan from its
 * describe body, which runs while the file is collected, so the one parse it
 * cannot avoid is not charged to a test's limit either.
 *
 * `parsedSource(file, text)` takes the text a guard is judging. When it is the
 * file as it stands on disk the parse is kept; a planted variant (a guard
 * proving it goes red) is parsed afresh and never replaces the kept one, so a
 * plant cannot leak into the next case. `parseSnippet` is for source written in
 * the test itself, which is never kept.
 *
 * lib/__tests__/source-parsed-once.test.ts fails on a test file that calls
 * ts.createSourceFile itself.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const texts = new Map<string, string | null>()
const trees = new Map<string, ts.SourceFile>()

const kindOf = (file: string): ts.ScriptKind => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/** The file's text as it stands on disk, read once; null when there is no such file. */
function diskText(file: string): string | null {
  let text = texts.get(file)
  if (text === undefined) {
    text = existsSync(file) ? readFileSync(file, 'utf8') : null
    texts.set(file, text)
  }
  return text
}

/** The file's text as it stands on disk, read once; undefined when there is no such file (also remembered). */
export function sourceTextIfAny(file: string): string | undefined {
  return diskText(file) ?? undefined
}

/** The file's text as it stands on disk, read once. Throws, naming the file, when there is none. */
export function sourceText(file: string): string {
  const text = diskText(file)
  if (text === null) throw new Error(`${file} does not exist`)
  return text
}

/** A syntax tree of source written in a test, with parent links. Never kept. */
export function parseSnippet(text: string, fileName = 'source.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kindOf(fileName))
}

/**
 * The syntax tree, with parent links, of `text` as the content of `file` (the
 * file on disk when no text is given). Only an absolute path names a file on
 * disk; any other name (a test's 'x.ts') is a snippet, parsed and not kept.
 */
export function parsedSource(file: string, text: string = sourceText(file)): ts.SourceFile {
  if (!path.isAbsolute(file) || text !== diskText(file)) return parseSnippet(text, file)
  let tree = trees.get(file)
  if (tree === undefined) {
    tree = parseSnippet(text, file)
    trees.set(file, tree)
  }
  return tree
}
