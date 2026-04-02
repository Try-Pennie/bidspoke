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
