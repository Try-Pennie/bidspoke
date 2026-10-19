/**
 * A customer's repeat visit to the same Submission, in the invalid state
 * canary watch (#2485).
 *
 * The 2026-10-19 report counted 2 of 17 direct writes as not landed, and both
 * were one customer's two Main Flow runs 15 minutes apart writing Submission
 * a04Ui00000O0URhIAN with a 204. Reproduced from those runs' real records
 * (fixtures/invalid-state-repeat-visit-2026-10-18.ts): before this change the
 * check returned exactly the two verdicts the job run record holds, the first
 * run "Another write has stamped the Submission since" with five differing
 * fields, the second "The Lead's Engine UUID and Engine Lead UUID differ from
 * the Submission's".
 *
 * Two rules, each here with the genuine loss it must not hide:
 *  - a direct write whose stamp names a LATER run of the same step, whose link
 *    the Submission holds, was overwritten by that run: set aside, said and
 *    counted, and an overwrite storm pages;
 *  - a Lead that names this Submission and holds the Engine ids an EARLIER run
 *    wrote to it is Salesforce's first completion copy (SubmissionService copies
 *    the ids only when Completed_Submission_SO__c changes to Yes), not a lost
 *    write.
 */
import { describe, it, expect } from 'vitest'
import { runInvalidStateWatch, canaryWatchMessage, OVERWRITE_STORM_MIN, type CanaryWatchDeps, type CanaryWatchReport, type WatchedStep } from '../invalid-state-canary-watch'
import type { SalesforceRead } from '../../engine/inquiry-post'
import type { JobRunEnding } from '../job-run-record'
import {
  REPEAT_VISIT_APP as APP,
  REPEAT_RUN_1 as RUN_1,
  REPEAT_RUN_2 as RUN_2,
  REPEAT_SUBMISSION as SUB,
  REPEAT_LEAD as LEAD,
  REPEAT_REPORT_NOW_MS as NOW_MS,
  REPEAT_STEP_1 as STEP_1,
  REPEAT_STEP_2 as STEP_2,
  REPEAT_SUBMISSION_RECORD as SUB_RECORD,
  REPEAT_LEAD_RECORD as LEAD_RECORD,
} from './fixtures/invalid-state-repeat-visit-2026-10-18'

/** A third visit, minted after the second. */
const RUN_3 = '01a14fdd-6c10-7000-8000-000000000003'
/** A run of the same day minted BEFORE the first. */
const RUN_0 = '01a14f90-0000-7000-8000-000000000000'
const OTHER_SUB = 'a04Ui00000O0OLDIAN'

const link = (run: string) => `${APP}/workflows/60e2e0bc-5aa2-47db-b333-3a8fe1c62e09?execution=${run}`
const stamp = (run: string, step = 'invalid_state_sf_post', attempt = 0) => `${run}:${step}:${attempt}`
const bodyOf = (s: WatchedStep) => (s.input as { resolved: { body: Record<string, unknown> } }).resolved.body

/** A step of `run` sending the same body as the second visit but with its own link, stamp and Engine ids. */
function visit(run: string, ids: { uuid: string; lead: string }, sub = SUB): WatchedStep {
  const body = { ...bodyOf(STEP_2), PDFlow_1__c: link(run), PDFlow_4__c: link(run), Bidspoke_Write__c: stamp(run), Engine_UUID_SO__c: ids.uuid, Engine_Lead_UUID_SO__c: ids.lead }
  return { ...STEP_2, execution_id: run, input: { resolved: { ...(STEP_2.input as { resolved: Record<string, unknown> }).resolved, record_id: sub, body } } }
}

/** What the Submission holds once `step`'s write is the last to land. */
function holding(step: WatchedStep, over: Record<string, unknown> = {}): Record<string, unknown> {
  const b = bodyOf(step)
  return {
    ...SUB_RECORD,
    Bidspoke_Write__c: b.Bidspoke_Write__c,
    PDFlow_1__c: b.PDFlow_1__c,
    PDFlow_4__c: b.PDFlow_4__c,
    Engine_UUID_SO__c: b.Engine_UUID_SO__c,
    Engine_Lead_UUID_SO__c: b.Engine_Lead_UUID_SO__c,
    External_Timestamp__c: b.External_Timestamp__c,
    PD_Completed_Timestamp__c: b.PD_Completed_Timestamp__c,
    ...over,
  }
}

const ok = (body: unknown): SalesforceRead => ({ kind: 'answer', status: 200, text: JSON.stringify(body) })

function deps(opts: { steps: WatchedStep[]; records: Record<string, unknown>; prior?: WatchedStep[] | Error }) {
  const posted: ReturnType<typeof canaryWatchMessage>[] = []
  const windows: Array<[string, string]> = []
  const runs: JobRunEnding[] = []
  const d: CanaryWatchDeps = {
    now: () => NOW_MS,
    appUrl: APP,
    readSteps: async (from, to) => {
      windows.push([from, to])
      if (windows.length === 1) return opts.steps
      if (opts.prior instanceof Error) throw opts.prior
      return opts.prior ?? []
    },
    readRelay: async () => ({ total: 0, sample: [] }),
    salesforce: async () => async (p: string) => {
      const id = /^\/sobjects\/(?:Submission__c|Lead)\/([A-Za-z0-9]+)\?fields=/.exec(p)?.[1]
      const r = id ? opts.records[id] : undefined
      return r ? ok(r) : { kind: 'answer', status: 404, text: '[{"errorCode":"NOT_FOUND"}]' }
    },
    post: async (m) => {
      posted.push(m)
      return true
    },
    recordRun: async (_s, ending) => {
      runs.push(ending)
    },
  }
  return { d, posted, windows, runs }
}

describe('a repeat visit to the same Submission (#2485)', () => {
  it('the 2026-10-19 runs: the first was overwritten by the second, and the second landed with its Lead holding the first completion copy', async () => {
    const { d, posted, runs, windows } = deps({ steps: [STEP_1, STEP_2], records: { [SUB]: SUB_RECORD, [LEAD]: LEAD_RECORD } })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([
      { kind: 'superseded', executionId: RUN_1, byExecutionId: RUN_2 },
      { kind: 'moved_on', executionId: RUN_2, laterWrite: [], newerSubmission: false, leadFromEarlierRun: RUN_1 },
    ])
    // The earlier run was in the day's own steps, so the day before was not read.
    expect(windows).toHaveLength(1)

    const m = posted[0]
    expect(m.alert).toBe(false)
    expect(m.fixHint).toBeUndefined()
    expect(m.title).toBe('1 of 2 invalid state writes landed in Salesforce and 1 was overwritten by a later run')
    expect(m.lines[0]).toBe(
      '2 Main Flow runs wrote an invalid state outcome straight to Salesforce from Oct 18, 8:50 AM EDT to Oct 19, 8:50 AM EDT. ' +
        "1 landed fully: the Submission took the run's link and every field it sent, and its Lead carries the same Engine ids. " +
        "Of those, 1 wrote a Submission an earlier run had already completed, so its Lead keeps that run's Engine ids, which Salesforce copies only at the first completion, and was not compared. " +
        "1 more was overwritten since by a later run's write to the same Submission, so it was not compared.",
    )
    expect(m.lines.join('\n')).not.toMatch(/did not land|roll/)

    expect(runs[0].outcome).toBe('all_landed')
    expect(runs[0].summary).toMatchObject({
      native: 2,
      landed: 1,
      not_landed: 0,
      superseded: 1,
      superseded_runs: [{ kind: 'superseded', executionId: RUN_1, byExecutionId: RUN_2 }],
      lead_from_first_completion: 1,
    })
  })

  it('the direct writes are compared with the relay on the same measure, the overwritten one said and left out', async () => {
    const { d, posted } = deps({ steps: [STEP_1, STEP_2], records: { [SUB]: SUB_RECORD, [LEAD]: LEAD_RECORD } })
    d.readRelay = async () => ({ total: 3, sample: [] })
    await runInvalidStateWatch(d)
    expect(posted[0].lines.join('\n')).toContain(
      'The direct writes on the same measure: 1 of 1 landed fully (100.0%), and 1 more was left out because a later run wrote the same Submission.',
    )
  })

  it("a Submission holding an EARLIER run's stamp means this run's write did not land, and is never set aside", async () => {
    // The first visit's write is the one Salesforce holds, whole: the second's is lost.
    const { d, posted } = deps({ steps: [STEP_1, STEP_2], records: { [SUB]: holding(STEP_1), [LEAD]: LEAD_RECORD } })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'landed', executionId: RUN_1 })
    expect(report.native[1]).toMatchObject({ kind: 'not_landed', executionId: RUN_2 })
    expect((report.native[1] as { problems: string[] }).problems[0]).toBe(`Another write has stamped the Submission since (run ${RUN_1}), so a difference below may be that write's.`)
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('1 of 2 invalid state writes did not land in Salesforce')
    expect(posted[0].fixHint).toContain('roll Main Flow back')
  })

  it('a stamp that cannot be read, or names a later run of a DIFFERENT step, or a later run whose link the Submission does not hold, is not a later run overwriting this one', async () => {
    for (const over of [
      { Bidspoke_Write__c: 'not a stamp' },
      { Bidspoke_Write__c: stamp(RUN_2, 'send_salesforce') },
      { PDFlow_1__c: link(RUN_3) },
    ]) {
      const { d } = deps({ steps: [STEP_1], records: { [SUB]: holding(STEP_2, over), [LEAD]: LEAD_RECORD } })
      const report = await runInvalidStateWatch(d)
      expect(report.native.map((v) => v.kind)).toEqual(['not_landed'])
    }
  })

  it("a stamp naming a run minted in the same millisecond or earlier is not a later run, even when the Submission holds that run's link", async () => {
    // Sorts after the first run's id as text, but was minted in the same millisecond.
    const sameMs = `${RUN_1.slice(0, 19)}bfff-ffffffffffff`
    for (const other of [sameMs, RUN_0]) {
      const { d } = deps({ steps: [STEP_1], records: { [SUB]: holding(visit(other, { uuid: 'x', lead: 'y' })), [LEAD]: LEAD_RECORD } })
      const report = await runInvalidStateWatch(d)
      expect(report.native.map((v) => v.kind)).toEqual(['not_landed'])
    }
  })

  it("a Lead matching no run's Engine ids is still a mismatch", async () => {
    const { d } = deps({ steps: [STEP_1, STEP_2], records: { [SUB]: SUB_RECORD, [LEAD]: { ...LEAD_RECORD, EngineUUID__c: 'uuid-nobody', EngineLeadUUID__c: 'lead-uuid-nobody' } } })
    const report = await runInvalidStateWatch(d)
    expect(report.native[1]).toEqual({ kind: 'not_landed', executionId: RUN_2, problems: ["The Lead's Engine UUID and Engine Lead UUID differ from the Submission's."] })
  })

  it("a Lead holding a LATER run's Engine ids is not a first completion copy", async () => {
    // The second visit is judged; its Lead holds the ids a third visit sent to the same Submission.
    const third = visit(RUN_3, { uuid: 'uuid-third', lead: 'lead-uuid-third' })
    const { d } = deps({ steps: [STEP_2, third], records: { [SUB]: SUB_RECORD, [LEAD]: { ...LEAD_RECORD, EngineUUID__c: 'uuid-third', EngineLeadUUID__c: 'lead-uuid-third' } } })
    const report = await runInvalidStateWatch(d)
    expect(report.native[0]).toEqual({ kind: 'not_landed', executionId: RUN_2, problems: ["The Lead's Engine UUID and Engine Lead UUID differ from the Submission's."] })
  })

  it("an earlier run's ids on a Lead that names ANOTHER Submission, or that the earlier run wrote to another Submission, are not this Submission's first completion", async () => {
    const elsewhere = visit(RUN_1, { uuid: bodyOf(STEP_1).Engine_UUID_SO__c as string, lead: bodyOf(STEP_1).Engine_Lead_UUID_SO__c as string }, OTHER_SUB)
    for (const c of [
      { steps: [STEP_1, STEP_2], lead: { ...LEAD_RECORD, Submission_Object_ID__c: OTHER_SUB } },
      { steps: [elsewhere, STEP_2], lead: LEAD_RECORD },
    ]) {
      const { d } = deps({ steps: c.steps, records: { [SUB]: SUB_RECORD, [LEAD]: c.lead, [OTHER_SUB]: { ...SUB_RECORD, CreatedDate: '2026-10-18T15:00:00.000+0000' } } })
      const report = await runInvalidStateWatch(d)
      expect(report.native.find((v) => v.executionId === RUN_2)?.kind).toBe('not_landed')
    }
  })

  it('a Lead whose Engine ids are blank is never matched to an earlier run that sent blanks', async () => {
    const blankFirst = visit(RUN_1, { uuid: '', lead: '' })
    const { d } = deps({ steps: [blankFirst, STEP_2], records: { [SUB]: SUB_RECORD, [LEAD]: { ...LEAD_RECORD, EngineUUID__c: null, EngineLeadUUID__c: null } } })
    const report = await runInvalidStateWatch(d)
    expect(report.native.find((v) => v.executionId === RUN_2)?.kind).toBe('not_landed')
  })

  it('an earlier visit the day before is read from the day before, only when the day itself has none', async () => {
    const { d, windows, posted } = deps({ steps: [STEP_2], prior: [STEP_1], records: { [SUB]: SUB_RECORD, [LEAD]: LEAD_RECORD } })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([{ kind: 'moved_on', executionId: RUN_2, laterWrite: [], newerSubmission: false, leadFromEarlierRun: RUN_1 }])
    expect(windows).toEqual([
      ['2026-10-18T12:50:42.666Z', '2026-10-19T12:50:42.666Z'],
      ['2026-10-17T12:50:42.666Z', '2026-10-18T12:50:42.666Z'],
    ])
    expect(posted[0].alert).toBe(false)
  })

  it('the day before that cannot be read leaves the run could not be checked, never landed', async () => {
    const { d } = deps({ steps: [STEP_2], prior: new Error('execution_steps read failed: timeout'), records: { [SUB]: SUB_RECORD, [LEAD]: LEAD_RECORD } })
    const report = await runInvalidStateWatch(d)
    expect(report.native).toEqual([
      { kind: 'unchecked', executionId: RUN_2, reason: "Main Flow's runs of the day before could not be read to compare the Lead against (execution_steps read failed: timeout)." },
    ])
  })

  it('an overwrite storm pages: many runs set aside as overwritten by later runs is not a quiet day', async () => {
    const native = [
      ...Array.from({ length: 15 }, (_, i) => ({ kind: 'landed' as const, executionId: `run-${i}` })),
      ...Array.from({ length: OVERWRITE_STORM_MIN }, (_, i) => ({ kind: 'superseded' as const, executionId: `old-${i}`, byExecutionId: `new-${i}` })),
    ]
    const report: CanaryWatchReport = {
      from: '2026-10-18T12:50:00.000Z', to: '2026-10-19T12:50:00.000Z', native, skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: native.length,
      relay: { total: 0, sample: [], noSubmission: 0 },
    }
    const m = canaryWatchMessage(report, APP)
    expect(m.alert).toBe(true)
    expect(m.title).toBe(`${OVERWRITE_STORM_MIN} of ${native.length} invalid state writes were overwritten by a later run of Main Flow`)
    expect(m.lines).toContain(`<${link('old-0')}|Run old-0> was overwritten by <${link('new-0')}|Run new-0>.`)
    expect(m.fixHint).toMatch(/^More runs than usual wrote a Submission another run wrote after them\./)
    expect(m.fixHint).not.toMatch(/roll/)

    // End to end, the job run record says so too.
    const later = ['01a14fdd-6c10-7000-8000-00000000000a', '01a14fdd-6c10-7000-8000-00000000000b', '01a14fdd-6c10-7000-8000-00000000000c']
    const subs = ['a04Ui00000O0AAAIAA', 'a04Ui00000O0BBBIAB', 'a04Ui00000O0CCCIAC']
    const first = later.map((_, i) => visit(`01a14fbd-04b3-72f7-8cfa-00000000000${i}`, { uuid: `u${i}`, lead: `l${i}` }, subs[i]))
    const records = Object.fromEntries(subs.map((sub, i) => [sub, holding(visit(later[i], { uuid: `v${i}`, lead: `m${i}` }, sub))]))
    const e2e = deps({ steps: first, records })
    const r = await runInvalidStateWatch(e2e.d)
    expect(r.native.map((v) => v.kind)).toEqual(['superseded', 'superseded', 'superseded'])
    expect(e2e.posted[0].alert).toBe(true)
    expect(e2e.runs[0].outcome).toBe('overwrite_storm')

    // One fewer, or the same count in a day ten times busier, is the ordinary repeat visit.
    for (const n of [native.slice(0, -1), [...native, ...Array.from({ length: 200 }, (_, i) => ({ kind: 'landed' as const, executionId: `more-${i}` }))]]) {
      const quiet = canaryWatchMessage({ ...report, native: n, nativeCompleted: n.length }, APP)
      expect(quiet.alert).toBe(false)
    }
  })
})
