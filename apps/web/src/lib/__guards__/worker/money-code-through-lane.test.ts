/**
 * Money code is reached only through a lane check (#1725).
 *
 * An ops workflow must never run money code. The walk enforces that in two
 * places: every step goes through the executor for the walk's lane
 * (`nodeExecutorForLane` in engine/index.ts), and walkGraph refuses a node its
 * lane cannot run before any of its branches, the walker only money ones
 * included, reaches an executor. Both are proven by behaviour in
 * apps/worker/src/engine/__tests__/walk-lane-gate.test.ts. What a behaviour
 * test cannot see is a NEW route to money code: a direct call of the money
 * executor somewhere else, which is how the walk itself used to run every node
 * (L621). This scan fails on one.
 *
 *  1. `executeNode`, the money lane's registry executor, is named only where it
 *     is built (engine/nodes/index.ts) and, in engine/index.ts, only by the
 *     import and the body of nodeExecutorForLane.
 *  2. A money node's own executor, derived from the lane traits so a money type
 *     added later is covered without being listed, is used (called or handed
 *     on) only in its own module, the registry, and the body of walkGraph,
 *     whose lane gate runs first on every node.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { NODE_TRAITS, NODE_TYPES } from '@bidspoke/node-types'
import { consumeParens, listTsFiles, sanitizeSource, WORKER_SRC } from '../../__tests__/_scan-utils'

const ENGINE_INDEX = path.join(WORKER_SRC, 'engine/index.ts')
const REGISTRY = path.join(WORKER_SRC, 'engine/nodes/index.ts')

const pascal = (type: string) => type.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')

/** Every money node type with its executor function and the module it lives in. */
const MONEY_EXECUTORS = NODE_TYPES
  .filter((t) => NODE_TRAITS[t].lane === 'money')
  .map((t) => ({ type: t, fn: `execute${pascal(t)}Node`, file: path.join(WORKER_SRC, 'engine/nodes', `${NODE_TRAITS[t].executorFile}.ts`) }))

const rel = (file: string) => path.relative(WORKER_SRC, file)
const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

/** [start, end) of a function's body, found in comment and string blanked source. */
function functionBody(src: string, header: RegExp): [number, number] | null {
  const m = header.exec(src)
  if (!m) return null
  const paramsOpen = src.indexOf('(', m.index)
  const bodyOpen = src.indexOf('{', consumeParens(src, paramsOpen))
  let depth = 0
  for (let k = bodyOpen; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}' && --depth === 0) return [bodyOpen, k + 1]
  }
  return null
}

function engineIndex() {
  const raw = readFileSync(ENGINE_INDEX, 'utf8')
  const clean = sanitizeSource(raw)
  return {
    raw,
    clean,
    resolver: functionBody(clean, /export function nodeExecutorForLane\s*\(/),
    walk: functionBody(clean, /export async function walkGraph\s*\(/),
  }
}

/** Places outside its home that name the money registry executor. */
function moneyRegistryOffenders(): string[] {
  const { raw, clean, resolver } = engineIndex()
  const out: string[] = []
  for (const file of listTsFiles(WORKER_SRC)) {
    if (file === REGISTRY) continue
    const src = file === ENGINE_INDEX ? clean : sanitizeSource(readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/\bexecuteNode\b/g)) {
      const at = m.index ?? 0
      if (file === ENGINE_INDEX) {
        const line = raw.split('\n')[lineOf(raw, at) - 1]
        if (/^import \{[^}]*\} from '\.\/nodes\/index'$/.test(line)) continue
        if (resolver && at >= resolver[0] && at < resolver[1]) continue
      }
      out.push(`${rel(file)}:${lineOf(src, at)} names the money executor directly`)
    }
  }
  return out
}

/**
 * Uses of a money node's own executor outside the places allowed to make one.
 * Any reference counts, not only a call, so the function cannot be handed out
 * under another name and called from there. An import or a re-export list only
 * moves the name; the use it enables is what this finds.
 */
function moneyNodeUseOffenders(): string[] {
  const { walk } = engineIndex()
  const out: string[] = []
  for (const file of listTsFiles(WORKER_SRC)) {
    const raw = readFileSync(file, 'utf8')
    const rawLines = raw.split('\n')
    const src = sanitizeSource(raw)
    for (const { fn, file: home } of MONEY_EXECUTORS) {
      if (file === home || file === REGISTRY) continue
      for (const m of src.matchAll(new RegExp(`\\b${fn}\\b`, 'g'))) {
        const at = m.index ?? 0
        const line = rawLines[lineOf(src, at) - 1]
        if (/^\s*(import|export) \{[^}]*\}/.test(line)) continue
        if (file === ENGINE_INDEX && walk && at >= walk[0] && at < walk[1]) continue
        out.push(`${rel(file)}:${lineOf(src, at)} uses ${fn} outside the lane gated walk`)
      }
    }
  }
  return out
}

describe('money code is reached only through a lane check', () => {
  it('finds what it scans, so it cannot pass on nothing', () => {
    const files = listTsFiles(WORKER_SRC)
    expect(files.length).toBeGreaterThan(100)
    expect(files).toContain(ENGINE_INDEX)
    expect(files).toContain(REGISTRY)
    const { clean, resolver, walk } = engineIndex()
    expect(resolver, 'engine/index.ts has no nodeExecutorForLane').not.toBeNull()
    expect(walk, 'engine/index.ts has no walkGraph').not.toBeNull()
    // The spans are the whole functions, not a prefix of one.
    expect(clean.slice(...resolver!)).toMatch(/\bexecuteNode\b/)
    expect(clean.slice(...walk!)).toMatch(/\bforwardBlockSightings\b/)
    expect(clean.slice(...walk!)).toMatch(/return pendingResponse \?\?/)
    expect(clean.slice(...walk!)).toMatch(/\blaneRefusalFor\(node\.type, lane\)/)
  })

  it('derives an executor for every money node type, and each is exported where the traits say', () => {
    expect(MONEY_EXECUTORS.map((e) => e.type)).toEqual(expect.arrayContaining(['partner_bid', 'bid_group', 'buyer_select', 'buyer_click_send', 'buyer_click_check']))
    for (const { fn, file } of MONEY_EXECUTORS) {
      expect(readFileSync(file, 'utf8'), `${rel(file)} exports ${fn}`).toMatch(new RegExp(`export (async )?function ${fn}\\b`))
    }
  })

  it('the walk calls the walker only money executors, which is what the second rule allows (positive control)', () => {
    const { clean, walk } = engineIndex()
    const body = clean.slice(...walk!)
    for (const fn of ['executeBidGroupNode', 'executeBuyerSelectNode', 'executeBuyerClickSendNode', 'executeBuyerClickCheckNode']) {
      expect(body, fn).toMatch(new RegExp(`\\b${fn}\\s*\\(`))
    }
  })

  it('nothing names the money registry executor outside its home and the lane resolver', () => {
    expect(moneyRegistryOffenders()).toEqual([])
  })

  it('nothing uses a money node executor outside its module, the registry and the lane gated walk', () => {
    expect(moneyNodeUseOffenders()).toEqual([])
  })
})
