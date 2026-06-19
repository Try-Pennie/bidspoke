import { describe, it, expect, vi } from 'vitest'
import {
  withDbRetry,
  isPermanentDbError,
  isDuplicateError,
  type DbError,
} from '../db-retry'

describe('withDbRetry', () => {
  it('returns immediately when the op succeeds (no retry)', async () => {
    const op = vi.fn().mockResolvedValue({ error: null })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toBeNull()
    expect(op).toHaveBeenCalledOnce()
  })

  it('retries a transient error and returns success on a later attempt', async () => {
    const transient: DbError = { code: 'PGRST002', message: 'Could not query the database for the schema cache.' }
    const op = vi
      .fn()
      .mockResolvedValueOnce({ error: transient })
      .mockResolvedValueOnce({ error: transient })
      .mockResolvedValueOnce({ error: null })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toBeNull()
    expect(op).toHaveBeenCalledTimes(3)
  })

  it('fails fast on a permanent error without retrying', async () => {
    const permanent: DbError = { code: '23502', message: 'null value in column violates not-null constraint' }
    const op = vi.fn().mockResolvedValue({ error: permanent })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toEqual(permanent)
    expect(op).toHaveBeenCalledOnce()
  })

  it('returns the last error after exhausting retries on a persistent transient error', async () => {
    const transient: DbError = { code: 'PGRST002', message: 'schema cache' }
    const op = vi.fn().mockResolvedValue({ error: transient })
    const { error } = await withDbRetry(op, [0, 0])
    expect(error).toEqual(transient)
    // 1 initial attempt + 2 retries (delays length)
    expect(op).toHaveBeenCalledTimes(3)
  })
})

describe('isPermanentDbError', () => {
  it('is true for known permanent SQLSTATE / PostgREST codes', () => {
    expect(isPermanentDbError({ code: '23502', message: '' })).toBe(true)
    expect(isPermanentDbError({ code: '42703', message: '' })).toBe(true)
    expect(isPermanentDbError({ code: 'PGRST204', message: '' })).toBe(true)
  })

  it('is false for transient errors (schema-cache reload, lock contention) and null', () => {
    expect(isPermanentDbError({ code: 'PGRST002', message: '' })).toBe(false)
    expect(isPermanentDbError({ message: 'connection reset' })).toBe(false)
    expect(isPermanentDbError(null)).toBe(false)
  })
})

describe('isDuplicateError', () => {
  it('is true only for unique_violation (23505)', () => {
    expect(isDuplicateError({ code: '23505', message: '' })).toBe(true)
    expect(isDuplicateError({ code: '23502', message: '' })).toBe(false)
    expect(isDuplicateError(null)).toBe(false)
  })
})
