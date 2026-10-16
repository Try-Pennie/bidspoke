/**
 * The words of the drain's alerts (#468 step 3): a resend Salesforce refused, a
 * write given up after its tries, and a field left out because another writer
 * changed it. Objects and field names only: never a value, a record id or a run.
 */
import { describe, it, expect } from 'vitest'
import { writebackDrainMessage } from '../slack'

const all = (m: { title: string; sections: string[] }) => [m.title, ...m.sections].join('\n')
/** The en and em dash, and a hyphen used as a sentence break, built from their codes. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]|\\s${String.fromCharCode(0x2d)}\\s`)

describe('writebackDrainMessage', () => {
  it('says a refused resend in plain sentences, with where to look', () => {
    const m = writebackDrainMessage({ kind: 'refused', tries: 2, writes: [{ sf_object: 'Prospect__c', resent: true }, { sf_object: 'Lead', resent: true }, { sf_object: 'Prospect__c', resent: false }] })
    expect(m.title).toBe('Salesforce writes could not be resent')
    expect(m.sections[0]).toBe('3 Salesforce writes that failed after a lead was answered could not be resent, because Salesforce refused them: 2 to Prospect and 1 to Lead. Bidspoke will not send them again.')
    expect(m.sections[1]).toBe('*Fix:* list them at `/api/admin/held-writes?status=refused`, then set those fields by hand in Salesforce, unless the refusal was right.')
  })

  it('says one write in the singular', () => {
    const m = writebackDrainMessage({ kind: 'refused', tries: 2, writes: [{ sf_object: 'Lead', resent: true }] })
    expect(m.title).toBe('Salesforce write could not be resent')
    expect(m.sections[0]).toBe('1 Salesforce write that failed after a lead was answered could not be resent, because Salesforce refused it: 1 to Lead. Bidspoke will not send it again.')
  })

  it('says a write given up, and that one whose last try got no answer may have landed', () => {
    const m = writebackDrainMessage({ kind: 'abandoned', tries: 2, writes: [{ sf_object: 'Prospect__c', answered: true }, { sf_object: 'Prospect__c', answered: false }] })
    expect(m.title).toBe('Salesforce writes were given up')
    expect(m.sections[0]).toBe(
      '2 Salesforce writes that failed after a lead was answered did not land when Bidspoke sent them again twice: 2 to Prospect. Bidspoke has stopped trying. The last try for 1 of them got no answer, so it may have landed.',
    )
    expect(m.sections[1]).toBe('*Fix:* list them at `/api/admin/held-writes?status=abandoned`, then check each record in Salesforce and set the fields by hand where the write did not land.')
  })

  it('names the fields left out, by name only, and whether the rest was sent', () => {
    const m = writebackDrainMessage({
      kind: 'moved',
      tries: 2,
      writes: [
        { sf_object: 'Prospect__c', fields: ['Status__c', 'Amount__c'], resent: true },
        { sf_object: 'Lead', fields: ['Status'], resent: false },
      ],
    })
    expect(m.title).toBe('Salesforce writes resent without some fields')
    expect(m.sections[0]).toBe('2 Salesforce writes that failed after a lead was answered found fields changed in Salesforce since they failed, so Bidspoke left those fields as they were.')
    expect(m.sections[1]).toBe(
      'A write to Prospect was sent again without Status__c and Amount__c.\nA write to Lead was not sent again, because every field it set (Status) had changed. Bidspoke closed it.',
    )
    expect(m.sections[2]).toBe('*Fix:* open each record in Salesforce and decide whether those fields should keep their current values. The writes are listed at `/api/admin/held-writes`.')
  })

  it('escapes what it prints, and carries no dashes or emoji', () => {
    const m = writebackDrainMessage({ kind: 'moved', tries: 2, writes: [{ sf_object: 'A<b>__c', fields: ['X&Y__c'], resent: true }] })
    expect(all(m)).not.toMatch(/<b>|X&Y/)
    for (const kind of ['refused', 'abandoned', 'moved'] as const) {
      const text = all(writebackDrainMessage({ kind, tries: 2, writes: [{ sf_object: 'Prospect__c', fields: ['Status__c'], resent: true, answered: false }] }))
      expect(text).not.toMatch(DASHES)
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })
})
