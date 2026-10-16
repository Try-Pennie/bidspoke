/**
 * `readBackHoldsStep` (#2024): whether the Salesforce read-back holds one step's
 * write as its own, asked of the at-risk record the real watch wrote, through the
 * read-back's own classifier. The engine's unfinished work alert stays quiet only
 * on this answer, so it must be the read-back's answer and nothing else's.
 */
import { describe, it, expect } from 'vitest'
import { readBackHoldsStep } from '../salesforce-read-back'
import { startAtRiskWatch, type SalesforceRequestNote } from '../../engine/at-risk-writes'
import { writeMarker } from '../../engine/write-marker'
import { CREDIT_INQUIRY_APEX_PATH } from '../../engine/inquiry-post'
import { VirtualClock } from './_virtual-clock'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 5)).toString('base64')
const OTHER_KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 77)).toString('base64')
const EXEC = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

function kv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(k: string) { return store.get(k) ?? null },
    async put(k: string, v: string) { store.set(k, v) },
    async delete(k: string) { store.delete(k) },
    async list() { return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true } },
  }
}

/** Writes the at-risk record exactly as the walk does: a write still out after 2 s, never settled. */
async function hold(store: ReturnType<typeof kv>, step: string, req: SalesforceRequestNote) {
  const clock = new VirtualClock()
  const watch = startAtRiskWatch({ kv: store, keys: KEY, clock, run: { orgId: 'org-1', workflowId: 'wf-1', executionId: EXEC }, stepNamespace: step })
  watch.note(req)
  await clock.run()
  expect(await watch.settle('unknown')).not.toBeNull()
}

const prospect = (body: Record<string, unknown>): SalesforceRequestNote => ({ object: 'Prospect__c', record_id: 'a06Ui00002sLkNuIAK', operation: 'update', body })

describe('readBackHoldsStep (#2024)', () => {
  it('holds a stamped post-answer update the watch recorded', async () => {
    const store = kv()
    await hold(store, 'patch_prospect', prospect({ BidStatus__c: 'Rejected', Bidspoke_Write__c: writeMarker(EXEC, 'patch_prospect', 0) }))
    expect(await readBackHoldsStep(store, KEY, EXEC, 'patch_prospect')).toBe(true)
  })

  it('does not hold an update recorded without its own stamp', async () => {
    const store = kv()
    await hold(store, 'patch_prospect', prospect({ BidStatus__c: 'Rejected' }))
    expect(await readBackHoldsStep(store, KEY, EXEC, 'patch_prospect')).toBe(false)
  })

  it('does not hold an update on an object with no marker field', async () => {
    const store = kv()
    await hold(store, 'patch_opportunity', { object: 'Opportunity', record_id: '006Ui00000AbCdEFGH', operation: 'update', body: { StageName: 'Won', Bidspoke_Write__c: writeMarker(EXEC, 'patch_opportunity', 0) } })
    expect(await readBackHoldsStep(store, KEY, EXEC, 'patch_opportunity')).toBe(false)
  })

  it('holds a credit inquiry post the watch recorded', async () => {
    const store = kv()
    await hold(store, 'inquiry_apex_main', { object: 'Submission__c', record_id: 'a0XUi00000AbCdEFGH', operation: 'apex', apex_path: CREDIT_INQUIRY_APEX_PATH, body: { submissionId: 'a0XUi00000AbCdEFGH', inquiriesJson: '{"inquiries":[]}' } })
    expect(await readBackHoldsStep(store, KEY, EXEC, 'inquiry_apex_main')).toBe(true)
  })

  it('does not hold a step with no record', async () => {
    expect(await readBackHoldsStep(kv(), KEY, EXEC, 'patch_prospect')).toBe(false)
  })

  it('does not hold a record of another step of the same run', async () => {
    const store = kv()
    await hold(store, 'patch_prospect', prospect({ BidStatus__c: 'Rejected', Bidspoke_Write__c: writeMarker(EXEC, 'patch_prospect', 0) }))
    expect(await readBackHoldsStep(store, KEY, EXEC, 'patch_lead')).toBe(false)
  })

  it('does not hold a record the keys cannot open', async () => {
    const store = kv()
    await hold(store, 'patch_prospect', prospect({ BidStatus__c: 'Rejected', Bidspoke_Write__c: writeMarker(EXEC, 'patch_prospect', 0) }))
    expect(await readBackHoldsStep(store, OTHER_KEY, EXEC, 'patch_prospect')).toBe(false)
  })
})
