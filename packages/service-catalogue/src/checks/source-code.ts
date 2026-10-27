import path from 'node:path'
import ts from 'typescript'

/**
 * The code of one source file, as a version fingerprint takes it (#2732): what
 * can change behaviour, and nothing that cannot. Before this, the fingerprint
 * hashed the raw text, so a reworded comment in a package every Salesforce
 * action reaches moved all ten of their fingerprints and demanded ten new
 * versions for a change that did nothing.
 *
 * A TypeScript or JavaScript file is read by the TypeScript parser into its
 * tokens, each kept as its exact source text: a string, template or regex
 * literal keeps every character between its delimiters, whitespace and
 * comment shaped text included, and the parser, not a pattern, decides where a
 * literal begins and ends (a slash is division or a regex as the grammar says).
 * What lies between tokens is dropped: comments, indentation, blank lines and
 * spaces. One thing between tokens is kept, whether a line break separates
 * two of them, because automatic semicolon insertion reads it (`return` then
 * `x` on the next line returns nothing). So the result is the file's lines of
 * tokens, a line being the tokens with no break between them; joining or
 * splitting a line of code is a change, a comment or a reindent is not.
 *
 * Every gap between tokens is scanned again and must hold only comments and
 * whitespace, so text the parser skipped (a file that does not parse) is
 * refused by name rather than silently left out of the fingerprint.
 *
 * A JSON file is read by its value, so its layout does not count and its keys,
 * their order and its values do. A file of any other kind (a .tsx, whose JSX
 * text gives whitespace a meaning of its own) keeps its whole text, which can
 * only ask for a version too often, never too rarely.
 */

export class SourceCodeError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}, so its code cannot be fingerprinted`)
    this.name = 'SourceCodeError'
  }
}

/** Lines of tokens for a script, the value for JSON, the whole text for anything else. */
export type SourceCode = readonly (readonly string[])[] | string

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
}

const TRIVIA = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.SingleLineCommentTrivia,
  ts.SyntaxKind.MultiLineCommentTrivia,
  ts.SyntaxKind.NewLineTrivia,
  ts.SyntaxKind.WhitespaceTrivia,
  ts.SyntaxKind.ShebangTrivia,
])

/** The line terminators ECMAScript reads for automatic semicolon insertion. */
const LINE_TERMINATORS = ['\n', '\r', '\u2028', '\u2029']

/** `file` names the file for the language it is read as and for any refusal. */
export function codeOf(file: string, text: string): SourceCode {
  const normalised = text.replace(/\r\n/g, '\n')
  const extension = path.extname(file).toLowerCase()
  if (extension === '.json') {
    try {
      return JSON.stringify(JSON.parse(normalised))
    } catch (err) {
      throw new SourceCodeError(file, `it is not valid JSON (${err instanceof Error ? err.message : 'unreadable'})`)
    }
  }
  const kind = SCRIPT_KINDS[extension]
  if (kind === undefined) return normalised
  return scriptLines(file, normalised, kind)
}

/** The leaf tokens of a parsed file, in source order, each with width. */
function leafTokens(source: ts.SourceFile): ts.Node[] {
  const leaves: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    // A doc comment is parsed into nodes of its own; it is still a comment.
    if (ts.isJSDoc(node)) return
    const children = node.getChildren(source)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    if (node.getStart(source) < node.end) leaves.push(node)
  }
  visit(source)
  return leaves
}

/**
 * Throws unless `text` from `start` to `end` is nothing but comments and
 * whitespace. Exported for its test: the parser keeps even a broken file's
 * tokens, so no real file has been found that makes codeOf reach this refusal.
 */
export function assertOnlyTrivia(file: string, text: string, start: number, end: number): void {
  if (end < start) throw new SourceCodeError(file, `its tokens overlap at offset ${end}`)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text, undefined, start, end - start)
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (!TRIVIA.has(kind)) {
      throw new SourceCodeError(file, `the parser left out ${JSON.stringify(scanner.getTokenText())} at offset ${scanner.getTokenStart()}`)
    }
  }
}

function scriptLines(file: string, text: string, kind: ts.ScriptKind): string[][] {
  let tokens: ts.Node[]
  let source: ts.SourceFile
  try {
    source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind)
    tokens = leafTokens(source)
  } catch (err) {
    throw new SourceCodeError(file, `the parser could not read it (${err instanceof Error ? err.message : 'unreadable'})`)
  }
  const lines: string[][] = []
  let line: string[] = []
  let previousEnd = 0
  for (const token of tokens) {
    const start = token.getStart(source)
    assertOnlyTrivia(file, text, previousEnd, start)
    const gap = text.slice(previousEnd, start)
    if (line.length > 0 && LINE_TERMINATORS.some((t) => gap.includes(t))) {
      lines.push(line)
      line = []
    }
    line.push(text.slice(start, token.end))
    previousEnd = token.end
  }
  assertOnlyTrivia(file, text, previousEnd, text.length)
  if (line.length > 0) lines.push(line)
  return lines
}
