import { describe, it, expect } from 'vitest'
import { checkLogpush } from '../logpush-check'
import { EXPECTED_LOGPUSH_JOBS, type ExpectedLogpushJob } from '../logpush-expectation'

// A Supabase double that records nothing: notifyExportFailure is exercised
// elsewhere, and what matters here is that the check reaches a verdict.
const supabase = { from: () => ({ insert: () => Promise.resolve({ error: null }), select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) } as never

const NOW = () => Date.parse('2026-09-09T17:00:00Z')

/**
 * The Better Stack job as it stood on 2026-09-09, kept as a fixture so the
 * per-job comparisons stay covered for the day a job is deliberately expected
 * again. The committed expectation is now empty (Logpush was switched off on the
 * account on 2026-09-26), so these tests pass the fixture in explicitly.
 */
const JOB: ExpectedLogpushJob = {
  id: 1740821,
  name: 'logpush-better-stack-logs',
  destinationHost: 's2537399.eu-fsn-3.betterstackdata.com',
  dataset: 'workers_trace_events',
  enabled: true,
  fieldNames: ['DispatchNamespace', 'Entrypoint', 'EventTimestampMs', 'EventType', 'ScriptName', 'ScriptTags', 'ScriptVersion'],
}
const expected = [JOB]

/** The live shape, as returned by the API on 2026-09-09. */
function liveBody() {
  const w = JOB
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
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => liveBody(), now: NOW, expected })
    expect(r.differences).toEqual([])
    expect(r.alerted).toBe(false)
  })

  it('parses the destination down to its host, ignoring credentials in the query', async () => {
    const body = liveBody()
    body.result[0].destination_conf =
      `r2://bucket/{DATE}?access-key-id=SECRET&secret-access-key=ALSOSECRET`
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => body, now: NOW, expected })
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
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => body, now: NOW, expected })
    expect(r.differences.join(' ').toLowerCase()).toContain('personal data')
    expect(r.alerted).toBe(true)
  })

  // L50: Date.parse returns NaN on an unparseable string, and `now - NaN > threshold`
  // is FALSE, so a job with a corrupt last_complete lands on the HEALTHY side of
  // the staleness test. A monitoring check that fails open is worse than none,
  // because it reports the thing it is watching as fine.
  it('does not report a job as healthy when its last_complete cannot be parsed', async () => {
    const body = liveBody()
    body.result[0].last_complete = 'not a date'
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => body, now: NOW, expected })
    expect(r.alerted).toBe(true)
    expect(r.differences.join(' ').toLowerCase()).toContain('last_complete')
  })

  it('treats a missing last_complete as never delivered, which is its own message', async () => {
    const body = liveBody()
    delete (body.result[0] as { last_complete?: unknown }).last_complete
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => body, now: NOW, expected })
    expect(r.differences.join(' ').toLowerCase()).toContain('never')
  })

  // 2026-09-26: Cloudflare switched Logpush off for the whole account, and Dan
  // accepted that rather than re-enabling it. The committed expectation is
  // therefore no jobs, and "not enabled" is how the API says there are none.
  describe('with Logpush switched off on the account', () => {
    const notEnabled = () => ({ success: false, errors: [{ code: 1004, message: 'logpush is not enabled for this account' }] })

    it('expects no Logpush jobs', () => {
      expect(EXPECTED_LOGPUSH_JOBS).toEqual([])
    })

    it('reads the not-enabled refusal as zero jobs and raises nothing', async () => {
      const r = await checkLogpush({}, supabase, { fetchJobs: async () => notEnabled(), now: NOW })
      expect(r.observed.unreadable).toEqual([])
      expect(r.observed.jobs).toEqual([])
      expect(r.differences).toEqual([])
      expect(r.alerted).toBe(false)
    })

    it('alerts when any job reappears, since logs would be leaving the account again', async () => {
      const r = await checkLogpush({}, supabase, { fetchJobs: async () => liveBody(), now: NOW })
      expect(r.alerted).toBe(true)
      expect(r.differences.join(' ')).toContain('unexpected Logpush job')
    })

    it('still reports any other refusal, so the check cannot go quiet by accident', async () => {
      const r = await checkLogpush({}, supabase, {
        fetchJobs: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
        now: NOW,
      })
      expect(r.alerted).toBe(true)
      expect(r.differences.join(' ')).toContain('10000')
    })

    it('still reports the refusal when a job is expected, since that job cannot be running', async () => {
      const r = await checkLogpush({}, supabase, { fetchJobs: async () => notEnabled(), now: NOW, expected })
      expect(r.alerted).toBe(true)
      expect(r.differences.join(' ')).toContain('1004 logpush is not enabled')
    })
  })
})
