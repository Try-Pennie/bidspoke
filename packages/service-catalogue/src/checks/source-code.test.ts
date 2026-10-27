import { describe, expect, it } from 'vitest'
import { assertOnlyTrivia, codeOf, SourceCodeError } from './source-code'

/**
 * The code a fingerprint is taken over (#2732): a source file with its comments
 * and the whitespace between tokens removed, so a comment or a reindent moves
 * no action version, while every character that can change what runs still
 * does. Each pair below is either the same code or not, and the test says which.
 */

const same = (a: string, b: string, file = 'a.ts') => expect(codeOf(file, b)).toEqual(codeOf(file, a))
const differs = (a: string, b: string, file = 'a.ts') => expect(codeOf(file, b)).not.toEqual(codeOf(file, a))

describe('codeOf leaves out what cannot change behaviour', () => {
  it('drops line comments, block comments and doc comments', () => {
    same(
      'export const a = (x: number) => x + 1\n',
      '/** Adds one. */\n// a reason\nexport const a = (x: number) => /* inline */ x + 1 // trailing\n',
    )
  })

  it('drops a comment that sits inside a call or an object', () => {
    same('f(a, { b: 1 })\n', 'f(a, /* first */ { b: /* the b */ 1 })\n')
    same('f(\na,\n{ b: 1 })\n', 'f( // the call\na, // first\n{ b: 1 }) // done\n')
  })

  it('drops indentation, blank lines and trailing spaces', () => {
    same('if (a) {\nreturn b\n}\n', '\n\nif (a)   {\n    return b   \n}\n\n')
  })

  it('treats a reworded comment as no change at all', () => {
    same('// the old reason\nexport const a = 1\n', '// a new and longer reason\n// over two lines\nexport const a = 1\n')
  })

  it('reads CRLF line endings as LF', () => {
    same('const a = 1\nconst b = 2\n', 'const a = 1\r\nconst b = 2\r\n')
  })
})

describe('codeOf keeps everything that can change behaviour', () => {
  it('sees a one token change', () => {
    differs('export const a = (x: number) => x + 1\n', 'export const a = (x: number) => x + 2\n')
    differs('export const a = (x: number) => x + 1\n', 'export const a = (x: number) => x - 1\n')
  })

  it('sees a change inside a string literal, whitespace included', () => {
    differs("const a = 'one two'\n", "const a = 'one  two'\n")
    differs('const a = "x"\n', 'const a = "x "\n')
  })

  it('sees a change of whitespace inside a template literal, in every part of it', () => {
    differs('const a = `one two`\n', 'const a = `one  two`\n')
    differs('const a = `head ${x} tail`\n', 'const a = `head  ${x} tail`\n')
    differs('const a = `head ${x} mid ${y} tail`\n', 'const a = `head ${x} mid  ${y} tail`\n')
    differs('const a = `head ${x} tail`\n', 'const a = `head ${x} tail `\n')
    differs('const a = `line one\nline two`\n', 'const a = `line one\n  line two`\n')
  })

  it('keeps text that looks like a comment inside a string, a template or a regex', () => {
    differs("const a = 'https://example.com'\n", "const a = 'https:'\n")
    differs('const a = `/* kept */`\n', 'const a = ``\n')
    differs('const a = /a\\/\\/b/\n', 'const a = /a/\n')
    differs("const a = '// kept'\n", "const a = ''\n")
  })

  it('sees a change inside a regex literal, whitespace and flags included', () => {
    differs('const r = /a b/\n', 'const r = /a  b/\n')
    differs('const r = /a b/g\n', 'const r = /a b/gi\n')
  })

  it('reads a slash as division or a regex as the parser does', () => {
    differs('const q = a / b / c\n', 'const q = a / b / d\n')
    same('const q = a / b / c\n', 'const q = a/b/c\n')
  })

  it('keeps whether two tokens are on one line, which automatic semicolon insertion reads', () => {
    differs('function f() {\nreturn x\n}\n', 'function f() {\nreturn\nx\n}\n')
    differs('function f() {\nreturn x\n}\n', 'function f() {\nreturn x\n}\n')
    // A block comment holding a line break is a line break to the grammar too.
    differs('function f() {\nreturn x\n}\n', 'function f() {\nreturn /* a\nb */ x\n}\n')
    same('function f() {\nreturn x\n}\n', 'function f() {\nreturn /* a b */ x\n}\n')
  })

  it('sees an import edit, a value import changing what the file reaches', () => {
    differs("import { a } from './a'\n", "import { a } from './b'\n")
  })
})

describe('codeOf over files that are not TypeScript', () => {
  it('reads JSON by its value, so its layout does not count and its content does', () => {
    same('{"a": [1, 2], "b": "x y"}\n', '{\n  "a": [1, 2],\n  "b": "x y"\n}\n', 'data.json')
    differs('{"a": [1, 2], "b": "x y"}\n', '{"a": [1, 2], "b": "x  y"}\n', 'data.json')
    differs('{"a": 1, "b": 2}\n', '{"b": 2, "a": 1}\n', 'data.json')
  })

  it('keeps the whole text of a file of any other kind, since it has no parser here', () => {
    differs('a b\n', 'a  b\n', 'notes.txt')
  })
})

describe('codeOf accounts for every character of a file', () => {
  it('keeps every token of a file that does not parse, so a syntax error cannot hide code', () => {
    expect(codeOf('broken.ts', 'f(a b c)\nconst a = 1 #!? garbage\n')).toEqual([
      ['f', '(', 'a', 'b', 'c', ')'],
      ['const', 'a', '=', '1', '#', '!', '?', 'garbage'],
    ])
  })

  it('accepts a gap between tokens holding only comments and whitespace', () => {
    const text = 'a /* one */ // two\n  \t b'
    expect(() => assertOnlyTrivia('a.ts', text, 1, text.length - 1)).not.toThrow()
  })

  it('refuses, naming the file, a gap between tokens that holds code the parser left out', () => {
    const text = 'a /* one */ dropped b'
    expect(() => assertOnlyTrivia('lost.ts', text, 1, text.length - 1)).toThrow(SourceCodeError)
    expect(() => assertOnlyTrivia('lost.ts', text, 1, text.length - 1)).toThrow(/lost\.ts.*"dropped"/)
  })

  it('refuses a JSON file that does not parse, naming it', () => {
    expect(() => codeOf('data.json', '{"a": }')).toThrow(/data\.json/)
  })
})
