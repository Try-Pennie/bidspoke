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
 */

type State = 'code' | 'single' | 'double' | 'template' | 'line' | 'block'

function trimLineEnd(out: string, lineStart: number): string {
  let end = out.length
  while (end > lineStart && (out[end - 1] === ' ' || out[end - 1] === '\t')) end--
  return end === out.length ? out : out.slice(0, end)
}

function isNewline(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r'
}

export function stripTrailingWhitespace(script: string): string {
  let out = ''
  let lineStart = 0
  let state: State = 'code'
  // One entry per open `${ }` expression: the brace depth of the expression around it, so a
  // closing brace can tell "end of this expression" from "end of an object literal inside it".
  const enclosingDepths: number[] = []
  let braceDepth = 0

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]
    const next = script[i + 1]

    if (ch === '\n' || (ch === '\r' && next === '\n')) {
      if (state !== 'template') out = trimLineEnd(out, lineStart)
      // A quoted string or a line comment cannot continue past a line end. Resetting here
      // means an unterminated quote does not leave the rest of the script untrimmed.
      if (state === 'single' || state === 'double' || state === 'line') state = 'code'
      if (ch === '\r') {
        out += '\r\n'
        i++
      } else {
        out += '\n'
      }
      lineStart = out.length
      continue
    }

    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          state = 'line'
          out += '//'
          i++
          continue
        }
        if (ch === '/' && next === '*') {
          state = 'block'
          out += '/*'
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
          out += ch + next
          i++
          continue
        }
        if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"')) state = 'code'
        break
      case 'template':
        if (ch === '\\' && next !== undefined && !isNewline(next)) {
          out += ch + next
          i++
          continue
        }
        if (ch === '`') state = 'code'
        else if (ch === '$' && next === '{') {
          enclosingDepths.push(braceDepth)
          braceDepth = 0
          state = 'code'
          out += '${'
          i++
          continue
        }
        break
      case 'line':
        break
      case 'block':
        if (ch === '*' && next === '/') {
          state = 'code'
          out += '*/'
          i++
          continue
        }
        break
    }
    out += ch
  }

  if (state !== 'template') out = trimLineEnd(out, lineStart)
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
