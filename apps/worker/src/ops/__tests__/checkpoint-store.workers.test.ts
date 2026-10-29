/**
 * The run checkpoint store against a REAL R2 binding (#1951), inside workerd
 * with the OPS_CHECKPOINTS binding wrangler.ops.toml declares. The Node tests
 * use a double of R2's conditional put; this proves the double's two claims on
 * the platform's own implementation: a put with onlyIf etagDoesNotMatch '*'
 * writes only where nothing is, and a put whose sha256 is not the body's digest
 * is refused rather than stored.
 */
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { CHECKPOINT_FORMAT, CONTINUATION_BUDGET, CheckpointRefused, checkpointStoreFrom, decodeCheckpoint, encodeCheckpoint, type Checkpoint } from '../checkpoint'
import type { OpsEnv } from '../index'
import { organizationIdFrom } from '../ops-db'
import type { NamedCheckpoint } from '../ops-writes'
import type { RunContext } from '../run-invocation'
import { walkOpsDefinition, type OpsStepHandler } from '../run-walk'

const opsEnv = env as unknown as OpsEnv

const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const RUN_ID = '0192f4a0-0000-7000-8000-000000000001'
const IDENTITY = { runRequestId: RUN_ID, organizationId: ORG, workflowId: '00000000-0000-4000-8000-0000000019a1', workflowVersion: 3, executionChainId: '0192f4a0-0000-7000-9000-000000000001' }

function checkpoint(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    v: CHECKPOINT_FORMAT, ...IDENTITY, stateVersion: 4, executionId: '0192f4a0-0000-7000-8000-0000000000ee', attempt: 1, writtenAt: '2026-10-27T14:00:00.000Z',
    path: [{ seq: 0, nodeId: 'shape', namespace: 'shape', output: { amount: 3 }, edgeId: 'shape-pick' }],
    nextNodeId: 'pick', totals: { steps: 1, computeMs: 10, slices: 1 },
    ...over,
  }
}

describe('the checkpoint store on R2 (workerd)', () => {
  it('is bound under the name the code reads', () => {
    expect(opsEnv.OPS_CHECKPOINTS).toBeDefined()
  })

  it('writes a checkpoint, reads it back whole, and a repeat of the same write is already_written', async () => {
    const store = checkpointStoreFrom(opsEnv)
    const cp = checkpoint()
    const enc = await encodeCheckpoint(cp)
    expect(await store.put(enc.key, enc.body, enc.sha256)).toBe('written')
    expect(await store.put(enc.key, enc.body, enc.sha256)).toBe('already_written')
    const body = await store.get(enc.key)
    expect(body).toBe(enc.body)
    expect(await decodeCheckpoint(body!, { key: enc.key, stateVersion: 4, steps: 1, sha256: enc.sha256, bytes: enc.bytes }, IDENTITY)).toEqual(cp)
  })

  it('never overwrites another body at a taken key', async () => {
    const store = checkpointStoreFrom(opsEnv)
    const first = await encodeCheckpoint(checkpoint({ stateVersion: 5 }))
    const other = await encodeCheckpoint(checkpoint({ stateVersion: 5, writtenAt: '2026-10-27T14:00:09.000Z' }))
    expect(first.key).toBe(other.key)
    await store.put(first.key, first.body, first.sha256)
    let reason = ''
    try {
      await store.put(other.key, other.body, other.sha256)
    } catch (err) {
      if (err instanceof CheckpointRefused) reason = err.reason
      else throw err
    }
    expect(reason).toBe('checkpoint_key_taken')
    expect(await store.get(first.key)).toBe(first.body)
  })

  it('refuses a write whose digest is not the body\'s, storing nothing', async () => {
    const store = checkpointStoreFrom(opsEnv)
    const enc = await encodeCheckpoint(checkpoint({ stateVersion: 6 }))
    await expect(store.put(enc.key, enc.body, 'f'.repeat(64))).rejects.toThrow()
    expect(await store.get(enc.key)).toBeNull()
  })

  it('answers null for a key nothing was written at', async () => {
    expect(await checkpointStoreFrom(opsEnv).get(`checkpoints/v1/${ORG}/${RUN_ID}/99-1.json`)).toBeNull()
  })
})

/**
 * Suspend and resume through the real bucket (#1951, on): one slice writes and
 * names its checkpoint and ends to continue; the next, a new holder at a later
 * state version, resumes from what R2 holds, and refuses an object altered in
 * R2 after it was named rather than walking the run from its first step.
 */
describe('suspend and resume through R2 (workerd)', () => {
  const RESUME_RUN = '0192f4a0-0000-7000-8000-0000000019ab'
  const def = {
    nodes: ['s0', 's1', 's2', 's3'].map((id) => ({ id, namespace: id, type: 'step', config: {} })),
    edges: [{ id: 't-s0', source: 'trigger', target: 's0' }, { id: 's0-s1', source: 's0', target: 's1' }, { id: 's1-s2', source: 's1', target: 's2' }, { id: 's2-s3', source: 's2', target: 's3' }],
  }
  const continuation = { mode: 'on' as const, budget: { ...CONTINUATION_BUDGET, sliceSteps: 2 }, store: () => checkpointStoreFrom(opsEnv), log: () => undefined }

  function slice(row: { pointer: NamedCheckpoint | null; continuations: number }, stateVersion: number): RunContext {
    let t = Date.parse('2026-10-28T12:00:00.000Z')
    return {
      run: {
        ...IDENTITY, runRequestId: RESUME_RUN, organizationId: organizationIdFrom(ORG), triggerKind: 'schedule', claimToken: `token-${stateVersion}`,
        claimExpiresAt: '2026-10-28T12:01:00.000Z', stateVersion, attempts: 0, unchargedAttempts: 0, maxAttempts: 3, resumeReason: null,
        resumedFromExecutionId: null, payload: {}, payloadRef: null,
      },
      executionId: `0192f4a0-0000-7000-8000-0000000000${stateVersion}0`, attempt: 1, signal: new AbortController().signal,
      send: () => Promise.reject(new Error('no step here sends')), now: () => (t += 5), recordStep: async () => undefined,
      stateVersion, continuations: row.continuations,
      checkpoints: {
        name: async (ack) => {
          row.pointer = { key: ack.key, stateVersion, steps: ack.steps, sha256: ack.sha256, bytes: ack.bytes }
          return 'recorded'
        },
        read: async () => row.pointer,
      },
    }
  }

  it('the next slice resumes from what the bucket holds, and the run finishes once', async () => {
    const ran: string[] = []
    const step: OpsStepHandler = async ({ node }) => { ran.push(node.id); return { output: { ran: node.id } } }
    const row = { pointer: null as NamedCheckpoint | null, continuations: 0 }
    expect(await walkOpsDefinition(def, slice(row, 10), { step }, { continuation })).toEqual({ outcome: 'continue' })
    row.continuations++
    expect(await walkOpsDefinition(def, slice(row, 12), { step }, { continuation })).toEqual({ outcome: 'done' })
    expect(ran).toEqual(['s0', 's1', 's2', 's3'])
  })

  it('an object altered in the bucket after it was named is refused by name, and no step runs', async () => {
    const ran: string[] = []
    const step: OpsStepHandler = async ({ node }) => { ran.push(node.id); return { output: { ran: node.id } } }
    const row = { pointer: null as NamedCheckpoint | null, continuations: 0 }
    await walkOpsDefinition(def, slice(row, 20), { step }, { continuation })
    row.continuations++
    // Written over outside the store's only-where-nothing-is put, as a torn or tampered object would be.
    await opsEnv.OPS_CHECKPOINTS!.put(row.pointer!.key, '{"v":1}')
    ran.length = 0
    const end = await walkOpsDefinition(def, slice(row, 22), { step }, { continuation })
    expect(end).toEqual({ outcome: 'failed', error: expect.stringMatching(/^checkpoint_corrupt: /) })
    expect(ran).toEqual([])
  })
})
