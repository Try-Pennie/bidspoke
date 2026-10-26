/**
 * Two runs on one Submission are ordered by when each one's write was SENT, not
 * by when each run started (#2806, its second half).
 *
 * Salesforce keeps whichever write arrived last. On 2026-10-23 run
 * 01a1689d-3f57 started 1.6 s before 01a1689d-45b2 but its under_10000_sf_post
 * was sent 3.4 s after 45b2's, so Submission a04Ui00000OEoFFIA1 holds 3f57's
 * write and the relay sample counted 45b2 as not landed. The step times below
 * are those two step rows as read from execution_steps on 2026-10-26 (read
 * only); the bodies carry only the shape the check reads (link, ids, one
 * field), not the values those runs sent.
 *
 * A pair whose order cannot be measured (the sends overlap, or a send time is
 * not recorded and the runs' own starts do not settle it) is "order unknown":
 * counted and said apart, never read as a lost write (L540).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  runCanaryWatch,
  canaryWatchMessage,
  readSendSteps,
  INVALID_STATE_SUBJECT,
  SEND_SALESFORCE_SUBJECT,
  SEND_BOUND_MS,
  STEP_COLUMNS,
  OVERWRITE_STORM_MIN,
  type CanaryWatchDeps,
  type CanaryWatchReport,
  type CanaryWatchSubject,
  type RelayStep,
  type SendStep,
  type WatchedStep,
} from '../invalid-state-canary-watch'
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS } from '../main-flow-port/transform'
import type { SalesforceRead } from '../../engine/inquiry-post'
import type { JobRunEnding } from '../job-run-record'

const APP = 'https://bidspoke.example'
const NOW_MS = Date.parse('2026-10-23T13:00:30Z')
/** The two runs of 2026-10-23: 3f57 STARTED first, 45b2 SENT first. */
const EARLY_START = '01a1689d-3f57-7c73-a9d1-c99574ca15bc'
const LATE_START = '01a1689d-45b2-7412-88d7-70e1bcaedaa8'
const SUB = 'a04Ui00000OEoFFIA1'
const LEAD = '00QUi00000ZZZZZMAA'
/** The two under_10000_sf_post steps as recorded: 45b2 sent at 13.279, 3f57 at 16.652. */
const LATE_START_SENT = { started_at: '2026-10-23T11:55:13.279+00:00', completed_at: '2026-10-23T11:55:13.340+00:00' }
const EARLY_START_SENT = { started_at: '2026-10-23T11:55:16.652+00:00', completed_at: '2026-10-23T11:55:16.676+00:00' }

const link = (run: string) => `${APP}/workflows/${MAIN_FLOW_WORKFLOW_ID}?execution=${run}`
const tag = (run: string) => run.slice(9, 13)
const ok = (body: unknown): SalesforceRead => ({ kind: 'answer', status: 200, text: JSON.stringify(body) })

function deps(over: Partial<CanaryWatchDeps> & { steps?: WatchedStep[]; records?: Record<string, unknown>; sendSteps?: Record<string, SendStep[]> } = {}) {
  const posted: ReturnType<typeof canaryWatchMessage>[] = []
  const recorded: JobRunEnding[] = []
  const sendAsked: string[] = []
  const d: CanaryWatchDeps = {
    now: () => NOW_MS,
    appUrl: APP,
    readSteps: async () => over.steps ?? [],
    readRelay: async () => ({ total: 0, sample: [] }),
    readSendSteps: async (run) => {
      sendAsked.push(run)
      return over.sendSteps?.[run] ?? []
    },
    salesforce: async () => async (p: string) => {
      const id = /^\/sobjects\/(?:Submission__c|Lead)\/([A-Za-z0-9]+)\?fields=/.exec(p)?.[1]
      const r = id ? over.records?.[id] : undefined
      return r ? ok(r) : { kind: 'answer', status: 404, text: '[{"errorCode":"NOT_FOUND"}]' }
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
  return { d, posted, recorded, sendAsked }
}

/** What a direct write of `subject` sends from `run`: its link, its stamp, a field, and the Engine ids when the subject sends them. */
function directBody(subject: CanaryWatchSubject, run: string): Record<string, unknown> {
  return {
    PDFlow_1__c: link(run),
    Bidspoke_Write__c: `${run}:${subject.step}:0`,
    VantageScore__c: 640,
    ...(subject.checksLead ? { Engine_UUID_SO__c: `uuid-${tag(run)}`, Engine_Lead_UUID_SO__c: `lead-uuid-${tag(run)}` } : {}),
  }
}

function directStep(subject: CanaryWatchSubject, run: string, sent: { started_at: string; completed_at: string }): WatchedStep {
  return {
    execution_id: run,
    step_type: 'salesforce',
    status: 'completed',
    ...sent,
    input: { resolved: { operation: 'update', object: 'Submission__c', record_id: SUB, body: directBody(subject, run) } },
    output: { status: 204, body: null },
  }
}

/** The Submission holding `run`'s direct write, last. */
const holdingDirect = (subject: CanaryWatchSubject, run: string) => ({ ...directBody(subject, run), Lead__c: LEAD, CreatedDate: '2026-10-23T11:50:00.000+0000', LastModifiedDate: '2026-10-23T11:55:17.000+0000' })
/** Its Lead, holding `run`'s Engine ids, the copy of the Submission's first completion. */
const leadWith = (run: string) => ({ EngineUUID__c: `uuid-${tag(run)}`, EngineLeadUUID__c: `lead-uuid-${tag(run)}`, Submission_Object_ID__c: SUB })

function relayPost(run: string, sent: { started_at: string; completed_at: string }): RelayStep {
  return {
    execution_id: run,
    step_namespace: 'under_10000_sf_post',
    step_type: 'webhook',
    status: 'completed',
    ...sent,
    input: { resolved: { method: 'POST', body: { submissionId: SUB, executionId: run, UUID: `uuid-${tag(run)}`, leadUUID: `lead-uuid-${tag(run)}`, PDFlow_1__c: link(run), External_Exchange_Status__c: 'Pending' } } },
    output: { status: 200, body: { success: true } },
  }
}

/** The Submission holding `run`'s relay PATCH. */
const holdingRelay = (run: string) => ({
  PDFlow_1__c: link(run),
  Engine_UUID_SO__c: `uuid-${tag(run)}`,
  Engine_Lead_UUID_SO__c: `lead-uuid-${tag(run)}`,
  External_Exchange_Status__c: 'Pending',
  Lead__c: LEAD,
  Bidspoke_Write__c: null,
})

const sendStep = (run: string, sent: { started_at: string; completed_at: string | null }, step_namespace = 'under_10000_sf_post'): SendStep => ({ execution_id: run, step_namespace, ...sent })

const at = (ms: number) => new Date(ms).toISOString()
const mintedMs = (run: string) => parseInt(run.replace(/-/g, '').slice(0, 12), 16)

describe('the 2026-10-23 inversion: the run that started first sent last (#2806)', () => {
  it('a relay post sent BEFORE an earlier started run was overwritten by it, not lost', async () => {
    const { d, recorded } = deps({
      readRelay: async () => ({ total: 1, sample: [relayPost(LATE_START, LATE_START_SENT)] }),
      records: { [SUB]: holdingRelay(EARLY_START) },
      sendSteps: { [EARLY_START]: [sendStep(EARLY_START, EARLY_START_SENT)] },
    })
    const report = await runCanaryWatch(INVALID_STATE_SUBJECT, d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([{ kind: 'superseded', executionId: LATE_START, byExecutionId: EARLY_START }])
    expect(recorded[0].summary).toMatchObject({ relay: { superseded: 1, not_landed: 0, order_unknown: 0 } })
  })

  it('a relay post sent AFTER the run whose link the Submission holds still did not land, whichever run started first', async () => {
    // The mirror: 3f57's post is judged, and the Submission holds 45b2's write, sent 3.4 s before it.
    const { d } = deps({
      readRelay: async () => ({ total: 1, sample: [relayPost(EARLY_START, EARLY_START_SENT)] }),
      records: { [SUB]: holdingRelay(LATE_START) },
      sendSteps: { [LATE_START]: [sendStep(LATE_START, LATE_START_SENT)] },
    })
    const report = await runCanaryWatch(INVALID_STATE_SUBJECT, d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample.map((v) => v.kind)).toEqual(['not_landed'])
  })

  for (const subject of [INVALID_STATE_SUBJECT, SEND_SALESFORCE_SUBJECT]) {
    it(`two direct ${subject.step} writes in the same shape: the one sent first was overwritten, the one sent last landed`, async () => {
      const { d, posted, recorded, sendAsked } = deps({
        steps: [directStep(subject, EARLY_START, EARLY_START_SENT), directStep(subject, LATE_START, LATE_START_SENT)],
        records: { [SUB]: holdingDirect(subject, EARLY_START), [LEAD]: leadWith(EARLY_START) },
      })
      const report = await runCanaryWatch(subject, d)
      expect(report.native).toEqual([
        { kind: 'landed', executionId: EARLY_START },
        { kind: 'superseded', executionId: LATE_START, byExecutionId: EARLY_START },
      ])
      // Both runs were in the day's own steps, so no send time was looked up.
      expect(sendAsked).toEqual([])
      expect(posted[0].alert).toBe(false)
      expect(recorded[0].outcome).toBe('all_landed')
    })
  }
})

describe('a pair whose order cannot be measured is "order unknown", never lost (#2806)', () => {
  // Two direct writes whose sends overlap: B was sent before A was answered.
  const A = '01a1689d-45b2-7412-88d7-70e1bcaedaa8'
  const B = '01a1689d-45b2-7412-88d7-70e1bcaedab9'
  const A_SENT = { started_at: '2026-10-23T11:55:13.279+00:00', completed_at: '2026-10-23T11:55:13.540+00:00' }
  const B_SENT = { started_at: '2026-10-23T11:55:13.279+00:00', completed_at: '2026-10-23T11:55:13.402+00:00' }

  for (const subject of [INVALID_STATE_SUBJECT, SEND_SALESFORCE_SUBJECT]) {
    it(`a tie on send time (${subject.step}): the write Salesforce does not hold is order unknown, counted and said, and does not page`, async () => {
      const { d, posted, recorded } = deps({
        steps: [directStep(subject, A, A_SENT), directStep(subject, B, B_SENT)],
        records: { [SUB]: holdingDirect(subject, B), [LEAD]: leadWith(B) },
      })
      const report = await runCanaryWatch(subject, d)
      expect(report.native).toEqual([
        { kind: 'order_unknown', executionId: A, otherExecutionId: B, reason: 'the two were sent at nearly the same time' },
        { kind: 'landed', executionId: B },
      ])
      const m = posted[0]
      expect(m.alert).toBe(false)
      expect(m.title).toBe(`${subject.title}: 1 of 2 arrived complete and 1 was not compared`)
      expect(m.lines.join('\n')).toContain('1 more was not compared: another run also wrote the same Submission, and which of the two arrived last cannot be told.')
      expect(m.lines).toContain(
        `<${link(A)}|Run ${A}> was not compared: <${link(B)}|Run ${B}> also wrote the same Submission, and the two were sent at nearly the same time, so which arrived last cannot be told.`,
      )
      expect(m.lines.join('\n')).not.toMatch(/did not arrive|replaced/)
      expect(recorded[0].outcome).toBe('all_landed')
      expect(recorded[0].summary).toMatchObject({
        landed: 1,
        not_landed: 0,
        superseded: 0,
        order_unknown: 1,
        order_unknown_runs: [{ kind: 'order_unknown', executionId: A, otherExecutionId: B, reason: 'the two were sent at nearly the same time' }],
      })
    })
  }

  it("a later run's write whose send time is not recorded, started before this write was sent, is order unknown rather than overwritten", async () => {
    // Run C's step rows are gone; it started 5 s after A, before A's write was sent 13 s into A's run.
    const C = '01a1689d-58b2-7412-88d7-70e1bcaedac0'
    expect(mintedMs(C) - mintedMs(A)).toBe(4_864)
    const subject = SEND_SALESFORCE_SUBJECT
    const { d, sendAsked } = deps({ steps: [directStep(subject, A, A_SENT)], records: { [SUB]: holdingDirect(subject, C) } })
    const report = await runCanaryWatch(subject, d)
    expect(report.native).toEqual([{ kind: 'order_unknown', executionId: A, otherExecutionId: C, reason: "that run's send time is not recorded" }])
    expect(sendAsked).toEqual([C])
  })

  it('a relay post the same way: left out of the rate as order unknown, and said', async () => {
    const C = '01a1689d-58b2-7412-88d7-70e1bcaedac0'
    const { d, posted, recorded } = deps({
      readRelay: async () => ({ total: 1, sample: [relayPost(A, A_SENT)] }),
      records: { [SUB]: holdingRelay(C) },
    })
    const report = await runCanaryWatch(INVALID_STATE_SUBJECT, d)
    if ('error' in report.relay) throw new Error('relay read failed')
    expect(report.relay.sample).toEqual([{ kind: 'order_unknown', executionId: A, otherExecutionId: C, reason: "that run's send time is not recorded" }])
    expect(posted[0].lines[posted[0].lines.length - 1]).toBe(
      'In the same hours Pipedream sent 1 other outcome. 1 of them was left out because another run of Main Flow wrote the same Submission and which arrived last cannot be told.',
    )
    expect(recorded[0].summary).toMatchObject({ relay: { order_unknown: 1, not_landed: 0, superseded: 0 } })
  })

  it("a run whose send time is not recorded but that started after this write was answered is later: a run sends nothing before it starts", async () => {
    const D = '01a1689d-8000-7000-8000-000000000001'
    expect(mintedMs(D)).toBeGreaterThan(Date.parse(A_SENT.completed_at))
    const subject = SEND_SALESFORCE_SUBJECT
    const { d } = deps({ steps: [directStep(subject, A, A_SENT)], records: { [SUB]: holdingDirect(subject, D) } })
    const report = await runCanaryWatch(subject, d)
    expect(report.native).toEqual([{ kind: 'superseded', executionId: A, byExecutionId: D }])
  })

  it("a run whose send time is not recorded and that started more than the send bound before this write still means this write was lost: a missing record never hides a genuine loss", async () => {
    // A customer's visit eight days earlier, its step rows purged: its write was sent long before this one.
    const OLD = '01a12f00-0000-7000-8000-000000000001'
    expect(Date.parse(A_SENT.started_at) - mintedMs(OLD)).toBeGreaterThan(SEND_BOUND_MS)
    const subject = SEND_SALESFORCE_SUBJECT
    const { d, posted } = deps({ steps: [directStep(subject, A, A_SENT)], records: { [SUB]: holdingDirect(subject, OLD) } })
    const report = await runCanaryWatch(subject, d)
    expect(report.native).toEqual([{ kind: 'not_landed', executionId: A, problems: ["the Submission still holds an earlier run's write, so this run's link never arrived"], stampedBy: OLD }])
    expect(posted[0].alert).toBe(true)
  })

  it('a send time that cannot be read when it decides the verdict leaves the write could not be checked, never landed or lost', async () => {
    const C = '01a1689d-58b2-7412-88d7-70e1bcaedac0'
    const subject = SEND_SALESFORCE_SUBJECT
    const { d } = deps({
      steps: [directStep(subject, A, A_SENT)],
      records: { [SUB]: holdingDirect(subject, C) },
      readSendSteps: async () => {
        throw new Error('execution_steps read failed: timeout')
      },
    })
    const report = await runCanaryWatch(subject, d)
    expect(report.native).toEqual([
      { kind: 'unchecked', executionId: A, reason: "The send time of the run whose write the Submission holds could not be read (execution_steps read failed: timeout)." },
    ])
  })

  it("a Lead holding the ids of a run whose write overlapped this one's is order unknown, not a first completion copy and not a mismatch", async () => {
    // X started first; X and Y were sent within the same moments; the Submission holds Y, the Lead X's ids.
    const X = '01a1689d-45b2-7412-88d7-70e1bcaedaa8'
    const Y = '01a1689d-45b3-7412-88d7-70e1bcaedaa9'
    const subject = INVALID_STATE_SUBJECT
    const { d } = deps({
      steps: [directStep(subject, X, A_SENT), directStep(subject, Y, B_SENT)],
      records: { [SUB]: holdingDirect(subject, Y), [LEAD]: leadWith(X) },
    })
    const report = await runCanaryWatch(subject, d)
    expect(report.native).toEqual([
      { kind: 'order_unknown', executionId: X, otherExecutionId: Y, reason: 'the two were sent at nearly the same time' },
      { kind: 'order_unknown', executionId: Y, otherExecutionId: X, reason: 'the two were sent at nearly the same time' },
    ])
  })

  it('many writes of a day that cannot be ordered page, with their own Fix line: missing send times must not go quiet', () => {
    const u = Array.from({ length: OVERWRITE_STORM_MIN }, (_, i) => ({ kind: 'order_unknown' as const, executionId: `run-u${i}`, otherExecutionId: `run-o${i}`, reason: "that run's send time is not recorded" }))
    const native = [...Array.from({ length: 10 }, (_, i) => ({ kind: 'landed' as const, executionId: `run-${i}` })), ...u]
    const report: CanaryWatchReport = {
      from: '2026-10-22T12:50:00.000Z', to: '2026-10-23T12:50:00.000Z', native, skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: native.length,
      relay: { total: 0, sample: [], noSubmission: 0 },
    }
    const m = canaryWatchMessage(report, APP)
    expect(m.alert).toBe(true)
    expect(m.title).toBe(`Direct Salesforce writes: ${OVERWRITE_STORM_MIN} of ${native.length} were not compared`)
    expect(m.fixHint).toMatch(/^More writes than usual could not be ordered against another run/)
    expect(m.fixHint).not.toMatch(/move Main Flow back/)
    // One fewer is an ordinary day.
    expect(canaryWatchMessage({ ...report, native: native.slice(0, -1) }, APP).alert).toBe(false)
  })
})

describe('readSendSteps, the production read of another run\'s send times', () => {
  function sendDatabase(rows: SendStep[], error: string | null = null) {
    const queries: Array<Array<[string, unknown[]]>> = []
    const from = (table: string) => {
      const calls: Array<[string, unknown[]]> = [['from', [table]]]
      queries.push(calls)
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'not', 'order', 'range', 'limit']) {
        builder[m] = (...args: unknown[]) => {
          calls.push([m, args])
          return builder
        }
      }
      builder.then = (resolve: (v: unknown) => void) => resolve({ data: error ? null : rows, error: error ? { message: error } : null })
      return builder
    }
    return { supabase: { from } as unknown as SupabaseClient, queries }
  }

  it("reads that run's outcome post steps, within the partitions its start allows, under one bound", async () => {
    const rows = [sendStep(EARLY_START, EARLY_START_SENT)]
    const { supabase, queries } = sendDatabase(rows)
    expect(await readSendSteps(supabase, EARLY_START)).toEqual(rows)
    expect(queries).toHaveLength(1)
    const q = queries[0]
    expect(q).toContainEqual(['from', ['execution_steps']])
    const columns = (q.find(([m]) => m === 'select')![1][0] as string).split(',').map((c) => c.trim())
    expect(columns).toEqual(expect.arrayContaining(['execution_id', 'step_namespace', 'started_at', 'completed_at']))
    expect(q).toContainEqual(['eq', ['workflow_id', MAIN_FLOW_WORKFLOW_ID]])
    expect(q).toContainEqual(['eq', ['execution_id', EARLY_START]])
    expect(q).toContainEqual(['in', ['step_namespace', [...OUTCOME_POSTS]]])
    const minted = mintedMs(EARLY_START)
    expect(q).toContainEqual(['gte', ['started_at', at(minted - 60_000)]])
    expect(q).toContainEqual(['lt', ['started_at', at(minted + SEND_BOUND_MS)]])
    expect(q.some(([m]) => m === 'limit')).toBe(true)
  })

  it('an id that is not a UUIDv7 has no start to bound the read by, so nothing is read', async () => {
    const { supabase, queries } = sendDatabase([])
    expect(await readSendSteps(supabase, 'not-a-run')).toEqual([])
    expect(queries).toHaveLength(0)
  })

  it('a failed read throws', async () => {
    const { supabase } = sendDatabase([], 'canceling statement due to statement timeout')
    await expect(readSendSteps(supabase, EARLY_START)).rejects.toThrow('send time read failed: canceling statement due to statement timeout')
  })

  it('both step reads carry the answer time, which bounds when a write arrived', () => {
    expect(STEP_COLUMNS.split(',').map((c) => c.trim())).toContain('completed_at')
  })
})
