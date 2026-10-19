/**
 * Export-failure alerting (#412): the nightly Snowflake exports accumulate errors
 * into a returned summary instead of throwing, so a Snowflake outage was only
 * console-logged. notifyExportFailure pages every Slack-connected org when an
 * export reports errors (and no-ops on a clean run). Slack is mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../slack', () => ({ sendExportFailureAlert: vi.fn() }))

import {
  notifyExportFailure,
  notifyExportRecovery,
  parsePendingFailure,
  EXPORT_ALERT_PENDING_TTL_SECONDS,
} from '../export-alerts'
import { BACKOFF_STEPS_SECONDS } from '../alert-backoff'
import { sendExportFailureAlert } from '../slack'

function makeSupabase(orgIds: string[]) {
  const chain: unknown = new Proxy({}, {
    get(_, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then')
        return (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: orgIds.map((organization_id) => ({ organization_id })), error: null }).then(resolve)
      return () => chain
    },
  })
  return { from: () => chain } as never
}

function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get: vi.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
    put: vi.fn((key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value)
      return Promise.resolve()
    }),
    delete: vi.fn((key: string) => {
      store.delete(key)
      return Promise.resolve()
    }),
  }
}

describe('notifyExportFailure', () => {
  beforeEach(() => vi.clearAllMocks())

  // THE GUARD (2026-09-10). Omitting the remedy is what produced an alert about
  // a line of code telling the reader to check Snowflake. The parameter is now
  // REQUIRED and a genuine export job says so explicitly, so a new check cannot
  // inherit export wording by saying nothing: `tsc` refuses the omission. A rule
  // each call site must opt into cannot be enforced by a scan (L621), so the
  // type carries it. These two assert the sentinel still means what it says.
  it('classifies the message as an export error when the caller says export-job', async () => {
    await notifyExportFailure(makeSupabase(['org-1']), 'an-export', ['Snowflake 401 unauthorized'], makeKv(), 'export-job')
    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.fixHint).toContain('credential')
    expect(payload.headlineVerb).toBeUndefined()
  })

  it('does not classify the message when the caller supplied its own wording', async () => {
    await notifyExportFailure(makeSupabase(['org-1']), 'a-check', ['Snowflake 401 unauthorized'], makeKv(), {
      consequence: 'two settings disagree.',
      fixHint: 'change one of them.',
    })
    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.fixHint).toBe('change one of them.')
    expect(payload.consequence).toBe('two settings disagree.')
  })

  it('carries the caller\'s headline verb and item noun through to the alert', async () => {
    await notifyExportFailure(makeSupabase(['org-1']), 'a-check', ['one finding'], makeKv(), {
      consequence: 'c',
      fixHint: 'f',
      headlineVerb: 'found something to look at',
      itemNoun: { one: 'finding', many: 'findings' },
    })
    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.headlineVerb).toBe('found something to look at')
    expect(payload.itemNoun).toEqual({ one: 'finding', many: 'findings' })
  })

  it('leaves the headline and noun unset when the caller says nothing, so the failure wording stands', async () => {
    // Deliberately NOT a transient message: a lone transient failure is held
    // back by the grace and sends nothing, so the assertion would read no call
    // as a passing default (L98).
    await notifyExportFailure(makeSupabase(['org-1']), 'an-export', ['an unrecognised problem'], makeKv(), 'export-job')
    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.headlineVerb).toBeUndefined()
    expect(payload.itemNoun).toBeUndefined()
  })

  it('carries a remedy the caller supplies instead of classifying the message as an export error', async () => {
    // Every scheduled check borrows this alerter, and one whose message the
    // classifier does not recognise used to be told "rows were not exported,
    // check Snowflake", whatever it was actually about. On 2026-09-06 the
    // Tripoint pricing check paged with exactly that text under a pricing
    // disagreement, and Dan asked what he was supposed to do about it.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const remedy = {
      consequence: 'Bidspoke and Salesforce disagree on a Tripoint price; nothing was exported or retried:',
      fixHint: 'Open Partners, Tripoint, and set the tier to what the Salesforce formula books.',
    }

    await notifyExportFailure(makeSupabase(['org-1']), 'tripoint-pricing-drift', ['Bidspoke prices the high band at 0.0013 of debt, Salesforce books 0.0012'], undefined, remedy)

    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.consequence).toBe(remedy.consequence)
    expect(payload.fixHint).toBe(remedy.fixHint)
    expect(payload.fixHint).not.toContain('Snowflake')
  })

  it('passes a titled remedy through as its title, context and fix, with no export wording', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const remedy = { title: 'Tripoint rate mismatch', context: 'Salesforce changed Sep 30.', fixHint: 'update whichever is wrong.' }

    await notifyExportFailure(makeSupabase(['org-1']), 'tripoint-pricing-drift', ['x'], undefined, remedy)

    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.title).toBe(remedy.title)
    expect(payload.context).toBe(remedy.context)
    expect(payload.fixHint).toBe(remedy.fixHint)
    expect(payload.consequence ?? '').not.toMatch(/exported|Snowflake/i)
  })

  it('does nothing (no Slack lookup) when there are no errors', async () => {
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings export', [], undefined, 'export-job')
    expect(from).not.toHaveBeenCalled()
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
  })

  it('alerts each Slack-connected org when an export reports errors', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1', 'org-2']), 'Lead sightings export', ['Snowflake 503'], undefined, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(2)
    const [, orgId, channel, payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(orgId).toBe('org-1')
    expect(channel).toBeNull()
    expect(payload).toMatchObject({ jobName: 'Lead sightings export', errors: ['Snowflake 503'] })
  })

  it('passes a fix hint derived from the actual error class (#542)', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', [
      'sightings export: canceling statement due to statement timeout (57014)',
    ], undefined, 'export-job')
    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    // A DB congestion error must not tell the reader to go look at Snowflake.
    expect(payload.fixHint).toBeDefined()
    expect(payload.fixHint).not.toContain('Snowflake availability')
    expect(payload.fixHint?.toLowerCase()).toContain('congestion')
  })

  it('de-duplicates org ids', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1', 'org-1']), 'x', ['boom'], undefined, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('suppresses repeat alerts for the same job while cooldown state is set', async () => {
    const kv = makeKv({ 'export-alert:Lead sightings export:cooldown': '1' })
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings export', ['still broken'], kv, 'export-job')
    expect(from).not.toHaveBeenCalled()
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
  })

  it('alerts and sets the first backoff interval on the first PERMANENT failure when kv is provided', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(
      makeSupabase(['org-1']),
      'Lead sightings export',
      ['sightings export: permission denied for table lead_sightings (42501)'],
      kv,
      'export-job',
    )
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    // The gap lengthens on each reminder while the failure stands (#1334); this
    // is the first, so it is the shortest step.
    expect(kv.put).toHaveBeenCalledWith(
      'export-alert:Lead sightings export:cooldown',
      '1',
      { expirationTtl: BACKOFF_STEPS_SECONDS[0] },
    )
  })

  it('does not set cooldown state when the alert failed to deliver', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(false)
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', ['boom nobody recognises'], kv, 'export-job')
    expect(kv.put).not.toHaveBeenCalled()
  })

  it('clears cooldown state on a successful run when kv is provided', async () => {
    const kv = makeKv({ 'export-alert:Lead sightings export:cooldown': '1' })
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings export', [], kv, 'export-job')
    expect(from).not.toHaveBeenCalled()
    // Both halves: a cooldown left behind without its condition would restart
    // the reminder schedule mid-way through the next occurrence.
    expect(kv.delete).toHaveBeenCalledWith('export-alert:Lead sightings export:cooldown')
    expect(kv.delete).toHaveBeenCalledWith('export-alert:Lead sightings export:condition')
  })
})

/**
 * Transient-failure grace (2026-07-24): a lone connectivity blip (Cloudflare 522,
 * Snowflake 503, a statement timeout) self-heals on the next scheduled run, because
 * every run automatically re-attempts whatever the failed run left behind. Alerting
 * on the first one is pure noise, so a transient failure is held silently in KV and
 * only pages when the NEXT run fails too. Permanent errors (permissions, schema,
 * auth) and unrecognised errors still page immediately: a retry cannot fix those.
 */
describe('notifyExportFailure transient grace (alert only on two consecutive failed runs)', () => {
  beforeEach(() => vi.clearAllMocks())
  const TRANSIENT = ['sightings purge: error code: 522']
  const PENDING_KEY = 'export-alert-pending:Lead sightings purge'

  it('stays silent on the first transient failure and records a pending marker', async () => {
    const kv = makeKv()
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings purge', TRANSIENT, kv, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
    expect(from).not.toHaveBeenCalled()
    // Asserted through the reader rather than on the raw string, so the marker's
    // encoding can carry more than a timestamp (#1441) without this test
    // becoming a claim about JSON.
    const [key, written, opts] = kv.put.mock.calls[0]
    expect(key).toBe(PENDING_KEY)
    expect(parsePendingFailure(written)).toEqual({
      since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      recovered: false,
    })
    expect(opts).toEqual({ expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS })
  })

  it('alerts on the second consecutive transient failure and says when the failures started', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-07-24T11:48:00.000Z' })
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', TRANSIENT, kv, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload).toMatchObject({ jobName: 'Lead sightings purge', failingSince: '2026-07-24T11:48:00.000Z' })
  })

  it('refreshes the pending marker with the ORIGINAL first-failure time on repeat failures', async () => {
    // During a long outage the marker must not expire mid-outage (that would
    // silently restart the grace period), and the alert's "failing since" must
    // keep pointing at the first failure, not the latest one.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-07-24T11:48:00.000Z' })
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', TRANSIENT, kv, 'export-job')
    const [key, written, opts] = kv.put.mock.calls[0]
    expect(key).toBe(PENDING_KEY)
    expect(parsePendingFailure(written)).toEqual({ since: '2026-07-24T11:48:00.000Z', recovered: false })
    expect(opts).toEqual({ expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS })
  })

  it('keeps and stamps the grace marker on a clean run, not deletes it, so an every-other-run failure stays pageable (#1445)', async () => {
    // Deleting the marker on a success was the #1445 bug: a job that fails every
    // other run re-armed the grace on each clean run and never reached the second
    // failure that pages. The marker is now KEPT and stamped as interrupted, the
    // same as notifyExportRecovery, so every clean-run caller is fixed at once.
    const kv = makeKv({ [PENDING_KEY]: '2026-07-24T11:48:00.000Z' })
    await notifyExportFailure({ from: vi.fn() } as never, 'Lead sightings purge', [], kv, 'export-job')
    expect(kv.delete).not.toHaveBeenCalledWith(PENDING_KEY)
    expect(parsePendingFailure(await kv.get(PENDING_KEY))).toEqual({
      since: '2026-07-24T11:48:00.000Z',
      recovered: true,
    })
  })

  it('pages on a failure that follows a clean run, so an every-other-run failure is not silent (#1445)', async () => {
    // fail, succeed, fail, succeed never paged before: each clean run deleted the
    // marker the second consecutive failure depended on. Driven entirely through
    // the public failure notifier (the clean run is notifyExportFailure with []),
    // because that is what every export and purge job calls.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    const JOB = 'Lead sightings purge'

    // fail 1: held silently by the transient grace.
    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()

    // clean run: must not erase the record that a failure just happened.
    await notifyExportFailure(makeSupabase(['org-1']), JOB, [], kv, 'export-job')

    // fail 2, one clean run later: the every-other-run pattern must now page.
    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    // A run succeeded in between, so it is intermittent, not a standing outage.
    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.failingSince).toBeUndefined()
    expect(payload.intermittentSince).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
  })

  it('alerts immediately on a permanent error even with no pending marker', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(
      makeSupabase(['org-1']),
      'Lead sightings purge',
      ['sightings purge: permission denied for table lead_sightings (42501)'],
      kv,
      'export-job',
    )
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('alerts immediately when a transient error is mixed with a permanent one', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(
      makeSupabase(['org-1']),
      'Lead sightings purge',
      ['sightings purge: error code: 522', 'sightings purge: permission denied for table lead_sightings (42501)'],
      kv,
      'export-job',
    )
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('alerts immediately on an unrecognised error (fail loud when we cannot tell)', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', ['something nobody has seen'], kv, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('alerts immediately when no KV is available (no store to hold the grace state)', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings purge', TRANSIENT, undefined, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('stays quiet during the post-alert cooldown but keeps the pending marker fresh', async () => {
    const kv = makeKv({
      [PENDING_KEY]: '2026-07-24T11:48:00.000Z',
      'export-alert:Lead sightings purge:cooldown': '1',
    })
    const from = vi.fn()
    await notifyExportFailure({ from } as never, 'Lead sightings purge', TRANSIENT, kv, 'export-job')
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
    const [key, written, opts] = kv.put.mock.calls[0]
    expect(key).toBe(PENDING_KEY)
    expect(parsePendingFailure(written)).toEqual({ since: '2026-07-24T11:48:00.000Z', recovered: false })
    expect(opts).toEqual({ expirationTtl: EXPORT_ALERT_PENDING_TTL_SECONDS })
  })
})

describe('the consequence sentence travels with the classification (#1180)', () => {
  beforeEach(() => vi.clearAllMocks())

  const KILLED =
    'the previous run has held the lock for 60 minutes, past its own deadline and the 5 minute grace, ' +
    'so it was killed rather than still working. This run is proceeding; the work its predecessor did not finish is simply unarchived.'

  it('hands the killed-run consequence and hint to the alert', async () => {
    // Derived once, next to the hint, from the same classification. Left to the
    // alert renderer, the sentence is chosen by job name alone and says rows were
    // not exported for a job that exports nothing.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'execution-archive-killed', [KILLED], undefined, 'export-job')

    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.consequence).toBeDefined()
    expect(payload.consequence).not.toContain('not exported')
    expect(payload.fixHint).not.toContain('Snowflake availability')
  })

  it('hands no consequence for an ordinary export failure, so the renderer keeps its default', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    await notifyExportFailure(makeSupabase(['org-1']), 'Lead sightings export', ['Snowflake 401: JWT token is invalid'], undefined, 'export-job')

    const payload = vi.mocked(sendExportFailureAlert).mock.calls[0][3]
    expect(payload.consequence).toBeUndefined()
  })
})

/**
 * A job that reports its health separately from its failures (#1441).
 *
 * A healthy run says so without erasing the history: the standing condition
 * clears, which stops the escalating reminders, and the grace marker is kept but
 * stamped as interrupted, which keeps the alternating pattern pageable while
 * stopping the message claiming an outage that ended hours ago. The archive
 * reports this through notifyExportRecovery because it computes its failures and
 * recoveries from different predicates; since #1445 notifyExportFailure with an
 * empty errors array does the same thing rather than deleting the marker.
 *
 * The cost of the old delete-on-success was measured on 2026-09-22: two
 * unrelated timeouts 22 successful runs apart were reported as one incident,
 * `Failing since Sep 21, 12:26 PM EDT`, `the second consecutive failed run`, and
 * `standing for ~21h`. All of it untrue.
 */
describe('notifyExportRecovery (a healthy run reports itself) (#1441)', () => {
  beforeEach(() => vi.clearAllMocks())
  const JOB = 'execution-archive-ingest'
  const PENDING_KEY = `export-alert-pending:${JOB}`
  const CONDITION_KEY = `export-alert:${JOB}:condition`
  const COOLDOWN_KEY = `export-alert:${JOB}:cooldown`
  const TRANSIENT = ['archive run stopped on send-failed: Snowflake 524: error code: 524']

  it('clears the standing condition, so the reminders stop and the schedule resets', async () => {
    const kv = makeKv({ [CONDITION_KEY]: JSON.stringify({ since: '2026-09-21T16:26:00.000Z', alerts: 2 }) })

    await notifyExportRecovery(kv, JOB, Date.parse('2026-09-22T12:00:00.000Z'))

    expect(kv.delete).toHaveBeenCalledWith(CONDITION_KEY)
    expect(kv.delete).toHaveBeenCalledWith(COOLDOWN_KEY)
  })

  it('keeps the grace marker rather than deleting it, so an alternating job still pages', async () => {
    const kv = makeKv({ [PENDING_KEY]: '2026-09-21T16:26:00.000Z' })

    await notifyExportRecovery(kv, JOB, Date.parse('2026-09-22T12:00:00.000Z'))

    expect(kv.delete).not.toHaveBeenCalledWith(PENDING_KEY)
    expect(await kv.get(PENDING_KEY)).toContain('2026-09-21T16:26:00.000Z')
  })

  it('does nothing when the job has no failure recorded, so a healthy job writes nothing', async () => {
    const kv = makeKv()

    await notifyExportRecovery(kv, JOB, Date.parse('2026-09-22T12:00:00.000Z'))

    expect(kv.put).not.toHaveBeenCalled()
  })

  it('still pages when a failure follows a recovery, which is the pattern the grace protects', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-09-21T16:26:00.000Z' })
    await notifyExportRecovery(kv, JOB, Date.parse('2026-09-22T12:00:00.000Z'))
    vi.clearAllMocks()

    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')

    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
  })

  it('does not claim a standing failure when successful runs came in between', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-09-21T16:26:00.000Z' })
    await notifyExportRecovery(kv, JOB, Date.parse('2026-09-22T12:00:00.000Z'))

    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')

    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.failingSince).toBeUndefined()
    expect(payload.intermittentSince).toBe('2026-09-21T16:26:00.000Z')
  })

  it('still claims a standing failure when no run succeeded in between', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-09-21T16:26:00.000Z' })

    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')

    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.failingSince).toBe('2026-09-21T16:26:00.000Z')
    expect(payload.intermittentSince).toBeUndefined()
  })

  it('reads a marker written before this change, which is a bare timestamp, as a standing failure', async () => {
    // There is one of these in production KV right now, so the reader has to
    // accept both shapes or the first failure after the deploy is misread.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-09-21T16:26:00.000Z' })

    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')

    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.failingSince).toBe('2026-09-21T16:26:00.000Z')
  })

  it('still pages, without a date, when the stored time will not parse (L50)', async () => {
    // Every sentence built from this runs through a date formatter, which
    // renders an unreadable value as the words Invalid Date rather than
    // refusing. A failure demonstrably happened, so the alert stands and only
    // the claim about when it started is dropped.
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: JSON.stringify({ since: 'yesterday afternoon', recovered: false }) })

    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')

    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.failingSince).toBeUndefined()
    expect(payload.intermittentSince).toBeUndefined()
  })

  it('keeps the original first-failure time on the first failure after a recovery', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: '2026-09-21T16:26:00.000Z' })
    await notifyExportRecovery(kv, JOB, Date.parse('2026-09-22T12:00:00.000Z'))

    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')

    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.intermittentSince).toBe('2026-09-21T16:26:00.000Z')
  })

  it('starts a fresh standing streak after an intermittent failure, so a continuing outage stops reading as intermittent (#1445)', async () => {
    // The #1445 fix keeps the grace marker across a clean run. Without this, a
    // sustained outage that begins after a recovery would keep recovered:true
    // and every alert would say "intermittent since <an old time>" for the whole
    // outage, never "failing since", which is a false claim during a run of
    // consecutive failures (L11).
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv({ [PENDING_KEY]: JSON.stringify({ since: '2026-09-21T16:26:00.000Z', recovered: true }) })

    await notifyExportFailure(makeSupabase(['org-1']), JOB, TRANSIENT, kv, 'export-job')

    // Paged as intermittent for the failure that followed the recovery...
    const [, , , payload] = vi.mocked(sendExportFailureAlert).mock.calls[0]
    expect(payload.intermittentSince).toBe('2026-09-21T16:26:00.000Z')
    // ...and the marker now holds a fresh standing streak (recovered:false, a new
    // start time), so the next consecutive failure reports "failing since".
    const stored = parsePendingFailure(await kv.get(PENDING_KEY))
    expect(stored?.recovered).toBe(false)
    expect(stored?.since).not.toBe('2026-09-21T16:26:00.000Z')
  })
})

// #2311: on 2026-10-17 at 09:00 UTC the hourly matrix audit's Salesforce token
// fetch took longer than its 10 s deadline once, the next runs were clean, and
// the first failure paged anyway: the classifier knew no Salesforce wording, so
// the timeout was 'unknown', which pages at once. The message below is the one
// that paged, word for word.
describe('a lone Salesforce token timeout waits for the next run (#2311)', () => {
  beforeEach(() => vi.clearAllMocks())

  const PAGED = 'the bid matrix audit failed: Salesforce token fetch timed out after 10000 ms'
  const remedy = { consequence: 'the audit did not complete:', fixHint: 'read the line above.' }

  it('holds the first one and pages on the second in a row', async () => {
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'sf-matrix-audit', [PAGED], kv, remedy)
    expect(sendExportFailureAlert).not.toHaveBeenCalled()

    await notifyExportFailure(makeSupabase(['org-1']), 'sf-matrix-audit', [PAGED], kv, remedy)
    expect(sendExportFailureAlert).toHaveBeenCalledTimes(1)
  })

  it('still pages at once when Salesforce refuses the login, which no retry fixes', async () => {
    await notifyExportFailure(
      makeSupabase(['org-1']),
      'sf-matrix-audit',
      ['the bid matrix audit failed: Salesforce token fetch failed (400): {"error":"invalid_client","error_description":"invalid client credentials"}'],
      makeKv(),
      remedy,
    )
    expect(sendExportFailureAlert).toHaveBeenCalledTimes(1)
  })
})

/**
 * #2506: the ops tick report check holds a problem until three ticks in a row
 * report it, then calls the alerter. The alerter's own grace counts calls, and
 * that check reads one kept report every minute, so its grace would hold the
 * third tick once more without ever measuring another tick. A caller that held
 * the repeats itself says so, and the first transient failure then pages.
 */
describe('notifyExportFailure for a caller that holds repeats itself', () => {
  beforeEach(() => vi.clearAllMocks())
  const TRANSIENT = ['The run_expiry sweep failed: error code: 522.']
  const titled = { title: 'The ops minute cron reported a problem' }

  it('pages the first transient failure at once and writes no grace marker', async () => {
    vi.mocked(sendExportFailureAlert).mockResolvedValue(true)
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'ops-tick', TRANSIENT, kv, titled, Date.now(), { repeatsHeldByCaller: true })
    expect(vi.mocked(sendExportFailureAlert)).toHaveBeenCalledTimes(1)
    expect(kv.put.mock.calls.map(([key]) => key)).not.toContain('export-alert-pending:ops-tick')
  })

  it('still holds the first transient failure for a caller that does not say so', async () => {
    const kv = makeKv()
    await notifyExportFailure(makeSupabase(['org-1']), 'ops-tick', TRANSIENT, kv, titled, Date.now())
    expect(vi.mocked(sendExportFailureAlert)).not.toHaveBeenCalled()
  })
})
