import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC } from './_scan-utils'

/**
 * The signal matching and the tier walk live once, in @bidspoke/buyer-profile
 * (#1408). This is the guard half of that consolidation (L613, L370): the two
 * worker files that used to hold their own copies must import the shared
 * implementation and must not grow a second copy back. Sharing the constant
 * while re-copying the code that applies it is the exact failure L370 names,
 * so the check is on the FUNCTIONS, not the vocabulary.
 */
const FILES = {
  resolver: path.join(WORKER_SRC, 'engine/bid-resolver.ts'),
  classifier: path.join(WORKER_SRC, 'engine/error-classifier.ts'),
}

/** A hand rolled copy of something the package owns. Each pattern is one function or the old inline walk. */
const LOCAL_COPIES: Array<[string, RegExp]> = [
  ['a local looseEquals', /function\s+looseEquals\s*\(/],
  ['a local getBodyField', /function\s+getBodyField\s*\(/],
  ['a local matchSignal', /function\s+matchSignal\s*\(/],
  ['a local matchTier', /function\s+matchTier\s*\(/],
  ['the old inline tier walk', /value\s*>\s*tier\.above/],
]

const localCopiesIn = (src: string): string[] => LOCAL_COPIES.filter(([, re]) => re.test(src)).map(([name]) => name)

describe('bid-resolver.ts and error-classifier.ts consume @bidspoke/buyer-profile rather than copying it', () => {
  for (const [label, file] of Object.entries(FILES)) {
    const src = readFileSync(file, 'utf8')
    it(`${label} imports from the shared package`, () => {
      expect(src).toMatch(/from '@bidspoke\/buyer-profile'/)
    })
    it(`${label} holds no local copy of a shared function`, () => {
      expect(localCopiesIn(src)).toEqual([])
    })
  }

  it('the detector fires on the pre consolidation shape, so a green here is a measurement (L1)', () => {
    const before = [
      'function looseEquals(a: unknown, b: unknown): boolean {',
      'function getBodyField(body: unknown, field: string): unknown {',
      'for (const tier of tiers) { if (value > tier.above) return value * tier.multiplier }',
    ].join('\n')
    expect(localCopiesIn(before)).toEqual(['a local looseEquals', 'a local getBodyField', 'the old inline tier walk'])
  })
})
