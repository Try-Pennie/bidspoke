/**
 * #1162: refuse an ambiguous quoted rate instead of taking the first producer found.
 *
 * `extractQuotedRate` iterated `Object.entries(steps)` and returned the first code
 * node carrying `body.offers[0].rate`, so with two producers the value was chosen by
 * insertion order rather than by any rule. Today each of the three quoting workflows
 * has exactly one producer, so the behaviour was correct by accident of the
 * workflows rather than by anything the function asserted.
 *
 * This is a money field. A second producer (an author splitting a response builder,
 * or adding one) would make it silently WRONG rather than absent, and a wrong rate
 * looks exactly like a right one. So: exactly one producer yields a value, more than
 * one refuses, and the refusal is reported rather than swallowed — a null that means
 * "two producers disagreed" must be distinguishable from a null that means "nothing
 * quoted" (L622, L11), and the callback is what carries that difference out.
 */
import { describe, it, expect, vi } from 'vitest'
import { extractQuotedRate } from '../lead-sightings'
import type { StepOutput, NodeDefinition } from '../../types'

function node(id: string, namespace: string, type: string): NodeDefinition {
  return { id, namespace, type } as NodeDefinition
}

/** A code node's response-builder output carrying one offer at `rate`. */
function producer(rate: unknown): StepOutput {
  return {
    status: 'completed',
    output: { isRejected: false, body: { offers: [{ name: 'Pennie', rate }] } },
  } as StepOutput
}

describe('extractQuotedRate: one producer', () => {
  it('returns the rate in cents and reports no ambiguity', () => {
    const onAmbiguous = vi.fn()
    const cents = extractQuotedRate(
      { build_response: producer(3.24), offer_response: { status: 'completed', output: { ok: true } } as StepOutput },
      [node('n1', 'build_response', 'code'), node('n2', 'offer_response', 'response')],
      { onAmbiguous },
    )
    expect(cents).toBe(324)
    expect(onAmbiguous).not.toHaveBeenCalled()
  })

  it('a node carrying the body at BOTH depths is still one producer, not two', () => {
    // Lead Economy's return_response returns the quoted body one level down under
    // `response`. Reading both depths must not turn one node into an ambiguity.
    const onAmbiguous = vi.fn()
    const both = {
      status: 'completed',
      output: { body: { offers: [{ rate: 1.3 }] }, response: { body: { offers: [{ rate: 1.3 }] } } },
    } as StepOutput
    const cents = extractQuotedRate({ return_response: both }, [node('n1', 'return_response', 'code')], { onAmbiguous })
    expect(cents).toBe(130)
    expect(onAmbiguous).not.toHaveBeenCalled()
  })
})

describe('extractQuotedRate: no producer', () => {
  it('returns null and does NOT report ambiguity (absent is not ambiguous)', () => {
    const onAmbiguous = vi.fn()
    const cents = extractQuotedRate(
      { plain: { status: 'completed', output: { ok: true } } as StepOutput },
      [node('n1', 'plain', 'code')],
      { onAmbiguous },
    )
    expect(cents).toBeNull()
    expect(onAmbiguous).not.toHaveBeenCalled()
  })

  it('a non-code node carrying a rate is not a producer', () => {
    const onAmbiguous = vi.fn()
    const cents = extractQuotedRate(
      { offer_response: producer(9.99) },
      [node('n1', 'offer_response', 'response')],
      { onAmbiguous },
    )
    expect(cents).toBeNull()
    expect(onAmbiguous).not.toHaveBeenCalled()
  })
})

describe('extractQuotedRate: two producers (#1162)', () => {
  it('refuses rather than taking the first, and names every producer it saw', () => {
    const onAmbiguous = vi.fn()
    const cents = extractQuotedRate(
      { build_response: producer(3.24), build_response_v2: producer(9.99) },
      [node('n1', 'build_response', 'code'), node('n2', 'build_response_v2', 'code')],
      { onAmbiguous },
    )
    expect(cents).toBeNull()
    expect(onAmbiguous).toHaveBeenCalledTimes(1)
    expect(onAmbiguous.mock.calls[0][0]).toEqual([
      { namespace: 'build_response', cents: 324 },
      { namespace: 'build_response_v2', cents: 999 },
    ])
  })

  it('refuses even when both producers agree, because agreement today is not a rule', () => {
    const onAmbiguous = vi.fn()
    const cents = extractQuotedRate(
      { a: producer(2.5), b: producer(2.5) },
      [node('n1', 'a', 'code'), node('n2', 'b', 'code')],
      { onAmbiguous },
    )
    expect(cents).toBeNull()
    expect(onAmbiguous).toHaveBeenCalledTimes(1)
  })

  it('one producer beside a code node with no rate is NOT ambiguous', () => {
    // The second code node simply does not quote; that is the common shape and
    // must keep working, or the refusal would swallow every real quote.
    const onAmbiguous = vi.fn()
    const cents = extractQuotedRate(
      { build_response: producer(4.99), enrich: { status: 'completed', output: { fico: 700 } } as StepOutput },
      [node('n1', 'build_response', 'code'), node('n2', 'enrich', 'code')],
      { onAmbiguous },
    )
    expect(cents).toBe(499)
    expect(onAmbiguous).not.toHaveBeenCalled()
  })

  it('a failed producer does not count toward ambiguity', () => {
    const onAmbiguous = vi.fn()
    const failed = { status: 'failed', output: { body: { offers: [{ rate: 8.88 }] } } } as StepOutput
    const cents = extractQuotedRate(
      { build_response: producer(4.99), broken: failed },
      [node('n1', 'build_response', 'code'), node('n2', 'broken', 'code')],
      { onAmbiguous },
    )
    expect(cents).toBe(499)
    expect(onAmbiguous).not.toHaveBeenCalled()
  })

  it('works with no callback supplied (the seam is optional)', () => {
    expect(() =>
      extractQuotedRate(
        { a: producer(1), b: producer(2) },
        [node('n1', 'a', 'code'), node('n2', 'b', 'code')],
      ),
    ).not.toThrow()
  })
})
