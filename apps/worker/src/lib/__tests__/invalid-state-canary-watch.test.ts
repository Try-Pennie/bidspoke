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
 * write stamp added. `PDFlow_1__c` and `PDFlow_4__c` both hold the run's
 * Bidspoke link, as on all four direct posts read on 2026-10-17 (#2313). Every
 * other value is invented.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  runInvalidStateWatch,
  canaryWatchMessage,
  canaryWatchWindow,
  INVALID_STATE_WATCH_JOB,
  WATCHED_STEP,
  RELAY_READ_BUDGET_MS,
  RELAY_SAMPLE_SIZE,
  RELAY_COMPARISON_POSTS,
  pickEvenly,
  readRelayPosts,
  STEP_COLUMNS,
  DIRECT_WRITE_SINCE,
  OVERWRITE_STORM_MIN,
  type CanaryWatchDeps,
  type CanaryWatchReport,
  type RelayStep,
  type SendStep,
  type WatchedStep,
} from '../invalid-state-canary-watch'
import { CRON_JOBS, evaluateHeartbeat } from '../cron-heartbeat'
import { MAIN_FLOW_WORKFLOW_ID } from '../main-flow-port/transform'
import type { SalesforceRead } from '../../engine/inquiry-post'
import { REPEAT_RUN_1, REPEAT_RUN_2 } from './fixtures/invalid-state-repeat-visit-2026-10-18'

const APP = 'https://bidspoke.example'
/** The first paragraph of every message that reports runs (#2652). */
const INTRO = "Since Oct 16, Main Flow writes the outcome for leads from states we don't serve straight to Salesforce, while most other outcomes still go through Pipedream."
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
    PDFlow_1__c: link(run),
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
    started_at: '2026-10-17T15:04:04.000Z',
    completed_at: '2026-10-17T15:04:04.412Z',
    input: { resolved: { operation: 'update', object: 'Submission__c', record_id: sub, body: sentBody(run) } },
    output: { status: 204, body: null },
    ...over,
  }
}

/** A step of `run` sent at the same moment as nativeStep's, so the two cannot be ordered (#2806). */
const sentWithRunA = (run: string, step_namespace: string): SendStep => ({ execution_id: run, step_namespace, started_at: '2026-10-17T15:04:04.000Z', completed_at: '2026-10-17T15:04:04.412Z' })

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
    // The field history query (#3005): no rows, as for a field Salesforce keeps no history of.
    if (p.startsWith('/query?q=') && decodeURIComponent(p).includes('FROM Submission__History')) return ok({ totalSize: 0, done: true, records: [] })
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
    readRelay: async () => ({ total: 0, sample: [] }),
    // No other run's step rows: a run outside the day is ordered by its own start (#2806).
    readSendSteps: async () => [],
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
    expect(asked[1]).toBe(`/sobjects/Lead/${LEAD_A}?fields=EngineUUID__c,EngineLeadUUID__c,Submission_Object_ID__c`)
    expect(posted).toHaveLength(1)
    expect(posted[0].alert).toBe(false)
    expect(posted[0].title).toBe('Direct Salesforce writes: the one write arrived complete')
  })

  // Marked as a resend (#2938), so a timed out write that arrived only because the read-back sent it again is said apart.
  it('a landed resend from the read-back (attempt 1) still counts as this run landing', async () => {
    const held = { ...landedSubmission(RUN_A, LEAD_A), Bidspoke_Write__c: marker(RUN_A, 1) }
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A, { status: 'failed' })],
      records: { [SUB_A]: ok(held), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([{ kind: 'landed', executionId: RUN_A, resent: true }])
    expect(report.nativeCompleted).toBe(0)
  })

  // #2313: PDFlow_1__c is the run link to judge by. Every outcome post writes it
  // (the relay's and the direct one alike), while PDFlow_4__c is also written by
  // the inquiry relay, with a Pipedream link, on every run that still has it.
  it('a missing PDFlow_1__c is a run that did not land fully, and the message reads as an alert naming the run', async () => {
    const { d, posted } = deps({
      steps: [nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B)],
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_1__c: null }),
        [LEAD_A]: ok(landedLead(RUN_A)),
        [SUB_B]: ok(landedSubmission(RUN_B, LEAD_B)),
        [LEAD_B]: ok(landedLead(RUN_B)),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ['the Submission has no Bidspoke run link'] })
    expect(report.native[1]).toEqual({ kind: 'landed', executionId: RUN_B })
    const m = posted[0]
    expect(m.alert).toBe(true)
    expect(m.title).toBe('Direct Salesforce writes: 1 of 2 did not arrive complete')
    expect(m.lines.join('\n')).toContain(`<${link(RUN_A)}|Run ${RUN_A}>: the Submission has no Bidspoke run link.`)
    expect(m.fixHint).toBeTruthy()
  })

  it("another run's link in PDFlow_1__c is named as such", async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_1__c: link(RUN_B) }), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ["the Submission's run link is not this run's"] })
  })

  // A pipedream.com link there, on a Submission written since, is the inquiry
  // relay's PATCH arriving last and counts as moved on
  // (send-salesforce-canary-watch.test.ts); any other value is still a field that differs.
  it('PDFlow_4__c holding a link that is not on pipedream.com is a field that holds a different value, not a missing run link', async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_4__c: 'https://pipedream.example/@pennie/p_abc/inspect/1' }), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ['1 of its fields holds a different value from the one this run sent'], fields: ['PDFlow_4__c'] })
  })

  it("a direct run that sent no stamp and whose Submission holds a later run's link did not land: a direct write is set aside only on a later run's stamp of the same step (#2485)", async () => {
    const { Bidspoke_Write__c: _stamp, ...unstamped } = sentBody(RUN_A)
    const step = nativeStep(RUN_A, SUB_A, { input: { resolved: { operation: 'update', object: 'Submission__c', record_id: SUB_A, body: unstamped } } })
    const { d } = deps({
      steps: [step],
      records: { [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_1__c: link(RUN_B) }), [LEAD_A]: ok(landedLead(RUN_A)) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([{ kind: 'not_landed', executionId: RUN_A, problems: ["the Submission's run link is not this run's"] }])
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
      problems: ['2 of its fields hold different values from the ones this run sent'],
      // The record keeps which fields, by name, never by value; the message says how many.
      fields: ['LeadSaleType__c', 'VantageScore__c'],
    })
    const text = JSON.stringify(posted[0])
    expect(text).not.toContain('701')
    expect(text).not.toContain('Offer Wall')
    expect(text).not.toContain('uuid-a')
  })

  it("a later write's stamp is said, so a difference it caused is not read as this run's write failing silently", async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      readSendSteps: async (run) => (run === RUN_B ? [sentWithRunA(RUN_B, 'send_salesforce')] : []),
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), Bidspoke_Write__c: `${RUN_B}:send_salesforce:0`, VantageScore__c: 701 }),
        [LEAD_A]: ok(landedLead(RUN_A)),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({
      kind: 'not_landed',
      executionId: RUN_A,
      // RUN_B's write was sent at the same moment as this one, so it cannot be shown to be later or earlier (#2806).
      problems: ['another run wrote the same Submission', '1 of its fields holds a different value from the one this run sent'],
      fields: ['VantageScore__c'],
      stampedBy: RUN_B,
    })
  })

  it("a Lead whose Engine UUID differs from the Submission's is a run that did not land fully", async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: { [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)), [LEAD_A]: ok({ ...landedLead(RUN_A), EngineUUID__c: null }) },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ["its Lead's Engine UUID doesn't match the Submission"] })
  })

  it('a Submission with no Lead is said, because the Lead check could not be met', async () => {
    const { d } = deps({ steps: [nativeStep(RUN_A, SUB_A)], records: { [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), Lead__c: null }) } })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ['the Submission has no Lead, so its Engine ids reached no Lead'] })
  })

  it('a Submission that does not exist did not land', async () => {
    const { d } = deps({ steps: [nativeStep(RUN_A, SUB_A)] })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_A, problems: ['the Submission does not exist in Salesforce'] })
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
    expect(m.title).toBe('Direct Salesforce writes: 2 of 2 could not be checked')
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
    expect(posted[0].lines.join('\n')).toContain('1 more lead was not written because the Engine sent nothing to write.')
  })

  it('zero runs is said plainly, as a report, not an alert', async () => {
    const { d, posted } = deps({ steps: [] })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([])
    expect(posted[0].alert).toBe(false)
    expect(posted[0].title).toBe('Direct Salesforce writes: none to check yesterday')
    expect(posted[0].lines[0]).toBe(INTRO)
    expect(posted[0].lines[1]).toBe('No leads were written directly from Oct 17, 8:50 AM to Oct 18, 8:50 AM ET.')
  })

  // #2312: the first report (2026-10-17) said Main Flow had left the direct write
  // because five relay posts sat in its window, when all five came before version
  // 172 went live and both posts after it went direct. Whether Main Flow is on the
  // relay is a question about the LAST post, never about any post.
  const relayStep = (run: string): WatchedStep => ({ execution_id: run, step_type: 'webhook', status: 'completed', started_at: '2026-10-17T15:00:00.000Z', input: {}, output: { status: 200 } })
  const landedA = { [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)), [LEAD_A]: ok(landedLead(RUN_A)), [SUB_B]: ok(landedSubmission(RUN_B, LEAD_B)), [LEAD_B]: ok(landedLead(RUN_B)) }

  it('relay posts from before the switch are said as such, and the day stays a report (the 2026-10-17 shape)', async () => {
    const before = ['r1', 'r2', 'r3', 'r4', 'r5'].map(relayStep)
    const { d, posted } = deps({ steps: [...before, nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B)], records: landedA })
    const report = await runInvalidStateWatch(d)
    expect(report.relayInvalidState).toBe(5)
    const text = posted[0].lines.join('\n')
    expect(text).toContain("5 outcomes for leads from states we don't serve went through Pipedream before Main Flow started writing them directly.")
    expect(text).not.toMatch(/back on Pipedream|went back to Pipedream/)
    expect(posted[0].alert).toBe(false)
    expect(posted[0].title).toBe('Direct Salesforce writes: all 2 arrived complete')
  })

  it('a relay post after the last direct write is a rollback, and reads as an alert', async () => {
    const { d, posted } = deps({ steps: [nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B), relayStep('r1')], records: landedA })
    await runInvalidStateWatch(d)
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('Direct Salesforce writes: Main Flow is back on Pipedream')
    expect(posted[0].lines.join('\n')).toContain("1 outcome for a lead from a state we don't serve went through Pipedream after every direct write, so Main Flow is back on Pipedream.")
    expect(posted[0].fixHint).toMatch(/version history/)
  })

  it('a day with only relay posts says Main Flow is not on the direct write, as an alert', async () => {
    const { d, posted } = deps({ steps: [relayStep('r1')] })
    const report = await runInvalidStateWatch(d)
    expect(report.relayInvalidState).toBe(1)
    expect(report.native).toEqual([])
    expect(posted[0].alert).toBe(true)
    expect(posted[0].lines.join('\n')).toContain("The one outcome for a lead from a state we don't serve went through Pipedream, so Main Flow is not writing these directly.")
    // Not "back on": nothing in the window shows it was ever on the direct write.
    expect(posted[0].title).toBe('Direct Salesforce writes: Main Flow is not writing directly')
  })

  it('relay posts between direct writes are said as a spell off the direct write, as an alert', async () => {
    const { d, posted } = deps({ steps: [nativeStep(RUN_A, SUB_A), relayStep('r1'), relayStep('r2'), nativeStep(RUN_B, SUB_B)], records: landedA })
    await runInvalidStateWatch(d)
    expect(posted[0].alert).toBe(true)
    expect(posted[0].lines.join('\n')).toContain("2 outcomes for leads from states we don't serve went through Pipedream between direct writes, so Main Flow went back to Pipedream for a while and came back.")
  })

  it('a write that did not land keeps its own title when a rollback came too, and the Fix line covers both', async () => {
    const missing = { ...landedA, [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), PDFlow_1__c: null }) }
    const { d, posted } = deps({ steps: [nativeStep(RUN_A, SUB_A), relayStep('r1')], records: missing })
    await runInvalidStateWatch(d)
    expect(posted[0].title).toBe('Direct Salesforce writes: 1 of 1 did not arrive complete')
    expect(posted[0].fixHint).toMatch(/Open each run above/)
    expect(posted[0].fixHint).toMatch(/version history/)
  })

  // #2313: the relay side is judged by what Salesforce saved, through the same
  // read-back, never by what Pipedream answered. The bodies below have the
  // shapes measured on 2026-10-17: a code node's object (under_10000_sf_post,
  // with the Engine ids) and a JSON text body (send_salesforce, without them),
  // each carrying `submissionId`, `executionId` and the run link in PDFlow_1__c.
  const RELAY_1 = '01a14500-0000-7000-8000-000000000001'
  const RELAY_2 = '01a14500-0000-7000-8000-000000000002'
  // A run whose post was sent after the others' were answered (#2806), so a later run.
  const RELAY_3 = '01a14500-0001-7000-8000-000000000003'
  const RSUB_1 = 'a04Ui00000RRRR1IAA'
  const RSUB_2 = 'a04Ui00000RRRR2IAA'
  const RLEAD_1 = '00QUi00000RRRR1MAA'
  const RLEAD_2 = '00QUi00000RRRR2MAA'

  function relayBody(run: string, sub: string | null): Record<string, unknown> {
    return {
      submissionId: sub,
      executionId: run,
      UUID: `uuid-${run.slice(-1)}`,
      leadUUID: `lead-uuid-${run.slice(-1)}`,
      PDFlow_1__c: link(run),
      External_Exchange_Status__c: 'Pending',
      External_Routing_Code__c: 3,
      VantageScore__c: 'null',
    }
  }

  function relayPost(run: string, body: unknown, over: Partial<RelayStep> = {}): RelayStep {
    return {
      execution_id: run,
      step_namespace: 'under_10000_sf_post',
      step_type: 'webhook',
      status: 'completed',
      started_at: '2026-10-17T13:31:13.000Z',
      completed_at: '2026-10-17T13:31:13.061Z',
      input: { resolved: { method: 'POST', url: 'https://relay.example/update-submission', headers: {}, body } },
      output: { status: 200, body: { success: true } },
      ...over,
    }
  }

  /** What Salesforce holds when the relay's PATCH landed: the two ids dropped, the Engine ids renamed. */
  function relaySaved(run: string, lead: string): Record<string, unknown> {
    return {
      Engine_UUID_SO__c: `uuid-${run.slice(-1)}`,
      Engine_Lead_UUID_SO__c: `lead-uuid-${run.slice(-1)}`,
      PDFlow_1__c: link(run),
      PDFlow_4__c: 'https://pipedream.example/@pennie/p_abc/inspect/1',
      External_Exchange_Status__c: 'Pending',
      External_Routing_Code__c: '3',
      VantageScore__c: 'null',
      Lead__c: lead,
      Bidspoke_Write__c: null,
    }
  }

  it('a relay post Pipedream answered 2xx that did not land in Salesforce is counted as not landed, and the rate says what Salesforce saved', async () => {
    const { d, posted } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      readRelay: async () => ({ total: 3360, sample: [relayPost(RELAY_1, relayBody(RELAY_1, RSUB_1)), relayPost(RELAY_2, relayBody(RELAY_2, RSUB_2))] }),
      records: {
        [SUB_A]: ok(landedSubmission(RUN_A, LEAD_A)),
        [LEAD_A]: ok(landedLead(RUN_A)),
        [RSUB_1]: ok(relaySaved(RELAY_1, RLEAD_1)),
        [RLEAD_1]: ok(landedLead(RELAY_1)),
        // Pipedream answered 200, and Salesforce holds none of what was sent.
        [RSUB_2]: ok({ Lead__c: RLEAD_2, PDFlow_1__c: null, External_Exchange_Status__c: null, External_Routing_Code__c: null, VantageScore__c: null, Engine_UUID_SO__c: null, Engine_Lead_UUID_SO__c: null }),
        [RLEAD_2]: ok({ EngineUUID__c: null, EngineLeadUUID__c: null }),
      },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.total).toBe(3360)
    expect(report.relay.sample.map((v) => v.kind)).toEqual(['landed', 'not_landed'])
    const text = posted[0].lines.join('\n')
    expect(text).toContain('For comparison, we checked 2 of the 3,360 outcomes Pipedream sent in the same hours: 1 arrived complete and 1 did not.')
    // The direct count is said once, in its own paragraph, never repeated here.
    expect(text).not.toMatch(/direct writes on the same measure/)
    expect(text).not.toMatch(/Pipedream answered/)
    // The comparison does not page: the relay is not what the canary watches.
    expect(posted[0].alert).toBe(false)
  })

  it("reads a relay post back by the relay's own PATCH: ids dropped, Engine ids renamed, a JSON text body parsed", async () => {
    const textBody = JSON.stringify(relayBody(RELAY_1, RSUB_1))
    const { d, asked } = deps({
      readRelay: async () => ({ total: 1, sample: [relayPost(RELAY_1, textBody, { step_namespace: 'send_salesforce' })] }),
      records: { [RSUB_1]: ok(relaySaved(RELAY_1, RLEAD_1)), [RLEAD_1]: ok(landedLead(RELAY_1)) },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([{ kind: 'landed', executionId: RELAY_1 }])
    const fields = new URL(`https://x${asked[0]}`).searchParams.get('fields')!.split(',')
    expect(asked[0].startsWith(`/sobjects/Submission__c/${RSUB_1}?`)).toBe(true)
    expect(fields).toEqual(expect.arrayContaining(['PDFlow_1__c', 'Engine_UUID_SO__c', 'Engine_Lead_UUID_SO__c', 'External_Routing_Code__c', 'VantageScore__c', 'Lead__c']))
    for (const f of ['UUID', 'leadUUID', 'submissionId', 'executionId']) expect(fields).not.toContain(f)
  })

  it("a relay post that did not send the Engine ids is not judged by its Lead's (the tripoint and amone bodies)", async () => {
    const { submissionId, executionId, PDFlow_1__c, External_Exchange_Status__c } = relayBody(RELAY_1, RSUB_1)
    const { d, asked } = deps({
      readRelay: async () => ({ total: 1, sample: [relayPost(RELAY_1, { submissionId, executionId, PDFlow_1__c, External_Exchange_Status__c }, { step_namespace: 'tripoint_sf_post' })] }),
      records: { [RSUB_1]: ok({ PDFlow_1__c: link(RELAY_1), External_Exchange_Status__c: 'Pending', Lead__c: RLEAD_1 }) },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([{ kind: 'landed', executionId: RELAY_1 }])
    expect(asked).toHaveLength(1)
  })

  it("a relay post the relay's filter stopped (no Submission) is counted apart and read for nothing", async () => {
    const { d, posted, asked } = deps({ readRelay: async () => ({ total: 1, sample: [relayPost(RELAY_1, relayBody(RELAY_1, null))] }) })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([])
    expect(report.relay.noSubmission).toBe(1)
    expect(asked).toHaveLength(0)
    expect(posted[0].lines.join('\n')).toContain('In the same hours Pipedream sent 1 other outcome. 1 of them had no Submission, so Pipedream wrote nothing.')
  })

  it('a relay post a LATER run overwrote is left out of the rate, while an EARLIER run\'s link means this one did not land', async () => {
    const { d, posted } = deps({
      readRelay: async () => ({ total: 2, sample: [relayPost(RELAY_2, relayBody(RELAY_2, RSUB_1)), relayPost(RELAY_1, relayBody(RELAY_1, RSUB_2))] }),
      // RELAY_3 sent its post 3 s after RELAY_2's was answered; the earlier run's rows are gone, and it started a day before.
      readSendSteps: async (run) =>
        run === RELAY_3 ? [{ execution_id: RELAY_3, step_namespace: 'under_10000_sf_post', started_at: '2026-10-17T13:31:16.000Z', completed_at: '2026-10-17T13:31:16.050Z' }] : [],
      records: {
        // RELAY_2's Submission holds RELAY_3's link: a later run wrote it since.
        [RSUB_1]: ok({ ...relaySaved(RELAY_3, RLEAD_1) }),
        // RELAY_1's Submission still holds an earlier run's link: its write never landed.
        [RSUB_2]: ok({ ...relaySaved(RELAY_1, RLEAD_2), PDFlow_1__c: link('01a14400-0000-7000-8000-000000000009') }),
        [RLEAD_2]: ok(landedLead(RELAY_1)),
      },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([
      { kind: 'superseded', executionId: RELAY_2, byExecutionId: RELAY_3 },
      { kind: 'not_landed', executionId: RELAY_1, problems: ["the Submission's run link is not this run's"] },
    ])
    const text = posted[0].lines.join('\n')
    expect(text).toContain('For comparison, we checked 1 of the 2 outcomes Pipedream sent in the same hours: 0 arrived complete and 1 did not.')
    expect(text).toContain('1 more was left out because a later run of Main Flow wrote the same Submission.')
  })

  it('a relay read that Salesforce does not answer is "could not be checked", and stops the relay reads too', async () => {
    const { d, asked, posted } = deps({
      readRelay: async () => ({ total: 2, sample: [relayPost(RELAY_1, relayBody(RELAY_1, RSUB_1)), relayPost(RELAY_2, relayBody(RELAY_2, RSUB_2))] }),
      records: { [RSUB_1]: { kind: 'no_answer', error: 'no answer within 12 s' } },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample.map((v) => v.kind)).toEqual(['unchecked', 'unchecked'])
    expect(asked).toHaveLength(1)
    expect(posted[0].lines.join('\n')).toContain('For comparison, we checked all 2 outcomes Pipedream sent in the same hours: 0 arrived complete and 2 could not be checked.')
  })

  it('the relay reads stop at their time budget, and what was not read is said as not checked', async () => {
    let t = NOW_MS
    const sample = [relayPost(RELAY_1, relayBody(RELAY_1, RSUB_1)), relayPost(RELAY_2, relayBody(RELAY_2, RSUB_2))]
    const sf = fakeSalesforce({ [RSUB_1]: ok(relaySaved(RELAY_1, RLEAD_1)), [RLEAD_1]: ok(landedLead(RELAY_1)), [RSUB_2]: ok(relaySaved(RELAY_2, RLEAD_2)), [RLEAD_2]: ok(landedLead(RELAY_2)) })
    const { d } = deps({
      now: () => t,
      readRelay: async () => ({ total: 2, sample }),
      // Each Salesforce read takes half the budget, so the first relay post uses all of it.
      salesforce: async () => async (p: string) => {
        t += RELAY_READ_BUDGET_MS / 2
        return sf.read(p)
      },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([
      { kind: 'landed', executionId: RELAY_1 },
      { kind: 'unchecked', executionId: RELAY_2, reason: 'The relay reads ran out of time before this post.' },
    ])
    expect(sf.asked.some((p) => p.includes(RSUB_2))).toBe(false)
  })

  it('a relay read that cannot be read is said, not shown as zero', async () => {
    const { d, posted } = deps({ readRelay: async () => { throw new Error('canceling statement due to statement timeout') } })
    const report = await runInvalidStateWatch(d)
    expect(report.relay).toEqual({ error: 'canceling statement due to statement timeout' })
    expect(posted[0].lines.join('\n')).toContain("Pipedream's outcomes could not be read from the database (canceling statement due to statement timeout).")
  })

  it('picks the relay sample evenly over the day, in order, and takes every post when there are fewer', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `id-${i}`)
    expect(pickEvenly(ids, 5)).toEqual(['id-0', 'id-2', 'id-4', 'id-6', 'id-8'])
    expect(pickEvenly(ids, 3)).toEqual(['id-0', 'id-3', 'id-6'])
    expect(pickEvenly(ids, 20)).toEqual(ids)
    expect(pickEvenly([], 5)).toEqual([])
  })

  it('a database read failure names itself and reads as an alert', async () => {
    const { d, posted } = deps({ readSteps: async () => { throw new Error('upstream connect error') } })
    const report = await runInvalidStateWatch(d)
    expect(report.readError).toBe('upstream connect error')
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('Direct Salesforce writes: the check could not run')
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

  // #2396: the 2026-10-18 report said 13 of 100 relay posts did not land, and all
  // 13 had. 11 differed only in External_Exchange_Status__c and
  // External_Timestamp__c: the relay sent Pending and the sale's own completion
  // set Completed 30 s to 2 min later. 2 differed only because the Lead follows
  // its customer's NEWER Submission, whose Engine ids it carries. The shapes below
  // are those, with every id and value invented.
  const NEWER_SUB = 'a04Ui00000NNNN1IAV'
  const tripointBody = (run: string, sub: string) => ({
    submissionId: sub,
    executionId: run,
    PDFlow_1__c: link(run),
    External_Exchange_Status__c: 'Pending',
    External_Timestamp__c: '2026-10-17T13:31:14.000Z',
    VantageScore__c: 'null',
  })
  /** Read back after the sale's completion: the relay's post landed, then the status moved on. */
  const completedSince = (run: string, lead: string, over: Record<string, unknown> = {}) => ({
    PDFlow_1__c: link(run),
    External_Exchange_Status__c: 'Completed',
    External_Timestamp__c: '2026-10-17T13:31:41.000+0000',
    VantageScore__c: 'null',
    Lead__c: lead,
    CreatedDate: '2026-10-17T13:29:07.000+0000',
    LastModifiedDate: '2026-10-17T13:31:41.000+0000',
    ...over,
  })
  const tripointSample = (sample: RelayStep[]) => async () => ({ total: sample.length, sample })

  it('a relay post whose status a later write advanced landed, and is counted as superseded by a later write rather than not landed', async () => {
    const { d, posted, asked } = deps({
      readRelay: tripointSample([relayPost(RELAY_1, tripointBody(RELAY_1, RSUB_1), { step_namespace: 'tripoint_sf_post' })]),
      records: { [RSUB_1]: ok(completedSince(RELAY_1, RLEAD_1)) },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([
      { kind: 'moved_on', executionId: RELAY_1, laterWrite: ['External_Exchange_Status__c', 'External_Timestamp__c'], newerSubmission: false },
    ])
    // The Submission read asks for when it was last written and created.
    const fields = new URL(`https://x${asked[0]}`).searchParams.get('fields')!.split(',')
    expect(fields).toEqual(expect.arrayContaining(['LastModifiedDate', 'CreatedDate']))
    const text = posted[0].lines.join('\n')
    expect(text).toContain(
      'For comparison, we checked the one outcome Pipedream sent in the same hours, and it arrived complete. 1 of those was updated again later when the sale finished, which is expected.',
    )
  })

  it('a differing status on a Submission last written BEFORE the post is still a post that did not land', async () => {
    const { d } = deps({
      readRelay: tripointSample([relayPost(RELAY_1, tripointBody(RELAY_1, RSUB_1), { step_namespace: 'tripoint_sf_post' })]),
      // Only the status differs, and nothing has written the record since 13:20, before the post began at 13:31:13.
      records: { [RSUB_1]: ok(completedSince(RELAY_1, RLEAD_1, { LastModifiedDate: '2026-10-17T13:20:00.000+0000', External_Timestamp__c: '2026-10-17T13:31:14.000+0000' })) },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([
      { kind: 'not_landed', executionId: RELAY_1, problems: ['1 of its fields holds a different value from the one this run sent'], fields: ['External_Exchange_Status__c'] },
    ])
  })

  it('a post whose step recorded no start time cannot be shown to have been superseded, so a difference is still said', async () => {
    const { d } = deps({
      readRelay: tripointSample([relayPost(RELAY_1, tripointBody(RELAY_1, RSUB_1), { step_namespace: 'tripoint_sf_post', started_at: '' })]),
      records: { [RSUB_1]: ok(completedSince(RELAY_1, RLEAD_1)) },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample.map((v) => v.kind)).toEqual(['not_landed'])
  })

  it('a field a later write would not explain still reads as not landed, naming every field that differs', async () => {
    const { d } = deps({
      readRelay: tripointSample([relayPost(RELAY_1, tripointBody(RELAY_1, RSUB_1), { step_namespace: 'tripoint_sf_post' })]),
      records: { [RSUB_1]: ok(completedSince(RELAY_1, RLEAD_1, { VantageScore__c: '701' })) },
    })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([
      {
        kind: 'not_landed',
        executionId: RELAY_1,
        problems: ['3 of its fields hold different values from the ones this run sent'],
        fields: ['External_Exchange_Status__c', 'External_Timestamp__c', 'VantageScore__c'],
      },
    ])
  })

  it('a timestamp a later write moved BACK, or a status it cleared, is not what a later write does, so it is not excused', async () => {
    for (const over of [{ External_Timestamp__c: '2026-10-17T13:00:00.000+0000' }, { External_Exchange_Status__c: null }]) {
      const { d } = deps({
        readRelay: tripointSample([relayPost(RELAY_1, tripointBody(RELAY_1, RSUB_1), { step_namespace: 'tripoint_sf_post' })]),
        records: { [RSUB_1]: ok(completedSince(RELAY_1, RLEAD_1, over)) },
      })
      const report = await runInvalidStateWatch(d)
      if ('error' in report.relay) throw new Error('relay read failed')
      expect(report.relay.sample.map((v) => v.kind)).toEqual(['not_landed'])
    }
  })

  /** The under_10000 shape: the Submission holds all it was sent, and its Lead now names a newer Submission whose Engine ids it carries. */
  const followedNewer = (newer: Record<string, unknown>, leadOver: Record<string, unknown> = {}): Record<string, Answer> => ({
    [RSUB_1]: ok({ ...relaySaved(RELAY_1, RLEAD_1), CreatedDate: '2026-10-17T12:49:52.000+0000', LastModifiedDate: '2026-10-17T12:50:51.000+0000' }),
    [RLEAD_1]: ok({ EngineUUID__c: 'uuid-newer', EngineLeadUUID__c: 'lead-uuid-newer', Submission_Object_ID__c: NEWER_SUB, ...leadOver }),
    [NEWER_SUB]: ok({ CreatedDate: '2026-10-17T12:53:50.000+0000', Engine_UUID_SO__c: 'uuid-newer', Engine_Lead_UUID_SO__c: 'lead-uuid-newer', ...newer }),
  })

  it("a Lead that follows a NEWER Submission of the same customer, carrying that Submission's Engine ids, is counted as followed a newer Submission, not a mismatch", async () => {
    const { d, asked, posted } = deps({ readRelay: tripointSample([relayPost(RELAY_1, relayBody(RELAY_1, RSUB_1))]), records: followedNewer({}) })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([{ kind: 'moved_on', executionId: RELAY_1, laterWrite: [], newerSubmission: true }])
    expect(asked[1]).toBe(`/sobjects/Lead/${RLEAD_1}?fields=EngineUUID__c,EngineLeadUUID__c,Submission_Object_ID__c`)
    expect(asked[2]).toBe(`/sobjects/Submission__c/${NEWER_SUB}?fields=CreatedDate,Engine_UUID_SO__c,Engine_Lead_UUID_SO__c`)
    expect(posted[0].lines.join('\n')).toContain('1 belongs to a customer who came back and started a new Submission, so only the Submission was checked for it.')
  })

  it('a Lead naming an OLDER Submission, or a newer one whose Engine ids it does not carry either, is still a mismatch', async () => {
    for (const newer of [{ CreatedDate: '2026-10-17T12:40:00.000+0000' }, { Engine_UUID_SO__c: 'uuid-other' }]) {
      const { d } = deps({ readRelay: tripointSample([relayPost(RELAY_1, relayBody(RELAY_1, RSUB_1))]), records: followedNewer(newer) })
      const report = await runInvalidStateWatch(d)
      if ('error' in report.relay) throw new Error('relay read failed')
      expect(report.relay.sample).toEqual([
        { kind: 'not_landed', executionId: RELAY_1, problems: ["its Lead's Engine ids don't match the Submission"] },
      ])
    }
  })

  it('a Lead naming this Submission by its 15 character id is not a newer Submission, so its differing ids are a mismatch', async () => {
    const { d, asked } = deps({ readRelay: tripointSample([relayPost(RELAY_1, relayBody(RELAY_1, RSUB_1))]), records: followedNewer({}, { Submission_Object_ID__c: RSUB_1.slice(0, 15) }) })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample.map((v) => v.kind)).toEqual(['not_landed'])
    expect(asked).toHaveLength(2)
  })

  it("a Lead's other Submission that Salesforce does not answer for leaves the post could not be checked, never landed", async () => {
    const records = { ...followedNewer({}), [NEWER_SUB]: { kind: 'no_answer', error: 'no answer within 12 s' } as Answer }
    const { d } = deps({ readRelay: tripointSample([relayPost(RELAY_1, relayBody(RELAY_1, RSUB_1))]), records })
    const report = await runInvalidStateWatch(d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([{ kind: 'unchecked', executionId: RELAY_1, reason: "Salesforce did not answer the Lead's other Submission read (no answer within 12 s)." }])
  })

  it('the same rules hold for the direct write, so the two halves are judged alike', async () => {
    const later = { External_Exchange_Status__c: 'Completed', External_Timestamp__c: '2026-10-17T15:05:00.000+0000', LastModifiedDate: '2026-10-17T15:05:00.000+0000' }
    const { d, posted } = deps({
      steps: [nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B)],
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), ...later }),
        [LEAD_A]: ok(landedLead(RUN_A)),
        [SUB_B]: ok({ ...landedSubmission(RUN_B, LEAD_B), CreatedDate: '2026-10-17T15:00:00.000+0000' }),
        [LEAD_B]: ok({ EngineUUID__c: 'uuid-newer', EngineLeadUUID__c: 'lead-uuid-newer', Submission_Object_ID__c: NEWER_SUB }),
        [NEWER_SUB]: ok({ CreatedDate: '2026-10-17T15:30:00.000+0000', Engine_UUID_SO__c: 'uuid-newer', Engine_Lead_UUID_SO__c: 'lead-uuid-newer' }),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([
      { kind: 'moved_on', executionId: RUN_A, laterWrite: ['External_Exchange_Status__c', 'External_Timestamp__c'], newerSubmission: false },
      { kind: 'moved_on', executionId: RUN_B, laterWrite: [], newerSubmission: true },
    ])
    expect(posted[0].alert).toBe(false)
    expect(posted[0].title).toBe('Direct Salesforce writes: all 2 arrived complete')
    expect(posted[0].lines[1]).toBe(
      'From Oct 17, 8:50 AM to Oct 18, 8:50 AM ET, 2 leads were written directly, and all 2 arrived complete. ' +
        'Each Submission has every field the run sent, and each Lead we compared has matching Engine ids. ' +
        '1 of those was updated again later when the sale finished, which is expected. ' +
        '1 belongs to a customer who came back and started a new Submission, so only the Submission was checked for it.',
    )
  })

  it('a direct write stamped since by another write is not excused by a later status change', async () => {
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), Bidspoke_Write__c: `${RUN_B}:send_salesforce:0`, External_Exchange_Status__c: 'Completed', LastModifiedDate: '2026-10-17T15:05:00.000+0000' }),
        [LEAD_A]: ok(landedLead(RUN_A)),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native.map((v) => v.kind)).toEqual(['not_landed'])
  })

  it('the 2026-10-18 shape reads as the relay landing 100 of 100, with the 13 moved on counted in the message and the job run record', async () => {
    const landed = Array.from({ length: 87 }, (_, i) => ({ kind: 'landed' as const, executionId: `relay-${i}` }))
    const laterWrite = Array.from({ length: 11 }, (_, i) => ({ kind: 'moved_on' as const, executionId: `later-${i}`, laterWrite: ['External_Exchange_Status__c', 'External_Timestamp__c'], newerSubmission: false }))
    const newer = Array.from({ length: 2 }, (_, i) => ({ kind: 'moved_on' as const, executionId: `newer-${i}`, laterWrite: [], newerSubmission: true }))
    const report: CanaryWatchReport = {
      from: '2026-10-17T12:50:00.000Z', to: '2026-10-18T12:50:00.000Z', skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: 11,
      native: Array.from({ length: 11 }, (_, i) => ({ kind: 'landed' as const, executionId: `direct-${i}` })),
      relay: { total: 3400, sample: [...landed, ...laterWrite, ...newer], noSubmission: 0 },
    }
    const text = canaryWatchMessage(report, APP).lines.join('\n')
    expect(text).toContain(
      'For comparison, we checked 100 of the 3,400 outcomes Pipedream sent in the same hours, and all 100 arrived complete. ' +
        '11 of those were updated again later when the sale finished, which is expected. ' +
        '2 belong to customers who came back and started a new Submission, so only the Submission was checked for those.',
    )
    expect(text).not.toMatch(/did not/)

    // And the job run record keeps them, so a reader sees how many were moved on.
    const runs: Array<{ outcome: string; summary?: Record<string, unknown> }> = []
    const { d } = deps({
      steps: [nativeStep(RUN_A, SUB_A)],
      readRelay: tripointSample([relayPost(RELAY_1, tripointBody(RELAY_1, RSUB_1), { step_namespace: 'tripoint_sf_post' })]),
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), External_Exchange_Status__c: 'Completed', External_Timestamp__c: '2026-10-17T15:05:00.000+0000', LastModifiedDate: '2026-10-17T15:05:00.000+0000' }),
        [LEAD_A]: ok(landedLead(RUN_A)),
        [RSUB_1]: ok(completedSince(RELAY_1, RLEAD_1)),
      },
      recordRun: async (_s, ending) => {
        runs.push(ending as { outcome: string; summary?: Record<string, unknown> })
      },
    })
    await runInvalidStateWatch(d)
    expect(runs[0].outcome).toBe('all_landed')
    const summary = runs[0].summary!
    expect(summary).toMatchObject({ native: 1, landed: 1, not_landed: 0, superseded_by_later_write: 1, followed_newer_submission: 0 })
    expect(summary.relay).toMatchObject({ read: 1, landed: 1, not_landed: 0, superseded_by_later_write: 1, followed_newer_submission: 0 })
    expect(summary.moved_on_runs).toEqual([{ kind: 'moved_on', executionId: RUN_A, laterWrite: ['External_Exchange_Status__c', 'External_Timestamp__c'], newerSubmission: false }])
  })

  it('lists at most 15 runs and says how many more, so a bad day is not cut off silently', () => {
    const native = Array.from({ length: 18 }, (_, i) => ({ kind: 'not_landed' as const, executionId: `run-${i}`, problems: ['the Submission has no Bidspoke run link'] }))
    const report: CanaryWatchReport = {
      from: '2026-10-17T12:50:00.000Z', to: '2026-10-18T12:50:00.000Z', native, skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: 18,
      relay: { total: 10, sample: [], noSubmission: 0 },
    }
    const m = canaryWatchMessage(report, APP)
    expect(m.lines.filter((l) => l.startsWith('<'))).toHaveLength(15)
    expect(m.lines).toContain('3 more runs did not arrive complete or could not be checked; the job run record lists them all.')
  })
})

/**
 * A database that holds `n` relay post rows, in time order, and records every
 * query: enough of PostgREST's builder for readRelayPosts' two reads (the paged
 * id list, then the sample by id).
 */
function relayDatabase(n: number, opts: { dropFromSample?: number; listError?: string } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `step-${String(i).padStart(5, '0')}`)
  const queries: Array<Array<[string, unknown[]]>> = []
  const from = () => {
    const calls: Array<[string, unknown[]]> = []
    queries.push(calls)
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'not', 'order', 'range', 'limit']) {
      builder[m] = (...args: unknown[]) => {
        calls.push([m, args])
        return builder
      }
    }
    builder.then = (resolve: (v: unknown) => void) => {
      const columns = calls.find(([m]) => m === 'select')![1][0]
      if (columns === 'id') {
        if (opts.listError) return resolve({ data: null, error: { message: opts.listError } })
        const [lo, hi] = calls.find(([m]) => m === 'range')![1] as [number, number]
        return resolve({ data: ids.slice(lo, hi + 1).map((id) => ({ id })), error: null })
      }
      const wanted = calls.find(([m, a]) => m === 'in' && a[0] === 'id')![1][1] as string[]
      // Answered out of order, as a database may.
      const rows = [...wanted].reverse().filter((_, i) => i !== opts.dropFromSample).map((id) => ({ id, execution_id: `run-${id}`, step_namespace: 'send_salesforce', step_type: 'webhook', status: 'completed', started_at: '2026-10-17T13:00:00.000Z', input: {}, output: {} }))
      return resolve({ data: rows, error: null })
    }
    return builder
  }
  return { supabase: { from } as unknown as SupabaseClient, queries }
}

/**
 * The words of the daily message (#2652). Dan found the report hard to read on
 * 2026-10-22: it never said what was being trialled, used internal terms, and
 * printed Salesforce field names. One vocabulary on every variant: "written
 * directly" for the native write, "Pipedream" for the relay, "arrived complete"
 * for landed fully, no field API names, times in ET.
 */
describe('the words of the daily message (#2652)', () => {
  const day = (over: Partial<CanaryWatchReport>): CanaryWatchReport => ({
    from: '2026-10-21T13:23:00.000Z',
    to: '2026-10-22T13:23:00.000Z',
    native: [],
    skipped: [],
    relayInvalidState: 0,
    relayAfterSwitch: 0,
    lastWasRelay: false,
    nativeCompleted: 0,
    relay: { total: 0, sample: [], noSubmission: 0 },
    ...over,
  })
  const landedRuns = (n: number, tag = 'direct') => Array.from({ length: n }, (_, i) => ({ kind: 'landed' as const, executionId: `${tag}-${i}` }))
  const laterWrite = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ kind: 'moved_on' as const, executionId: `later-${i}`, laterWrite: ['External_Exchange_Status__c', 'External_Timestamp__c'], newerSubmission: false }))
  const newerSubmission = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: 'moved_on' as const, executionId: `newer-${i}`, laterWrite: [], newerSubmission: true }))
  const label = (run: string) => `<${link(run)}|Run ${run}>`

  it('names the day the direct write started from the constant for the switch, version 172 at 7:20 PM ET on Oct 16', () => {
    expect(DIRECT_WRITE_SINCE).toBe('2026-10-16T23:20:00.000Z')
    expect(canaryWatchMessage(day({ native: landedRuns(1) }), APP).lines[0]).toBe(INTRO)
  })

  it('a normal day (the 2026-10-22 shape) reads in plain words', () => {
    const m = canaryWatchMessage(
      day({ native: landedRuns(13), nativeCompleted: 13, relay: { total: 3285, sample: [...landedRuns(89, 'relay'), ...laterWrite(9), ...newerSubmission(2)], noSubmission: 0 } }),
      APP,
    )
    expect(m.title).toBe('Direct Salesforce writes: all 13 arrived complete')
    expect(m.lines).toEqual([
      INTRO,
      'From Oct 21, 9:23 AM to Oct 22, 9:23 AM ET, 13 leads were written directly, and all 13 arrived complete. ' +
        'Each Submission has every field the run sent, and each Lead has matching Engine ids.',
      'For comparison, we checked 100 of the 3,285 outcomes Pipedream sent in the same hours, and all 100 arrived complete. ' +
        '9 of those were updated again later when the sale finished, which is expected. ' +
        '2 belong to customers who came back and started a new Submission, so only the Submission was checked for those.',
    ])
    expect(m.alert).toBe(false)
    expect(m.fixHint).toBeUndefined()
  })

  it('a day with misses (the 2026-10-19 shape) names each run in words and says how to fix it', () => {
    const m = canaryWatchMessage(
      day({
        from: '2026-10-18T13:00:00.000Z',
        to: '2026-10-19T13:00:00.000Z',
        native: [
          ...landedRuns(15),
          {
            kind: 'not_landed',
            executionId: REPEAT_RUN_1,
            problems: ["a later run wrote the same Submission, so this run's link and 5 of its fields were replaced", "its Lead's Engine ids don't match the Submission"],
          },
          { kind: 'not_landed', executionId: REPEAT_RUN_2, problems: ["its Lead's Engine ids don't match the Submission"] },
        ],
        nativeCompleted: 17,
        relay: { total: 3310, sample: [...landedRuns(88, 'relay'), ...laterWrite(11), ...newerSubmission(1)], noSubmission: 0 },
      }),
      APP,
    )
    expect(m.title).toBe('Direct Salesforce writes: 2 of 17 did not arrive complete')
    expect(m.lines).toEqual([
      INTRO,
      'From Oct 18, 9:00 AM to Oct 19, 9:00 AM ET, 17 leads were written directly. 15 arrived complete and 2 did not.',
      `${label(REPEAT_RUN_1)}: a later run wrote the same Submission, so this run's link and 5 of its fields were replaced, and its Lead's Engine ids don't match the Submission.`,
      `${label(REPEAT_RUN_2)}: its Lead's Engine ids don't match the Submission.`,
      'For comparison, we checked 100 of the 3,310 outcomes Pipedream sent in the same hours, and all 100 arrived complete. ' +
        '11 of those were updated again later when the sale finished, which is expected. ' +
        '1 belongs to a customer who came back and started a new Submission, so only the Submission was checked for it.',
    ])
    expect(m.alert).toBe(true)
    expect(m.fixHint).toBe('Open each run above and its Submission in Salesforce. If writes are being lost, move Main Flow back to Pipedream with the saved rollback record.')
  })

  it('on a mixed day, the runs moved on since are counted among those that arrived complete, never among those that did not', () => {
    const m = canaryWatchMessage(
      day({ native: [...landedRuns(1), ...laterWrite(1), { kind: 'not_landed', executionId: RUN_A, problems: ['the Submission has no Bidspoke run link'] }] }),
      APP,
    )
    expect(m.lines[1]).toBe(
      'From Oct 21, 9:23 AM to Oct 22, 9:23 AM ET, 3 leads were written directly. 2 arrived complete and 1 did not. ' +
        '1 of those that arrived complete was updated again later when the sale finished, which is expected.',
    )
  })

  it('a Lead holding the first completion copy is said as such, and never claimed to match this run', () => {
    const m = canaryWatchMessage(
      day({ native: [...landedRuns(2), { kind: 'moved_on', executionId: RUN_B, laterWrite: [], newerSubmission: false, leadFromEarlierRun: RUN_A }] }),
      APP,
    )
    expect(m.lines[1]).toBe(
      'From Oct 21, 9:23 AM to Oct 22, 9:23 AM ET, 3 leads were written directly, and all 3 arrived complete. ' +
        'Each Submission has every field the run sent, and each Lead we compared has matching Engine ids. ' +
        "1 went to a Submission an earlier run had already completed. Salesforce copies the Engine ids to the Lead only the first time, so its Lead keeps that earlier run's ids.",
    )
  })

  it('every variant keeps the same vocabulary in its title, and the intro on each that reports runs', () => {
    const notLanded = { kind: 'not_landed' as const, executionId: RUN_A, problems: ['the Submission has no Bidspoke run link'] }
    const unchecked = { kind: 'unchecked' as const, executionId: RUN_B, reason: 'Salesforce refused the login (401).' }
    const storm = Array.from({ length: OVERWRITE_STORM_MIN }, (_, i) => ({ kind: 'superseded' as const, executionId: `old-${i}`, byExecutionId: `new-${i}` }))
    const cases: Array<[CanaryWatchReport, string]> = [
      [day({ readError: 'upstream connect error' }), 'Direct Salesforce writes: the check could not run'],
      [day({}), 'Direct Salesforce writes: none to check yesterday'],
      [day({ native: landedRuns(1) }), 'Direct Salesforce writes: the one write arrived complete'],
      [day({ native: landedRuns(13) }), 'Direct Salesforce writes: all 13 arrived complete'],
      [day({ native: [...landedRuns(2), notLanded] }), 'Direct Salesforce writes: 1 of 3 did not arrive complete'],
      [day({ native: [...landedRuns(2), unchecked] }), 'Direct Salesforce writes: 1 of 3 could not be checked'],
      [day({ native: [landedRuns(1)[0], notLanded, unchecked] }), 'Direct Salesforce writes: 1 of 3 did not arrive complete, and 1 could not be checked'],
      [day({ relayInvalidState: 4, lastWasRelay: true }), 'Direct Salesforce writes: Main Flow is not writing directly'],
      [day({ native: landedRuns(2), relayInvalidState: 1, relayAfterSwitch: 1, lastWasRelay: true }), 'Direct Salesforce writes: Main Flow is back on Pipedream'],
      [day({ native: landedRuns(2), relayInvalidState: 1, relayAfterSwitch: 1 }), 'Direct Salesforce writes: Main Flow went back to Pipedream for a while'],
      [day({ native: [...landedRuns(15), ...storm] }), `Direct Salesforce writes: ${OVERWRITE_STORM_MIN} of ${15 + OVERWRITE_STORM_MIN} were replaced by a later run`],
      [day({ native: [storm[0]] }), 'Direct Salesforce writes: the one write was replaced by a later run'],
      [day({ native: [...landedRuns(4), storm[0]] }), 'Direct Salesforce writes: 4 of 5 arrived complete and 1 was replaced by a later run'],
    ]
    for (const [report, title] of cases) {
      const m = canaryWatchMessage(report, APP)
      expect(m.title).toBe(title)
      if (!report.readError) expect(m.lines[0]).toBe(INTRO)
      const words = [m.title, ...m.lines, m.fixHint ?? ''].join('\n')
      expect(words).not.toMatch(/\brelay\b|invalid state|landed fully|\bEDT\b|\bEST\b|__c\b/)
    }
  })

  it('the Fix lines for a day off the direct write and an overwrite storm use the same words', () => {
    const off = canaryWatchMessage(day({ native: landedRuns(2), relayInvalidState: 1, relayAfterSwitch: 1, lastWasRelay: true }), APP)
    expect(off.fixHint).toBe(
      "If Main Flow was moved back to Pipedream on purpose, nothing else is needed. If not, open Main Flow's version history and see which version is live. Either way, the time on Pipedream is a gap in the direct writes being measured.",
    )
    const storm = Array.from({ length: OVERWRITE_STORM_MIN }, (_, i) => ({ kind: 'superseded' as const, executionId: `old-${i}`, byExecutionId: `new-${i}` }))
    const stormy = canaryWatchMessage(day({ native: [...landedRuns(5), ...storm] }), APP)
    expect(stormy.fixHint).toBe(
      'More runs than usual wrote a Submission that a later run wrote again. Open the runs above: one customer coming back several times is expected, the same visit written twice is not.',
    )
    expect(stormy.lines).toContain(`${label('old-0')} was replaced by ${label('new-0')}, a later run that wrote the same Submission.`)
  })

  it('no message line names a Salesforce field by its API name, even when the runs it lists differ in named fields', async () => {
    // End to end, so the per run lines are what the check actually wrote, on both halves.
    const RSUB = 'a04Ui00000RRRR9IAA'
    const { d, posted } = deps({
      steps: [nativeStep(RUN_A, SUB_A), nativeStep(RUN_B, SUB_B)],
      // RUN_B's send_salesforce write went at the same moment as RUN_A's, so neither is later.
      readSendSteps: async (run) => (run === RUN_B ? [sentWithRunA(RUN_B, 'send_salesforce')] : []),
      readRelay: async () => ({
        total: 40,
        sample: [
          {
            execution_id: '01a14500-0000-7000-8000-000000000009',
            step_namespace: 'tripoint_sf_post',
            step_type: 'webhook',
            status: 'completed',
            started_at: '2026-10-17T13:31:13.000Z',
            input: { resolved: { body: { submissionId: RSUB, executionId: '01a14500-0000-7000-8000-000000000009', PDFlow_1__c: link('01a14500-0000-7000-8000-000000000009'), VantageScore__c: 'null' } } },
            output: {},
          },
        ],
      }),
      records: {
        [SUB_A]: ok({ ...landedSubmission(RUN_A, LEAD_A), Bidspoke_Write__c: `${RUN_B}:send_salesforce:0`, VantageScore__c: 701, PDFlow_4__c: 'https://pipedream.example/x' }),
        [LEAD_A]: ok({ ...landedLead(RUN_A), EngineUUID__c: null }),
        [SUB_B]: ok({ ...landedSubmission(RUN_B, LEAD_B), PDFlow_1__c: null, LeadSaleType__c: null }),
        [LEAD_B]: ok(landedLead(RUN_B)),
        [RSUB]: ok({ PDFlow_1__c: link('01a14500-0000-7000-8000-000000000009'), VantageScore__c: '640' }),
      },
    })
    const report = await runInvalidStateWatch(d)
    expect(report.native.map((v) => v.kind)).toEqual(['not_landed', 'not_landed'])
    const m = posted[0]
    const words = [m.title, ...m.lines, m.fixHint ?? '']
    expect(words.join('\n')).toContain(`${label(RUN_A)}: another run wrote the same Submission, 2 of its fields hold different values from the ones this run sent, and its Lead's Engine UUID doesn't match the Submission.`)
    for (const w of words) expect(w).not.toMatch(/__c\b/)
  })
})

describe('reading the relay sample from the database', () => {
  it('lists every relay post of the seven outcome posts no canary watches in the window, then reads back an even sample of them in time order', async () => {
    const { supabase, queries } = relayDatabase(2500)
    const { total, sample } = await readRelayPosts(supabase, '2026-10-17T12:50:00.000Z', '2026-10-18T12:50:00.000Z')
    expect(total).toBe(2500)
    expect(sample).toHaveLength(RELAY_SAMPLE_SIZE)
    expect(sample[0].execution_id).toBe('run-step-00000')
    expect(sample[1].execution_id).toBe('run-step-00025')
    expect(sample[99].execution_id).toBe('run-step-02475')
    // Three pages of ids, then one read of the sample.
    expect(queries).toHaveLength(4)
    for (const q of queries) {
      expect(q).toContainEqual(['in', ['step_namespace', RELAY_COMPARISON_POSTS]])
      expect(q).toContainEqual(['eq', ['step_type', 'webhook']])
      expect(q).toContainEqual(['gte', ['execution_started_at', '2026-10-17T12:50:00.000Z']])
      expect(q).toContainEqual(['lt', ['execution_started_at', '2026-10-18T12:50:00.000Z']])
      expect(q).toContainEqual(['not', ['is_test', 'is', true]])
    }
    // The sample read carries each post's start, which a later write is judged against (#2396).
    const sampleColumns = queries[3].find(([m]) => m === 'select')![1][0] as string
    expect(sampleColumns.split(',').map((c) => c.trim())).toContain('started_at')
    expect(STEP_COLUMNS.split(',').map((c) => c.trim())).toContain('started_at')
    expect(RELAY_COMPARISON_POSTS).not.toContain(WATCHED_STEP)
    // send_salesforce is the second canary's subject (#2174), so it is not a comparison either.
    expect(RELAY_COMPARISON_POSTS).not.toContain('send_salesforce')
    expect(RELAY_COMPARISON_POSTS).toHaveLength(7)
  })

  it('each read carries the relay filter and its own bound: the list pages under a full order, the sample is one limit (#1437)', async () => {
    const { supabase, queries } = relayDatabase(1500)
    await readRelayPosts(supabase, 'a', 'b')
    const names = (q: Array<[string, unknown[]]>) => q.map(([m]) => m)
    const [page1, page2, sampleRead] = queries
    for (const [lo, q] of [[0, page1], [1000, page2]] as const) {
      expect(q).toContainEqual(['eq', ['workflow_id', MAIN_FLOW_WORKFLOW_ID]])
      expect(q).toContainEqual(['order', ['execution_started_at', { ascending: true }]])
      expect(q).toContainEqual(['order', ['id', { ascending: true }]])
      expect(q).toContainEqual(['range', [lo, lo + 999]])
      expect(names(q)).not.toContain('limit')
    }
    expect(sampleRead).toContainEqual(['eq', ['workflow_id', MAIN_FLOW_WORKFLOW_ID]])
    expect(sampleRead).toContainEqual(['limit', [RELAY_SAMPLE_SIZE]])
    expect(names(sampleRead)).not.toContain('range')
    expect(queries).toHaveLength(3)
  })

  it('a sample read that comes back short throws, rather than comparing against fewer posts than it says', async () => {
    const { supabase } = relayDatabase(300, { dropFromSample: 3 })
    await expect(readRelayPosts(supabase, 'a', 'b')).rejects.toThrow('the relay sample read returned 99 of 100 posts')
  })

  it('a failed list read throws, so the message says the relay could not be read', async () => {
    const { supabase } = relayDatabase(10, { listError: 'canceling statement due to statement timeout' })
    await expect(readRelayPosts(supabase, 'a', 'b')).rejects.toThrow('relay post list failed: canceling statement due to statement timeout')
  })

  it('no relay posts is a total of zero and nothing read', async () => {
    const { supabase, queries } = relayDatabase(0)
    expect(await readRelayPosts(supabase, 'a', 'b')).toEqual({ total: 0, sample: [] })
    expect(queries).toHaveLength(1)
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
