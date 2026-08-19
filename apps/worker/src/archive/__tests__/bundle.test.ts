import { describe, it, expect } from 'vitest'
import { encodeBundle, decodeBundle } from '../bundle'

describe('encodeBundle', () => {
  it('round-trips an execution and its steps through gzip and base64', async () => {
    const bundle = {
      execution: { id: 'e1', started_at: '2026-08-19T00:00:00.000Z', trigger_payload: { ssn: '000-00-0000' } },
      steps: [
        { id: 's1', step_namespace: 'validate', input: { a: 1 }, output: { b: 2 } },
        { id: 's2', step_namespace: 'bid', input: { c: 3 }, output: { d: 4 } },
      ],
    }

    const encoded = await encodeBundle(bundle)
    const decoded = await decodeBundle(encoded.wire)

    expect(decoded).toEqual(bundle)
  })

  it('derives the step count from the encoded bundle, so a short bundle cannot report a full count', async () => {
    const bundle = {
      execution: { id: 'e1' },
      steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    }

    const encoded = await encodeBundle(bundle)
    const decoded = await decodeBundle(encoded.wire)

    // The deletion gate compares this number against an independent Postgres
    // count. If it came from the caller rather than from the payload, both sides
    // would agree while every bundle was short (L63).
    expect(encoded.stepCount).toBe(decoded.steps.length)
    expect(encoded.stepCount).toBe(3)
  })

  it('reports the three sizes the batching arithmetic depends on', async () => {
    const bundle = { execution: { id: 'e1' }, steps: [{ id: 's1', output: 'x'.repeat(5000) }] }

    const encoded = await encodeBundle(bundle)

    expect(encoded.rawBytes).toBe(new TextEncoder().encode(JSON.stringify(bundle)).length)
    expect(encoded.wireBytes).toBe(encoded.wire.length)
    expect(encoded.gzipBytes).toBeLessThan(encoded.rawBytes)
    expect(encoded.wireBytes).toBeGreaterThan(encoded.gzipBytes)
  })
})

describe('decodeBundle', () => {
  it('throws on a corrupt wire rather than returning an empty bundle', async () => {
    await expect(decodeBundle('bm90LWd6aXA=')).rejects.toThrow()
  })
})
