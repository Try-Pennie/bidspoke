import { describe, it, expect } from 'vitest'
import { redactPii, parsePiiFields, redactPiiInLogMessage } from '../pii-redactor'

describe('redactPii', () => {
  describe('empty fields list', () => {
    it('returns data unchanged when fields is empty', () => {
      const data = { ssn: '123-45-6789', name: 'Alice' }
      expect(redactPii(data, [])).toEqual(data)
    })

    it('returns primitives unchanged', () => {
      expect(redactPii('hello', [])).toBe('hello')
      expect(redactPii(42, [])).toBe(42)
      expect(redactPii(null, [])).toBeNull()
    })
  })

  describe('exact key matching', () => {
    it('redacts a matching top-level key', () => {
      const result = redactPii({ ssn: '123-45-6789', name: 'Alice' }, ['ssn'])
      expect(result).toEqual({ ssn: '[REDACTED]', name: 'Alice' })
    })

    it('does not redact non-matching keys', () => {
      const result = redactPii({ email: 'a@b.com', score: 700 }, ['ssn'])
      expect(result).toEqual({ email: 'a@b.com', score: 700 })
    })

    it('redacts multiple specified keys', () => {
      const result = redactPii({ ssn: '1', dob: '1990-01-01', name: 'Bob' }, ['ssn', 'dob'])
      expect(result).toEqual({ ssn: '[REDACTED]', dob: '[REDACTED]', name: 'Bob' })
    })

    it('does not redact nested keys with exact pattern (no wildcard)', () => {
      const result = redactPii({ user: { ssn: '123' } }, ['ssn'])
      // exact 'ssn' only matches top-level keys named 'ssn'; nested requires '*.ssn'
      expect(result).toEqual({ user: { ssn: '[REDACTED]' } })
    })
  })

  describe('wildcard pattern (*.key)', () => {
    it('redacts a matching key at any depth', () => {
      const result = redactPii({ user: { ssn: '123-45-6789' } }, ['*.ssn'])
      expect(result).toEqual({ user: { ssn: '[REDACTED]' } })
    })

    it('redacts the same key across multiple nested objects', () => {
      const result = redactPii(
        { primary: { ssn: 'aaa' }, secondary: { ssn: 'bbb' } },
        ['*.ssn']
      )
      expect(result).toEqual({
        primary: { ssn: '[REDACTED]' },
        secondary: { ssn: '[REDACTED]' },
      })
    })

    it('also redacts top-level keys with wildcard pattern', () => {
      const result = redactPii({ ssn: 'top-level' }, ['*.ssn'])
      expect(result).toEqual({ ssn: '[REDACTED]' })
    })
  })

  describe('arrays', () => {
    it('redacts matching keys inside array items', () => {
      const result = redactPii(
        [{ ssn: '111', name: 'Alice' }, { ssn: '222', name: 'Bob' }],
        ['ssn']
      )
      expect(result).toEqual([
        { ssn: '[REDACTED]', name: 'Alice' },
        { ssn: '[REDACTED]', name: 'Bob' },
      ])
    })

    it('leaves array items without the key unchanged', () => {
      const result = redactPii([{ name: 'Alice' }, { name: 'Bob' }], ['ssn'])
      expect(result).toEqual([{ name: 'Alice' }, { name: 'Bob' }])
    })
  })

  describe('edge cases', () => {
    it('handles null gracefully', () => {
      expect(redactPii(null, ['ssn'])).toBeNull()
    })

    it('handles an empty object', () => {
      expect(redactPii({}, ['ssn'])).toEqual({})
    })

    it('handles deeply nested structures', () => {
      const result = redactPii({ a: { b: { ssn: 'deep' } } }, ['*.ssn'])
      expect(result).toEqual({ a: { b: { ssn: '[REDACTED]' } } })
    })
  })
})

describe('parsePiiFields', () => {
  it('parses a comma-separated list', () => {
    expect(parsePiiFields('ssn,email,*.phone')).toEqual(['ssn', 'email', '*.phone'])
  })

  it('trims whitespace around entries', () => {
    expect(parsePiiFields(' ssn , email , *.phone ')).toEqual(['ssn', 'email', '*.phone'])
  })

  it('returns an empty array for an empty string', () => {
    expect(parsePiiFields('')).toEqual([])
  })

  it('filters out blank entries', () => {
    expect(parsePiiFields('ssn,,email')).toEqual(['ssn', 'email'])
  })

  it('handles a single field', () => {
    expect(parsePiiFields('ssn')).toEqual(['ssn'])
  })
})

// #1214: the redactor reached `input` and `output` only, so a code node that
// PRINTS the payload put the SSN in `execution_steps.logs`, a column nothing
// scrubbed, and from there into the 13 month execution archive. A log line is a
// string, so the field list cannot walk it; these cover scrubbing the JSON
// embedded in one.
describe('redactPiiInLogMessage', () => {
  const scoutLine =
    'Sending body to Eligibility Scout: {"first_name":"Alice","social_security_number":"123-45-6789","zip":"11201"}'

  it('redacts a listed field inside the JSON embedded in a log line', () => {
    const out = redactPiiInLogMessage(scoutLine, ['social_security_number'])
    expect(out).not.toContain('123-45-6789')
    expect(out).toContain('[REDACTED]')
  })

  it('keeps the human prefix and the unlisted fields of that line', () => {
    const out = redactPiiInLogMessage(scoutLine, ['social_security_number'])
    expect(out).toContain('Sending body to Eligibility Scout:')
    expect(out).toContain('Alice')
    expect(out).toContain('11201')
  })

  it('returns the line unchanged when the fields list is empty', () => {
    expect(redactPiiInLogMessage(scoutLine, [])).toBe(scoutLine)
  })

  it('returns a line carrying no JSON unchanged', () => {
    const plain = 'Scout responded 200 in 412ms'
    expect(redactPiiInLogMessage(plain, ['social_security_number'])).toBe(plain)
  })

  it('leaves a line whose braces are not valid JSON untouched rather than mangling it', () => {
    const notJson = 'matched rule {score > 700 and state in (NY, NJ)}'
    expect(redactPiiInLogMessage(notJson, ['social_security_number'])).toBe(notJson)
  })

  it('redacts a nested listed field, so a wrapped payload is not a way past it', () => {
    const nested = 'POST body {"applicant":{"ssn":"999-88-7777"},"amount":5000}'
    const out = redactPiiInLogMessage(nested, ['ssn'])
    expect(out).not.toContain('999-88-7777')
    expect(out).toContain('5000')
  })
})
