import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the SQL the Hyperdrive writer sends. The dynamic `import('pg')` in
// pg-writer resolves to this mock. vi.mock factories are hoisted above the
// module body, so the mock plumbing must live in vi.hoisted() to exist when the
// factory runs.
const h = vi.hoisted(() => {
  const calls: { text: string; values: unknown[] }[] = []
  const connect = vi.fn().mockResolvedValue(undefined)
  const end = vi.fn().mockResolvedValue(undefined)
  const query = vi.fn().mockImplementation((text: string, values: unknown[]) => {
    calls.push({ text, values })
    return Promise.resolve({ rows: [], rowCount: 1 })
  })
  const ClientCtor = vi.fn().mockImplementation(function () {
    return { connect, query, end }
  })
  return { calls, connect, end, query, ClientCtor }
})
const { calls, connect, end, query, ClientCtor } = h
vi.mock('pg', () => ({ Client: h.ClientCtor }))

import { pgInsert, pgUpdate, hyperdriveEnabled, EXECUTION_JSONB_COLS } from '../pg-writer'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = { HYPERDRIVE: { connectionString: 'postgres://u:p@h:6543/postgres' } } as any

beforeEach(() => {
  calls.length = 0
  ClientCtor.mockClear()
  connect.mockClear()
  end.mockClear()
  query.mockClear()
})

describe('hyperdriveEnabled', () => {
  it('is false without a binding or connection string', () => {
    expect(hyperdriveEnabled(undefined)).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(hyperdriveEnabled({} as any)).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(hyperdriveEnabled({ HYPERDRIVE: {} } as any)).toBe(false)
  })

  it('is true when the connection string is present', () => {
    expect(hyperdriveEnabled(env)).toBe(true)
  })
})

describe('pgInsert', () => {
  it('builds a parameterized insert with jsonb casts and opens/closes one client', async () => {
    await pgInsert(
      env,
      'workflow_executions',
      [{ id: 'e1', trigger_payload: { a: 1 }, source: 's' }],
      EXECUTION_JSONB_COLS
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toBe(
      'INSERT INTO workflow_executions ("id", "trigger_payload", "source") VALUES ($1, $2::jsonb, $3)'
    )
    expect(calls[0].values).toEqual(['e1', '{"a":1}', 's'])
    expect(connect).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('takes the union of columns across uneven rows and inserts NULL for missing keys', async () => {
    await pgInsert(env, 't', [{ a: 1 }, { b: 2 }], new Set())
    expect(calls[0].text).toBe('INSERT INTO t ("a", "b") VALUES ($1, $2), ($3, $4)')
    expect(calls[0].values).toEqual([1, null, null, 2])
  })

  it('is a no-op for an empty queue (never opens a connection)', async () => {
    await pgInsert(env, 't', [], new Set())
    expect(query).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
})

describe('pgUpdate', () => {
  it('builds a SET/WHERE update and returns the affected row count', async () => {
    const n = await pgUpdate(
      env,
      'workflow_executions',
      { status: 'completed', response_body: { ok: true } },
      { id: 'e1', started_at: 't0' },
      new Set(['response_body'])
    )
    expect(calls[0].text).toBe(
      'UPDATE workflow_executions SET "status" = $1, "response_body" = $2::jsonb WHERE "id" = $3 AND "started_at" = $4'
    )
    expect(calls[0].values).toEqual(['completed', '{"ok":true}', 'e1', 't0'])
    expect(n).toBe(1)
  })
})
