import { describe, it, expect } from 'vitest'
import { checkLogpush } from '../logpush-check'
import { EXPECTED_LOGPUSH_JOBS } from '../logpush-expectation'

// A Supabase double that records nothing: notifyExportFailure is exercised
// elsewhere, and what matters here is that the check reaches a verdict.
const supabase = { from: () => ({ insert: () => Promise.resolve({ error: null }), select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) } as never

const NOW = () => Date.parse('2026-09-09T17:00:00Z')

/** The live shape, as returned by the API on 2026-09-09. */
function liveBody() {
  const w = EXPECTED_LOGPUSH_JOBS[0]
  return {
    success: true,
    result: [
      {
        id: w.id,
        name: w.name,
        dataset: w.dataset,
        enabled: w.enabled,
        destination_conf: `https://${w.destinationHost}`,
        last_complete: '2026-09-09T16:45:38Z',
        output_options: { field_names: [...w.fieldNames], timestamp_format: 'rfc3339' },
      },
    ],
  }
}

describe('checkLogpush', () => {
  it('finds no differences against the recorded live account', async () => {
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => liveBody(), now: NOW })
    expect(r.differences).toEqual([])
    expect(r.alerted).toBe(false)
  })

  it('parses the destination down to its host, ignoring credentials in the query', async () => {
    const body = liveBody()
    body.result[0].destination_conf =
      `r2://bucket/{DATE}?access-key-id=SECRET&secret-access-key=ALSOSECRET`
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => body, now: NOW })
    expect(JSON.stringify(r.observed.jobs)).not.toContain('SECRET')
    expect(r.observed.jobs[0].destinationHost).toBe('bucket')
  })

  // L98 and L215: every way this can fail to see the account must read as its
  // own condition, never as a healthy empty result.
  it('reports a refusal rather than reporting no jobs', async () => {
    const r = await checkLogpush({}, supabase, {
      fetchJobs: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
      now: NOW,
    })
    expect(r.differences.join(' ')).toContain('10000')
    expect(r.alerted).toBe(true)
  })

  it('reports a thrown error rather than swallowing it', async () => {
    const r = await checkLogpush({}, supabase, {
      fetchJobs: async () => { throw new Error('connect ETIMEDOUT') },
      now: NOW,
    })
    expect(r.differences.join(' ')).toContain('ETIMEDOUT')
  })

  it('reports an unrecognised shape rather than treating it as an empty account', async () => {
    const r = await checkLogpush({}, supabase, {
      fetchJobs: async () => ({ success: true, result: 'not an array' }),
      now: NOW,
    })
    expect(r.differences.join(' ')).toContain('unrecognised shape')
  })

  it('names a missing token as its own cause, not as a refusal', async () => {
    const r = await checkLogpush({ CLOUDFLARE_ACCOUNT_ID: 'acct' }, supabase, { now: NOW })
    expect(r.differences.join(' ')).toContain('CLOUDFLARE_LOGS_TOKEN is not set')
  })

  it('names a missing account id as its own cause', async () => {
    const r = await checkLogpush({ CLOUDFLARE_LOGS_TOKEN: 'tok' }, supabase, { now: NOW })
    expect(r.differences.join(' ')).toContain('CLOUDFLARE_ACCOUNT_ID is not set')
  })

  it('alerts when a PII bearing field is added to the live job', async () => {
    const body = liveBody()
    body.result[0].output_options.field_names.push('Logs')
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => body, now: NOW })
    expect(r.differences.join(' ').toLowerCase()).toContain('personal data')
    expect(r.alerted).toBe(true)
  })
})
