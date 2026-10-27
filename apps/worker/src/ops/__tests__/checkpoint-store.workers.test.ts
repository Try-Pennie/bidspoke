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
import { CHECKPOINT_FORMAT, CheckpointRefused, checkpointStoreFrom, decodeCheckpoint, encodeCheckpoint, type Checkpoint } from '../checkpoint'
import type { OpsEnv } from '../index'

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
