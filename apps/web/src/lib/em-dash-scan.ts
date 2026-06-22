// Static scan for em dashes (U+2014) in source, used by the CI guard that keeps
// them out of user-facing PROSE (project convention: no em dashes in UI/Slack
// copy — use periods, colons, or commas). Exemptions:
//   - code COMMENTS (not user-facing; the codebase uses em dashes in them heavily)
//   - a string whose only content is the em dash (the idiomatic "no value" cell
//     glyph, e.g. {value ?? '—'} / return '—')
//   - any line carrying an `em-dash-ok` marker
// An em dash anywhere else in a scanned file is necessarily JSX text or an
// embedded string — i.e. prose — since it isn't valid JS syntax otherwise.

const EM_DASH = '—'

export interface EmDashHit {
  line: number
  excerpt: string
}

export function findEmDashes(content: string): EmDashHit[] {
  const rawHitLines: number[] = []
  const len = content.length
  let line = 1
  let i = 0

  while (i < len) {
    const c = content[i]
    const n = content[i + 1]

    if (c === '\n') { line++; i++; continue }

    // Line comment — skip to newline.
    if (c === '/' && n === '/') { while (i < len && content[i] !== '\n') i++; continue }

    // Block comment — skip to */ (tracking newlines).
    if (c === '/' && n === '*') {
      i += 2
      while (i < len && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }

    // String / template literal — consume the whole token so we can judge it as a
    // unit (a bare-em-dash placeholder is exempt; an em dash among other text is
    // flagged). `${}` interpolation isn't parsed; mark a genuine exception with
    // an em-dash-ok comment if a bare placeholder ever sits inside one.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      const startLine = line
      let inner = ''
      let emLine = -1
      i++ // past opening quote
      while (i < len && content[i] !== quote) {
        if (content[i] === '\\') {
          if (content[i + 1] === '\n') line++
          inner += content[i + 1] ?? ''
          i += 2
          continue
        }
        if (content[i] === '\n') line++
        if (content[i] === EM_DASH && emLine === -1) emLine = line
        inner += content[i]
        i++
      }
      i++ // past closing quote
      if (inner.includes(EM_DASH) && inner.trim() !== EM_DASH) {
        rawHitLines.push(emLine === -1 ? startLine : emLine)
      }
      continue
    }

    // Bare text (incl. JSX text) — any em dash here is prose.
    if (c === EM_DASH) rawHitLines.push(line)
    i++
  }

  if (rawHitLines.length === 0) return []
  const lines = content.split('\n')
  const hits: EmDashHit[] = []
  for (const ln of rawHitLines) {
    const src = lines[ln - 1] ?? ''
    if (src.includes('em-dash-ok')) continue // explicit opt-out
    hits.push({ line: ln, excerpt: src.trim() })
  }
  return hits
}
