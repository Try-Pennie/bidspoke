import { describe, expect, it } from 'vitest'
import { summarize } from './stats.ts'

describe('summarize', () => {
  it('reports received, lost and nearest rank percentiles over the received samples', () => {
    const s = summarize([100, 50, null, 300, 200])
    expect(s).toEqual({ sent: 5, received: 4, lost: 1, minMs: 50, p50Ms: 100, p90Ms: 300, maxMs: 300 })
  })

  it('reports nulls, not zeros, when nothing arrived', () => {
    expect(summarize([null, null])).toEqual({ sent: 2, received: 0, lost: 2, minMs: null, p50Ms: null, p90Ms: null, maxMs: null })
  })
})
