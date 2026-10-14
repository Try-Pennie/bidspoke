import { describe, it, expect, vi } from 'vitest'

// Recorded rather than sent, so a test can read which wording a finding got
// (#835). The other tests here assert only the verdict, which this leaves alone.
vi.mock('../export-alerts', () => ({ notifyExportFailure: vi.fn(async () => undefined) }))

import { checkLogpush } from '../logpush-check'
import { notifyExportFailure } from '../export-alerts'
import { EXPECTED_LOGPUSH_JOBS, type ExpectedLogpushJob } from '../logpush-expectation'

// A Supabase double that records nothing: notifyExportFailure is exercised
// elsewhere, and what matters here is that the check reaches a verdict.
const supabase = { from: () => ({ insert: () => Promise.resolve({ error: null }), select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) } as never

const NOW = () => Date.parse('2026-09-09T17:00:00Z')

/**
 * The Better Stack job as narrowed on 2026-09-09 (#1214). Logpush was off on the
 * account from 2026-09-26 to 2026-09-28 (#1613), and the job came back when it
 * was switched on again; Dan chose to keep it, so it is the committed
 * expectation once more. The per-job tests pass it in explicitly so they do not
 * depend on what the committed list holds.
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

  // 2026-09-28: Logpush came back on the account with the Better Stack job, and
  // Dan chose to keep it rather than delete it. It is expected again, on the
  // seven metadata fields it was narrowed to on 2026-09-09.
  it('expects the Better Stack job on its seven metadata fields', () => {
    expect(EXPECTED_LOGPUSH_JOBS).toEqual([JOB])
  })

  it('raises nothing when the live account matches the committed expectation', async () => {
    const r = await checkLogpush({}, supabase, { fetchJobs: async () => liveBody(), now: NOW })
    expect(r.differences).toEqual([])
    expect(r.alerted).toBe(false)
  })

  it('reports Logpush being switched off again, since the expected job cannot be running', async () => {
    const r = await checkLogpush({}, supabase, {
      fetchJobs: async () => ({ success: false, errors: [{ code: 1004, message: 'logpush is not enabled for this account' }] }),
      now: NOW,
    })
    expect(r.alerted).toBe(true)
    expect(r.differences.join(' ')).toContain('1004 logpush is not enabled')
  })

  // The not-enabled refusal reads as zero jobs only while nothing is expected.
  // The Better Stack job is expected today, so these pass an empty expectation
  // in explicitly to keep that rule covered for the day no job is expected.
  describe('when no job is expected', () => {
    const none: readonly ExpectedLogpushJob[] = []
    const notEnabled = () => ({ success: false, errors: [{ code: 1004, message: 'logpush is not enabled for this account' }] })

    it('reads the not-enabled refusal as zero jobs and raises nothing', async () => {
      const r = await checkLogpush({}, supabase, { fetchJobs: async () => notEnabled(), now: NOW, expected: none })
      expect(r.observed.unreadable).toEqual([])
      expect(r.observed.jobs).toEqual([])
      expect(r.differences).toEqual([])
      expect(r.alerted).toBe(false)
    })

    it('alerts when any job appears, since logs would be leaving the account', async () => {
      const r = await checkLogpush({}, supabase, { fetchJobs: async () => liveBody(), now: NOW, expected: none })
      expect(r.alerted).toBe(true)
      expect(r.differences.join(' ')).toContain('unexpected Logpush job')
    })

    it('still reports any other refusal, so the check cannot go quiet by accident', async () => {
      const r = await checkLogpush({}, supabase, {
        fetchJobs: async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }),
        now: NOW,
        expected: none,
      })
      expect(r.alerted).toBe(true)
      expect(r.differences.join(' ')).toContain('10000')
    })
  })
})

/**
 * #835: every Logpush finding arrived headed "found a destination change" with
 * "remove the job, restore the destination, re-enable" as the fix, including an
 * unset token, a refused API call, a stale job and a removed field. A list that
 * could not be read now has its own headline and the token fix.
 */
describe('the Logpush alert headline and fix follow the finding', () => {
  const sent = async (fetchJobs: () => Promise<unknown>) => {
    vi.mocked(notifyExportFailure).mockClear()
    await checkLogpush({}, supabase, { fetchJobs, now: NOW, expected })
    const call = vi.mocked(notifyExportFailure).mock.calls.find((c) => (c[2] as string[]).length > 0)
    return call?.[4] as { headlineVerb?: string; consequence: string; fixHint: string }
  }

  it('gives an unset token its own headline and the token fix', async () => {
    const remedy = await sent(async () => {
      throw new Error('CLOUDFLARE_LOGS_TOKEN is not set on the worker')
    })
    expect(remedy.headlineVerb).not.toMatch(/destination change/)
    expect(remedy.fixHint).toMatch(/wrangler secret put CLOUDFLARE_LOGS_TOKEN/)
    expect(remedy.consequence).not.toMatch(/leaving Pennie right now/)
  })

  it('gives a refused list the same could-not-check headline', async () => {
    const remedy = await sent(async () => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }))
    expect(remedy.headlineVerb).toMatch(/could not check/)
  })

  it('tells a 1004 refusal to switch Logpush back on, not to replace the token', async () => {
    const remedy = await sent(async () => ({
      success: false,
      errors: [{ code: 1004, message: 'logpush is not enabled for this account' }],
    }))
    expect(remedy.fixHint).toMatch(/switch Logpush on/)
  })

  it('does not call a stale job a destination change', async () => {
    const body = liveBody()
    body.result[0].last_complete = '2026-09-01T00:00:00Z'
    const remedy = await sent(async () => body)
    expect(remedy.headlineVerb).not.toMatch(/destination change/)
  })
})
