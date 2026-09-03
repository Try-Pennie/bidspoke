import { describe, it, expect } from 'vitest'
import { isNotFoundError, EXECUTION_RETENTION_DAYS } from '../execution-retention'

describe('isNotFoundError', () => {
  it('matches the api req() 404 error shape', () => {
    expect(isNotFoundError(new Error('API 404: {"error":"Execution not found"}'))).toBe(true)
  })

  it('rejects other statuses, network errors, and non-errors', () => {
    expect(isNotFoundError(new Error('API 500: boom'))).toBe(false)
    expect(isNotFoundError(new Error('Failed to fetch'))).toBe(false)
    expect(isNotFoundError('API 404: string not error')).toBe(false)
    expect(isNotFoundError(undefined)).toBe(false)
  })
})

describe('EXECUTION_RETENTION_DAYS', () => {
  it('matches the nightly purge cron (truncate_verified_execution_partitions(21))', () => {
    expect(EXECUTION_RETENTION_DAYS).toBe(21)
  })
})
