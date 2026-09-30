/**
 * Trailing whitespace hygiene for code node scripts (#1117).
 *
 * Measured 2026-09-03: 48 percent of every live code node's characters were trailing
 * whitespace, pasted in as rectangular blocks from another editor, and the wrapping editor
 * drew each padded line as a blank row. Nothing trimmed it on save. The one thing a trim
 * must not touch is a line inside a template literal, because those spaces are part of the
 * value the script sends, and every affected script contains backticks.
 */
import { describe, it, expect } from 'vitest'
import { lineStartsInsideTemplate, sanitizeCodeNodeScripts, stripTrailingWhitespace } from './index'

describe('stripTrailingWhitespace', () => {
  it('strips trailing spaces and tabs from ordinary code lines', () => {
    const padded = 'const a = 1;    \nif (a) {\t\t\n  return a;   \n}'
    expect(stripTrailingWhitespace(padded)).toBe('const a = 1;\nif (a) {\n  return a;\n}')
  })

  it('leaves a padded line inside a template literal untouched', () => {
    const script = 'const body = `line one   \n  line two   \n`;   \nreturn body;   '
    expect(stripTrailingWhitespace(script)).toBe('const body = `line one   \n  line two   \n`;\nreturn body;')
  })

  it('resumes stripping after the template literal closes', () => {
    const script = 'const t = `a   \n`;\nconst b = 2;    \n'
    expect(stripTrailingWhitespace(script)).toBe('const t = `a   \n`;\nconst b = 2;\n')
  })

  it('does not treat a backtick inside a line comment as opening a template', () => {
    const script = '// uses ` for markdown   \nconst x = 1;    \n'
    expect(stripTrailingWhitespace(script)).toBe('// uses ` for markdown\nconst x = 1;\n')
  })

  it('does not treat a backtick inside a quoted string as opening a template', () => {
    const script = "const q = '`';    \nconst x = 1;    \n"
    expect(stripTrailingWhitespace(script)).toBe("const q = '`';\nconst x = 1;\n")
  })

  it('does not treat an escaped backtick inside a template as closing it', () => {
    const script = 'const t = `a \\` b   \nstill inside   \n`;   \n'
    expect(stripTrailingWhitespace(script)).toBe('const t = `a \\` b   \nstill inside   \n`;\n')
  })

  it('strips inside a block comment, which carries no value', () => {
    const script = '/* note   \n   more   \n*/   \nconst x = 1;'
    expect(stripTrailingWhitespace(script)).toBe('/* note\n   more\n*/\nconst x = 1;')
  })

  it('keeps CRLF line endings while stripping the spaces before them', () => {
    expect(stripTrailingWhitespace('a = 1;   \r\nb = 2;\t\r\n')).toBe('a = 1;\r\nb = 2;\r\n')
  })

  it('returns a clean script unchanged', () => {
    const clean = 'const a = 1;\nreturn `x ${a}`;\n'
    expect(stripTrailingWhitespace(clean)).toBe(clean)
  })
})

describe('sanitizeCodeNodeScripts', () => {
  const padded = 'const a = 1;    \nreturn `keep   \n`;   '
  const clean = 'const a = 1;\nreturn `keep   \n`;'

  it('strips the script of every code node and leaves the rest of the definition alone', () => {
    const def = {
      trigger: { type: 'http_webhook' },
      nodes: [
        { id: 'c1', type: 'code', config: { script: padded, retries: 2 } },
        { id: 'f1', type: 'filter', config: { script: padded } },
      ],
      edges: [{ id: 'e', source: 'c1', target: 'f1' }],
    }
    const out = sanitizeCodeNodeScripts(def)
    expect(out.nodes[0].config).toEqual({ script: clean, retries: 2 })
    expect(out.nodes[1].config).toEqual({ script: padded })
    expect(out.edges).toBe(def.edges)
    expect(out.trigger).toBe(def.trigger)
  })

  it('does not mutate the definition it was given', () => {
    const def = { nodes: [{ id: 'c1', type: 'code', config: { script: padded } }] }
    sanitizeCodeNodeScripts(def)
    expect(def.nodes[0].config.script).toBe(padded)
  })

  it('leaves a code node whose script is not a string alone', () => {
    const def = { nodes: [{ id: 'c1', type: 'code', config: { script: null } }, { id: 'c2', type: 'code' }] }
    expect(sanitizeCodeNodeScripts(def)).toEqual(def)
  })

  it('accepts a definition with no nodes', () => {
    expect(sanitizeCodeNodeScripts({})).toEqual({})
  })
})

describe('lineStartsInsideTemplate (#1636)', () => {
  it('marks the lines that begin inside a template, one entry per \\n separated line', () => {
    const script = 'const a = 1\nconst t = `x\n  y\nz`\nreturn t'
    expect(lineStartsInsideTemplate(script)).toEqual([false, false, true, true, false])
  })

  it('does not count a backtick inside a quoted string or a comment as a template', () => {
    const script = "const a = '`'\n// a ` in a comment\n/* and ` here */\nreturn a"
    expect(lineStartsInsideTemplate(script)).toEqual([false, false, false, false])
  })

  it('follows a ${} holding a nested backtick string back into the outer template', () => {
    const script = 'const t = `a\n${x ? `b` : `c`}\nd`\ne'
    expect(lineStartsInsideTemplate(script)).toEqual([false, true, true, false])
  })

  it('treats a line break inside a multi-line ${} as code, and the one after it as template', () => {
    const script = 'const t = `a${f({\n  k: 1,\n})}\nb`\nc'
    expect(lineStartsInsideTemplate(script)).toEqual([false, false, false, true, false])
  })

  it('counts a CRLF break once, so the result still lines up with split on \\n', () => {
    const script = 'const t = `x\r\n  y`\r\nreturn t'
    const marks = lineStartsInsideTemplate(script)
    expect(marks).toHaveLength(script.split('\n').length)
    expect(marks).toEqual([false, true, false])
  })
})
