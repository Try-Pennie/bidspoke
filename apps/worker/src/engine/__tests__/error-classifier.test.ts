import { describe, it, expect } from 'vitest'
import { classifyHttpError, classifyTransportError } from '../error-classifier'

describe('classifyHttpError', () => {
  describe('transient (should retry)', () => {
    it('429 Too Many Requests', () => expect(classifyHttpError(429)).toBe('transient'))
    it('502 Bad Gateway', () => expect(classifyHttpError(502)).toBe('transient'))
    it('503 Service Unavailable', () => expect(classifyHttpError(503)).toBe('transient'))
    it('504 Gateway Timeout', () => expect(classifyHttpError(504)).toBe('transient'))
  })

  describe('permanent (do not retry)', () => {
    it('400 Bad Request', () => expect(classifyHttpError(400)).toBe('permanent'))
    it('401 Unauthorized', () => expect(classifyHttpError(401)).toBe('permanent'))
    it('403 Forbidden', () => expect(classifyHttpError(403)).toBe('permanent'))
    it('404 Not Found', () => expect(classifyHttpError(404)).toBe('permanent'))
    it('422 Unprocessable Entity', () => expect(classifyHttpError(422)).toBe('permanent'))
    it('500 Internal Server Error', () => expect(classifyHttpError(500)).toBe('permanent'))
    it('501 Not Implemented', () => expect(classifyHttpError(501)).toBe('permanent'))
  })
})

describe('classifyTransportError', () => {
  it('network failures are transient', () => {
    expect(classifyTransportError(new Error('fetch failed'))).toBe('transient')
  })

  it('timeout errors are transient', () => {
    expect(classifyTransportError(new Error('Step timed out after 30000ms'))).toBe('transient')
  })

  it('unknown errors are transient', () => {
    expect(classifyTransportError('some string error')).toBe('transient')
  })
})
