/**
 * The response contract check (#933).
 *
 * The declarations are checked against the MEASURED fixture, not only against
 * cases I chose. That is the whole difference between this and the defect it
 * exists to catch: #926 shipped a guard reading a field nobody sends because its
 * fixture and its code agreed with each other and neither was compared to
 * reality (L48, L52).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  checkResponseContract,
  reportResponseContract,
  RESPONSE_CONTRACTS,
  RESPONSE_CONTRACT_EVENTS,
  type ResponseContract,
} from '../response-contracts'
import measured from './fixtures/response-shapes.json'

const REJECTION = { lead_id: 'lead-1', reason: 'ineligible state', status: 'rejected' }
const OFFER = { offers: [{ amount: 12 }], requestId: 'req-1' }
const LEAD_ECONOMY = '89b1a6af-7e0f-43de-bc66-1e888184551f'
const ctx = { workflowId: LEAD_ECONOMY, executionId: 'exec-1', traceId: 'trace-1' }

describe('the declarations against the measured shapes', () => {
  // Every shape production actually sends must be accounted for. A declaration
  // that fires on the ordinary traffic is worse than no declaration, because it
  // teaches everyone to ignore the signal (L36).
  const declared = new Map(RESPONSE_CONTRACTS.map((c) => [c.workflowId, c]))

  for (const wf of measured.workflows) {
    describe(wf.name, () => {
      it('has a declared contract', () => {
        expect(declared.get(wf.workflowId), `${wf.name} is measured but not declared`).toBeDefined()
      })

      for (const shape of wf.shapes) {
        const body = Object.fromEntries(shape.keys.map((k) => [k, k === 'offers' ? [{ amount: 1 }] : `v-${k}`]))
        const label = `{${shape.keys.join(', ')}} (${shape.count} measured)`

        it(`judges ${label}`, () => {
          const verdict = checkResponseContract(wf.workflowId, body)
          // The one measured shape that SHOULD be flagged is Lead Economy's
          // {error, trace_id}: trace_id is our identifier, so a partner
          // receiving it cannot correlate the response at all. Every other
          // measured shape is ordinary traffic and must pass.
          if (shape.keys.includes('trace_id') && !shape.keys.includes('lead_id')) {
            expect(verdict.status).toBe('unrecognised')
          } else {
            expect(verdict.status, `${label} is ordinary traffic and must not be flagged`).toBe('ok')
          }
        })
      }
    })
  }

  it('flags no ordinary traffic at all, counted', () => {
    let flagged = 0
    let total = 0
    for (const wf of measured.workflows) {
      for (const shape of wf.shapes) {
        const body = Object.fromEntries(shape.keys.map((k) => [k, k === 'offers' ? [{ amount: 1 }] : `v-${k}`]))
        total += shape.count
        if (checkResponseContract(wf.workflowId, body).status !== 'ok') flagged += shape.count
      }
    }
    // 2 of 1,200: the {error, trace_id} pair, and nothing else.
    expect(total).toBeGreaterThan(1000)
    expect(flagged).toBe(2)
  })
})

describe('checkResponseContract', () => {
  it('accepts a complete rejection and a complete offer', () => {
    expect(checkResponseContract(LEAD_ECONOMY, REJECTION)).toEqual({ status: 'ok', family: 'rejection' })
    expect(checkResponseContract(LEAD_ECONOMY, OFFER)).toEqual({ status: 'ok', family: 'offer' })
  })

  // The incident itself: the key is gone from the JSON entirely.
  it('catches a rejection sent without lead_id', () => {
    const verdict = checkResponseContract(LEAD_ECONOMY, { reason: 'ineligible state', status: 'rejected' })

    expect(verdict).toMatchObject({ status: 'missing', family: 'rejection', missing: ['lead_id'] })
  })

  // The same failure wearing a different hat. A partner cannot correlate on an
  // empty string any more than on an absent key, and the template path produces
  // exactly this when an inline interpolation misses.
  it('catches a lead_id that arrives empty, null or undefined', () => {
    for (const bad of ['', null, undefined]) {
      const verdict = checkResponseContract(LEAD_ECONOMY, { ...REJECTION, lead_id: bad })
      expect(verdict, String(bad)).toMatchObject({ status: 'missing', missing: ['lead_id'] })
    }
  })

  it('keeps a legitimately falsy value that is not absent', () => {
    // 0 and false are real values a partner can read. Treating them as missing
    // would be the mirror-image defect.
    expect(checkResponseContract(LEAD_ECONOMY, { ...REJECTION, lead_id: 0 }).status).toBe('ok')
    expect(checkResponseContract(LEAD_ECONOMY, { ...REJECTION, lead_id: false }).status).toBe('ok')
  })

  it('names every missing field, not just the first', () => {
    const verdict = checkResponseContract(LEAD_ECONOMY, { reason: 'x' })
    expect(verdict).toMatchObject({ status: 'missing', missing: ['lead_id', 'status'] })
  })

  // An empty offers array is a real value (no offers), not an absent field, so
  // only the genuinely missing correlation id is named. Treating [] as absent
  // would flag a legitimate no-offers response, which is the mirror-image defect.
  it('judges an offer against the offer family, not the rejection one', () => {
    const verdict = checkResponseContract(LEAD_ECONOMY, { offers: [] })
    expect(verdict).toMatchObject({ status: 'missing', family: 'offer', missing: ['requestId'] })
  })

  it('reports a body matching no family rather than passing it', () => {
    const verdict = checkResponseContract(LEAD_ECONOMY, { error: 'boom', trace_id: 't-1' })
    expect(verdict).toMatchObject({ status: 'unrecognised', keys: ['error', 'trace_id'] })
  })

  // The exemption has to be visible from the outside, or a workflow nobody
  // declared is exempt from the very check meant to cover it (L96, L129).
  it('reports an undeclared workflow rather than passing it', () => {
    expect(checkResponseContract('00000000-0000-0000-0000-000000000000', REJECTION)).toEqual({
      status: 'undeclared',
    })
  })

  it('never throws on a body that is not an object', () => {
    for (const odd of [null, undefined, 'a string', 42, [1, 2]]) {
      expect(() => checkResponseContract(LEAD_ECONOMY, odd)).not.toThrow()
      expect(checkResponseContract(LEAD_ECONOMY, odd).status).toBe('not-a-body')
    }
  })

  it('does not treat an inherited property as present', () => {
    // A body built with a prototype carrying lead_id must not satisfy the
    // contract: the partner receives the serialized own properties only.
    const body = Object.create({ lead_id: 'inherited' }) as Record<string, unknown>
    body.reason = 'x'
    body.status = 'rejected'

    expect(checkResponseContract(LEAD_ECONOMY, body)).toMatchObject({ status: 'missing', missing: ['lead_id'] })
  })
})

describe('reportResponseContract', () => {
  afterEach(() => vi.restoreAllMocks())

  it('says nothing at all on a healthy response', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    reportResponseContract({ status: 'ok', family: 'rejection' }, ctx)
    reportResponseContract({ status: 'not-a-body' }, ctx)

    expect(err).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  // Three distinct event names, because two checks sharing one status field
  // cannot be counted or alerted separately (L53).
  it('gives each outcome its own event name and names the missing fields', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    reportResponseContract(
      { status: 'missing', family: 'rejection', missing: ['lead_id'], workflowName: 'Lead Economy' },
      ctx,
    )
    reportResponseContract({ status: 'unrecognised', keys: ['error'], workflowName: 'Lead Economy' }, ctx)
    reportResponseContract({ status: 'undeclared' }, ctx)

    const events = [...err.mock.calls, ...warn.mock.calls].map(
      (c) => (JSON.parse(c[0] as string) as { event: string }).event,
    )
    expect(new Set(events)).toEqual(
      new Set([
        RESPONSE_CONTRACT_EVENTS.missing,
        RESPONSE_CONTRACT_EVENTS.unrecognised,
        RESPONSE_CONTRACT_EVENTS.undeclared,
      ]),
    )

    const first = JSON.parse(err.mock.calls[0][0] as string) as Record<string, unknown>
    expect(first.missing_fields).toEqual(['lead_id'])
    expect(first.trace_id).toBe('trace-1')
    expect(first.execution_id).toBe('exec-1')
    // The line has to say what it COSTS, not just what is absent, so a reader
    // knows why it matters without going to the issue.
    expect(String(first.detail)).toMatch(/tie the response to the lead/)
  })
})

describe('the shape fixture itself', () => {
  it('records how and when it was measured, and what it cannot show', () => {
    expect(measured.provenance.measuredAt).toBeTruthy()
    expect(measured.provenance.limitation).toMatch(/300 rows/)
  })

  it('covers more than a thousand real responses, so it is not a toy', () => {
    const total = measured.workflows.flatMap((w) => w.shapes).reduce((n, s) => n + s.count, 0)
    expect(total).toBeGreaterThan(1000)
  })

  it('declares no contract for a workflow with nothing measured', () => {
    const declaredIds = new Set(RESPONSE_CONTRACTS.map((c: ResponseContract) => c.workflowId))
    const measuredIds = new Set(measured.workflows.map((w) => w.workflowId))
    // Nothing is declared that was never measured: that is what stops a
    // contract being invented at the keyboard.
    for (const id of declaredIds) expect(measuredIds.has(id), `${id} declared but never measured`).toBe(true)
  })
})
