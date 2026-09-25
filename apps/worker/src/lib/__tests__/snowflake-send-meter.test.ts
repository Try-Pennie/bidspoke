/**
 * What a Snowflake send cost, and how often it was retried, per run (#1443).
 *
 * The retry path logged each resubmit to Workers Logs and nothing counted them,
 * and nothing recorded how long a send took, so the statement timeout could not
 * be chosen from a distribution. The client now reports both into a meter its
 * caller owns, and these tests pin what the meter records against a clock that
 * only moves when the fake Snowflake answers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  executeStatement,
  postStatementWithRetry,
  SnowflakeNotSentError,
  SnowflakeSendMeter,
  SEND_DURATION_BUCKETS_SECONDS,
  type SnowflakeConfig,
} from '../snowflake'

const url = 'https://acct.snowflakecomputing.com/api/v2/statements'
const headers = { Authorization: 'Bearer x' }

/**
 * A fake Snowflake: each answer takes `ms` on the shared clock, and either
 * returns a status or rejects as a dropped connection.
 */
function snowflakeAnswering(clock: { t: number }, answers: Array<{ ms: number; status?: number; body?: unknown }>) {
  let i = 0
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const a = answers[Math.min(i, answers.length - 1)]
    i++
    clock.t += a.ms
    if (a.status === undefined) throw new TypeError('Network connection lost.')
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status })
  })
}

afterEach(() => vi.restoreAllMocks())

describe('postStatementWithRetry reports into a meter (#1443)', () => {
  it('counts every attempt, every resubmit and the failed statuses, with their durations', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clock = { t: 0 }
    const meter = new SnowflakeSendMeter(() => clock.t)
    snowflakeAnswering(clock, [
      { ms: 61_000, status: 524 },
      { ms: 3_000, status: 503 },
      { ms: 12_000, status: 200 },
    ])

    await postStatementWithRetry(url, headers, '{}', 'req', {
      sleep: async () => {},
      delaysMs: [0, 0],
      now: () => clock.t,
      meter,
    })

    const s = meter.snapshot()
    expect(s.attempts).toBe(3)
    expect(s.resubmits).toBe(2)
    expect(s.failedAttempts).toEqual({ '524': 1, '503': 1 })
    expect(s.worstStatus).toBe(524)
    expect(s.slowestAttemptMs).toBe(61_000)
    expect(s.totalAttemptMs).toBe(76_000)
  })

  it('counts a dropped connection as a failed attempt with no response', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clock = { t: 0 }
    const meter = new SnowflakeSendMeter(() => clock.t)
    snowflakeAnswering(clock, [{ ms: 500 }, { ms: 800, status: 200 }])

    await postStatementWithRetry(url, headers, '{}', 'req', { sleep: async () => {}, delaysMs: [0], now: () => clock.t, meter })

    const s = meter.snapshot()
    expect(s.failedAttempts).toEqual({ no_response: 1 })
    expect(s.worstStatus).toBeNull()
    expect(s.resubmits).toBe(1)
  })

  it('does not count the last failed attempt as a resubmit when it gives up', async () => {
    const clock = { t: 0 }
    const meter = new SnowflakeSendMeter(() => clock.t)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    snowflakeAnswering(clock, [{ ms: 90_000, status: 408 }])

    await expect(
      postStatementWithRetry(url, headers, '{}', 'req', { sleep: async () => {}, delaysMs: [0, 0], now: () => clock.t, meter }),
    ).rejects.toThrow(/timed out twice/)

    const s = meter.snapshot()
    expect(s.attempts).toBe(2)
    expect(s.resubmits).toBe(1)
    expect(s.failedAttempts).toEqual({ '408': 2 })
  })

  it('counts a statement refused before its first attempt as not sent, and no attempt', async () => {
    const clock = { t: 0 }
    const meter = new SnowflakeSendMeter(() => clock.t)
    const fetchSpy = snowflakeAnswering(clock, [{ ms: 1, status: 200 }])

    await expect(
      postStatementWithRetry(url, headers, '{}', 'req', { now: () => clock.t, giveUpAt: 1_000, meter }),
    ).rejects.toBeInstanceOf(SnowflakeNotSentError)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(meter.snapshot()).toMatchObject({ attempts: 0, notSent: 1 })
  })

  it('files each attempt under the first bucket its duration fits', () => {
    const meter = new SnowflakeSendMeter(() => 0)
    meter.recordAttempt(4_999, 200)
    meter.recordAttempt(5_000, 200)
    meter.recordAttempt(89_000, 408)
    meter.recordAttempt(500_000, null)

    const buckets = meter.snapshot().attemptSeconds
    // Every edge has a bucket, plus one past the last edge, so no duration is dropped.
    expect(Object.keys(buckets)).toHaveLength(SEND_DURATION_BUCKETS_SECONDS.length + 1)
    expect(buckets['<5']).toBe(1)
    expect(buckets['<15']).toBe(1)
    expect(buckets['<90']).toBe(1)
    expect(buckets[`>=${SEND_DURATION_BUCKETS_SECONDS[SEND_DURATION_BUCKETS_SECONDS.length - 1]}`]).toBe(1)
    const counted = Object.values(buckets).reduce((a, b) => a + b, 0)
    expect(counted).toBe(meter.snapshot().attempts)
  })

  it('starts empty, so a run that sent nothing reports zeros rather than missing fields', () => {
    const s = new SnowflakeSendMeter(() => 0).snapshot()
    expect(s).toMatchObject({
      statements: 0,
      attempts: 0,
      resubmits: 0,
      notSent: 0,
      asyncStatements: 0,
      failedAttempts: {},
      worstStatus: null,
      slowestAttemptMs: 0,
      totalAttemptMs: 0,
      slowestStatementMs: 0,
      totalStatementMs: 0,
    })
  })
})

describe('executeStatement reports whole statements into the meter (#1443)', () => {
  async function config(): Promise<SnowflakeConfig> {
    const pair = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
    let s = ''
    for (const b of der) s += String.fromCharCode(b)
    return {
      account: 'acct.us-east-1',
      user: `svc_${crypto.randomUUID().slice(0, 8)}`,
      // Header assembled from parts so a secret scanner does not read it as a key.
      privateKeyPem: `-----BEGIN ${['PRIVATE', 'KEY'].join(' ')}-----\n${btoa(s)}\n-----END ${['PRIVATE', 'KEY'].join(' ')}-----`,
      database: 'db',
      schema: 'sc',
      warehouse: 'wh',
      role: 'r',
    }
  }

  it('records each statement from send to result, retries included', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clock = { t: 0 }
    const meter = new SnowflakeSendMeter(() => clock.t)
    snowflakeAnswering(clock, [
      { ms: 2_000, status: 200, body: { data: [[1]] } },
      { ms: 30_000, status: 503 },
      { ms: 7_000, status: 200, body: { data: [[1]] } },
    ])
    const c = await config()

    await executeStatement(c, 'insert 1', undefined, { meter })
    await executeStatement(c, 'insert 2', undefined, { meter, sleep: async () => {} })

    const s = meter.snapshot()
    expect(s.statements).toBe(2)
    expect(s.attempts).toBe(3)
    expect(s.resubmits).toBe(1)
    expect(s.slowestStatementMs).toBe(37_000)
    expect(s.totalStatementMs).toBe(39_000)
  })

  it('counts a statement that went async', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clock = { t: 0 }
    const meter = new SnowflakeSendMeter(() => clock.t)
    snowflakeAnswering(clock, [
      { ms: 45_000, status: 202, body: { statementHandle: 'h1' } },
      { ms: 1_000, status: 200, body: { data: [[1]] } },
    ])

    await executeStatement(await config(), 'insert', undefined, { meter, sleep: async () => {} })

    expect(meter.snapshot()).toMatchObject({ statements: 1, asyncStatements: 1, attempts: 1 })
  })

  it('still records a statement that failed', async () => {
    const clock = { t: 0 }
    const meter = new SnowflakeSendMeter(() => clock.t)
    snowflakeAnswering(clock, [{ ms: 4_000, status: 422, body: { message: 'SQL compilation error' } }])

    await expect(executeStatement(await config(), 'bad', undefined, { meter })).rejects.toThrow(/422/)

    expect(meter.snapshot()).toMatchObject({ statements: 1, attempts: 1, failedAttempts: { '422': 1 }, totalStatementMs: 4_000 })
  })
})
