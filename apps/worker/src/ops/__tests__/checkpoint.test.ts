/**
 * The ops run checkpoint (#1951, B4 of the #1698 run engine): what a slice
 * writes to R2 at its boundary, how the resume reads it back, and how it
 * restores the walk's place by following the recorded routes, never by
 * evaluating an edge again.
 *
 * The two things a checkpoint must never be trusted for: a body that is not
 * the one the run acknowledged (another state version, another run, a torn or
 * altered object), and a recorded route that does not fit the definition.
 */
import { describe, expect, it } from 'vitest'
import type { EdgeDefinition, NodeDefinition } from '../../types'
import {
  CHECKPOINT_FORMAT, CheckpointRefused, checkpointKey, continuationModeFrom, decodeCheckpoint, encodeCheckpoint, replayCheckpoint, r2CheckpointStore,
  type Checkpoint, type CheckpointPointer,
} from '../checkpoint'

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const RUN_ID = '0192f4a0-0000-7000-8000-000000000001'
const CHAIN = '0192f4a0-0000-7000-9000-000000000001'
const WF = '00000000-0000-4000-8000-0000000019a1'

// Test only types: action_a and the like are handler types the walk is given, not saved node types.
const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, namespace: id, type, config }) as unknown as NodeDefinition
const edge = (source: string, target: string, sourceHandle?: string): EdgeDefinition => ({ id: `${source}-${target}`, source, target, ...(sourceHandle ? { source_handle: sourceHandle } : {}) })

/**
 * A branch whose two arms are both unconditional edges, the shape #1698 1.8
 * records: its route lives only in its output's _route, so evaluating its
 * edges again picks the FIRST arm whatever it actually took.
 */
const BRANCHED = {
  nodes: [
    node('shape', 'transform'),
    node('pick', 'branch', { branches: [{ label: 'big', condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: 'trigger.payload.amount', operator: 'gt', value: '5' }] }] } }] }),
    node('a', 'action_a'), node('b', 'action_b'), node('after', 'action_c'),
  ],
  edges: [edge('trigger', 'shape'), edge('shape', 'pick'), edge('pick', 'a', 'big'), edge('pick', 'b', 'else'), edge('a', 'after'), edge('b', 'after')],
}

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    v: CHECKPOINT_FORMAT,
    runRequestId: RUN_ID, organizationId: ORG, workflowId: WF, workflowVersion: 3, executionChainId: CHAIN,
    stateVersion: 4, executionId: '0192f4a0-0000-7000-8000-0000000000ee', attempt: 1, writtenAt: '2026-10-27T14:00:00.000Z',
    path: [
      { seq: 0, nodeId: 'shape', namespace: 'shape', output: { amount: 3 }, edgeId: 'shape-pick' },
      { seq: 1, nodeId: 'pick', namespace: 'pick', output: { matched_branch: null, _route: 'else' }, edgeId: 'pick-b' },
    ],
    nextNodeId: 'b',
    totals: { steps: 2, computeMs: 1_200, slices: 1 },
    ...over,
  }
}

const IDENTITY = { runRequestId: RUN_ID, organizationId: ORG, workflowId: WF, workflowVersion: 3, executionChainId: CHAIN }

async function pointerOf(cp: Checkpoint): Promise<{ pointer: CheckpointPointer; body: string }> {
  const enc = await encodeCheckpoint(cp)
  return { pointer: { key: enc.key, stateVersion: cp.stateVersion, steps: cp.path.length, sha256: enc.sha256, bytes: enc.bytes }, body: enc.body }
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof CheckpointRefused) return err.reason
    throw err
  }
  throw new Error('expected a refusal')
}

describe('checkpointKey', () => {
  it('names the organization, the run, the state version the holder wrote it at and the steps it holds', () => {
    expect(checkpointKey(ORG, RUN_ID, 4, 2)).toBe(`checkpoints/v1/${ORG}/${RUN_ID}/4-2.json`)
  })

  it('refuses parts that could reach outside the run\'s own prefix', () => {
    expect(() => checkpointKey('../x', RUN_ID, 4, 2)).toThrow(/organization/)
    expect(() => checkpointKey(ORG, 'a/b', 4, 2)).toThrow(/run/)
    expect(() => checkpointKey(ORG, RUN_ID, 0, 2)).toThrow(/state version/)
    expect(() => checkpointKey(ORG, RUN_ID, 4, 0)).toThrow(/steps/)
  })
})

describe('encodeCheckpoint and decodeCheckpoint', () => {
  it('round trips a checkpoint through its text and digest', async () => {
    const cp = checkpoint()
    const { pointer, body } = await pointerOf(cp)
    expect(pointer.key).toBe(checkpointKey(ORG, RUN_ID, 4, 2))
    expect(pointer.bytes).toBe(new TextEncoder().encode(body).length)
    expect(pointer.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await decodeCheckpoint(body, pointer, IDENTITY)).toEqual(cp)
  })

  it('refuses a body whose digest is not the one acknowledged: a torn or altered object reads as healthy to any content check (L617)', async () => {
    const { pointer, body } = await pointerOf(checkpoint())
    expect(await refusal(decodeCheckpoint(body.replace('"amount":3', '"amount":4'), pointer, IDENTITY))).toBe('checkpoint_corrupt')
  })

  it('refuses a checkpoint written at another state version than the one acknowledged, so a stale holder\'s is never resumed', async () => {
    const stale = await pointerOf(checkpoint({ stateVersion: 3 }))
    const acked = { ...stale.pointer, stateVersion: 4 }
    expect(await refusal(decodeCheckpoint(stale.body, acked, IDENTITY))).toBe('checkpoint_stale')
  })

  it('refuses a checkpoint of another run, organization, workflow version or chain', async () => {
    for (const over of [{ runRequestId: '0192f4a0-0000-7000-8000-000000000002' }, { organizationId: 'aaaaaaaa-0000-4000-8000-000000000001' }, { workflowVersion: 4 }, { executionChainId: '0192f4a0-0000-7000-9000-000000000002' }]) {
      const { pointer, body } = await pointerOf(checkpoint(over))
      expect(await refusal(decodeCheckpoint(body, pointer, IDENTITY)), JSON.stringify(over)).toBe('checkpoint_not_this_run')
    }
  })

  it('refuses a format it does not know, and a body that is not a checkpoint, by name', async () => {
    const newer = await pointerOf({ ...checkpoint(), v: 2 as unknown as typeof CHECKPOINT_FORMAT })
    expect(await refusal(decodeCheckpoint(newer.body, newer.pointer, IDENTITY))).toBe('checkpoint_format_unknown')
    const text = 'not json'
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    expect(await refusal(decodeCheckpoint(text, { key: 'k', stateVersion: 4, steps: 2, sha256: digest, bytes: text.length }, IDENTITY))).toBe('checkpoint_corrupt')
  })

  it('refuses a path that does not hold the steps the acknowledgement counted', async () => {
    const { pointer, body } = await pointerOf(checkpoint())
    expect(await refusal(decodeCheckpoint(body, { ...pointer, steps: 3 }, IDENTITY))).toBe('checkpoint_stale')
  })
})

describe('replayCheckpoint (#1698 1.8: follow the recorded route, never evaluate an edge again)', () => {
  it('failure shape 1: a branch that routed its SECOND arm resumes down the second arm, with every recorded output restored', () => {
    const at = replayCheckpoint(BRANCHED.nodes, BRANCHED.edges, checkpoint())
    expect(at.next.id).toBe('b')
    expect(at.steps).toEqual({ shape: { output: { amount: 3 }, status: 'completed' }, pick: { output: { matched_branch: null, _route: 'else' }, status: 'completed' } })
    expect(at.lastCompletedNamespace).toBe('pick')
    expect(at.walked).toBe(2)
  })

  it('restores a step walked twice (a loop) in order, so the later output is the one the next step reads', () => {
    const loop = {
      nodes: [node('x', 'action_a'), node('y', 'action_b')],
      edges: [edge('trigger', 'x'), edge('x', 'y'), { id: 'y-x', source: 'y', target: 'x' }],
    }
    const cp = checkpoint({
      path: [
        { seq: 0, nodeId: 'x', namespace: 'x', output: { n: 1 }, edgeId: 'x-y' },
        { seq: 1, nodeId: 'y', namespace: 'y', output: { n: 1 }, edgeId: 'y-x' },
        { seq: 2, nodeId: 'x', namespace: 'x', output: { n: 2 }, edgeId: 'x-y' },
      ],
      nextNodeId: 'y',
      totals: { steps: 3, computeMs: 1, slices: 1 },
    })
    const at = replayCheckpoint(loop.nodes, loop.edges, cp)
    expect(at.next.id).toBe('y')
    expect(at.steps.x.output).toEqual({ n: 2 })
  })

  it('refuses a recorded route that does not fit the definition, naming the step, rather than walking somewhere else', () => {
    const cases: Array<[string, Partial<Checkpoint>]> = [
      ['the first step is not the entry', { path: [{ seq: 0, nodeId: 'pick', namespace: 'pick', output: {}, edgeId: 'pick-b' }], nextNodeId: 'b' }],
      ['an edge that does not leave the step', { path: [{ seq: 0, nodeId: 'shape', namespace: 'shape', output: {}, edgeId: 'pick-b' }], nextNodeId: 'b' }],
      ['an edge the definition does not hold', { path: [{ seq: 0, nodeId: 'shape', namespace: 'shape', output: {}, edgeId: 'shape-gone' }], nextNodeId: 'pick' }],
      ['a next step the last edge does not reach', { path: [{ seq: 0, nodeId: 'shape', namespace: 'shape', output: {}, edgeId: 'shape-pick' }], nextNodeId: 'a' }],
      ['a step whose namespace changed', { path: [{ seq: 0, nodeId: 'shape', namespace: 'renamed', output: {}, edgeId: 'shape-pick' }], nextNodeId: 'pick' }],
    ]
    for (const [why, over] of cases) {
      let reason = ''
      try {
        replayCheckpoint(BRANCHED.nodes, BRANCHED.edges, checkpoint(over))
      } catch (err) {
        if (err instanceof CheckpointRefused) reason = err.reason
        else throw err
      }
      expect(reason, why).toBe('checkpoint_route_mismatch')
    }
  })
})

describe('continuationModeFrom', () => {
  it('reads off and observe, and treats anything else as off, named, since a mode this build does not run must never run half', () => {
    expect(continuationModeFrom(undefined)).toEqual({ mode: 'off', unknown: null })
    expect(continuationModeFrom(' ')).toEqual({ mode: 'off', unknown: null })
    expect(continuationModeFrom('off')).toEqual({ mode: 'off', unknown: null })
    expect(continuationModeFrom('observe')).toEqual({ mode: 'observe', unknown: null })
    expect(continuationModeFrom('on')).toEqual({ mode: 'off', unknown: 'on' })
    expect(continuationModeFrom('Observe')).toEqual({ mode: 'off', unknown: 'Observe' })
  })
})

/** An R2 bucket double with the conditional put the store relies on: onlyIf etagDoesNotMatch '*' writes only where nothing is. */
function bucketDouble(over: { putThrows?: Error } = {}) {
  const objects = new Map<string, string>()
  const puts: Array<{ key: string; onlyIf: unknown; sha256: unknown }> = []
  const bucket = {
    async put(key: string, body: string, options: { onlyIf?: unknown; sha256?: unknown }) {
      puts.push({ key, onlyIf: options.onlyIf, sha256: options.sha256 })
      if (over.putThrows) throw over.putThrows
      if (objects.has(key)) return null
      objects.set(key, body)
      return { key }
    },
    async get(key: string) {
      const body = objects.get(key)
      return body === undefined ? null : { text: async () => body }
    },
  }
  return { bucket: bucket as unknown as R2Bucket, objects, puts }
}

describe('r2CheckpointStore', () => {
  it('writes only where nothing is, with R2 checking the digest it was given', async () => {
    const b = bucketDouble()
    const store = r2CheckpointStore(b.bucket)
    const enc = await encodeCheckpoint(checkpoint())
    expect(await store.put(enc.key, enc.body, enc.sha256)).toBe('written')
    expect(b.puts[0]).toEqual({ key: enc.key, onlyIf: { etagDoesNotMatch: '*' }, sha256: enc.sha256 })
    expect(await store.get(enc.key)).toBe(enc.body)
    expect(await store.get('checkpoints/v1/none.json')).toBeNull()
  })

  it('a repeat after a lost answer finds its own object and says already_written; another body at the key is refused, never overwritten', async () => {
    const b = bucketDouble()
    const store = r2CheckpointStore(b.bucket)
    const enc = await encodeCheckpoint(checkpoint())
    await store.put(enc.key, enc.body, enc.sha256)
    expect(await store.put(enc.key, enc.body, enc.sha256)).toBe('already_written')
    const other = await encodeCheckpoint(checkpoint({ writtenAt: '2026-10-27T14:00:01.000Z' }))
    expect(await refusal(store.put(enc.key, other.body, other.sha256))).toBe('checkpoint_key_taken')
    expect(b.objects.get(enc.key)).toBe(enc.body)
  })

  it('passes on a failed write as thrown, never as written', async () => {
    const store = r2CheckpointStore(bucketDouble({ putThrows: new Error('R2 answered 500') }).bucket)
    const enc = await encodeCheckpoint(checkpoint())
    await expect(store.put(enc.key, enc.body, enc.sha256)).rejects.toThrow(/R2 answered 500/)
  })
})
