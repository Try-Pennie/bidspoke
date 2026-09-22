import { describe, it, expect } from 'vitest'
import { NODE_TYPES as SAVED_NODE_TYPES } from '@bidspoke/node-types'
import { suggestedTimeoutMs, roundUpSmart, DEFAULT_RETRIES } from '../timeout-suggestion'
// The worker is the source of truth; the web copy is a hand-kept mirror. The
// worker module only depends on its own timeout-floor (also dependency-free),
// so it imports cleanly into the web (node) test environment.
import {
  suggestedTimeoutMs as workerSuggestedTimeoutMs,
  roundUpSmart as workerRoundUpSmart,
  DEFAULT_RETRIES as WORKER_DEFAULT_RETRIES,
} from '../../../../worker/src/lib/timeout-suggestion'

// Every saved node type, from the shared list rather than a hand kept subset
// (#1411), plus undefined to pin the default.
const NODE_TYPES: Array<string | undefined> = [...SAVED_NODE_TYPES, undefined]
const P99S = [5, 40, 200, 739, 5000, 29299]
const MAXES_FACTOR = [1, 1.05, 1.4, 3.7]
const RETRIES = [0, 1, 2, 5]

describe('timeout suggestion web↔worker sync', () => {
  it('default retries agree', () => {
    expect(DEFAULT_RETRIES).toBe(WORKER_DEFAULT_RETRIES)
  })

  it('rounding agrees across magnitudes', () => {
    for (const ms of [1, 7, 99, 101, 437, 1000, 1001, 11809.5, 43948.5]) {
      expect(roundUpSmart(ms), `roundUpSmart(${ms})`).toBe(workerRoundUpSmart(ms))
    }
  })

  it('suggested value agrees for every type/p99/max/retries combination', () => {
    for (const type of NODE_TYPES) {
      for (const p99 of P99S) {
        for (const f of MAXES_FACTOR) {
          for (const retries of RETRIES) {
            const max = Math.round(p99 * f)
            expect(
              suggestedTimeoutMs(type, p99, max, retries),
              `mismatch for type=${type} p99=${p99} max=${max} retries=${retries}`
            ).toBe(workerSuggestedTimeoutMs(type, p99, max, retries))
          }
        }
      }
    }
  })
})
