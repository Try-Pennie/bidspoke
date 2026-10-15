/**
 * The per write marker the engine stamps on a post-answer Salesforce update
 * (#2023), so the read-back can tell whether THIS write landed by the record
 * carrying its own stamp, never by its fields looking equal.
 */
import { describe, it, expect } from 'vitest'
import {
  WRITE_MARKER_FIELD,
  WRITE_MARKER_MAX_LENGTH,
  ENGINE_ATTEMPT,
  writeMarker,
  parseWriteMarker,
  stampWriteMarker,
  stampsWrites,
  readBackOwns,
  withWriteMarker,
} from '../write-marker'

const EXEC = '01a13cf7-0191-7dc3-aada-59ceeacc1616'

describe('writeMarker', () => {
  it('is the run, the step and the attempt, in that order', () => {
    expect(writeMarker(EXEC, 'patch_prospect_reject', ENGINE_ATTEMPT)).toBe(`${EXEC}:patch_prospect_reject:0`)
    expect(writeMarker(EXEC, 'patch_prospect_reject', 2)).toBe(`${EXEC}:patch_prospect_reject:2`)
  })

  it('refuses a marker the Text(255) field could not hold, rather than have Salesforce refuse the write', () => {
    const step = 'x'.repeat(WRITE_MARKER_MAX_LENGTH)
    expect(writeMarker(EXEC, step, 0)).toBeNull()
    // The longest that fits is still made.
    const fits = 'y'.repeat(WRITE_MARKER_MAX_LENGTH - EXEC.length - 3)
    expect(writeMarker(EXEC, fits, 0)?.length).toBe(WRITE_MARKER_MAX_LENGTH)
  })

  it('reads back what it wrote, a step name holding a colon included', () => {
    expect(parseWriteMarker(`${EXEC}:patch:prospect:1`)).toEqual({ executionId: EXEC, stepNamespace: 'patch:prospect', attempt: 1 })
    expect(parseWriteMarker(writeMarker(EXEC, 'update_lead', 0))).toEqual({ executionId: EXEC, stepNamespace: 'update_lead', attempt: 0 })
  })

  it('reads anything else as no marker', () => {
    for (const v of [null, undefined, '', 'Set by Bidspoke', `${EXEC}:step`, `${EXEC}:step:x`, `${EXEC}::0`, ':step:0', 42]) {
      expect(parseWriteMarker(v)).toBeNull()
    }
  })
})

describe('stampWriteMarker', () => {
  const marker = writeMarker(EXEC, 'patch_prospect', 0)!

  it('adds the marker to an update on the three objects that carry the field', () => {
    for (const object of ['Prospect__c', 'Applicant__c', 'Lead']) {
      expect(stampsWrites(object)).toBe(true)
      expect(stampWriteMarker({ BidStatus__c: 'Bid' }, object, marker)).toEqual({ BidStatus__c: 'Bid', [WRITE_MARKER_FIELD]: marker })
    }
  })

  it('leaves a Submission alone: it has no such field, and a PATCH naming one would be refused', () => {
    expect(stampsWrites('Submission__c')).toBe(false)
    expect(stampWriteMarker({ External_Exchange_Status__c: 'Completed' }, 'Submission__c', marker)).toEqual({ External_Exchange_Status__c: 'Completed' })
  })

  it('leaves the body alone when the step is not a post-answer write', () => {
    expect(stampWriteMarker({ BidStatus__c: 'Bid' }, 'Prospect__c', undefined)).toEqual({ BidStatus__c: 'Bid' })
  })

  it('overrides a marker a canvas body carried: the engine owns the field', () => {
    expect(stampWriteMarker({ [WRITE_MARKER_FIELD]: 'typed by hand' }, 'Lead', marker)).toEqual({ [WRITE_MARKER_FIELD]: marker })
  })
})

describe('readBackOwns', () => {
  const body = (m: unknown) => ({ BidStatus__c: 'Rejected', [WRITE_MARKER_FIELD]: m })

  it('owns a held update whose body carries this step\'s own engine stamp', () => {
    expect(readBackOwns('Prospect__c', body(`${EXEC}:patch_prospect_reject:0`), EXEC, 'patch_prospect_reject')).toBe(true)
  })

  it('does not own one made before the stamp shipped, one for another step, or one on a Submission', () => {
    expect(readBackOwns('Prospect__c', { BidStatus__c: 'Rejected' }, EXEC, 'patch_prospect_reject')).toBe(false)
    expect(readBackOwns('Prospect__c', body(`${EXEC}:patch_prospect:0`), EXEC, 'patch_prospect_reject')).toBe(false)
    expect(readBackOwns('Submission__c', body(`${EXEC}:update_submission:0`), EXEC, 'update_submission')).toBe(false)
  })
})

describe('withWriteMarker', () => {
  it('sets the marker for the step and takes it back however the step ends', async () => {
    const ctx: { writeMarker?: string } = {}
    const seen: Array<string | undefined> = []
    await withWriteMarker(ctx, 'm', async () => { seen.push(ctx.writeMarker) })
    expect(seen).toEqual(['m'])
    expect(ctx.writeMarker).toBeUndefined()
    await expect(withWriteMarker(ctx, 'm', async () => { throw new Error('timed out') })).rejects.toThrow('timed out')
    expect(ctx.writeMarker).toBeUndefined()
  })
})
