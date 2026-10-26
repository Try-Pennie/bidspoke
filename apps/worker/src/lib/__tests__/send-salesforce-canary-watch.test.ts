/**
 * The daily read-back of Main Flow's native `send_salesforce` writes (#2174,
 * the phase 5 canary of #1680), the same check as the invalid state one
 * (invalid-state-canary-watch.test.ts) on a second subject.
 *
 * What differs from the first canary, and is proved here:
 *  - send_salesforce runs about 1,271 times a day (#2174) where invalid state
 *    ran about 19, and one read takes about half a second (the first canary's
 *    job_runs: 230 reads in 57 to 229 s), so every write cannot be read inside
 *    the morning run. A sample of DIRECT_SAMPLE_SIZE, spread evenly over the
 *    day as the relay's is, is read back, and the message says how many were
 *    written and how many were checked;
 *  - it is switched on by a separate, visible step (Dan's apply of the
 *    `canary_send_salesforce` stage), so while Main Flow does not hold the port,
 *    nothing went direct and the check has never posted a day, it posts nothing
 *    rather than an alert a day; any one of the three makes it report;
 *  - its body sends no Engine ids, so no Lead is read and none is claimed.
 * And for both subjects: the window ends at 12:50 UTC whenever the run starts,
 * so a late run neither leaves a gap nor overlaps (#2806, its first half).
 *
 * The body is the one the native step records for send_salesforce's JSON text
 * body after the port's omit and inject, from the engine walk in
 * main-flow-port/__tests__/send-salesforce-canary.test.ts. Values are invented;
 * the field types are the org's (Tooling FieldDefinition, read 2026-10-26).
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  runCanaryWatch,
  canaryWatchWindow,
  canaryWatchMessage,
  readWatchedSteps,
  INVALID_STATE_SUBJECT,
  SEND_SALESFORCE_SUBJECT,
  SEND_SALESFORCE_WATCH_JOB,
  RELAY_COMPARISON_POSTS,
  DIRECT_SAMPLE_SIZE,
  type CanaryWatchDeps,
  type CanaryWatchReport,
  type WatchedStep,
} from '../invalid-state-canary-watch'
import { CRON_JOBS } from '../cron-heartbeat'
import { MAIN_FLOW_WORKFLOW_ID, OUTCOME_POSTS } from '../main-flow-port/transform'
import type { SalesforceRead } from '../../engine/inquiry-post'
import type { JobRunEnding } from '../job-run-record'

const APP = 'https://bidspoke.example'
const NOW_MS = Date.parse('2026-10-28T13:00:00Z')
const link = (run: string) => `${APP}/workflows/${MAIN_FLOW_WORKFLOW_ID}?execution=${run}`
const runId = (i: number) => `01a20000-0000-7000-8000-${String(i).padStart(12, '0')}`
const subId = (i: number) => `a04Ui0${String(i).padStart(9, '0')}IAA`

function sentBody(run: string): Record<string, unknown> {
  return {
    ADV_SO__c: '2',
    XBC_SO__c: '230',
    PDFlow_1__c: link(run),
    VantageScore__c: '702',
    EQXCreditPullStatus__c: 'Success',
    InternalDebtRouting__c: '25000',
    Credit_Pull_Result_ES__c: '',
    PD_Completed_Timestamp__c: '2026-10-27T15:04:05',
    Unsecured_Debt_Verified_ES__c: '',
    Monthly_Creditor_Payment_ES__c: '',
    CreditFreeze__c: false,
    PDFlow_4__c: link(run),
    Bidspoke_Write__c: `${run}:send_salesforce:0`,
  }
}

function directStep(i: number, over: Partial<WatchedStep> = {}): WatchedStep {
  const run = runId(i)
  return {
    execution_id: run,
    step_type: 'salesforce',
    status: 'completed',
    started_at: '2026-10-27T15:04:04.000Z',
    input: { resolved: { operation: 'update', object: 'Submission__c', record_id: subId(i), body: sentBody(run) } },
    output: { status: 204, body: null },
    ...over,
  }
}

const relayStep = (i: number): WatchedStep => ({ ...directStep(i), step_type: 'webhook', input: { resolved: { body: '{}' } }, output: { status: 200 } })

/** What Salesforce holds when the write landed, spelled the way Salesforce answers: numbers as numbers, blanks as null. */
function landed(i: number): Record<string, unknown> {
  return {
    ...sentBody(runId(i)),
    ADV_SO__c: 2,
    InternalDebtRouting__c: 25000,
    Credit_Pull_Result_ES__c: null,
    Unsecured_Debt_Verified_ES__c: null,
    Monthly_Creditor_Payment_ES__c: null,
    PD_Completed_Timestamp__c: '2026-10-27T15:04:05.000+0000',
    Lead__c: '00QUi00000AAAAAMAA',
    CreatedDate: '2026-10-27T15:00:00.000+0000',
    LastModifiedDate: '2026-10-27T15:04:05.000+0000',
  }
}

const ok = (body: unknown): SalesforceRead => ({ kind: 'answer', status: 200, text: JSON.stringify(body) })

function deps(over: Partial<CanaryWatchDeps> & { steps?: WatchedStep[]; records?: (id: string) => SalesforceRead | undefined; clockStepMs?: number } = {}) {
  const asked: string[] = []
  const posted: ReturnType<typeof canaryWatchMessage>[] = []
  const recorded: JobRunEnding[] = []
  const windows: Array<[string, string]> = []
  let clock = NOW_MS
  const d: CanaryWatchDeps = {
    now: () => clock,
    appUrl: APP,
    readSteps: async (from, to) => {
      windows.push([from, to])
      return over.steps ?? []
    },
    readRelay: async () => ({ total: 0, sample: [] }),
    // No other run's step rows: a run outside the day is ordered by its own start (#2806).
    readSendSteps: async () => [],
    salesforce: async () => async (p: string) => {
      asked.push(p)
      clock += over.clockStepMs ?? 0
      const m = /^\/sobjects\/(Submission__c|Lead)\/([A-Za-z0-9]+)\?fields=/.exec(p)
      return (m && over.records?.(m[2])) ?? { kind: 'answer', status: 404, text: '[{"errorCode":"NOT_FOUND"}]' }
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
  return { d, asked, posted, recorded, windows }
}

const landedRecords = (id: string) => {
  const i = Number(id.slice(6, 15))
  return Number.isFinite(i) ? ok(landed(i)) : undefined
}

describe('the windows tile however late the run starts (#2806)', () => {
  it('a run 31 minutes late reads the same 24 hours as one on time, ending at 12:50 UTC', () => {
    const onTime = canaryWatchWindow(Date.parse('2026-10-22T13:00:00Z'))
    const late = canaryWatchWindow(Date.parse('2026-10-22T13:33:44Z'))
    expect(late).toEqual(onTime)
    expect(late).toEqual({ from: '2026-10-21T12:50:00.000Z', to: '2026-10-22T12:50:00.000Z' })
  })

  it('a late day and the day after it meet exactly: no gap and no overlap', () => {
    const late = canaryWatchWindow(Date.parse('2026-10-22T13:33:44Z'))
    const next = canaryWatchWindow(Date.parse('2026-10-23T13:00:43Z'))
    expect(next.from).toBe(late.to)
  })

  it('a run before 12:50 UTC reads the day that ended at the last 12:50, never a window reaching into the future', () => {
    expect(canaryWatchWindow(Date.parse('2026-10-22T12:40:00Z'))).toEqual({ from: '2026-10-20T12:50:00.000Z', to: '2026-10-21T12:50:00.000Z' })
  })
})

describe('the two subjects', () => {
  it('send_salesforce has its own job, and the relay comparison leaves out both direct posts', () => {
    expect(SEND_SALESFORCE_SUBJECT.step).toBe('send_salesforce')
    expect(SEND_SALESFORCE_SUBJECT.job).toBe(SEND_SALESFORCE_WATCH_JOB)
    expect(SEND_SALESFORCE_WATCH_JOB).not.toBe(INVALID_STATE_SUBJECT.job)
    expect([...RELAY_COMPARISON_POSTS].sort()).toEqual(OUTCOME_POSTS.filter((p) => p !== 'send_salesforce' && p !== 'invalid_state_sf_post').sort())
  })

  it('send_salesforce is registered on the 9 AM ET daily cron with a heartbeat', () => {
    const job = CRON_JOBS.find((j) => j.id === SEND_SALESFORCE_WATCH_JOB)
    expect(job?.triggerCron).toBe('0 13 * * *')
  })
})

describe('before the stage is applied', () => {
  it('posts nothing and records the day as not switched on, when Main Flow does not hold the port and nothing went direct', async () => {
    const { d, posted, recorded, windows } = deps({ livePorted: async () => false, anyDirect: async () => false, reportedBefore: async () => false, steps: [relayStep(1)] })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.notSwitchedOn).toBe(true)
    expect(posted).toEqual([])
    expect(windows).toEqual([])
    expect(recorded.map((r) => r.outcome)).toEqual(['not_switched_on'])
  })

  it('once the check has reported a day, a later day with neither the port nor a direct write still reports, so a rollback is never silenced', async () => {
    const { d, posted, recorded } = deps({ livePorted: async () => false, anyDirect: async () => false, reportedBefore: async () => true, steps: [relayStep(1), relayStep(2)] })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.notSwitchedOn).toBeUndefined()
    expect(posted).toHaveLength(1)
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('Direct Send Salesforce writes: Main Flow is not writing directly')
    expect(recorded[0].outcome).toBe('off_direct_write')
  })

  it('the live invalid state canary, which has reported every day since Oct 17, keeps alerting after a rollback as before', async () => {
    const { d, posted } = deps({ livePorted: async () => false, anyDirect: async () => false, reportedBefore: async () => true, steps: [relayStep(1)] })
    await runCanaryWatch(INVALID_STATE_SUBJECT, d)
    expect(posted[0].title).toBe('Direct Salesforce writes: Main Flow is not writing directly')
  })

  it('whether it reported before, when that cannot be read, counts as yes', async () => {
    const { d, posted } = deps({ livePorted: async () => false, anyDirect: async () => false, reportedBefore: async () => { throw new Error('timeout') }, steps: [] })
    await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(posted).toHaveLength(1)
  })

  it('a direct write in the window reports even when Main Flow no longer holds the port: a canvas save may have undone it (#2312)', async () => {
    const { d, posted } = deps({ livePorted: async () => false, anyDirect: async () => true, steps: [directStep(1), relayStep(2)], records: landedRecords })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.notSwitchedOn).toBeUndefined()
    expect(report.lastWasRelay).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('Direct Send Salesforce writes: Main Flow is back on Pipedream')
  })

  it('Main Flow holding the port reports, even on a day nothing went direct', async () => {
    const { d, posted } = deps({ livePorted: async () => true, anyDirect: async () => false, steps: [] })
    await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(posted).toHaveLength(1)
    expect(posted[0].title).toBe('Direct Send Salesforce writes: none to check yesterday')
  })

  it('a live definition that cannot be read is read as switched on, so the day is reported rather than silenced', async () => {
    const { d, posted } = deps({ livePorted: async () => { throw new Error('statement timeout') }, anyDirect: async () => false, steps: [] })
    await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(posted).toHaveLength(1)
  })
})

describe('reading back a sample of the direct writes', () => {
  it('reads DIRECT_SAMPLE_SIZE writes spread evenly over the day, and says how many were written and how many checked', async () => {
    const steps = Array.from({ length: 1_200 }, (_, i) => directStep(i))
    const { d, asked, posted, recorded } = deps({ steps, records: landedRecords })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(DIRECT_SAMPLE_SIZE).toBe(200)
    expect(report.nativeWrites).toBe(1_200)
    expect(report.native).toHaveLength(200)
    expect(report.native.every((v) => v.kind === 'landed')).toBe(true)
    // Every sixth write, from the first: spread over the day, not the first 200.
    expect(report.native[0].executionId).toBe(runId(0))
    expect(report.native[199].executionId).toBe(runId(1_194))
    expect(report.nativeCompleted).toBe(1_200)
    // One Submission read per write, and no Lead read: this body sends no Engine ids.
    expect(asked).toHaveLength(200)
    expect(asked.every((p) => p.startsWith('/sobjects/Submission__c/'))).toBe(true)
    const m = posted[0]
    expect(m.alert).toBe(false)
    expect(m.title).toBe('Direct Send Salesforce writes: all 200 checked arrived complete')
    expect(m.lines[0]).toBe("Main Flow writes the outcome of its Send Salesforce step straight to Salesforce, while most other outcomes still go through Pipedream.")
    expect(m.lines[1]).toBe(
      'From Oct 27, 8:50 AM to Oct 28, 8:50 AM ET, 1,200 leads were written directly. We checked 200 of them, spread over those hours, and all 200 arrived complete. Each Submission has every field the run sent.',
    )
    expect(recorded[0]).toMatchObject({ outcome: 'all_landed', summary: { step: 'send_salesforce', native_writes: 1_200, native: 200, landed: 200 } })
  })

  it('a day under the sample size reads every write', async () => {
    const steps = Array.from({ length: 12 }, (_, i) => directStep(i))
    const { d, posted } = deps({ steps, records: landedRecords })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.native).toHaveLength(12)
    expect(posted[0].title).toBe('Direct Send Salesforce writes: all 12 arrived complete')
    expect(posted[0].lines[1]).toBe('From Oct 27, 8:50 AM to Oct 28, 8:50 AM ET, 12 leads were written directly, and all 12 arrived complete. Each Submission has every field the run sent.')
  })

  it('judges by the #2485 rule: landed, overwritten by a later run, and not landed, and alerts on the one that did not', async () => {
    const later = '01a30000-0000-7000-8000-000000000001'
    const records = (id: string) => {
      if (id === subId(1)) return ok({ ...landed(1), PDFlow_1__c: link(later), Bidspoke_Write__c: `${later}:send_salesforce:0` })
      if (id === subId(2)) return ok({ ...landed(2), InternalDebtRouting__c: 50000 })
      return landedRecords(id)
    }
    const { d, posted } = deps({ steps: [directStep(0), directStep(1), directStep(2)], records })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.native).toEqual([
      { kind: 'landed', executionId: runId(0) },
      { kind: 'superseded', executionId: runId(1), byExecutionId: later },
      { kind: 'not_landed', executionId: runId(2), problems: ['1 of its fields holds a different value from the one this run sent'], fields: ['InternalDebtRouting__c'] },
    ])
    expect(posted[0].alert).toBe(true)
    expect(posted[0].title).toBe('Direct Send Salesforce writes: 1 of 3 did not arrive complete')
  })

  it('a sampled day titles its counts as checked', () => {
    const report: CanaryWatchReport = {
      from: '2026-10-27T12:50:00.000Z',
      to: '2026-10-28T12:50:00.000Z',
      native: [{ kind: 'not_landed', executionId: runId(1), problems: ['the Submission does not exist in Salesforce'] }, ...Array.from({ length: 199 }, (_, i) => ({ kind: 'landed' as const, executionId: runId(i + 2) }))],
      nativeWrites: 1_271,
      skipped: [],
      relayInvalidState: 0,
      relayAfterSwitch: 0,
      lastWasRelay: false,
      nativeCompleted: 1_271,
      relay: { total: 0, sample: [], noSubmission: 0 },
    }
    const m = canaryWatchMessage(report, APP, SEND_SALESFORCE_SUBJECT)
    expect(m.title).toBe('Direct Send Salesforce writes: 1 of 200 checked did not arrive complete')
    expect(m.lines[1]).toBe('From Oct 27, 8:50 AM to Oct 28, 8:50 AM ET, 1,271 leads were written directly. We checked 200 of them, spread over those hours. 199 arrived complete and 1 did not.')
  })

  it('reads stop at the read budget, and the rest are said as not checked rather than dropped', async () => {
    const steps = Array.from({ length: 300 }, (_, i) => directStep(i))
    // Each read moves the clock two seconds: 150 reads fill a five minute budget.
    const { d, asked } = deps({ steps, records: landedRecords, clockStepMs: 2_000 })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(asked).toHaveLength(150)
    expect(report.native).toHaveLength(200)
    expect(report.native.filter((v) => v.kind === 'unchecked')).toHaveLength(50)
    expect(report.native.at(-1)).toEqual({ kind: 'unchecked', executionId: runId(298), reason: 'The direct reads ran out of time before this write.' })
  })

  it('a skipped write is counted and read for nothing, its reason said', async () => {
    const skipped = directStep(2, { output: { skipped: true, skip_reason: 'no_record_id' } })
    const { d, asked, posted } = deps({ steps: [directStep(1), skipped], records: landedRecords })
    const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(report.skipped).toEqual([{ executionId: runId(2), reason: 'no_record_id' }])
    expect(asked).toHaveLength(1)
    expect(posted[0].lines).toContain('1 more lead was not written because there was no Submission to write to.')
  })

  it('a day still all on Pipedream with the port live says Main Flow is not writing these directly', async () => {
    const { d, posted } = deps({ livePorted: async () => true, steps: [relayStep(1), relayStep(2)] })
    await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
    expect(posted[0].title).toBe('Direct Send Salesforce writes: Main Flow is not writing directly')
    expect(posted[0].lines).toContain('All 2 Send Salesforce outcomes went through Pipedream, so Main Flow is not writing them directly.')
  })
})

describe('the invalid state subject is unchanged by the second', () => {
  it('is configured to read every write and check the Lead, where send_salesforce samples and reads no Lead', () => {
    expect(INVALID_STATE_SUBJECT.sampleSize).toBeNull()
    expect(INVALID_STATE_SUBJECT.checksLead).toBe(true)
    expect(SEND_SALESFORCE_SUBJECT.checksLead).toBe(false)
  })

  it('its first line no longer says every other outcome goes through Pipedream, which stops being true once send_salesforce is direct', () => {
    const report: CanaryWatchReport = {
      from: '2026-10-27T12:50:00.000Z', to: '2026-10-28T12:50:00.000Z', native: [], skipped: [], relayInvalidState: 0, relayAfterSwitch: 0, lastWasRelay: false, nativeCompleted: 0,
      relay: { total: 0, sample: [], noSubmission: 0 },
    }
    expect(canaryWatchMessage(report, APP).lines[0]).toBe(
      "Since Oct 16, Main Flow writes the outcome for leads from states we don't serve straight to Salesforce, while most other outcomes still go through Pipedream.",
    )
  })
})

/** A fake PostgREST builder that records each read's calls and answers pages of `n` step rows. */
function stepsDatabase(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `step-${i}`, ...directStep(i) }))
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
    builder.then = (resolve: (v: unknown) => void) => {
      const [lo, hi] = calls.find(([m]) => m === 'range')![1] as [number, number]
      resolve({ data: rows.slice(lo, hi + 1), error: null })
    }
    return builder
  }
  return { supabase: { from } as unknown as SupabaseClient, queries }
}

describe('readWatchedSteps, the production read', () => {
  it('pages past PostgREST 1,000 rows under a full order, oldest first', async () => {
    const { supabase, queries } = stepsDatabase(1_300)
    const rows = await readWatchedSteps(supabase, 'send_salesforce', 'a', 'b', 5_000)
    expect(rows).toHaveLength(1_300)
    expect(queries).toHaveLength(2)
    for (const q of queries) {
      expect(q).toContainEqual(['eq', ['workflow_id', MAIN_FLOW_WORKFLOW_ID]])
      expect(q).toContainEqual(['eq', ['step_namespace', 'send_salesforce']])
      expect(q).toContainEqual(['not', ['is_test', 'is', true]])
      expect(q).toContainEqual(['order', ['execution_started_at', { ascending: true }]])
      expect(q).toContainEqual(['order', ['id', { ascending: true }]])
    }
  })

  it('a day past its bound throws rather than reading part of it', async () => {
    const { supabase } = stepsDatabase(1_000)
    await expect(readWatchedSteps(supabase, 'invalid_state_sf_post', 'a', 'b', 1_000)).rejects.toThrow(/did not reach its last row/)
  })
})
