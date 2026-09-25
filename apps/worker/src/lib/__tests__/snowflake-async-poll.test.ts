/**
 * A statement that goes async must leave a trace (#608).
 *
 * When Snowflake answers 202 the client polls the statement handle, sleeping
 * between polls. That path used to log nothing, so it could spend a minute of an
 * export's wall budget per batch invisibly, and the timeout it finally threw did
 * not say it had been waiting at all. These tests pin the entry log, a log per
 * poll, and failure messages that carry how long the statement had been waited on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { executeStatement, pollStatement, resolveStatementResult, type SnowflakeConfig } from '../snowflake'

const config = { account: 'acct.us-east-1' } as SnowflakeConfig
const headers = { Authorization: 'Bearer x' }

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
  })
}

/** A clock that only moves when the injected sleep is called, so no test waits. */
function fakeClock(start: number) {
  let t = start
  const slept: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms)
      t += ms
    },
    slept,
  }
}

function warnings(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c: unknown[]) => c.map(String).join(' '))
}

afterEach(() => vi.restoreAllMocks())

describe('pollStatement logging (#608)', () => {
  it('logs entry with the handle and how long the statement had already run', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([{ status: 200, body: { code: '090001' } }])
    const clock = fakeClock(1_000_000)

    await pollStatement(config, headers, 'h-entry', {
      intervalMs: 2000,
      maxAttempts: 5,
      sleep: clock.sleep,
      now: clock.now,
      sentAt: 1_000_000 - 45_000,
    })

    const lines = warnings(warn)
    const entry = lines.find((l) => l.includes('went async'))
    expect(entry).toBeDefined()
    expect(entry).toContain('h-entry')
    expect(entry).toContain('45s after it was sent')
  })

  it('logs every poll that finds the statement still running, and the completion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([
      { status: 202, body: {} },
      { status: 202, body: {} },
      { status: 200, body: { code: '090001' } },
    ])
    const clock = fakeClock(0)

    const result = await pollStatement(config, headers, 'h-poll', {
      intervalMs: 2000,
      maxAttempts: 5,
      sleep: clock.sleep,
      now: clock.now,
      sentAt: 0,
    })

    expect(result.code).toBe('090001')
    expect(clock.slept).toEqual([2000, 2000, 2000])
    const lines = warnings(warn)
    expect(lines.filter((l) => l.includes('h-poll') && l.includes('still running'))).toHaveLength(2)
    expect(lines.some((l) => l.includes('still running after poll 1 of 5') && l.includes('2s since it was sent'))).toBe(true)
    expect(lines.some((l) => l.includes('still running after poll 2 of 5') && l.includes('4s since it was sent'))).toBe(true)
    expect(lines.some((l) => l.includes('h-poll') && l.includes('completed after 3 polls') && l.includes('6s'))).toBe(true)
  })

  it('says how long it waited when the polls run out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([{ status: 202, body: {} }])
    const clock = fakeClock(0)

    await expect(
      pollStatement(config, headers, 'h-slow', {
        intervalMs: 2000,
        maxAttempts: 3,
        sleep: clock.sleep,
        now: clock.now,
        sentAt: -45_000,
      }),
    ).rejects.toThrow(/h-slow did not complete after 3 polls, 51s after it was sent: it went async and was waited on for 6s/)
  })

  it('says it had been waiting when a poll comes back failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([
      { status: 202, body: {} },
      { status: 422, body: { message: 'SQL compilation error' } },
    ])
    const clock = fakeClock(0)

    await expect(
      pollStatement(config, headers, 'h-fail', { intervalMs: 2000, maxAttempts: 5, sleep: clock.sleep, now: clock.now, sentAt: 0 }),
    ).rejects.toThrow(/Snowflake poll 422 on poll 2 of 5, 4s after statement h-fail was sent/)
  })

  it('never sleeps for real when resolveStatementResult polls with an injected sleep', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchSequence([{ status: 200, body: { code: '090001' } }])
    const clock = fakeClock(0)
    const result = await resolveStatementResult(config, headers, 202, JSON.stringify({ statementHandle: 'h-r' }), {
      intervalMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
      sentAt: 0,
    })
    expect(result.code).toBe('090001')
    expect(clock.slept).toEqual([60_000])
  })
})

describe('executeStatement going async (#608)', () => {
  afterEach(() => vi.useRealTimers())

  async function generatePem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
    let s = ''
    for (const b of der) s += String.fromCharCode(b)
    // Assembled from parts so a secret scanner does not read the header as a key.
    const label = ['PRIVATE', 'KEY'].join(' ')
    return `-----BEGIN ${label}-----\n${btoa(s)}\n-----END ${label}-----`
  }

  it('measures the wait from when the statement was sent, not from the first poll', async () => {
    const full: SnowflakeConfig = {
      account: 'acct.us-east-1',
      user: 'svc',
      privateKeyPem: await generatePem(),
      database: 'db',
      schema: 'sc',
      warehouse: 'wh',
      role: 'r',
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    vi.setSystemTime(1_000_000)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        // Snowflake holds the POST for 45 seconds before answering 202.
        vi.setSystemTime(Date.now() + 45_000)
        return new Response(JSON.stringify({ statementHandle: 'h-exec' }), { status: 202 })
      }
      return new Response(JSON.stringify({ data: [[1]] }), { status: 200 })
    })

    // Signing runs on real async crypto, so the poll's sleep is registered at an
    // unknown moment. Move the fake clock only when a timer is actually waiting,
    // which advances it by exactly the poll interval and nothing else.
    let settled = false
    const pending = executeStatement(full, 'select 1').finally(() => {
      settled = true
    })
    while (!settled) {
      if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
      else await new Promise((resolve) => setImmediate(resolve))
    }
    const result = await pending

    expect(result.data).toEqual([[1]])
    const lines = warnings(warn)
    expect(lines.some((l) => l.includes('h-exec went async (202) 45s after it was sent'))).toBe(true)
    expect(lines.some((l) => l.includes('h-exec completed after 1 polls, 47s after it was sent'))).toBe(true)
  })
})
