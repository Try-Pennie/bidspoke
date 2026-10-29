/**
 * A sampled Pipedream post whose step failed and recorded nothing it sent (#2939).
 *
 * The 2026-10-28 direct write reports counted run 01a18160-b7e9-7e54-a11a-87c69b02a7ae
 * as "could not be checked" in the Pipedream comparison. Its engine_no_bids_sf_post
 * timed out three times at 4.5 s and, as every failed webhook step does, recorded
 * no input, so the check had no body and no Submission to read. But its run's
 * trigger payload names the Submission (every relay comparison post takes its
 * `submissionId` from the trigger payload's `Submission__c`, checked below against
 * the production definition), and that Submission held no run link: the outcome
 * never reached Salesforce. That is a lost outcome on the Pipedream route.
 *
 * So a failed relay post with nothing recorded is read back by its run link alone
 * (every outcome post sends it, and Salesforce saves one PATCH whole or not at all):
 *  - the Submission holds this run's link: it arrived, though its fields cannot
 *    be compared (`arrived_unrecorded`);
 *  - it holds no sign of it (no run link, an earlier run's, or no Submission at all)
 *    and the step failed outright: never sent (`never_sent`);
 *  - the same, but the step timed out: Pipedream may have taken it after Bidspoke
 *    stopped waiting, so it is not found in Salesforce (`not_found`), never "never sent";
 *  - a later run's link: overwritten since, set aside as any relay post is;
 *  - a read that failed, of Salesforce or of the run's Submission id: could not be
 *    checked, never lost (L11).
 * The two that are not in Salesforce count as "did not" against Pipedream.
 *
 * Every id and value here is invented.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  runCanaryWatch,
  readRunSubmissionIds,
  RELAY_COMPARISON_POSTS,
  RELAY_SAMPLE_SIZE,
  SEND_SALESFORCE_SUBJECT,
  type CanaryWatchDeps,
  type CanaryWatchMessage,
  type RelayStep,
  type SendStep,
} from '../invalid-state-canary-watch'
import { MAIN_FLOW_WORKFLOW_ID, recordIdTemplateFor } from '../main-flow-port/transform'
import { nodeByNamespace, productionMainFlow } from '../main-flow-port/__tests__/production-fixture'
import { stepTimeoutMessage } from '../../engine/retry'
import type { SalesforceRead } from '../../engine/inquiry-post'
import type { JobRunEnding } from '../job-run-record'

const APP = 'https://bidspoke.example'
const NOW_MS = Date.parse('2026-10-28T13:00:00Z')
const link = (run: string) => `${APP}/workflows/${MAIN_FLOW_WORKFLOW_ID}?execution=${run}`

// Runs minted 2026-10-28 around 07:19 UTC; the later one minted a minute after.
const FAILED_RUN = '01a18160-0000-7000-8000-000000000001'
const OK_RUN = '01a18160-0000-7000-8000-000000000002'
const LATER_RUN = '01a18190-0000-7000-8000-000000000003'
const EARLIER_RUN = '01a18100-0000-7000-8000-000000000004'
const FAILED_SUB = 'a04Ui00000FFFF1IAA'
const OK_SUB = 'a04Ui00000FFFF2IAA'

const TIMED_OUT_4500 = stepTimeoutMessage(4_500)

/** A relay post Pipedream answered: its step recorded the body it posted. */
function answeredPost(run: string, sub: string): RelayStep {
  return {
    execution_id: run,
    step_namespace: 'under_10000_sf_post',
    step_type: 'webhook',
    status: 'completed',
    started_at: '2026-10-28T07:20:20.000Z',
    completed_at: '2026-10-28T07:20:20.080Z',
    input: { resolved: { method: 'POST', url: 'https://relay.example/update-submission', headers: {}, body: { submissionId: sub, executionId: run, PDFlow_1__c: link(run), External_Exchange_Status__c: 'Pending' } } },
    output: { status: 200, body: { success: true } },
  }
}

/** A relay post whose step failed: a failed webhook step records no input and no output. */
function failedPost(run: string, error: string, over: Partial<RelayStep> = {}): RelayStep {
  return {
    execution_id: run,
    step_namespace: 'engine_no_bids_sf_post',
    step_type: 'webhook',
    status: 'failed',
    started_at: '2026-10-28T07:20:20.082Z',
    completed_at: '2026-10-28T07:20:35.082Z',
    error_message: error,
    input: null,
    output: null,
    ...over,
  }
}

const ok = (body: unknown): SalesforceRead => ({ kind: 'answer', status: 200, text: JSON.stringify(body) })

function deps(over: Partial<CanaryWatchDeps> & { sample?: RelayStep[]; records?: Record<string, SalesforceRead>; submissions?: Record<string, unknown> } = {}) {
  const asked: string[] = []
  const posted: CanaryWatchMessage[] = []
  const recorded: JobRunEnding[] = []
  const submissionReads: Array<{ ids: string[]; from: string; to: string }> = []
  const sample = over.sample ?? []
  const d: CanaryWatchDeps = {
    now: () => NOW_MS,
    appUrl: APP,
    readSteps: async () => [],
    readRelay: async () => ({ total: 3_360, sample }),
    readSendSteps: async () => [],
    readRunSubmissions: async (ids, from, to) => {
      submissionReads.push({ ids, from, to })
      const subs = over.submissions ?? { [FAILED_RUN]: FAILED_SUB }
      return new Map(ids.filter((id) => id in subs).map((id) => [id, subs[id]]))
    },
    salesforce: async () => async (p: string) => {
      asked.push(p)
      const m = /^\/sobjects\/Submission__c\/([A-Za-z0-9]+)\?fields=/.exec(p)
      const records = over.records ?? {}
      return m && records[m[1]] ? records[m[1]] : { kind: 'answer', status: 404, text: '[{"errorCode":"NOT_FOUND"}]' }
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
  return { d, asked, posted, recorded, submissionReads }
}

const relayOf = async (d: CanaryWatchDeps) => {
  const report = await runCanaryWatch(SEND_SALESFORCE_SUBJECT, d)
  if ('error' in report.relay) throw new Error('relay read failed')
  return { report, relay: report.relay }
}

const comparison = (m: CanaryWatchMessage) => m.lines.find((l) => l.startsWith('For comparison') || l.startsWith('In the same hours')) ?? ''

/** What Salesforce holds for the answered post: it landed. */
const okRecord = ok({ PDFlow_1__c: link(OK_RUN), External_Exchange_Status__c: 'Pending', Lead__c: null })

describe('a sampled Pipedream post whose step failed and recorded nothing it sent (#2939)', () => {
  it('the 2026-10-28 run: timed out, nothing recorded, and its Submission holds no run link, so it is not found and counted against Pipedream', async () => {
    const { d, asked, posted, recorded, submissionReads } = deps({
      sample: [answeredPost(OK_RUN, OK_SUB), failedPost(FAILED_RUN, TIMED_OUT_4500)],
      records: { [OK_SUB]: okRecord, [FAILED_SUB]: ok({ PDFlow_1__c: null, LastModifiedDate: '2026-10-28T07:19:00.000+0000' }) },
    })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([
      { kind: 'landed', executionId: OK_RUN },
      { kind: 'not_found', executionId: FAILED_RUN, problems: ['the Submission has no Bidspoke run link'] },
    ])
    // The Submission comes from the run's trigger payload, read once for the failed post only, within the window.
    expect(submissionReads).toEqual([{ ids: [FAILED_RUN], from: '2026-10-27T12:50:00.000Z', to: '2026-10-28T12:50:00.000Z' }])
    expect(asked.map((p) => p.split('?')[0])).toEqual([`/sobjects/Submission__c/${OK_SUB}`, `/sobjects/Submission__c/${FAILED_SUB}`])
    const line = comparison(posted[0])
    expect(line).toBe(
      'For comparison, we checked 2 of the 3,360 outcomes Pipedream sent in the same hours: 1 arrived complete and 1 did not. ' +
        '1 of those that did not timed out in Bidspoke and was not found in Salesforce: Pipedream may have taken it after Bidspoke stopped waiting, but Salesforce held no sign of it when read.',
    )
    // Never claimed as never sent, and never as could not be checked.
    expect(line).not.toMatch(/never sent|could not be checked/)
    expect(recorded[0].summary).toMatchObject({
      relay: { read: 2, landed: 1, not_landed: 0, not_found: 1, never_sent: 0, arrived_unrecorded: 0, unchecked: 0, runs: [{ kind: 'not_found', executionId: FAILED_RUN, problems: ['the Submission has no Bidspoke run link'] }] },
    })
  })

  it('a post that failed outright, not by timing out, with no sign of it on the Submission, was never sent', async () => {
    const { d, posted, recorded } = deps({
      sample: [failedPost(FAILED_RUN, 'HTTP 502 from the relay', { completed_at: '2026-10-28T07:20:20.300Z' })],
      records: { [FAILED_SUB]: ok({ PDFlow_1__c: null }) },
    })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'never_sent', executionId: FAILED_RUN, problems: ['the Submission has no Bidspoke run link'] }])
    expect(comparison(posted[0])).toBe(
      'For comparison, we checked 1 of the 3,360 outcomes Pipedream sent in the same hours: 0 arrived complete and 1 did not. ' +
        '1 of those that did not was never sent: its post failed in Bidspoke and recorded nothing it sent, and Salesforce holds no sign of it.',
    )
    expect(recorded[0].summary).toMatchObject({ relay: { never_sent: 1, not_found: 0 } })
  })

  it('a Submission that does not exist holds no sign of the post either', async () => {
    const { d } = deps({ sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)], records: {} })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'not_found', executionId: FAILED_RUN, problems: ['the Submission does not exist in Salesforce'] }])
  })

  it("a timed out post whose Submission holds this run's link arrived, though its fields cannot be compared", async () => {
    const { d, posted, recorded } = deps({
      sample: [answeredPost(OK_RUN, OK_SUB), failedPost(FAILED_RUN, TIMED_OUT_4500)],
      records: { [OK_SUB]: okRecord, [FAILED_SUB]: ok({ PDFlow_1__c: link(FAILED_RUN) }) },
    })
    const { relay } = await relayOf(d)
    expect(relay.sample[1]).toEqual({ kind: 'arrived_unrecorded', executionId: FAILED_RUN })
    expect(comparison(posted[0])).toBe(
      'For comparison, we checked 2 of the 3,360 outcomes Pipedream sent in the same hours: 1 arrived complete and 1 arrived though Bidspoke recorded its post as failed. ' +
        'The one that arrived though its post failed has its run link on its Submission, but its post recorded nothing it sent, so its fields were not compared.',
    )
    expect(recorded[0].summary).toMatchObject({ relay: { landed: 1, arrived_unrecorded: 1, runs: [] } })
  })

  it('a Salesforce answer that cannot be used is could not be checked, never not found or never sent', async () => {
    const { d, posted } = deps({
      sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)],
      records: { [FAILED_SUB]: { kind: 'answer', status: 500, text: '[{"errorCode":"UNKNOWN_EXCEPTION"}]' } },
    })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'unchecked', executionId: FAILED_RUN, reason: 'Salesforce answered the Submission read with 500 UNKNOWN_EXCEPTION.' }])
    const line = comparison(posted[0])
    expect(line).toContain('1 could not be checked')
    expect(line).not.toMatch(/never sent|not found|did not/)
  })

  it('Salesforce not answering is could not be checked, and stops the reads after it', async () => {
    const second = '01a18160-0000-7000-8000-000000000005'
    const { d, asked } = deps({
      sample: [failedPost(FAILED_RUN, TIMED_OUT_4500), failedPost(second, TIMED_OUT_4500)],
      submissions: { [FAILED_RUN]: FAILED_SUB, [second]: OK_SUB },
      records: { [FAILED_SUB]: { kind: 'no_answer', error: 'deadline exceeded' } },
    })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([
      { kind: 'unchecked', executionId: FAILED_RUN, reason: 'Salesforce did not answer the Submission read (deadline exceeded).' },
      { kind: 'unchecked', executionId: second, reason: 'Salesforce stopped answering earlier in this check.' },
    ])
    expect(asked).toHaveLength(1)
  })

  it("a failed read of the run's Submission from the database is could not be checked, and nothing is read from Salesforce", async () => {
    const { d, asked } = deps({
      sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)],
      readRunSubmissions: async () => {
        throw new Error('canceling statement due to statement timeout')
      },
    })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([
      { kind: 'unchecked', executionId: FAILED_RUN, reason: "The run's Submission could not be read from the database (canceling statement due to statement timeout)." },
    ])
    expect(asked).toHaveLength(0)
  })

  it('a run the database no longer holds is could not be checked', async () => {
    const { d } = deps({ sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)], submissions: {} })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'unchecked', executionId: FAILED_RUN, reason: "The post recorded nothing it sent, and its run is not in the database to say which Submission it was for." }])
  })

  it("a run whose trigger named no Submission is one the relay's filter stops: counted apart, read for nothing", async () => {
    const { d, asked } = deps({ sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)], submissions: { [FAILED_RUN]: null } })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([])
    expect(relay.noSubmission).toBe(1)
    expect(asked).toHaveLength(0)
  })

  it('a Submission id Salesforce would not accept is could not be checked', async () => {
    const { d } = deps({ sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)], submissions: { [FAILED_RUN]: 'not-an-id' } })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'unchecked', executionId: FAILED_RUN, reason: "The run's Submission id is not one Salesforce would accept." }])
  })

  it("a later run's link means the post was overwritten since, so it is set aside, never counted as lost", async () => {
    const { d } = deps({ sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)], records: { [FAILED_SUB]: ok({ PDFlow_1__c: link(LATER_RUN) }) } })
    const later: SendStep = { execution_id: LATER_RUN, step_namespace: 'send_salesforce', started_at: '2026-10-28T07:40:00.000Z', completed_at: '2026-10-28T07:40:00.500Z' }
    d.readSendSteps = async (run) => (run === LATER_RUN ? [later] : [])
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'superseded', executionId: FAILED_RUN, byExecutionId: LATER_RUN }])
  })

  it("an earlier run's link means this post never replaced it, so it is not found", async () => {
    const { d } = deps({ sample: [failedPost(FAILED_RUN, TIMED_OUT_4500)], records: { [FAILED_SUB]: ok({ PDFlow_1__c: link(EARLIER_RUN) }) } })
    const earlier: SendStep = { execution_id: EARLIER_RUN, step_namespace: 'send_salesforce', started_at: '2026-10-28T07:00:00.000Z', completed_at: '2026-10-28T07:00:00.500Z' }
    d.readSendSteps = async (run) => (run === EARLIER_RUN ? [earlier] : [])
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'not_found', executionId: FAILED_RUN, problems: ["the Submission's run link is not this run's"] }])
  })

  it('a post that recorded nothing but did not fail is still could not be checked, as before', async () => {
    const { d, submissionReads } = deps({ sample: [failedPost(FAILED_RUN, '', { status: 'completed', error_message: null })] })
    const { relay } = await relayOf(d)
    expect(relay.sample).toEqual([{ kind: 'unchecked', executionId: FAILED_RUN, reason: 'The run did not record what it posted to the relay.' }])
    expect(submissionReads).toHaveLength(0)
  })

  it('a day with no failed post reads no Submission ids', async () => {
    const { d, submissionReads } = deps({ sample: [answeredPost(OK_RUN, OK_SUB)], records: { [OK_SUB]: okRecord } })
    await relayOf(d)
    expect(submissionReads).toHaveLength(0)
  })

  it("the plural says each count's own words", async () => {
    const runs = ['01a18160-0000-7000-8000-000000000011', '01a18160-0000-7000-8000-000000000012', '01a18160-0000-7000-8000-000000000013', '01a18160-0000-7000-8000-000000000014']
    const subs = ['a04Ui00000GGGG1IAA', 'a04Ui00000GGGG2IAA', 'a04Ui00000GGGG3IAA', 'a04Ui00000GGGG4IAA']
    const { d, posted } = deps({
      sample: [failedPost(runs[0], TIMED_OUT_4500), failedPost(runs[1], TIMED_OUT_4500), failedPost(runs[2], 'HTTP 500'), failedPost(runs[3], 'HTTP 500')],
      submissions: Object.fromEntries(runs.map((r, i) => [r, subs[i]])),
      records: Object.fromEntries(subs.map((s) => [s, ok({ PDFlow_1__c: null })])),
    })
    await relayOf(d)
    expect(comparison(posted[0])).toBe(
      'For comparison, we checked 4 of the 3,360 outcomes Pipedream sent in the same hours: 0 arrived complete and 4 did not. ' +
        '2 of those that did not were never sent: their posts failed in Bidspoke and recorded nothing they sent, and Salesforce holds no sign of them. ' +
        '2 of those that did not timed out in Bidspoke and were not found in Salesforce: Pipedream may have taken them after Bidspoke stopped waiting, but Salesforce held no sign of them when read.',
    )
  })
})

describe('readRunSubmissionIds, the production read of the runs\' Submission ids', () => {
  function runDatabase(rows: Array<{ id: string; submission: unknown }>, error: string | null = null) {
    const calls: Array<[string, unknown[]]> = []
    const builder: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'limit']) {
      builder[m] = (...args: unknown[]) => {
        calls.push([m, args])
        return builder
      }
    }
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: error ? null : rows, error: error ? { message: error } : null })
    const from = (table: string) => {
      calls.push(['from', [table]])
      return builder
    }
    return { supabase: { from } as unknown as SupabaseClient, calls }
  }

  it("reads only the trigger's Submission__c of Main Flow's runs in the window, under one bound", async () => {
    const { supabase, calls } = runDatabase([{ id: FAILED_RUN, submission: FAILED_SUB }])
    const got = await readRunSubmissionIds(supabase, [FAILED_RUN], '2026-10-27T12:50:00.000Z', '2026-10-28T12:50:00.000Z')
    expect([...got]).toEqual([[FAILED_RUN, FAILED_SUB]])
    expect(calls).toContainEqual(['from', ['workflow_executions']])
    expect(calls).toContainEqual(['select', ['id, submission:trigger_payload->>Submission__c']])
    expect(calls).toContainEqual(['eq', ['workflow_id', MAIN_FLOW_WORKFLOW_ID]])
    expect(calls).toContainEqual(['in', ['id', [FAILED_RUN]]])
    // workflow_executions is partitioned by its start, which the relay posts' own window bounds.
    expect(calls).toContainEqual(['gte', ['started_at', '2026-10-27T12:50:00.000Z']])
    expect(calls).toContainEqual(['lt', ['started_at', '2026-10-28T12:50:00.000Z']])
    expect(calls).toContainEqual(['limit', [RELAY_SAMPLE_SIZE]])
  })

  it('no ids reads nothing', async () => {
    const { supabase, calls } = runDatabase([])
    expect((await readRunSubmissionIds(supabase, [], 'a', 'b')).size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('more ids than the sample holds is refused rather than read in part', async () => {
    const { supabase } = runDatabase([])
    const ids = Array.from({ length: RELAY_SAMPLE_SIZE + 1 }, (_, i) => `run-${i}`)
    await expect(readRunSubmissionIds(supabase, ids, 'a', 'b')).rejects.toThrow(`asked for ${RELAY_SAMPLE_SIZE + 1} runs`)
  })

  it('a failed read throws', async () => {
    const { supabase } = runDatabase([], 'canceling statement due to statement timeout')
    await expect(readRunSubmissionIds(supabase, [FAILED_RUN], 'a', 'b')).rejects.toThrow('run Submission read failed: canceling statement due to statement timeout')
  })
})

describe("every relay comparison post's Submission is its run's trigger Submission__c (production Main Flow, version 169)", () => {
  // The check reads a failed post's Submission from the trigger payload because
  // its step recorded no body. That holds only while every compared post's
  // submissionId comes from there: a text body's own template, or a code node
  // that builds it from `payload` (the trigger payload, engine/nodes/code.ts).
  const def = productionMainFlow()
  for (const post of RELAY_COMPARISON_POSTS) {
    it(post, () => {
      const template = recordIdTemplateFor(nodeByNamespace(def, post).config.body)
      expect(template, `${post} has no submissionId template`).not.toBeNull()
      if (template === '{{trigger.payload.Submission__c}}') return
      const refs = /^\{\{(.+)\}\}$/.exec(template!)![1].split('??').map((p) => p.trim())
      for (const ref of refs) {
        const m = /^steps\.(\w+)\.output\.sfBody\.submissionId$/.exec(ref)
        expect(m, `${post}: ${ref} is not a code node's sfBody.submissionId`).not.toBeNull()
        const script = String(nodeByNamespace(def, m![1]).config.script)
        const direct = /submissionId:\s*payload\.Submission__c\b/.test(script)
        // `body` a copy of the payload (`payload ?? {}` or `{ ...(payload ?? {}) }`) whose Submission__c nothing sets.
        const copiesPayload = /const body = (?:payload \?\? \{\}|\{ \.\.\.\(payload \?\? \{\}\) \});/.test(script)
        const viaBody = copiesPayload && !/\bbody\.Submission__c\s*=(?!=)/.test(script) && /submissionId:\s*body\.Submission__c\b/.test(script)
        expect(direct || viaBody, `${m![1]} does not take submissionId from the trigger payload`).toBe(true)
      }
    })
  }
})
