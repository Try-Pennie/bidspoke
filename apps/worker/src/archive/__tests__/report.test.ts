import { describe, it, expect } from 'vitest'
import { encodeBundle } from '../bundle'
import { summarize } from '../report'

// These bundles carry live SSNs, dates of birth, addresses and credit reports.
// Nothing upstream strips them, so the measurement output is the leak surface.
const CANARY_SSN = '123-45-6789'
const CANARY_NAME = 'Zzyzx Quimbleforth'

async function sampleMeasurements() {
  const bundles = [
    { execution: { id: 'e1', trigger_payload: { ssn: CANARY_SSN, name: CANARY_NAME } }, steps: [{ id: 's1' }] },
    { execution: { id: 'e2', trigger_payload: { ssn: CANARY_SSN } }, steps: [{ id: 's2' }, { id: 's3' }] },
    { execution: { id: 'e3', trigger_payload: { notes: CANARY_NAME } }, steps: [] },
  ]
  return Promise.all(bundles.map(encodeBundle))
}

function leafValues(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return [value]
  return Object.values(value as Record<string, unknown>).flatMap(leafValues)
}

describe('summarize', () => {
  it('emits only numbers, so no payload value can ride out in the report', async () => {
    const report = summarize(await sampleMeasurements())

    const leaves = leafValues(report)
    expect(leaves.length).toBeGreaterThan(0)
    for (const leaf of leaves) expect(typeof leaf).toBe('number')
  })

  it('does not carry payload content through into the serialized report', async () => {
    const serialized = JSON.stringify(summarize(await sampleMeasurements()))

    expect(serialized).not.toContain(CANARY_SSN)
    expect(serialized).not.toContain(CANARY_NAME)
    expect(serialized).not.toContain('e1')
  })

  it('reports the percentiles that size the batching, and the real step total', async () => {
    const report = summarize(await sampleMeasurements())

    expect(report.count).toBe(3)
    expect(report.steps.total).toBe(3)
    expect(report.wireBytes.max).toBeGreaterThanOrEqual(report.wireBytes.p50)
    expect(report.compressionRatio.p50).toBeGreaterThan(0)
  })

  it('reports a compression ratio above 1 for a realistically sized bundle', async () => {
    // Tiny payloads gzip LARGER than they started, because the header outweighs
    // the savings. Real executions are hundreds of kB (p99 measured in A0), so
    // the ratio is only meaningful at a realistic size. Asserting it on a
    // three-field fixture asserts nothing about production.
    const step = { id: 's1', step_type: 'partner_bid', input: { credit_score: 700, state: 'TX' }, output: { bid_cents: 4200 } }
    const bundle = { execution: { id: 'e1' }, steps: Array.from({ length: 40 }, (_, i) => ({ ...step, id: `s${i}` })) }

    const report = summarize([await encodeBundle(bundle)])

    expect(report.compressionRatio.p50).toBeGreaterThan(1)
  })

  it('reports the verify timing, because the self-check is a real share of the CPU budget', async () => {
    // encodeBundle decodes its own output to derive stepCount. That cost is what
    // makes the count trustworthy, and it is paid on every bundle in production,
    // so a CPU budget that omits it understates the real load.
    const report = summarize(await sampleMeasurements())

    expect(report.cpuMs.verify.p50).toBeGreaterThanOrEqual(0)
    expect(typeof report.cpuMs.verify.max).toBe('number')
  })
})
