/**
 * The daily read-back of Main Flow's native invalid state writes (#2173, the
 * phase 4 canary of #1680).
 *
 * Drives the real check against a fake database read and a fake Salesforce that
 * answers by path, so it sees the reads it actually makes and the message it
 * actually builds. The clock is injected (L524, L290): nothing waits.
 *
 * The body's key set is the one the native step sends, measured on 2026-10-16
 * from the 51 relay era bodies of `invalid_state_sf_post` (16 keys, the same set
 * on every one), after the port's omit, rename and inject: `executionId` and
 * `submissionId` dropped, `UUID` and `leadUUID` renamed, `PDFlow_4__c` and the
 * write stamp added. Every value is invented.
 */
import { describe, it, expect } from 'vitest'
import {
  runInvalidStateWatch,
  canaryWatchMessage,
  canaryWatchWindow,
  INVALID_STATE_WATCH_JOB,
  WATCHED_STEP,
  type CanaryWatchDeps,
  type CanaryWatchReport,
  type WatchedStep,
} from '../invalid-state-canary-watch'
import { CRON_JOBS, evaluateHeartbeat } from '../cron-heartbeat'
import { MAIN_FLOW_WORKFLOW_ID } from '../main-flow-port/transform'
import type { SalesforceRead } from '../../engine/inquiry-post'

const APP = 'https://bidspoke.example'
// 13:00 UTC on 2026-10-18, when the daily batch runs.
const NOW_MS = Date.parse('2026-10-18T13:00:00Z')
const RUN_A = '01a14600-0000-7000-8000-00000000000a'
const RUN_B = '01a14600-0000-7000-8000-00000000000b'
const SUB_A = 'a04Ui00000AAAAAIAA'
const SUB_B = 'a04Ui00000BBBBBIAB'
const LEAD_A = '00QUi00000AAAAAMAA'
const LEAD_B = '00QUi00000BBBBBMAB'

const link = (run: string) => `${APP}/workflows/${MAIN_FLOW_WORKFLOW_ID}?execution=${run}`
const marker = (run: string, attempt = 0) => `${run}:${WATCHED_STEP}:${attempt}`

function sentBody(run: string): Record<string, unknown> {
  return {
    ADV_SO__c: 512,
    Credit_Pull_Result_ES__c: 'Success',
    EQXCreditPullStatus__c: 'Success',
    External_Exchange_Status__c: 'Pending',
    External_Partner_Name__c: 'Engine',
    External_Routing_Code__c: 1,
    External_Timestamp__c: '2026-10-17T15:04:05.000Z',
    LeadSaleType__c: 'Offer Wall',
    Engine_Lead_UUID_SO__c: `lead-uuid-${run.slice(-1)}`,
    PD_Completed_Timestamp__c: '2026-10-17T15:04:05.000Z',
    PDFlow_1__c: 'https://pipedream.example/run/1',
    Engine_UUID_SO__c: `uuid-${run.slice(-1)}`,
    VantageScore__c: 640,
    XBC_SO__c: '3',
    PDFlow_4__c: link(run),
    Bidspoke_Write__c: marker(run),
  }
}

function nativeStep(run: string, sub: string, over: Partial<WatchedStep> = {}): WatchedStep {
  return {
    execution_id: run,
    step_type: 'salesforce',
    status: 'completed',
    input: { resolved: { operation: 'update', object: 'Submission__c', record_id: sub, body: sentBody(run) } },
    output: { status: 204, body: null },
    ...over,
  }
}

/** What Salesforce holds when the write landed: every field sent, as Salesforce spells it back. */
function landedSubmission(run: string, lead: string): Record<string, unknown> {
  const b = sentBody(run)
  return {
    ...b,
    // Salesforce answers in its own types and time format, which must still compare equal.
    External_Routing_Code__c: '1',
    External_Timestamp__c: '2026-10-17T15:04:05.000+0000',
    PD_Completed_Timestamp__c: '2026-10-17T15:04:05.000+0000',
    XBC_SO__c: 3,
    Lead__c: lead,
    attributes: { type: 'Submission__c' },
  }
}

function landedLead(run: string): Record<string, unknown> {
  return { EngineUUID__c: `uuid-${run.slice(-1)}`, EngineLeadUUID__c: `lead-uuid-${run.slice(-1)}` }
}

type Answer = SalesforceRead
const ok = (body: unknown): Answer => ({ kind: 'answer', status: 200, text: JSON.stringify(body) })

/** A Salesforce that answers by record, and records every path it was asked for. */
function fakeSalesforce(records: Record<string, Answer>) {
  const asked: string[] = []
  const read = async (p: string): Promise<SalesforceRead> => {
    asked.push(p)
    const m = /^\/sobjects\/(Submission__c|Lead)\/([A-Za-z0-9]+)\?fields=/.exec(p)
    if (!m) return { kind: 'answer', status: 400, text: '[{"errorCode":"MALFORMED_QUERY"}]' }
    return records[m[2]] ?? { kind: 'answer', status: 404, text: '[{"errorCode":"NOT_FOUND"}]' }
  }
  return { read, asked }
}

function deps(over: Partial<CanaryWatchDeps> & { steps?: WatchedStep[]; records?: Record<string, Answer> } = {}) {
  const sf = fakeSalesforce(over.records ?? {})
  const posted: ReturnType<typeof canaryWatchMessage>[] = []
  const windows: Array<[string, string]> = []
  const d: CanaryWatchDeps = {
    now: () => NOW_MS,
    appUrl: APP,
    readSteps: async (from, to) => {
      windows.push([from, to])
      return over.steps ?? []
    },
    countRelay: async () => ({ total: 3360, accepted: 3360 }),
    salesforce: async () => sf.read,
    post: async (m) => {
      posted.push(m)
      return true
    },
    ...over,
  }
  return { d, posted, asked: sf.asked, windows }
}

describe('the invalid state canary watch', () => {
  it('reads the 24 hours that end ten minutes before the run, so consecutive days tile and a run still writing its steps is read tomorrow', async () => {
    expect(canaryWatchWindow(NOW_MS)).toEqual({ from: '2026-10-17T12:50:00.000Z', to: '2026-10-18T12:50:00.000Z' })
    const { d, windows } = deps()
    await runInvalidStateWatch(d)
    expect(windows).toEqual([['2026-10-17T12:50:00.000Z', '2026-10-18T12:50:00.000Z']])
  })

  it('a run that landed: its Submission holds the run link, its own stamp and every field sent, and its Lead the same Engine ids', async () => {
    const { d, posted, asked } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([{ kind: 'landed', executionId: RUN_A }])
    // One read of the Submission naming every field the run sent, then its Lead.
    expect(asked).toHaveLength(2)
    const subFields = new URL(`https://x${asked[0]}`).searchParams.get('fields')!.split(',')
    for (const f of [...Object.keys(sentBody(RUN_A)), 'Lead__c', 'Engine_UUID_SO__c', 'Engine_Lead_UUID_SO__c']) expect(subFields).toContain(f)
    expect(asked[0].startsWith(`/sobjects/Submission__c/${SUB_A}?`)).toBe(true)
    expect(asked[1]).toBe(`/sobjects/Lead/${LEAD_A}?fields=EngineUUID__c,EngineLeadUUID__c`)
    expect(posted).toHaveLength(1)
    expect(posted[0].alert).toBe(false)
    expect(posted[0].title).toBe('The invalid state write landed in Salesforce')
  })

  it('a landed resend from the read-back (attempt 1) still counts as this run landing', async () => {
    const held = { ...landedSubmission(RUN_A, LEAD_A), Bidspoke_Write__c: marker(RUN_A, 1) }
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A, { status: 'failed' })],
      records: { [SUB_A]: ok(held), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([{ kind: 'landed', executionId: RUN_A }])
    expect(report.nativeCompleted).toBe(0)
  })

  it('a missing PDFlow_4__c is a run that did not land fully, and the message reads as an alert naming the run', async () => {
    const { d, posted } = deps({
      steps: [nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B)],
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_4__c: null }),
        [LEAD_A]: ok(landedLead(RUN_A)),
        [SUB_B]: ok(landedSubmission(RUN_B, LEAD_B)),
        [LEAD_B]: ok(landedLead(RUN_B)),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ['The Submission has no Bidspoke run link.'] })
    expect(report.native[1]).toEqual({ kind: 'landed', executionId: RUN_B })
    const m = posted[0]
    expect(m.alert).toBe(true)
    expect(m.title).toBe('1 of 2 invalid state writes did not land in Salesforce')
    expect(m.lines.join('\n')).toContain(`<${link(RUN_A)}|Run ${RUN_A}>: The Submission has no Bidspoke run link.`)
    expect(m.fixHint).toBeTruthy()
  })

  it("another run's link in PDFlow_4__c is named as such", async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_4__c: link(RUN_B) }), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ["The Submission's Bidspoke run link is not this run's."] })
  })

  it('a mismatched field is named by field, never by value', async () => {
    const { d, posted } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), VantageScore__c: 701, LeadSaleType__c: null }),
        [LEAD_A]: ok(landedLead(RUN_A)),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({
      kind: 'not_landed',
      executionId: RUN_A,
      problems: ['2 fields hold a different value from the one the run sent: LeadSaleType__c and VantageScore__c.'],
    })
    const text = JSON.stringify(posted[0])
    expect(text).not.toContain('701')
    expect(text).not.toContain('Offer Wall')
    expect(text).not.toContain('uuid-a')
  })

  it("a later write's stamp is said, so a difference it caused is not read as this run's write failing silently", async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), Bidspoke_Write__c: `${RUN_B}:send_salesforce:0`, VantageScore__c: 701 }),
        [LEAD_A]: ok(landedLead(RUN_A)),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({
      kind: 'not_landed',
      executionId: RUN_A,
      problems: [
        `Another write has stamped the Submission since (run ${RUN_B}), so a difference below may be that write's.`,
        '1 field holds a different value from the one the run sent: VantageScore__c.',
      ],
    })
  })

  it("a Lead whose Engine UUID differs from the Submission's is a run that did not land fully", async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)), [LEAD_A]: ok({ ...landedLead(RUN_A), EngineUUID__c: null }) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ["The Lead's Engine UUID differs from the Submission's."] })
  })

  it('a Submission with no Lead is said, because the Lead check could not be met', async () => {
    const { d } = deps({ steps: [nativeStep(RUN_A, SUB_A)], records: { [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), Lead__c: null }) } })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ['The Submission has no Lead, so its Engine ids reached no Lead.'] })
  })

  it('a Submission that does not exist did not land', async () => {
    const { d } = deps({ steps: [nativeStep(RUN_A, SUB_A)] })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ['The Submission does not exist in Salesforce.'] })
  })

  it('a Salesforce read failure is "could not check", never "landed", and stops the reads so the rest say why', async () => {
    const { d, posted, asked } = deps({
      steps: [nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B)],
      records: { [SUB_A]: { kind: 'no_answer', error: 'no answer within 12 s' }, [SUB_B]: ok(landedSubmission(RUN_B, LEAD_B)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([
      { kind: 'unchecked', executionId: RUN_A, reason: 'Salesforce did not answer the Submission read (no answer within 12 s).' },
      { kind: 'unchecked', executionId: RUN_B, reason: 'Salesforce stopped answering earlier in this check.' },
    ])
    expect(asked).toHaveLength(1)
    const m = posted[0]
    expect(m.alert).toBe(true)
    expect(m.title).toBe('2 of 2 invalid state writes could not be checked in Salesforce')
    expect(m.lines.join('\n')).toContain(`<${link(RUN_A)}|Run ${RUN_A}> could not be checked: Salesforce did not answer the Submission read (no answer within 12 s).`)
  })

  it('a refused login names itself', async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: { kind: 'answer', status: 401, text: '[{"errorCode":"INVALID_SESSION_ID"}]' } },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'unchecked', executionId: RUN_A, reason: 'Salesforce refused the login (401 INVALID_SESSION_ID).' })
  })

  it('Salesforce settings that cannot be loaded leave every run unchecked, by name', async () => {
    const { d } = deps({ steps: [nativeStep(RUN_A, SUB_A)], salesforce: async () => { throw new Error('SALESFORCE_INSTANCE_URL must be set') } })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'unchecked', executionId: RUN_A, reason: 'Salesforce settings could not be loaded (SALESFORCE_INSTANCE_URL must be set).' })
  })

  it('a run that did not record what it sent cannot be checked', async () => {
    const { d } = deps({ steps: [nativeStep(RUN_A, SUB_A, { input: null })] })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'unchecked', executionId: RUN_A, reason: 'The run did not record the Submission it wrote or what it sent.' })
  })

  it('counts runs whose write was skipped as having nothing to write, reads nothing for them, and says so', async () => {
    const skipped = nativeStep(RUN_B, SUB_B, { output: { skipped: true, skip_reason: 'nothing_to_write' } })
    const { d, posted, asked } = deps({
      steps: [nativeStep(RUN_A, SUB_A), skipped],
      records: { [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.skipped).toEqual([{ executionId: RUN_B, reason: 'nothing_to_write' }])
    expect(asked.some((p) => p.includes(SUB_B))).toBe(false)
    expect(posted[0].lines.join('\n')).toContain('1 more run was skipped because the Engine sent nothing to write, so nothing was sent.')
  })

  it('zero runs is said plainly, as a report, not an alert', async () => {
    const { d, posted } = deps({ steps: [] })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([])
    expect(posted[0].alert).toBe(false)
    expect(posted[0].title).toBe('No invalid state writes to check yesterday')
    expect(posted[0].lines[0]).toBe('Zero Main Flow runs wrote an invalid state outcome straight to Salesforce from Oct 17, 8:50 AM EDT to Oct 18, 8:50 AM EDT.')
  })

  // #2312: the first report (2026-10-17) said Main Flow had left the direct write
  // because five relay posts sat in its window, when all five came before version
  // 172 went live and both posts after it went direct. Whether Main Flow is on the
  // relay is a question about the LAST post, never about any post.
  const relayStep = (run: string): WatchedStep => ({ execution_id: run, step_type: 'webhook', status: 'completed', input: {}, output: { status: 200 } })
  const landedA = { [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)), [LEAD_A]: ok(landedLead(RUN_A)), [SUB_B]: ok(landedSubmission(RUN_B, LEAD_B)), [LEAD_B]: ok(landedLead(RUN_B)) }

  it('relay posts from before the switch are said as such, and the day stays a report (the 2026-10-17 shape)', async () => {
    const before = ['r1', 'r2', 'r3', 'r4', 'r5'].map(relayStep)
    const { d, posted } = deps({ steps: [...before, nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B)], records: landedA })
    const report = await runInvalidStateWatch(d)
    expect(report.relayInvalidState).toBe(5)
    const text = posted[0].lines.join('\n')
    expect(text).toContain('5 invalid state posts went through the relay before Main Flow moved to the direct write.')
    expect(text).not.toMatch(/no longer on the direct write|back on the relay/)
    expect(posted[0].alert).toBe(false)
    expect(posted[0].title).toBe('All 2 invalid state writes landed in Salesforce')
  })

  it('a relay post after the last direct write is a rollback, and reads as an alert', async () => {
    const { d, posted } = deps({ steps: [nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B), relayStep('r1')], records: landedA })
    await runInvalidStateWatch(d)
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('Main Flow is back on the relay for invalid state posts')
    expect(posted[0].lines.join('\n')).toContain('the last of them after every direct write, so Main Flow is back on the relay.')
    expect(posted[0].fixHint).toMatch(/version history/)
  })

  it('a day with only relay posts says Main Flow is not on the direct write, as an alert', async () => {
    const { d, posted } = deps({ steps: [relayStep('r1')] })
    const report = await runInvalidStateWatch(d)
    expect(report.relayInvalidState).toBe(1)
    expect(report.native).toEqual([])
    expect(posted[0].alert).toBe(true)
    expect(posted[0].lines.join('\n')).toContain('The 1 invalid state post went through the relay, so Main Flow is not on the direct write.')
    // Not "back on": nothing in the window shows it was ever on the direct write.
    expect(posted[0].title).toBe('Main Flow is not on the direct write for invalid state posts')
  })

  it('relay posts between direct writes are said as a spell off the direct write, as an alert', async () => {
    const { d, posted } = deps({ steps: [nativeStep(RUN_A, SUB_A), relayStep('r1'), relayStep('r2'), nativeStep(RUN_B, SUB_B)], records: landedA })
    await runInvalidStateWatch(d)
    expect(posted[0].alert).toBe(true)
    expect(posted[0].lines.join('\n')).toContain('2 invalid state posts went through the relay between direct writes, so Main Flow left the direct write for a while and came back.')
  })

  it('a write that did not land keeps its own title when a rollback came too, and the Fix line covers both', async () => {
    const missing = { ...landedA, [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_4__c: null }) }
    const { d, posted } = deps({ steps: [nativeStep(RUN_A, SUB_A), relayStep('r1')], records: missing })
    await runInvalidStateWatch(d)
    expect(posted[0].title).toBe('1 of 1 invalid state writes did not land in Salesforce')
    expect(posted[0].fixHint).toMatch(/Open each run above/)
    expect(posted[0].fixHint).toMatch(/version history/)
  })

  it('compares with the relay, saying what each number counts', async () => {
    const { d, posted } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)), [LEAD_A]: ok(landedLead(RUN_A)) },
      countRelay: async () => ({ total: 3360, accepted: 3354 }),
    })
    await runInvalidStateWatch(d)
    const text = posted[0].lines.join('\n')
    expect(text).toContain("Over the same hours the relay took 3,354 of Main Flow's 3,360 other outcome posts (99.8%).")
    expect(text).toContain('That counts posts Pipedream answered with a success, not what reached Salesforce.')
    expect(text).toContain("Bidspoke's own record of the direct writes, the same measure, is 1 of 1 completed (100.0%).")
  })

  it('a relay count that cannot be read is said, not shown as zero', async () => {
    const { d, posted } = deps({ countRelay: async () => { throw new Error('canceling statement due to statement timeout') } })
    const report = await runInvalidStateWatch(d)
    expect(report.relay).toEqual({ error: 'canceling statement due to statement timeout' })
    expect(posted[0].lines.join('\n')).toContain("The relay's numbers could not be read from the database (canceling statement due to statement timeout).")
  })

  it('a database read failure names itself and reads as an alert', async () => {
    const { d, posted } = deps({ readSteps: async () => { throw new Error('upstream connect error') } })
    const report = await runInvalidStateWatch(d)
    expect(report.readError).toBe('upstream connect error')
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('Invalid state write check could not run')
    expect(posted[0].lines[0]).toBe("The check could not read yesterday's Main Flow runs from the database (upstream connect error).")
  })

  it('records its outcome, and a Slack post that fails is recorded as not posted rather than lost', async () => {
    const runs: Array<{ outcome: string }> = []
    const { d } = deps({ post: async () => false, recordRun: async (_s, ending) => { runs.push(ending) } })
    await runInvalidStateWatch(d)
    expect(runs).toEqual([expect.objectContaining({ outcome: 'not_posted' })])
  })

  it('never throws, even when the Slack post throws', async () => {
    const { d } = deps({ post: async () => { throw new Error('slack down') } })
    await expect(runInvalidStateWatch(d)).resolves.toBeDefined()
  })

  it('lists at most 15 runs and says how many more, so a bad day is not cut off silently', () => {
    const native = Array.from({ length: 18 }, (_, i) => ({ kind: 'not_landed' as const, executionId: `run-${i}`, problems: ['The Submission has no Bidspoke run link.'] }))
    const report: CanaryWatchReport = {
      from: '2026-10-17T12:50:00.000Z', to: '2026-10-18T12:50:00.000Z', native, skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: 18,
      relay: { total: 10, accepted: 10 },
    }
    const m = canaryWatchMessage(report, APP)
    expect(m.lines.filter((l) => l.startsWith('<'))).toHaveLength(15)
    expect(m.lines).toContain('3 more runs did not land fully or could not be checked; the job run record lists them all.')
  })
})

describe('its heartbeat', () => {
  const job = CRON_JOBS.find((j) => j.id === INVALID_STATE_WATCH_JOB)

  // That the worker declares the cron is the web guard worker-cron-wiring-guard's, for every entry.
  it('is registered on the 9 AM ET daily cron', () => {
    expect(job).toBeDefined()
    expect(job!.triggerCron).toBe('0 13 * * *')
  })

  it('a missed day reads as stale, so a run that never happened is paged', () => {
    const lastRan = new Date(NOW_MS - 27 * 3600_000).toISOString()
    expect(evaluateHeartbeat(lastRan, null, NOW_MS, job!.staleMs).status).toBe('stale')
    const yesterday = new Date(NOW_MS - 24 * 3600_000).toISOString()
    expect(evaluateHeartbeat(yesterday, null, NOW_MS, job!.staleMs).status).toBe('healthy')
  })
})
