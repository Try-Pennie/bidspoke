/**
 * One parser for the `steps.X.Y.Z` reference syntax (#433).
 *
 * The "find every reference" logic was written three times, in three packages,
 * against the same syntax: the engine's step-scoping scanner, the watched-field
 * derivation the silent-output detector runs on, and the canvas rename tool. A
 * fourth was about to be written for build-time validation in the editor
 * (#424).
 *
 * Three copies of a syntax rule is a drift problem, but ONE of these rules is
 * worse than that. `stripOutputWrapper` decides which field a path names, and
 * it is consulted by both the engine resolver (what actually gets read at run
 * time) and the field-presence capture (what gets recorded as present). If
 * those two ever disagreed, the detector would watch a different field than the
 * engine reads and be confidently wrong about a field nobody was watching, with
 * every test in both packages still green (L263: a shared NAME is read as
 * evidence of shared BEHAVIOUR, so two same-named functions either side of a
 * boundary are never compared).
 *
 * Pure string handling only. No engine types, no DOM, no I/O, so both apps and
 * any future tool can consume it.
 */

/**
 * The reference roots the engine actually resolves.
 *
 * Taken from `resolveReference` in the worker's engine/context.ts, which
 * branches on exactly these four. Anything else resolves to undefined, so a
 * validator that accepted a fifth would pass a reference the engine silently
 * drops.
 */
export const ROOT_NAMESPACES = ['env', 'execution', 'steps', 'trigger'] as const

export type RootNamespace = (typeof ROOT_NAMESPACES)[number]

export function isRootNamespace(name: string): name is RootNamespace {
  return (ROOT_NAMESPACES as readonly string[]).includes(name)
}

/**
 * A `steps...` reference chain: `steps` (not part of a larger identifier) then
 * one or more `.ident` / `?.ident` segments. Whitespace around separators is
 * tolerated. A bracket ends the chain, so `steps.x.list[0]` yields
 * `steps.x.list`: the bracket makes the rest dynamic, and guessing past it
 * would name a field that may not exist.
 *
 * Exported as a SOURCE string, not only as a compiled regex, because callers
 * embed it in a larger pattern (an alias declaration is `const X = <chain>`).
 * A caller that rebuilt the chain shape inline would be a fourth copy of the
 * syntax, which is what this module exists to prevent.
 */
export const STEP_CHAIN_SOURCE =
  '(?<![\\w$])steps(?:\\s*\\?\\.\\s*|\\s*\\.\\s*)[A-Za-z_$][\\w$]*(?:(?:\\s*\\?\\.\\s*|\\s*\\.\\s*)[A-Za-z_$][\\w$]*)*'

/** A fresh regex each call: a shared /g regex carries lastIndex between callers. */
export function stepChainRegex(): RegExp {
  return new RegExp(STEP_CHAIN_SOURCE, 'g')
}

/** Every literal `steps.X.Y.Z` chain in a string, in source order. */
export function extractStepChains(text: string): string[] {
  return [...text.matchAll(stepChainRegex())].map((m) => m[0])
}

/**
 * Drop the output wrapper segment that sits directly after the namespace.
 *
 * `x.output.y`, `x.$return_value.y` and `x.y` all name the same field, because
 * the engine stores a step's result under `output` and the Pipedream import
 * left `$return_value` spellings behind. Only the segment IMMEDIATELY after the
 * namespace is a wrapper: `x.y.output` is a real field called output.
 *
 * `segments` are the parts AFTER the `steps` root, so segments[0] is the
 * namespace.
 */
export function stripOutputWrapper(segments: string[]): string[] {
  if (segments[1] === 'output' || segments[1] === '$return_value') {
    return [segments[0], ...segments.slice(2)]
  }
  return segments
}

/** A matched chain as its canonical dotted field path, without the root. */
export function chainToStepPath(chain: string): string {
  const parts = chain.replace(/\s+/g, '').replace(/\?\./g, '.').split('.')
  // parts[0] is the literal "steps" root.
  return stripOutputWrapper(parts.slice(1)).join('.')
}

/**
 * A stored field path as canonical segments, with or without a `steps.` root.
 *
 * Accepts both because the same path is written both ways across the system: a
 * watched field is stored rootless, a config reference carries the root.
 */
export function parseStepPath(path: string): string[] {
  let segs = path.split('.').filter(Boolean)
  if (segs[0] === 'steps') segs = segs.slice(1)
  return stripOutputWrapper(segs)
}

/**
 * True when a script reaches `steps` in a way that defeats static analysis:
 * bracket access, whole-object aliasing, Object.* iteration, or for-in/of.
 *
 * Callers must bail OPEN on true. The engine sends the full steps object rather
 * than a wrong subset, and the watched-field scanner records nothing for the
 * node rather than a wrong watch. A partial alias (`const r = steps.a.b`) is
 * NOT dynamic: the trailing dot means it still names one path, and #435
 * resolves those.
 */
export function hasDynamicStepsAccess(script: string): boolean {
  if (/\bsteps\s*\[/.test(script)) return true
  if (/\b(?:const|let|var)\s+\w+\s*=\s*steps\b(?!\.)/.test(script)) return true
  if (/\bObject\s*\.\s*(?:keys|entries|values|assign)\s*\(\s*steps\b/.test(script)) return true
  if (/\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+(?:in|of)\s+steps\b/.test(script)) return true
  return false
}

/**
 * The step namespaces a script reads, or null when it cannot be read
 * statically. Null means "assume all of them"; an empty set means "none".
 * Those are different answers and callers must not collapse them (L98).
 */
export function extractReferencedNamespaces(script: string): Set<string> | null {
  if (hasDynamicStepsAccess(script)) return null
  const refs = new Set<string>()
  const re = /\bsteps\s*\.\s*([a-zA-Z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(script)) !== null) refs.add(m[1])
  return refs
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Matches `steps.<ns>` wherever it appears, for rename and reference counting.
 *
 * The trailing word boundary is what stops a rename of `credit_check` from
 * rewriting `credit_check_v2`, and the escape is what stops a namespace
 * containing a regex metacharacter from matching things it does not name.
 */
export function stepReferencePattern(namespace: string): RegExp {
  return new RegExp(`\\bsteps\\.${escapeRegex(namespace)}\\b`, 'g')
}

/**
 * The expressions inside `{{ }}` in a template string.
 *
 * Matches the engine's own two forms: a whole-string single expression, and
 * inline interpolation within surrounding text. The capture excludes braces so
 * a concatenation `{{a}}{{b}}` is read as two expressions rather than one
 * malformed one, exactly as resolveTemplate does.
 */
export function extractTemplateExpressions(template: string): string[] {
  return [...template.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1].trim()).filter(Boolean)
}

const ARITHMETIC_OPS = new Set(['*', '/', '+', '-'])
const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/

/**
 * The reference operands inside one expression, with literals removed.
 *
 * Mirrors resolveExpression's grammar so a validator judges what the engine
 * judges: `??` splits into fallback operands, and an odd-length list of
 * whitespace-separated tokens alternating operand and arithmetic operator
 * splits into its operands. Operators must be whitespace separated because a
 * payload key can legally contain a dash, so splitting on a bare `-` would
 * corrupt a plain lookup.
 */
export function referenceOperands(expression: string): string[] {
  const out: string[] = []
  for (const part of expression.split('??')) {
    const expr = part.trim()
    if (!expr) continue
    const tokens = expr.split(/\s+/)
    const isArithmetic =
      tokens.length >= 3 &&
      tokens.length % 2 === 1 &&
      tokens.every((t, i) => (i % 2 === 1 ? ARITHMETIC_OPS.has(t) : t.length > 0))
    if (isArithmetic) {
      for (let i = 0; i < tokens.length; i += 2) {
        if (!NUMBER_LITERAL.test(tokens[i])) out.push(tokens[i])
      }
      continue
    }
    if (NUMBER_LITERAL.test(expr)) continue
    out.push(expr)
  }
  return out
}

/**
 * The root of a reference when the engine cannot resolve it, else null.
 *
 * A root outside ROOT_NAMESPACES resolves to undefined with no error and no
 * retry: `{{payload.debt}}` where `{{trigger.payload.debt}}` was meant reads as
 * an ordinary empty value, and that single typo is what killed the Eligibility
 * Scout fallback in Main Flow for an extended period.
 *
 * Says nothing about a literal. A bare number or a quoted string is not a
 * reference, and reporting one would be a false accusation on a correct
 * template.
 */
export function unknownReferenceRoot(reference: string): string | null {
  const expr = reference.trim()
  if (!expr) return null
  if (NUMBER_LITERAL.test(expr)) return null
  if (/^['"`]/.test(expr)) return null
  // The root ends at the first dot or bracket: `payload[0].x` is rooted at
  // `payload` just as `payload.x` is.
  const root = expr.split(/[.[]/)[0].trim()
  if (!root) return null
  return isRootNamespace(root) ? null : root
}

/**
 * Tokens after which a `/` starts a REGEX rather than a division.
 *
 * Needed because the comment stripper has to tell `a / b` from `/a\/b/`, and
 * getting it wrong is not cosmetic: a regex read as division exposes its inner
 * `//` to the line-comment rule, which then blanks the rest of the line.
 */
const REGEX_PRECEDING_PUNCTUATION = new Set('(,=:[!&|?{};+-*%~^<>'.split(''))
const REGEX_PRECEDING_KEYWORDS = [
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await',
]

function startsRegex(source: string, slashIndex: number): boolean {
  const before = source.slice(0, slashIndex).replace(/\s+$/, '')
  if (before === '') return true
  if (REGEX_PRECEDING_PUNCTUATION.has(before[before.length - 1])) return true
  const word = /[A-Za-z_$][\w$]*$/.exec(before)
  return word !== null && REGEX_PRECEDING_KEYWORDS.includes(word[0])
}

/**
 * Blank out `//` and block comments, leaving everything else byte-for-byte.
 *
 * Exists because the watched-field derivation ran the chain extractor over raw
 * script text, so a migration note like
 *
 *   // Translates: steps.create_prospect.$return_value.id -> ...output.body.id
 *
 * was harvested as a live reference and reported as a field that never resolves
 * on 481,959 runs, while the real code beside it read the correct path (#1118).
 *
 * Two rules follow from the direction of risk. An UNWATCHED field is silent, so
 * anything this cannot prove is a comment is left alone: a `//` inside a string
 * or a regex stays, and an unterminated quote swallows the rest rather than
 * exposing it. And string and template literal CONTENTS are preserved rather
 * than blanked, because live references really do sit inside template literals
 * (``redirectUrl + `/${steps.create_prospect.output.body.id}` ``), so blanking
 * them would unwatch real fields to silence a cosmetic one.
 *
 * Comments are replaced with spaces, and their newlines kept, so offsets and
 * line numbers are unchanged for anything scanning the result positionally.
 */
export function stripComments(source: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ')
  const out: string[] = []
  let i = 0

  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (c === '/' && next === '/') {
      let j = i
      while (j < source.length && source[j] !== '\n') j++
      out.push(blank(source.slice(i, j)))
      i = j
      continue
    }

    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2)
      const j = close === -1 ? source.length : close + 2
      out.push(blank(source.slice(i, j)))
      i = j
      continue
    }

    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === c) {
          j++
          break
        }
        j++
      }
      out.push(source.slice(i, j))
      i = j
      continue
    }

    if (c === '/' && startsRegex(source, i)) {
      let j = i + 1
      let inCharacterClass = false
      let closed = false
      while (j < source.length) {
        const d = source[j]
        if (d === '\\') {
          j += 2
          continue
        }
        if (d === '\n') break // unterminated, so it was not a regex after all
        if (d === '[') inCharacterClass = true
        else if (d === ']') inCharacterClass = false
        else if (d === '/' && !inCharacterClass) {
          j++
          closed = true
          break
        }
        j++
      }
      if (closed) {
        out.push(source.slice(i, j))
        i = j
        continue
      }
    }

    out.push(c)
    i++
  }

  return out.join('')
}
