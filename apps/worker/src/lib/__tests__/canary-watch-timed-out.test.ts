/**
 * Every timed out direct write is read back, beside the day's sample (#2938).
 *
 * The direct Send Salesforce writes report of 2026-10-28 said 1,208 leads were
 * written directly. 9 of them timed out at Bidspoke's 5.25 s limit with no
 * retry, and the report did not say so: its sample of 200 reads a timed out
 * write only by chance, though a write Bidspoke stopped waiting for is the one
 * most likely to be lost. A read by hand found all 9 had landed.
 *
 * So each day every direct write whose step timed out is read back too, first,
 * within the same read budget, and the report says how many timed out and how
 * many of those arrived complete. A timed out write that did not arrive is
 * named as one, and one whose read failed is "could not be checked", never lost
 * (L11). A timed out step recorded when Bidspoke stopped waiting, not when
 * Salesforce answered, and its write can still land after that, so it is never
 * ordered against another run's write by that time.
 *
 * Values are invented, in the shape the native step records for send_salesforce
 * (send-salesforce-canary-watch.test.ts).
 */
import { describe, it, expect } from 'vitest'
import {
  runCanaryWatch,
  INVALID_STATE_SUBJECT,
  SEND_SALESFORCE_SUBJECT,
  ORDER_UNKNOWN_REASONS,
  STEP_COLUMNS,
  SEND_STEP_COLUMNS,
  type CanaryWatchDeps,
  type CanaryWatchMessage,
  type WatchedStep,
} from '../invalid-state-canary-watch'
import { MAIN_FLOW_WORKFLOW_ID } from '../main-flow-port/transform'
import type { SalesforceRead } from '../../engine/inquiry-post'
import type { JobRunEnding } from '../job-run-record'

const APP = 'https://bidspoke.example'
const NOW_MS = Date.parse('2026-10-28T13:00:00Z')
const link = (run: string) => `${APP}/workflows/${MAIN_FLOW_WORKFLOW_ID}?execution=${run}`
const runId = (i: number) => `01a20000-0000-7000-8000-${String(i).padStart(12, '0')}`
const subId = (i: number) => `a04Ui0${String(i).padStart(9, '0')}IAA`
const runLine = (i: number) => `<${link(runId(i))}|Run ${runId(i)}>`

/** The message the engine's step deadline records on a step it stopped (engine/step-timeout.ts), as a row written before the #3047 marker carries it alone. */
const TIMED_OUT_5250 = 'Step timed out after 5250ms (in-flight upstream call canceled via abort signal)'

function sentBody(run: string, step = 'send_salesforce'): Record<string, unknown> {
  return {
    ADV_SO__c: '2',
    XBC_SO__c: '230',
    PDFlow_1__c: link(run),
    VantageScore__c: '702',
    InternalDebtRouting__c: '25000',
    CreditFreeze__c: false,
    PDFlow_4__c: link(run),
    Bidspoke_Write__c: `${run}:${step}:0`,
  }
}

const STARTED = '2026-10-27T15:04:04.000Z'

function directStep(i: number, over: Partial<WatchedStep> = {}): WatchedStep {
  const run = runId(i)
  return {
    execution_id: run,
    step_type: 'salesforce',
    status: 'completed',
    started_at: STARTED,
    completed_at: '2026-10-27T15:04:04.600Z',
    input: { resolved: { operation: 'update', object: 'Submission__c', record_id: subId(i), body: sentBody(run) } },
    output: { status: 204, body: null },
    ...over,
  }
}

/** A step the engine stopped at its 5.25 s deadline: failed, no output, the watch's noted request as its input. */
const timedOutStep = (i: number, over: Partial<WatchedStep> = {}): WatchedStep =>
  directStep(i, { status: 'failed', output: null, completed_at: '2026-10-27T15:04:09.251Z', error_message: TIMED_OUT_5250, ...over })

/** What Salesforce holds when the write landed. */
function landed(i: number): Record<string, unknown> {
  return {
    ...sentBody(runId(i)),
    ADV_SO__c: 2,
    InternalDebtRouting__c: 25000,
    Lead__c: '00QUi00000AAAAAMAA',
    CreatedDate: '2026-10-27T15:00:00.000+0000',
    LastModifiedDate: '2026-10-27T15:04:06.000+0000',
  }
}

/** What Salesforce holds when the write never arrived: the values from before it, no stamp, no run link. */
function neverArrived(i: number): Record<string, unknown> {
  return { ...landed(i), Bidspoke_Write__c: null, PDFlow_1__c: null, PDFlow_4__c: null, ADV_SO__c: 0, LastModifiedDate: '2026-10-27T14:59:00.000+0000' }
}

const ok = (body: unknown): SalesforceRead => ({ kind: 'answer', status: 200, text: JSON.stringify(body) })
const indexOf = (id: string) => Number(id.slice(6, 15))
const landedRecords = (id: string): SalesforceRead => ok(landed(indexOf(id)))
const subOf = (s: WatchedStep) => (s.input as { resolved: { record_id: string } }).resolved.record_id

function deps(over: Partial<CanaryWatchDeps> & { steps?: WatchedStep[]; records?: (id: string) => SalesforceRead; clockStepMs?: number } = {}) {
  const asked: string[] = []
  const posted: CanaryWatchMessage[] = []
  const recorded: JobRunEnding[] = []
  let clock = NOW_MS
  const d: CanaryWatchDeps = {
    now: () => clock,
    appUrl: APP,
    readSteps: async () => over.steps ?? [],
    readRelay: async () => ({ total: 0, sample: [] }),
    readSendSteps: async () => [],
    readRunSubmissions: async () => new Map(),
    salesforce: async () => async (p: string) => {
      asked.push(p)
      clock += over.clockStepMs ?? 0
      if (p.startsWith('/query?q=')) return ok({ totalSize: 0, done: true, records: [] })
      const m = /^\/sobjects\/Submission__c\/([A-Za-z0-9]+)\?fields=/.exec(p)
      return m ? (over.records ?? landedRecords)(m[1]) : { kind: 'answer', status: 404, text: '[{"errorCode":"NOT_FOUND"}]' }
    },
    post: async (m) => {
      posted.push(m)
      return true
    },
    recordRun: async (_s, ending) => {
      recorded.push(ending)
    },
    ...over,
  }
  return { d, asked, posted, recorded }
}

/** A day of `n` direct writes whose steps at `timedOut` timed out. */
const day = (n: number, timedOut: number[]) => Array.from({ length: n }, (_, i) => (timedOut.includes(i) ? timedOutStep(i) : directStep(i)))

/** Nine indices the evenly spread sample of 200 in 1,200 never picks (it picks every sixth, from 0). */
const OFF_SAMPLE = [1, 7, 13, 19, 25, 31, 37, 43, 49]

describe('every timed out direct write is read back, beside the sample (#2938)', () => {
  it('the 2026-10-28 day: 9 of 1,208 timed out, none in the sample, all 9 read back and all arrived complete', async () => {
    const { d, asked, posted, recorded } = deps({ steps: day(1_208, OFF_SAMPLE) })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    // The sample is still the sample: 200, spread evenly, none of the nine among them.
    expect(report.native).toHaveLength(200)
    expect(report.native.some((v) => OFF_SAMPLE.map(runId).includes(v.executionId))).toBe(false)
    expect(report.timedOut?.verdicts).toEqual(OFF_SAMPLE.map((i) => ({ kind: 'landed', executionId: runId(i) })))
    expect(report.timedOut?.limitsMs).toEqual([5_250])
    // One Submission read each: 200 for the sample and 9 more, the nine first.
    expect(asked).toHaveLength(209)
    expect(asked.slice(0, 9).map((p) => p.split('?')[0])).toEqual(OFF_SAMPLE.map((i) => `/sobjects/Submission__c/${subId(i)}`))
    const m = posted[0]
    expect(m.alert).toBe(false)
    expect(m.title).toBe('Direct Send Salesforce writes: all 200 checked arrived complete')
    expect(m.lines[2]).toBe('9 of the 1,208 timed out after 5.25 s without an answer from Salesforce. All 9 were checked, and all 9 arrived complete.')
    expect(recorded[0]).toMatchObject({
      outcome: 'all_landed',
      summary: { native_writes: 1_208, native: 200, timed_out: 9, timed_out_limits_ms: [5_250], timed_out_landed: 9, timed_out_not_landed: 0, timed_out_unchecked: 0, timed_out_resent: 0, timed_out_runs: [] },
    })
  })

  it('a timed out write the sample also picked is read once, and counted in both', async () => {
    const { d, asked } = deps({ steps: day(1_200, [6]) })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(asked).toHaveLength(200)
    expect(report.native[1]).toEqual({ kind: 'landed', executionId: runId(6) })
    expect(report.timedOut?.verdicts).toEqual([{ kind: 'landed', executionId: runId(6) }])
  })

  it('a day with none timed out says so', async () => {
    const { d, posted, recorded } = deps({ steps: day(12, []) })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.timedOut).toEqual({ verdicts: [], limitsMs: [] })
    expect(posted[0].lines[2]).toBe('None of the 12 timed out waiting for Salesforce.')
    expect(recorded[0]).toMatchObject({ summary: { timed_out: 0 } })
  })

  it('a timed out write that did not arrive is named as one, titled, and alerts, never folded into the sample count', async () => {
    const records = (id: string) => (id === subId(7) ? ok(neverArrived(7)) : landedRecords(id))
    const { d, posted, recorded } = deps({ steps: day(1_200, [1, 7]), records })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.timedOut?.verdicts.map((v) => v.kind)).toEqual(['landed', 'not_landed'])
    const m = posted[0]
    expect(m.alert).toBe(true)
    expect(m.title).toBe('Direct Send Salesforce writes: 1 of the 2 writes that timed out did not arrive complete')
    // The sample's own count is unchanged: the lost write was not in it.
    expect(m.lines[1]).toContain('We checked 200 of them, spread over those hours, and all 200 arrived complete.')
    expect(m.lines[2]).toBe('2 of the 1,200 timed out after 5.25 s without an answer from Salesforce. Of those 2, 1 arrived complete and 1 did not arrive complete.')
    expect(m.lines).toContain(
      `${runLine(7)} timed out and did not arrive complete: the Submission does not carry this run's write stamp, the Submission has no Bidspoke run link, and 2 of its fields hold different values from the ones this run sent.`,
    )
    expect(m.fixHint).toContain('If writes are being lost, move Main Flow back to Pipedream')
    expect(recorded[0]).toMatchObject({
      outcome: 'not_all_landed',
      summary: { landed: 200, not_landed: 0, timed_out: 2, timed_out_landed: 1, timed_out_not_landed: 1, timed_out_runs: [{ kind: 'not_landed', executionId: runId(7) }] },
    })
  })

  it('the one write that timed out and did not arrive, in the sample too, is listed once, as timed out', async () => {
    const records = (id: string) => (id === subId(0) ? ok(neverArrived(0)) : landedRecords(id))
    const { d, posted } = deps({ steps: day(12, [0]), records })
    await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    const m = posted[0]
    expect(m.title).toBe('Direct Send Salesforce writes: the one write that timed out did not arrive complete')
    expect(m.lines[2]).toBe('1 of the 12 timed out after 5.25 s without an answer from Salesforce. It did not arrive complete.')
    expect(m.lines.filter((l) => l.includes(runId(0)))).toEqual([
      `${runLine(0)} timed out and did not arrive complete: the Submission does not carry this run's write stamp, the Submission has no Bidspoke run link, and 2 of its fields hold different values from the ones this run sent.`,
    ])
  })

  it('a timed out write whose read-back failed could not be checked, never lost', async () => {
    const records = (id: string): SalesforceRead => (id === subId(7) ? { kind: 'answer', status: 500, text: '[{"errorCode":"UNKNOWN_EXCEPTION"}]' } : landedRecords(id))
    const { d, posted, recorded } = deps({ steps: day(1_200, [7]), records })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.timedOut?.verdicts).toEqual([{ kind: 'unchecked', executionId: runId(7), reason: 'Salesforce answered the Submission read with 500 UNKNOWN_EXCEPTION.' }])
    const m = posted[0]
    expect(m.alert).toBe(true)
    expect(m.title).toBe('Direct Send Salesforce writes: the one write that timed out could not be checked')
    expect(m.lines[2]).toBe('1 of the 1,200 timed out after 5.25 s without an answer from Salesforce. It could not be checked.')
    expect(m.lines).toContain(`${runLine(7)} timed out and could not be checked: Salesforce answered the Submission read with 500 UNKNOWN_EXCEPTION.`)
    const all = [m.title, ...m.lines, m.fixHint ?? ''].join('\n')
    expect(all).not.toMatch(/did not arrive|lost/)
    expect(recorded[0]).toMatchObject({ outcome: 'not_all_landed', summary: { timed_out_not_landed: 0, timed_out_unchecked: 1 } })
  })

  it('Salesforce not answering a timed out write stops the reads, and the rest are could not be checked', async () => {
    const records = (id: string): SalesforceRead => (id === subId(1) ? { kind: 'no_answer', error: 'no answer within 12 s' } : landedRecords(id))
    const { d, asked } = deps({ steps: day(1_200, [1, 7]), records })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(asked).toHaveLength(1)
    expect(report.timedOut?.verdicts.map((v) => v.kind)).toEqual(['unchecked', 'unchecked'])
    expect(report.native.every((v) => v.kind === 'unchecked')).toBe(true)
  })

  it('a timed out step that recorded no request could not be checked', async () => {
    const { d, asked, posted } = deps({ steps: [directStep(0), timedOutStep(1, { input: null })] })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(asked).toHaveLength(1)
    expect(report.timedOut?.verdicts).toEqual([{ kind: 'unchecked', executionId: runId(1), reason: 'The run did not record the Submission it wrote or what it sent.' }])
    expect(posted[0].alert).toBe(true)
  })

  it('a timed out write that arrived only when Bidspoke sent it again says so', async () => {
    const records = (id: string) => (id === subId(7) ? ok({ ...landed(7), Bidspoke_Write__c: `${runId(7)}:send_salesforce:1` }) : landedRecords(id))
    const { d, posted, recorded } = deps({ steps: day(1_200, [1, 7]), records })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.timedOut?.verdicts).toEqual([
      { kind: 'landed', executionId: runId(1) },
      { kind: 'landed', executionId: runId(7), resent: true },
    ])
    expect(posted[0].alert).toBe(false)
    expect(posted[0].lines[2]).toBe('2 of the 1,200 timed out after 5.25 s without an answer from Salesforce. All 2 were checked, and all 2 arrived complete, 1 of them only after Bidspoke sent it again.')
    expect(recorded[0]).toMatchObject({ summary: { timed_out_landed: 2, timed_out_resent: 1 } })
  })

  it('timed out writes are read first, within the same read budget, so a slow day spends it on them', async () => {
    // Each read moves the clock two seconds: 150 reads fill the five minute budget.
    const { d, asked } = deps({ steps: day(300, [299]), clockStepMs: 2_000 })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(asked).toHaveLength(150)
    expect(asked[0].startsWith(`/sobjects/Submission__c/${subId(299)}?`)).toBe(true)
    expect(report.timedOut?.verdicts).toEqual([{ kind: 'landed', executionId: runId(299) }])
    expect(report.native.filter((v) => v.kind === 'unchecked')).toHaveLength(51)
  })

  it("a timed out write is never ordered by when Bidspoke stopped waiting: another run's later write is order unknown, not a replacement", async () => {
    // Run 2 wrote the same Submission 20 s after run 1's step began, after run 1
    // gave up at 5.25 s; run 1's write could still have arrived after run 2's.
    const later = directStep(2, {
      started_at: '2026-10-27T15:04:24.000Z',
      completed_at: '2026-10-27T15:04:24.400Z',
      input: { resolved: { operation: 'update', object: 'Submission__c', record_id: subId(1), body: sentBody(runId(2)) } },
    })
    const records = (id: string) => (id === subId(1) ? ok(landed(2)) : landedRecords(id))
    const { d } = deps({ steps: [timedOutStep(1), later], records })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    const expected = { kind: 'order_unknown', executionId: runId(1), otherExecutionId: runId(2), reason: ORDER_UNKNOWN_REASONS.ownTimedOut }
    expect(report.native[0]).toEqual(expected)
    expect(report.timedOut?.verdicts).toEqual([expected])
  })

  it('the invalid state subject, which reads every write, reads each timed out one once', async () => {
    const ofInvalidState = (s: WatchedStep): WatchedStep => ({ ...s, input: { resolved: { operation: 'update', object: 'Submission__c', record_id: subId(indexOf(subOf(s))), body: sentBody(s.execution_id, 'invalid_state_sf_post') } } })
    const records = (id: string) => ok({ ...landed(indexOf(id)), Bidspoke_Write__c: `${runId(indexOf(id))}:invalid_state_sf_post:0` })
    const { d, asked, posted } = deps({ steps: day(3, [1]).map(ofInvalidState), records })
    const report = await runCanaryWatch(INVALID_STATE_SUBJECT, d)
    expect(asked).toHaveLength(3)
    expect(report.timedOut?.verdicts).toEqual([{ kind: 'landed', executionId: runId(1) }])
    expect(posted[0].lines[2]).toBe('1 of the 3 timed out after 5.25 s without an answer from Salesforce. It arrived complete.')
  })

  it('the step read carries the error a timed out step records', () => {
    expect(STEP_COLUMNS.split(',').map((c) => c.trim())).toContain('error_message')
  })
})

/**
 * Since #3047 the engine marks a step its own deadline stopped (`timeout_kind`
 * 'step', `timed_out_after_ms`), and the report reads that marker. A row with
 * no marker, written before it existed, is still read by its text, which every
 * test above exercises.
 */
describe('a timed out write is found by the marker on its step row (#3047)', () => {
  /** A step the engine marked, whose message is not the one the text fallback reads. */
  const markedTimedOut = (i: number, over: Partial<WatchedStep> = {}) =>
    timedOutStep(i, { error_message: 'Step timed out, worded some new way', timeout_kind: 'step', timed_out_after_ms: 4_500, ...over })

  it('a marked step is read back as timed out, whatever its message says, and its deadline is the marker\'s', async () => {
    const steps = Array.from({ length: 1_200 }, (_, i) => (i === 7 ? markedTimedOut(7) : directStep(i)))
    const { d, asked, posted } = deps({ steps })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.timedOut).toEqual({ verdicts: [{ kind: 'landed', executionId: runId(7) }], limitsMs: [4_500] })
    expect(asked[0].startsWith(`/sobjects/Submission__c/${subId(7)}?`)).toBe(true)
    expect(posted[0].lines[2]).toBe('1 of the 1,200 timed out after 4.5 s without an answer from Salesforce. It arrived complete.')
  })

  it('a child its parallel block stopped waiting for did not time out at its own deadline', async () => {
    const cutOff = timedOutStep(7, { error_message: 'Parallel group timed out after 20000ms before this child completed', timeout_kind: 'parallel_block', timed_out_after_ms: 20_000 })
    const steps = Array.from({ length: 1_200 }, (_, i) => (i === 7 ? cutOff : directStep(i)))
    const { d } = deps({ steps })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.timedOut).toEqual({ verdicts: [], limitsMs: [] })
  })

  it('a marked row is judged by its marker, never by its text', async () => {
    const steps = [directStep(0), timedOutStep(1, { timeout_kind: 'parallel_block', timed_out_after_ms: 20_000 })]
    const { d } = deps({ steps })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.timedOut).toEqual({ verdicts: [], limitsMs: [] })
  })

  it("a marked timed out write is never ordered by when Bidspoke stopped waiting either", async () => {
    const later = directStep(2, {
      started_at: '2026-10-27T15:04:24.000Z',
      completed_at: '2026-10-27T15:04:24.400Z',
      input: { resolved: { operation: 'update', object: 'Submission__c', record_id: subId(1), body: sentBody(runId(2)) } },
    })
    const records = (id: string) => (id === subId(1) ? ok(landed(2)) : landedRecords(id))
    const { d } = deps({ steps: [markedTimedOut(1), later], records })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    const expected = { kind: 'order_unknown', executionId: runId(1), otherExecutionId: runId(2), reason: ORDER_UNKNOWN_REASONS.ownTimedOut }
    expect(report.native[0]).toEqual(expected)
    expect(report.timedOut?.verdicts).toEqual([expected])
  })

  it('every step read carries the marker', () => {
    for (const columns of [STEP_COLUMNS, SEND_STEP_COLUMNS]) {
      expect(columns.split(',').map((c) => c.trim())).toEqual(expect.arrayContaining(['error_message', 'timeout_kind', 'timed_out_after_ms']))
    }
  })
})
