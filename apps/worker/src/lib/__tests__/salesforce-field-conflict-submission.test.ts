/**
 * A Main Flow Send Salesforce resend on a Submission (2026-10-27).
 *
 * The update timed out, and before the read-back resent it, the run's own
 * Inquiries relay (Pipedream) wrote PDFlow_4__c and VantageScore__c on the same
 * Submission. So the record read as written since, and every field still holding
 * the value it was created with (ADV_SO__c, XBC_SO__c, EQXCreditPullStatus__c,
 * Credit_Pull_Result_ES__c) was called moved and left out, because Salesforce
 * kept no history of those fields. The fix was to track them, which needs no
 * code: these tests pin that the existing rule asks Submission__History, sends
 * a tracked field nobody changed, and still leaves out one a person changed.
 *
 * The times, the "Not Run" values and the values sent are the run's own. The
 * ADV_SO__c and XBC_SO__c values held are stand ins: the alert does not quote
 * them, since a text field can hold a lead's personal data.
 */
import { describe, it, expect } from 'vitest'
import { fieldsMovedSince, readFieldHistory, type HistoryGet } from '../salesforce-field-conflict'

const RECORD_ID = 'a04000000000001AAA'
/** When the Send Salesforce step started. */
const SINCE_MS = Date.parse('2026-10-27T16:44:34.938Z')

const FIELDS = ['ADV_SO__c', 'XBC_SO__c', 'EQXCreditPullStatus__c', 'Credit_Pull_Result_ES__c', 'PDFlow_4__c']
const FIXED = ['ADV_SO__c', 'XBC_SO__c', 'EQXCreditPullStatus__c', 'Credit_Pull_Result_ES__c']

const body: Record<string, unknown> = {
  ADV_SO__c: '1',
  XBC_SO__c: '111',
  EQXCreditPullStatus__c: 'Success',
  Credit_Pull_Result_ES__c: '',
  PDFlow_4__c: 'https://bidspoke.example/run',
}

/** The record as the resend read it: written since by the relay, the rest as created. */
const current: Record<string, unknown> = {
  LastModifiedDate: '2026-10-27T16:44:36.000+0000',
  ADV_SO__c: '0',
  XBC_SO__c: '000',
  EQXCreditPullStatus__c: 'Not Run',
  Credit_Pull_Result_ES__c: 'Not Run',
  PDFlow_4__c: 'https://relay.example/inspect',
}

/** Salesforce answering the two history queries for one Submission. */
function salesforce(tracked: string[], history: Array<{ Field: string; CreatedDate: string }>) {
  const asked: string[] = []
  const get: HistoryGet = async (path) => {
    const soql = decodeURIComponent(path.slice('/query?q='.length))
    asked.push(soql)
    const names = [...(soql.match(/IN \(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    if (/FROM FieldDefinition /.test(soql)) {
      const records = names.map((f) => ({ QualifiedApiName: f, DataType: 'Text(255)', IsFieldHistoryTracked: tracked.includes(f) }))
      return { kind: 'answer', status: 200, text: JSON.stringify({ totalSize: records.length, done: true, records }) }
    }
    if (soql.includes(`FROM Submission__History WHERE ParentId = '${RECORD_ID}'`)) {
      const records = history.filter((h) => names.includes(h.Field))
      return { kind: 'answer', status: 200, text: JSON.stringify({ totalSize: records.length, done: true, records }) }
    }
    return { kind: 'answer', status: 400, text: '[]' }
  }
  return { get, asked }
}

async function movedWith(tracked: string[], history: Array<{ Field: string; CreatedDate: string }> = []) {
  const sf = salesforce(tracked, history)
  const read = await readFieldHistory(sf.get, { sfObject: 'Submission__c', recordId: RECORD_ID, fields: FIELDS, sinceMs: SINCE_MS })
  if (read.kind === 'no_answer') throw new Error('the double always answers')
  return { moved: fieldsMovedSince({ fields: FIELDS, body, current, sinceMs: SINCE_MS, earlier: [], history: read }), asked: sf.asked }
}

describe('a Submission resend after the run wrote the record through its relay', () => {
  it('leaves out every field still holding its created value while none is tracked (the 2026-10-27 alert)', async () => {
    const { moved } = await movedWith([])
    expect(moved).toEqual(FIELDS)
  })

  it('asks Submission__History, and sends the tracked fields nobody changed since the write began', async () => {
    const { moved, asked } = await movedWith(FIXED, [
      // Set when the Submission was created, a minute before the write began.
      { Field: 'EQXCreditPullStatus__c', CreatedDate: '2026-10-27T16:43:42.000+0000' },
    ])
    expect(asked.some((q) => q.includes('FROM Submission__History'))).toBe(true)
    // PDFlow_4__c is not tracked, and the relay really did write it.
    expect(moved).toEqual(['PDFlow_4__c'])
  })

  it('still leaves out a tracked field a person changed after the write began', async () => {
    const { moved } = await movedWith(FIXED, [{ Field: 'EQXCreditPullStatus__c', CreatedDate: '2026-10-27T16:46:10.000+0000' }])
    expect(moved).toEqual(['EQXCreditPullStatus__c', 'PDFlow_4__c'])
  })
})
