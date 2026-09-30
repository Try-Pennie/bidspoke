/**
 * Trailing whitespace hygiene for code node scripts (#1117).
 *
 * Pasted scripts arrive padded to a column with trailing spaces (measured 2026-09-03: 48
 * percent of every live code node's characters), and the wrapping editor draws each padded
 * line as a blank row. Nothing trimmed them on save, so once pasted they were permanent and
 * every version snapshot carried them again.
 *
 * The one place a trailing space is VALUE rather than noise is inside a template literal:
 * `const body = \`line   \n\`` sends those spaces. Every affected script contains backticks, so
 * this is a scanner over the source rather than a regex over lines. It tracks quoted
 * strings, comments and template literals (including `${ }` expressions nested inside them)
 * and trims a line end everywhere except while inside a template.
 *
 * It errs towards NOT stripping: an unrecognised construct that looks like a template opening
 * (a backtick inside a regex literal, say) leaves the rest of the script untrimmed, which is
 * the harmless direction. It never invents a template close, so it cannot strip a real one.
 *
 * The same scanner tells the code step packager which lines BEGIN inside a template, so it
 * does not indent them (#1636): leading whitespace there is value for the same reason.
 */

type State = 'code' | 'single' | 'double' | 'template' | 'line' | 'block'

function isNewline(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r'
}

/**
 * Where each line break of a script falls. `inTemplate[k]` is true when the k-th break (a
 * `\n` or a `\r\n`, so exactly one entry per `\n` in the script) sits inside a template
 * literal's text, and `endsInTemplate` says the same of the end of the script. A break inside a
 * template is part of the string's value, so the line before it keeps its trailing whitespace
 * and the line after it keeps its leading whitespace. Both rules read this one scanner.
 */
export function scanLineBreaks(script: string): { inTemplate: boolean[]; endsInTemplate: boolean } {
  const inTemplate: boolean[] = []
  let state: State = 'code'
  // One entry per open `${ }` expression: the brace depth of the expression around it, so a
  // closing brace can tell "end of this expression" from "end of an object literal inside it".
  const enclosingDepths: number[] = []
  let braceDepth = 0

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]
    const next = script[i + 1]

    if (ch === '\n' || (ch === '\r' && next === '\n')) {
      inTemplate.push(state === 'template')
      // A quoted string or a line comment cannot continue past a line end. Resetting here
      // means an unterminated quote does not leave the rest of the script untrimmed.
      if (state === 'single' || state === 'double' || state === 'line') state = 'code'
      if (ch === '\r') i++
      continue
    }

    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          state = 'line'
          i++
          continue
        }
        if (ch === '/' && next === '*') {
          state = 'block'
          i++
          continue
        }
        if (ch === "'") state = 'single'
        else if (ch === '"') state = 'double'
        else if (ch === '`') state = 'template'
        else if (enclosingDepths.length > 0) {
          if (ch === '{') braceDepth++
          else if (ch === '}') {
            if (braceDepth === 0) {
              braceDepth = enclosingDepths.pop() ?? 0
              state = 'template'
            } else {
              braceDepth--
            }
          }
        }
        break
      case 'single':
      case 'double':
        if (ch === '\\' && next !== undefined && !isNewline(next)) {
          i++
          continue
        }
        if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) state = 'code'
        break
      case 'template':
        if (ch === '\\' && next !== undefined && !isNewline(next)) {
          i++
          continue
        }
        if (ch === '`') state = 'code'
        else if (ch === '$' && next === '{') {
          enclosingDepths.push(braceDepth)
          braceDepth = 0
          state = 'code'
          i++
          continue
        }
        break
      case 'line':
        break
      case 'block':
        if (ch === '*' && next === '/') {
          state = 'code'
          i++
          continue
        }
        break
    }
  }

  return { inTemplate, endsInTemplate: state === 'template' }
}

/**
 * One entry per line of `script.split('\n')`: true when that line BEGINS inside a template
 * literal's text, so its leading whitespace is part of a string value and indenting it would
 * change what the script computes (#1636). The first line never does.
 */
export function lineStartsInsideTemplate(script: string): boolean[] {
  return [false, ...scanLineBreaks(script).inTemplate]
}

function trimLineEnd(line: string): string {
  let end = line.length
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
  return end === line.length ? line : line.slice(0, end)
}

export function stripTrailingWhitespace(script: string): string {
  const { inTemplate, endsInTemplate } = scanLineBreaks(script)
  // Even entries are lines and odd entries their separators, so a CRLF script keeps its CRLFs.
  // The split matches exactly the breaks the scanner counts: every `\n`, with a `\r` before it.
  const parts = script.split(/(\r?\n)/)
  let out = ''
  for (let k = 0; k * 2 < parts.length; k++) {
    const line = parts[k * 2]
    const keep = k < inTemplate.length ? inTemplate[k] : endsInTemplate
    out += keep ? line : trimLineEnd(line)
    if (k * 2 + 1 < parts.length) out += parts[k * 2 + 1]
  }
  return out
}

interface NodeLike {
  type?: unknown
  config?: unknown
}

/**
 * The definition with every code node's script stripped, or the SAME object when nothing
 * needed stripping, so an unchanged definition still compares equal by reference. Nodes of
 * other types are left alone even if they carry a `script` key: only code nodes hold a
 * script whose whitespace is noise.
 */
export function sanitizeCodeNodeScripts<T extends { nodes?: unknown }>(definition: T): T {
  const nodes = definition.nodes
  if (!Array.isArray(nodes)) return definition
  let changed = false
  const next = nodes.map((node: unknown) => {
    if (!node || typeof node !== 'object') return node
    const n = node as NodeLike
    if (n.type !== 'code' || !n.config || typeof n.config !== 'object') return node
    const config = n.config as Record<string, unknown>
    if (typeof config.script !== 'string') return node
    const stripped = stripTrailingWhitespace(config.script)
    if (stripped === config.script) return node
    changed = true
    return { ...n, config: { ...config, script: stripped } }
  })
  return changed ? { ...definition, nodes: next } : definition
}
