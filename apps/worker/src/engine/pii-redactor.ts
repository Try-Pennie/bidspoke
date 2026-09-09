// PRD Section 12.4 — ships disabled (empty fields list = no redaction)
// Enable by setting PII_REDACTION_FIELDS env var to a comma-separated list of field patterns
// Supports exact keys ('ssn') and wildcard-depth ('*.ssn')

export function redactPii(data: unknown, fields: string[]): unknown {
  if (fields.length === 0) return data
  return walk(data, fields)
}

export function parsePiiFields(raw: string): string[] {
  return raw
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
}

function walk(data: unknown, fields: string[]): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => walk(item, fields))
  }
  if (data !== null && typeof data === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (shouldRedact(key, fields)) {
        result[key] = '[REDACTED]'
      } else {
        result[key] = walk(value, fields)
      }
    }
    return result
  }
  return data
}

function shouldRedact(key: string, fields: string[]): boolean {
  return fields.some((pattern) => {
    if (pattern.startsWith('*.')) {
      return key === pattern.slice(2)
    }
    return key === pattern
  })
}

/**
 * Redact listed fields inside the JSON embedded in a single log line (#1214).
 *
 * `execution_steps.logs` holds `{ level, message, ts }`, and `message` is a
 * string, so the field walk above cannot reach it. A code node that prints the
 * payload it is about to send therefore wrote PII into a column nothing
 * scrubbed, and the execution archive carries that column forward for 13
 * months while Postgres keeps it for 7 days.
 *
 * Scope is deliberately the JSON half of that issue's direction only. Matching
 * SSN-SHAPED text in prose is not done here: a shape rule has to be proved
 * against the content it must PRESERVE, not only the content it must catch
 * (L104), and an over-match reads exactly like the feature working. A line that
 * carries no parseable object is returned untouched rather than guessed at.
 *
 * Inert while `PII_REDACTION_FIELDS` is empty, which is the deliberate state
 * under ADR 0006. This closes the mechanism gap so the config change is the
 * only thing standing between here and covered logs.
 */
export function redactPiiInLogMessage(message: string, fields: string[]): string {
  if (fields.length === 0) return message
  const span = findJsonObjectSpan(message)
  if (span === null) return message
  const [start, end] = span
  let parsed: unknown
  try {
    parsed = JSON.parse(message.slice(start, end))
  } catch {
    // Braces that are not JSON (a rule expression, a template, prose). Leaving
    // the line alone is the only safe answer: a partial rewrite would corrupt
    // text nobody asked us to touch.
    return message
  }
  if (parsed === null || typeof parsed !== 'object') return message
  return message.slice(0, start) + JSON.stringify(walk(parsed, fields)) + message.slice(end)
}

/**
 * The span of the first balanced `{...}` in the line, or null. String literals
 * are tracked so a brace inside a quoted value does not close the object early.
 */
function findJsonObjectSpan(s: string): [number, number] | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (c === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return [start, i + 1]
    }
  }
  return null
}
