/**
 * The wording of the Salesforce read-back's alerts (#2023): a plain title, short
 * full sentences, times in ET, the record and the field names a write set, and
 * no value, which is lead data, except the two values of a field a conflict
 * alert left out (#2264), so a person can decide without opening the run.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { composeSalesforceReadBackAlert, NAMED_WRITES, type ReadBackAlertWrite, type SalesforceReadBackAlert } from '../salesforce-read-back-alert'
import { sendSalesforceReadBackAlert } from '../slack'
import { slackPostOf } from '../../__tests__/helpers/slack-fetch'

const APP = 'https://app.test'
// 00:29 UTC on Oct 15 is 8:29 PM ET on Oct 14.
const write = (over: Partial<ReadBackAlertWrite> = {}): ReadBackAlertWrite => ({
  workflow_id: 'wf-1',
  workflow_name: 'Engine Bidding Workflow',
  execution_id: '01a13cf7-0191-7dc3-aada-59ceeacc1616',
  sf_object: 'Prospect__c',
  sf_record_id: 'a06Ui00002sLkNuIAK',
  fields: ['BidStatus__c', 'RejectionReason__c'],
  first_attempt_at: '2026-10-15T00:29:54.000Z',
  expires_at: '2026-10-16T00:29:56.000Z',
  resends: 1,
  ...over,
})

const text = (p: SalesforceReadBackAlert) => {
  const c = composeSalesforceReadBackAlert(p, APP)
  return [c.title, ...c.sections, c.fallback].join('\n')
}

/** House style: no em or en dash. Built from char codes, so this file holds neither. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2014, 0x2013)}]`)

describe('composeSalesforceReadBackAlert', () => {
  it('a refused resend names the run, the record, the fields and what Salesforce said', () => {
    const c = composeSalesforceReadBackAlert({ kind: 'resend_failed', writes: [write({ detail: 'Salesforce answered 400 FIELD_CUSTOM_VALIDATION_EXCEPTION' })] }, APP)
    expect(c.title).toBe('Salesforce update could not be resent')
    expect(c.sections[0]).toBe(
      'Engine Bidding Workflow answered a lead at 8:29 PM ET, and a Salesforce update after the answer did not land. ' +
        'Bidspoke sent it again and it failed: Salesforce answered 400 FIELD_CUSTOM_VALIDATION_EXCEPTION. It was updating Prospect a06Ui00002sLkNuIAK, setting BidStatus__c and RejectionReason__c.',
    )
    expect(c.sections.at(-1)).toBe(`<${APP}/workflows/wf-1?execution=01a13cf7-0191-7dc3-aada-59ceeacc1616|View the run →>`)
  })

  it('a write still not confirmed says how often it was tried and when the request is deleted, in ET', () => {
    const t = text({ kind: 'unknown', writes: [write({ resends: 2, still_trying: false })] })
    expect(t).toContain('Bidspoke sent it again twice without an answer from Salesforce, so it is still not known whether it landed.')
    expect(t).toContain('Bidspoke has stopped trying, and holds the request until 8:29 PM ET on Oct 15.')
    expect(t).toContain('Fix: before 8:29 PM ET on Oct 15, open that Prospect in Salesforce and check those fields.')
  })

  it('a write it could not resend at all does not claim a resend was sent', () => {
    const t = text({ kind: 'unknown', writes: [write({ resends: 0, still_trying: true })] })
    expect(t).toContain('Bidspoke read the record back and the update was not there, and it has not been able to send it again.')
    expect(t).not.toMatch(/sent it again/)
  })

  it('a conflict names the fields left out and the rate for each, and says the rest was written', () => {
    const t = text({
      kind: 'conflict',
      writes: [write({ fields: ['ExternalExchangeStatus__c', 'ExternalPartnerName__c'], conflict_fields: ['ExternalExchangeStatus__c'], resent: true })],
      conflict_rates: [{ sf_object: 'Prospect__c', field: 'ExternalExchangeStatus__c', conflicts: 3, candidates: 4 }],
    })
    expect(t).toContain('Bidspoke sent it again, leaving out ExternalExchangeStatus__c, because that field already held a different value. It updated Prospect a06Ui00002sLkNuIAK with the rest.')
    expect(t).toContain('Today Prospect ExternalExchangeStatus__c held a different value in 3 of 4 resends.')
  })

  it('a conflict on every field says nothing was sent', () => {
    expect(text({ kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'], resent: false })] })).toContain(
      'Bidspoke did not send it again, because every field it set on Prospect a06Ui00002sLkNuIAK (BidStatus__c) already held a different value.',
    )
  })

  describe('a conflict carrying the values the tick read (#2264)', () => {
    const changed = { field: 'BidStatus__c', held: 'Won Bid', sending: 'Rejected', history: 'changed' as const, changed_at: '2026-10-15T00:31:00.000Z' }

    it('names the value Salesforce held, the value Bidspoke was sending, and when the field history says it changed', () => {
      const c = composeSalesforceReadBackAlert({ kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'], conflict_values: [changed], resent: true })] }, APP)
      expect(c.sections).toEqual([
        'Engine Bidding Workflow answered a lead at 8:29 PM ET, and a Salesforce update after the answer did not land. Bidspoke sent it again, leaving out BidStatus__c, because that field already held a different value. It updated Prospect a06Ui00002sLkNuIAK with the rest.',
        'BidStatus__c held "Won Bid" where Bidspoke was sending "Rejected". Its Salesforce history shows it was changed at 8:31 PM ET on Oct 14, after the update began.',
        'Fix: open that Prospect in Salesforce and decide whether BidStatus__c should keep "Won Bid" or be set to "Rejected".',
        `<${APP}/workflows/wf-1?execution=01a13cf7-0191-7dc3-aada-59ceeacc1616|View the run →>`,
      ])
    })

    it('says when the field keeps no history, or its history could not be read, so who set it could not be checked', () => {
      const notKept = text({ kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'], conflict_values: [{ field: 'BidStatus__c', held: 'No Bid', sending: 'Rejected', history: 'not_kept' }], resent: true })] })
      expect(notKept).toContain('BidStatus__c held "No Bid" where Bidspoke was sending "Rejected". Salesforce keeps no history of that field, so whether another writer set it could not be checked.')
      const unread = text({ kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'], conflict_values: [{ field: 'BidStatus__c', held: 'No Bid', sending: 'Rejected', history: 'unread' }], resent: true })] })
      expect(unread).toContain('Its Salesforce history could not be read, so whether another writer set it could not be checked.')
    })

    it('quotes a blank as nothing, a number bare, and cuts a long value short', () => {
      const t = text({
        kind: 'conflict',
        writes: [write({ conflict_fields: ['A__c', 'B__c'], conflict_values: [
          { field: 'A__c', held: 1200, sending: null, history: 'not_kept' },
          { field: 'B__c', held: 'x'.repeat(200), sending: '<b>', history: 'not_kept' },
        ], resent: false })],
      })
      expect(t).toContain('A__c held 1200 where Bidspoke was sending nothing.')
      expect(t).toContain(`B__c held "${'x'.repeat(80)}..." where Bidspoke was sending "&lt;b&gt;".`)
      expect(t).toContain('decide, for each of those fields, whether it should keep the value it holds or be set to the one Bidspoke was sending.')
    })

    it('puts the values on each write\'s line when it names several', () => {
      const t = text({ kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'], conflict_values: [changed], resent: true }), write({ conflict_fields: ['BidStatus__c'], resent: true })] })
      expect(t).toContain('It updated Prospect a06Ui00002sLkNuIAK with the rest. BidStatus__c held "Won Bid" where Bidspoke was sending "Rejected".')
      expect(t).not.toMatch(DASHES)
    })

    it('goes without them, as before, when an alert sent again on a later tick no longer has them', () => {
      expect(text({ kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'], resent: true })] })).toContain('The run below shows the values Bidspoke was sending, if its step was recorded.')
    })
  })

  it('unread writes say how many, the oldest, and why they were not read', () => {
    const t = text({ kind: 'unread', writes: [], count: 3, oldest_at: '2026-10-15T00:29:54.000Z', oldest_expires_at: '2026-10-16T00:29:56.000Z', reason: 'salesforce_not_answering' })
    expect(t).toContain('3 Salesforce updates made after leads were answered are waiting to be read back, the oldest from 8:29 PM ET. Bidspoke could not read them this minute because Salesforce did not answer.')
    expect(t).toContain('the oldest at 8:29 PM ET on Oct 15')
  })

  it('a held write the key will not open says so, and points at the key', () => {
    const t = text({ kind: 'unread', writes: [], count: 1, oldest_at: '2026-10-15T00:29:54.000Z', oldest_expires_at: '2026-10-16T00:29:56.000Z', reason: 'held_unreadable' })
    expect(t).toContain('Bidspoke could not read it this minute because its encryption key would not open what it holds, so nothing can check or resend it.')
    expect(t).toContain('Fix: check whether the encryption key was changed without following its rotation steps.')
  })

  it('the read-back not running says since when, or that it never has', () => {
    expect(text({ kind: 'not_running', writes: [], count: 1, oldest_at: '2026-10-15T00:29:54.000Z', oldest_expires_at: '2026-10-16T00:29:56.000Z', last_finished_at: '2026-10-15T00:10:00.000Z' }))
      .toContain('and the job that reads them back has not finished a run since 8:10 PM ET on Oct 14.')
    expect(text({ kind: 'not_running', writes: [], count: 2, oldest_at: '2026-10-15T00:29:54.000Z', last_finished_at: null })).toContain('has not finished a run since it was deployed.')
  })

  it('names at most a set number of writes and counts the rest', () => {
    const many = Array.from({ length: NAMED_WRITES + 3 }, (_, i) => write({ sf_record_id: `a06Ui00002sLkN${String(i).padStart(2, '0')}AK`, detail: 'the record no longer exists in Salesforce' }))
    const t = text({ kind: 'resend_failed', writes: many })
    expect(t).toContain(`${NAMED_WRITES + 3} Salesforce updates made after leads were answered did not land`)
    expect(t).toContain('and 3 more')
  })

  it('never carries a dash as punctuation, in any kind', () => {
    const all: SalesforceReadBackAlert[] = [
      { kind: 'resend_failed', writes: [write({ detail: 'x' })] },
      { kind: 'resend_failed', writes: [write(), write()] },
      { kind: 'unknown', writes: [write({ still_trying: true })] },
      { kind: 'unknown', writes: [write(), write()] },
      { kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'], resent: true })] },
      { kind: 'conflict', writes: [write({ conflict_fields: ['BidStatus__c'] }), write({ conflict_fields: ['BidStatus__c'] })] },
      { kind: 'unread', writes: [], count: 1, reason: 'bulkhead_busy' },
      { kind: 'not_running', writes: [], count: 1, last_finished_at: null },
    ]
    for (const p of all) expect(text(p)).not.toMatch(DASHES)
  })
})

/**
 * #2172: a credit inquiry post sets no field by name and is worded as a post,
 * for the Submission it was for, with what a person can check: the Lead's
 * Inquiries file. Never a value: the inquiries are lead data.
 */
describe('a credit inquiry post', () => {
  const post = (over: Partial<ReadBackAlertWrite> = {}) =>
    write({ workflow_name: 'Main Flow', sf_object: 'Submission__c', sf_record_id: 'a0XUi00000AbCdEFGH', fields: [], inquiry_post: true, ...over })

  it('a refused resend says the post was sent again and refused, and what the Lead keeps meanwhile', () => {
    const c = composeSalesforceReadBackAlert({ kind: 'resend_failed', writes: [post({ resent: true, detail: 'Salesforce answered 404' })] }, APP)
    expect(c.title).toBe('Credit inquiry post could not be resent')
    expect(c.fallback).toBe('Credit inquiry post could not be resent: Submission a0XUi00000AbCdEFGH')
    expect(c.sections[0]).toBe(
      "Main Flow posted a lead's credit inquiries to Salesforce at 8:29 PM ET, for Submission a0XUi00000AbCdEFGH, and the post did not land. " +
        'Bidspoke sent it again and it failed: Salesforce answered 404.',
    )
    expect(c.sections[1]).toBe("Bidspoke will not send it again. Until the lead's next credit pull, its Lead keeps the inquiry rows and counts it had before.")
    expect(c.sections[2]).toBe('Fix: open that Submission in Salesforce and check why the post was refused. The run below shows what Bidspoke was sending, if its step was recorded.')
  })

  it('one never resent says why, without claiming a resend', () => {
    const t = text({ kind: 'resend_failed', writes: [post({ resent: false, resends: 0, detail: 'the Submission has no Lead, so Salesforce refuses the post' })] })
    expect(t).toContain('Bidspoke did not send it again, because the Submission has no Lead, so Salesforce refuses the post.')
    expect(t).not.toMatch(/sent it again and/)
  })

  it('one still not confirmed after its one resend says so, why there is no second, and how to check', () => {
    const t = text({ kind: 'unknown', writes: [post({ resends: 1, still_trying: false })] })
    expect(t).toContain('Credit inquiry post still not confirmed')
    expect(t).toContain('Bidspoke sent it again once, and Salesforce did not confirm it, so it is still not known whether it landed.')
    expect(t).toContain('Bidspoke will not send it again, because each post that lands attaches another file to the Lead. It holds the post until 8:29 PM ET on Oct 15.')
    expect(t).toContain("Fix: before 8:29 PM ET on Oct 15, open that Submission's Lead in Salesforce and look for an Inquiries file from 8:29 PM ET or later. If there is none, the post did not land.")
  })

  it('one it could not resend at all does not claim a resend was sent', () => {
    const t = text({ kind: 'unknown', writes: [post({ resends: 0, still_trying: true })] })
    expect(t).toContain('Bidspoke found no Inquiries file on its Lead, and has not been able to send it again.')
    expect(t).toContain('Bidspoke keeps trying, and holds the post until 8:29 PM ET on Oct 15.')
    expect(t).not.toMatch(/sent it again once/)
  })

  it('several are named one line each', () => {
    const t = text({ kind: 'unknown', writes: [post(), post({ sf_record_id: 'a0XUi00000AbCdEFGI' })] })
    expect(t).toContain('2 credit inquiry posts to Salesforce did not land in time, and Bidspoke has not been able to confirm any of them since')
    expect(t).toContain('Main Flow at 8:29 PM ET: Submission a0XUi00000AbCdEFGI.')
    const f = text({ kind: 'resend_failed', writes: [post({ detail: 'Salesforce answered 404' }), post({ detail: 'Salesforce answered 404' })] })
    expect(f).toContain('2 credit inquiry posts to Salesforce did not land, and Bidspoke could not send them again. Bidspoke will not send them again.')
  })

  it('the waiting count says how many are posts, and reads as before when none are', () => {
    expect(text({ kind: 'unread', writes: [], count: 1, inquiry_posts: 1, oldest_at: '2026-10-15T00:29:54.000Z', reason: 'salesforce_not_answering' }))
      .toContain('Salesforce writes waiting to be checked\n1 credit inquiry post to Salesforce is waiting to be read back, the oldest from 8:29 PM ET. Bidspoke could not read it this minute because Salesforce did not answer.')
    expect(text({ kind: 'not_running', writes: [], count: 3, inquiry_posts: 1, oldest_at: '2026-10-15T00:29:54.000Z', last_finished_at: null }))
      .toContain('3 Salesforce writes (1 credit inquiry post and 2 updates made after leads were answered) are waiting to be read back, the oldest from 8:29 PM ET, and the job')
  })

  it('never carries a dash as punctuation', () => {
    const all: SalesforceReadBackAlert[] = [
      { kind: 'resend_failed', writes: [post({ resent: true, detail: 'x' })] },
      { kind: 'resend_failed', writes: [post({ resent: false, detail: 'x' })] },
      { kind: 'resend_failed', writes: [post(), post()] },
      { kind: 'unknown', writes: [post({ still_trying: true, resends: 0 })] },
      { kind: 'unknown', writes: [post(), post()] },
      { kind: 'unread', writes: [], count: 2, inquiry_posts: 1, reason: 'bulkhead_busy' },
      { kind: 'not_running', writes: [], count: 1, inquiry_posts: 1, last_finished_at: null },
    ]
    for (const p of all) expect(text(p)).not.toMatch(DASHES)
  })
})

describe('sendSalesforceReadBackAlert', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the title as a header and each sentence group as a section', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, ts: '1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await sendSalesforceReadBackAlert({ bot_token: 'x', default_channel: '#alerts' }, { kind: 'resend_failed', writes: [write({ detail: 'x' })] }, APP)
    expect(ok).toBe(true)
    const body = (await slackPostOf(fetchMock.mock.calls[0] as unknown[])) as unknown as { blocks: Array<{ type: string; text: { text: string } }>; text: string }
    expect(body.blocks[0]).toMatchObject({ type: 'header', text: { text: 'Salesforce update could not be resent' } })
    expect(body.blocks.slice(1).every((b) => b.type === 'section')).toBe(true)
    expect(body.text).toBe('Salesforce update could not be resent: Prospect a06Ui00002sLkNuIAK')
  })
})
