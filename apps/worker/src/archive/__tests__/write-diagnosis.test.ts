/**
 * The read only probes behind docs/snowflake-slow-write.md (#1454).
 *
 * On 2026-09-22 working out why archive writes were timing out took an hour,
 * most of it spent building these by hand, including one probe that measured
 * the wrong thing. The statements are pinned here so the runbook's commands
 * cannot drift from what they claim to run.
 */
import { describe, it, expect } from 'vitest'
import {
  HISTORY_DEFAULT_HOURS,
  HISTORY_MAX_HOURS,
  queryHistoryStatement,
  readHistory,
  dominantWait,
  summarizeHistory,
  probeRows,
  explainProbeStatement,
} from '../write-diagnosis'
import type { SnowflakeStatementResponse } from '../../lib/snowflake'

describe('the query history statement', () => {
  it('reads the archive database query history over the window asked for', () => {
    const sql = queryHistoryStatement(72)
    expect(sql).toContain('BIDSPOKE_ARCHIVE.INFORMATION_SCHEMA.QUERY_HISTORY(')
    expect(sql).toContain("DATEADD('hour', -72, CURRENT_TIMESTAMP())")
    // Only the archive's own writes, not every INSERT the identity ever ran.
    expect(sql).toContain("query_type = 'INSERT'")
    expect(sql.toUpperCase()).toContain('BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE')
  })

  it('splits the time into the parts that separate the causes', () => {
    const sql = queryHistoryStatement(HISTORY_DEFAULT_HOURS).toLowerCase()
    for (const col of [
      'compilation_time',
      'execution_time',
      'queued_overload_time',
      'queued_provisioning_time',
      'transaction_blocked_time',
    ]) {
      expect(sql).toContain(col)
    }
  })

  it('never selects the statement text, which carries applicant data', () => {
    const select = queryHistoryStatement(72).split(/\bFROM\b/)[0].toLowerCase()
    expect(select).not.toContain('query_text')
  })

  it('defaults to 72 hours, the window that answers inside the statement timeout', () => {
    expect(HISTORY_DEFAULT_HOURS).toBe(72)
  })

  it('refuses a window Snowflake would refuse, rather than sending it', () => {
    expect(() => queryHistoryStatement(HISTORY_MAX_HOURS + 1)).toThrow(/7 days/)
    expect(() => queryHistoryStatement(0)).toThrow()
    expect(() => queryHistoryStatement(1.5)).toThrow()
    expect(() => queryHistoryStatement(HISTORY_MAX_HOURS)).not.toThrow()
  })
})

describe('reading the history', () => {
  const columns = [
    'START_TIME',
    'QUERY_ID',
    'EXECUTION_STATUS',
    'ERROR_CODE',
    'TOTAL_ELAPSED_TIME',
    'COMPILATION_TIME',
    'EXECUTION_TIME',
    'QUEUED_OVERLOAD_TIME',
    'QUEUED_PROVISIONING_TIME',
    'TRANSACTION_BLOCKED_TIME',
  ]
  function response(order: string[], row: Record<string, string | null>): SnowflakeStatementResponse {
    return {
      resultSetMetaData: { rowType: order.map((name) => ({ name, type: 'text' })) },
      data: [order.map((n) => row[n])],
    }
  }
  const incident = {
    START_TIME: '1758554580.000000000',
    QUERY_ID: '01b7-abc',
    EXECUTION_STATUS: 'FAILED_WITH_ERROR',
    ERROR_CODE: '000630',
    TOTAL_ELAPSED_TIME: '78300',
    COMPILATION_TIME: '77813',
    EXECUTION_TIME: '460',
    QUEUED_OVERLOAD_TIME: '0',
    QUEUED_PROVISIONING_TIME: '0',
    TRANSACTION_BLOCKED_TIME: '0',
  }

  it('reads each cell by its column name, whatever order Snowflake returns them in', () => {
    const [row] = readHistory(response([...columns].reverse(), incident))
    expect(row.queryId).toBe('01b7-abc')
    expect(row.compilationMs).toBe(77813)
    expect(row.executionMs).toBe(460)
    expect(row.queuedMs).toBe(0)
    expect(row.provisioningMs).toBe(0)
    expect(row.blockedMs).toBe(0)
    expect(row.status).toBe('FAILED_WITH_ERROR')
  })

  it('refuses an answer missing a column rather than reading a wrong one', () => {
    expect(() => readHistory(response(columns.filter((c) => c !== 'COMPILATION_TIME'), incident))).toThrow(
      /compilation_time/,
    )
  })

  it('names the part the statement spent its time in', () => {
    const [row] = readHistory(response(columns, incident))
    expect(dominantWait(row)).toBe('compilation')
    expect(dominantWait({ ...row, compilationMs: 1, executionMs: 9 })).toBe('execution')
    expect(dominantWait({ ...row, compilationMs: 1, executionMs: 1, queuedMs: 9 })).toBe('queued')
    expect(dominantWait({ ...row, compilationMs: 1, executionMs: 1, blockedMs: 9 })).toBe('blocked')
    expect(dominantWait({ ...row, compilationMs: 1, executionMs: 1, provisioningMs: 9 })).toBe('provisioning')
  })
})

describe('summarising the history', () => {
  const base = {
    startTime: '1',
    queryId: 'q',
    status: 'SUCCESS',
    errorCode: null,
    compilationMs: 1000,
    executionMs: 300,
    queuedMs: 0,
    provisioningMs: 0,
    blockedMs: 0,
  }
  const rows = [
    { ...base, queryId: 'a', totalMs: 1300 },
    { ...base, queryId: 'b', totalMs: 90000, compilationMs: 89000, status: 'FAILED_WITH_ERROR', errorCode: '000630' },
    { ...base, queryId: 'c', totalMs: 5000, compilationMs: 100, executionMs: 4900 },
  ]

  it('counts the writes, the failures, and where the time went', () => {
    const s = summarizeHistory(rows, 2)
    expect(s.total).toBe(3)
    expect(s.failed.map((r) => r.queryId)).toEqual(['b'])
    expect(s.mostly).toEqual({ compilation: 2, execution: 1, queued: 0, provisioning: 0, blocked: 0 })
  })

  it('lists the slowest first, as many as asked for', () => {
    expect(summarizeHistory(rows, 2).slowest.map((r) => r.queryId)).toEqual(['b', 'c'])
  })

  it('an empty window is reported as empty, not as healthy', () => {
    const s = summarizeHistory([], 5)
    expect(s.total).toBe(0)
    expect(s.slowest).toEqual([])
  })
})

describe('the compile probe', () => {
  // Deterministic stand in for crypto.getRandomValues, different on every call.
  function counter() {
    let n = 0
    return (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256
      // The call number in the leading bytes, so no two calls fill alike.
      bytes[0] = n & 0xff
      bytes[1] = (n >> 8) & 0xff
      bytes[2] = (n >> 16) & 0xff
      n++
      return bytes
    }
  }

  it('gives every row its own payload, as real bundles are', () => {
    const rows = probeRows(150, 13 * 1024, counter())
    expect(rows).toHaveLength(150)
    expect(new Set(rows.map((r) => r.wire)).size).toBe(150)
    expect(new Set(rows.map((r) => r.executionId)).size).toBe(150)
  })

  it('makes each payload the size asked for', () => {
    const rows = probeRows(3, 13 * 1024, counter())
    for (const r of rows) expect(r.wire.length).toBe(13 * 1024)
  })

  it('only compiles: the statement is an EXPLAIN of the archive INSERT and nothing else', () => {
    const sql = explainProbeStatement(probeRows(2, 64, counter()))
    expect(sql.startsWith('EXPLAIN INSERT INTO BIDSPOKE_ARCHIVE.EXECUTIONS.EXECUTION_ARCHIVE ')).toBe(true)
    expect(sql.split(';')).toHaveLength(1)
  })
})
