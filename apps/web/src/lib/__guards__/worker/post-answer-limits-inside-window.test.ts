/**
 * A node that runs after the answer must not be allowed to wait as long as the
 * run waits for it (#1882).
 *
 * A run that answers early keeps walking, and finalize stops waiting for that walk
 * CONTINUATION_WINDOW_MS (12 s) after the answer. The Achieve Offers node gave up
 * on Achieve at 12 s by itself, so any reply slow enough to hit that limit ended
 * past the cut-off: the run was recorded degraded, the alert pointed at Salesforce
 * (which had finished 87 ms after the answer), and the Achieve evaluation was
 * never written. The window cannot grow: the 25 s budget is fully spent.
 *
 * Every network node type is classified here, enumerated from NODE_TRAITS so a
 * new one fails until somebody decides which kind it is (L96):
 *  - BOUNDED: a call whose loss is tolerable (data collection, nothing sold or
 *    written that matters). Its own limit, read from the worker source, must sit
 *    below the window, and so must the step limit the canvas gives it.
 *  - LEFT TO FINISH: a write or a sale whose outcome matters. Cut short at the
 *    window it would read as failed when it may have landed, so it keeps its own
 *    longer limit and a slow one is reported as unfinished, by name.
 *  - BEFORE THE ANSWER: the node decides what the answer says.
 *
 * It reads worker source, so it lives here rather than in `lib/__tests__/`.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_TRAITS, NODE_TYPES, type NodeType } from '@bidspoke/node-types'
import { CONTINUATION_WINDOW_MS } from '../../../../../worker/src/lib/post-response-budget'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'

type PostAnswerKind =
  | { kind: 'bounded'; limitConstant: string; file: string }
  | { kind: 'left_to_finish'; why: string }
  | { kind: 'before_the_answer'; why: string }

const WRITE_THAT_MATTERS =
  'its outcome matters: cut short at the window it would read as failed when it may have landed, so a slow one is left to finish and is reported as unfinished, by name'

const POST_ANSWER: Record<string, PostAnswerKind> = {
  achieve_offers: { kind: 'bounded', limitConstant: 'ACHIEVE_FETCH_TIMEOUT_MS', file: 'engine/nodes/achieve-offers.ts' },
  salesforce: { kind: 'left_to_finish', why: `a Salesforce write: ${WRITE_THAT_MATTERS}` },
  webhook: { kind: 'left_to_finish', why: `a delivery to another system: ${WRITE_THAT_MATTERS}` },
  buyer_click_send: { kind: 'left_to_finish', why: `a click sold to a buyer: ${WRITE_THAT_MATTERS}` },
  bid_group: { kind: 'before_the_answer', why: 'its winner is what the answer carries' },
  partner_bid: { kind: 'before_the_answer', why: 'its bid is what the answer carries' },
  buyer_select: { kind: 'before_the_answer', why: 'its sale decision is what the answer carries' },
}

const NETWORK_TYPES: NodeType[] = NODE_TYPES.filter((t) => NODE_TRAITS[t].network)

/** A `export const NAME = 9_000` style constant, read from the file that uses it. */
function sourceMs(file: string, name: string): number {
  const source = readFileSync(path.join(WORKER_SRC, file), 'utf8')
  const m = new RegExp(`export const ${name} = ([\\d_]+)\\b`).exec(source)
  expect(m, `${name} was not found in ${file}`).not.toBeNull()
  const ms = Number(String(m?.[1]).replace(/_/g, ''))
  // NaN compares false against every bound, so the checks below would pass on a
  // value that never parsed (L50).
  expect(Number.isInteger(ms) && ms > 0, `${name} read as ${String(m?.[1])}`).toBe(true)
  return ms
}

/** The step limit the canvas gives a freshly dropped node of this type. */
function canvasDefaultTimeoutMs(type: string): number {
  const file = path.join(REPO_ROOT, 'apps/web/src/components/canvas/WorkflowCanvas.tsx')
  const source = readFileSync(file, 'utf8')
  const start = source.indexOf(`if (type === '${type}') {`)
  expect(start, `WorkflowCanvas.tsx has no default config branch for ${type}`).toBeGreaterThan(-1)
  const block = source.slice(start, source.indexOf('\n  }\n', start))
  const m = /timeout_ms: (\d+)/.exec(block)
  expect(m, `the ${type} default config sets no timeout_ms`).not.toBeNull()
  return Number(m?.[1])
}

describe('nodes that can run after the answer (#1882)', () => {
  it('reads a twelve second window, so the comparisons below measure something', () => {
    expect(CONTINUATION_WINDOW_MS).toBe(12_000)
  })

  it('classifies every network node type, and nothing that is not one', () => {
    expect(Object.keys(POST_ANSWER).sort()).toEqual([...NETWORK_TYPES].sort())
  })

  for (const [type, entry] of Object.entries(POST_ANSWER)) {
    if (entry.kind !== 'bounded') continue

    it(`${type}: its own limit on the outside call ends before the run stops waiting`, () => {
      const limit = sourceMs(entry.file, entry.limitConstant)
      expect(limit, `${entry.limitConstant} is ${limit} ms, at or past the ${CONTINUATION_WINDOW_MS} ms the run waits after the answer`)
        .toBeLessThan(CONTINUATION_WINDOW_MS)
    })

    it(`${type}: the canvas step limit sits between the call's own limit and the window`, () => {
      const limit = sourceMs(entry.file, entry.limitConstant)
      const step = canvasDefaultTimeoutMs(type)
      // Below the call's own limit the step fails before the call can answer.
      expect(step, `a ${type} step limit of ${step} ms fails the step before its own ${limit} ms limit`).toBeGreaterThanOrEqual(limit)
      expect(step, `a ${type} step limit of ${step} ms is at or past the ${CONTINUATION_WINDOW_MS} ms window`).toBeLessThan(CONTINUATION_WINDOW_MS)
    })
  }

  it('the Achieve docs state the limits the code has', () => {
    const doc = readFileSync(path.join(REPO_ROOT, 'docs/nodes/achieve-offers.md'), 'utf8')
    const limit = sourceMs('engine/nodes/achieve-offers.ts', 'ACHIEVE_FETCH_TIMEOUT_MS')
    expect(doc).toContain(`Recommended: timeout \`${canvasDefaultTimeoutMs('achieve_offers')}\` ms`)
    expect(doc).toContain(`aborts its own fetch at ${limit / 1000} seconds`)
  })
})
