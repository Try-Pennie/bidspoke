/**
 * Recording a post-answer Salesforce write that is still out after 2 seconds
 * (#2022, phase D of #2015).
 *
 * A write that settles inside 2 s (most do, in about 100 ms) costs nothing. One
 * still out is recorded in KV, its body encrypted, so a run that dies, times out
 * or is cut off leaves the write findable by the read-back (#2023). A landed or
 * definitely refused write clears its record; anything else leaves it unknown.
 */
import { describe, it, expect } from 'vitest'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'
import { decryptSecret, secretKeys } from '../../lib/secret-crypto'
import {
  startAtRiskWatch,
  atRiskKey,
  outcomeOfFailedWrite,
  startWatchSafely,
  runWatched,
  AT_RISK_WRITE_PREFIX,
  AT_RISK_AFTER_MS,
  AT_RISK_WRITE_TTL_SECONDS,
  type AtRiskEntry,
} from '../at-risk-writes'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 11)).toString('base64')
const NEXT = Buffer.from(new Uint8Array(32).map((_, i) => i + 47)).toString('base64')

function kv() {
  const store = new Map<string, { value: string; ttl?: number }>()
  const ops: string[] = []
  return {
    store,
    ops,
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      ops.push(`put ${k}`)
      store.set(k, { value: v, ttl: o?.expirationTtl })
    },
    delete: async (k: string) => {
      ops.push(`delete ${k}`)
      store.delete(k)
    },
  }
}

const RUN = { orgId: 'org-1', workflowId: 'wf-1', executionId: 'ex-1' }
const REQ = { object: 'Submission__c', record_id: 'a04Ui00000NkhG1IAJ', operation: 'update' as const, body: { External_Exchange_Status__c: 'Completed', PDFlow_1__c: 'https://app/run/ex-1' } }

function watch(store: ReturnType<typeof kv>, clock: VirtualClock, keys: string | ReturnType<typeof secretKeys> = KEY) {
  return startAtRiskWatch({ kv: store, keys, clock, run: RUN, stepNamespace: 'patch_submission' })
}

describe('startAtRiskWatch', () => {
  it('writes nothing for a write that settles inside the threshold', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    w.note(REQ)
    await clock.run(AT_RISK_AFTER_MS - 1)
    await w.settle('landed')
    await clock.run()
    expect(store.ops).toEqual([])
  })

  it('records a write still out at the threshold, encrypted, with a 24 hour expiry', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    w.note(REQ)
    await clock.run(AT_RISK_AFTER_MS)
    const held = store.store.get(atRiskKey('ex-1', 'patch_submission'))
    expect(held?.ttl).toBe(AT_RISK_WRITE_TTL_SECONDS)
    expect(atRiskKey('ex-1', 'patch_submission').startsWith(AT_RISK_WRITE_PREFIX)).toBe(true)
    expect(held?.value).not.toContain('Completed')
    const entry = JSON.parse(held!.value) as AtRiskEntry
    expect(entry).toMatchObject({ v: 1, org_id: 'org-1', workflow_id: 'wf-1', execution_id: 'ex-1', step_namespace: 'patch_submission', sf_object: 'Submission__c', sf_record_id: 'a04Ui00000NkhG1IAJ', sf_operation: 'update' })
    expect(JSON.parse(await decryptSecret(entry.body_encrypted, KEY))).toEqual(REQ.body)
    await w.settle('unknown')
  })

  it('clears the record when a late write lands', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    w.note(REQ)
    await clock.run(AT_RISK_AFTER_MS + 500)
    await w.settle('landed')
    expect(store.store.size).toBe(0)
    expect(store.ops).toEqual([`put ${atRiskKey('ex-1', 'patch_submission')}`, `delete ${atRiskKey('ex-1', 'patch_submission')}`])
  })

  it('clears the record on a definite refusal, which the replay store holds instead', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    w.note(REQ)
    await clock.run(AT_RISK_AFTER_MS)
    await w.settle('refused')
    expect(store.store.size).toBe(0)
  })

  it('keeps the record when the outcome is unknown', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    w.note(REQ)
    await clock.run(AT_RISK_AFTER_MS)
    await w.settle('unknown')
    expect(store.store.size).toBe(1)
  })

  it('records a request that only arrives after the threshold, as soon as it is known', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    await clock.run(AT_RISK_AFTER_MS + 1000)
    expect(store.store.size).toBe(0)
    w.note(REQ)
    await clock.run()
    expect(store.store.size).toBe(1)
    await w.settle('unknown')
  })

  it('rewrites the record when the body changes after it was written', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    w.note(REQ)
    await clock.run(AT_RISK_AFTER_MS)
    const blanked = { ...REQ, body: { ...REQ.body, Email__c: null } }
    w.note(blanked)
    await w.settle('unknown')
    const entry = JSON.parse(store.store.get(atRiskKey('ex-1', 'patch_submission'))!.value) as AtRiskEntry
    expect(JSON.parse(await decryptSecret(entry.body_encrypted, KEY))).toEqual(blanked.body)
  })

  it('stays readable through a key rotation: written under NEXT, read once NEXT is the primary', async () => {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock, secretKeys({ SECRET_ENCRYPTION_KEY: KEY, SECRET_ENCRYPTION_KEY_NEXT: NEXT }))
    w.note(REQ)
    await clock.run(AT_RISK_AFTER_MS)
    await w.settle('unknown')
    const entry = JSON.parse(store.store.get(atRiskKey('ex-1', 'patch_submission'))!.value) as AtRiskEntry
    expect(JSON.parse(await decryptSecret(entry.body_encrypted, secretKeys({ SECRET_ENCRYPTION_KEY: NEXT })))).toEqual(REQ.body)
  })

  it('logs a record it could not write, and still lets the step settle', async () => {
    const store = kv()
    store.put = async () => { throw new Error('kv unavailable') }
    const clock = new VirtualClock()
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...a: unknown[]) => { errors.push(a) }
    try {
      const w = watch(store, clock)
      w.note(REQ)
      await clock.run(AT_RISK_AFTER_MS)
      await w.settle('unknown')
    } finally {
      console.error = original
    }
    expect(errors.map((e) => e.join(' ')).join('\n')).toMatch(/at-risk.*patch_submission.*kv unavailable/s)
  })
})

describe('outcomeOfFailedWrite', () => {
  it('reads a Salesforce business rejection as a definite refusal', () => {
    expect(outcomeOfFailedWrite(Object.assign(new Error('x'), { permanent: true, status: 400 }))).toBe('refused')
  })

  it('reads anything that may have reached Salesforce as unknown', () => {
    expect(outcomeOfFailedWrite(Object.assign(new Error('x'), { status: 503 }))).toBe('unknown')
    expect(outcomeOfFailedWrite(new Error('Step timed out after 30000ms'))).toBe('unknown')
    expect(outcomeOfFailedWrite(Object.assign(new Error('x'), { permanent: true }))).toBe('unknown')
    expect(outcomeOfFailedWrite('aborted')).toBe('unknown')
  })
})

describe('startWatchSafely', () => {
  // The watch guards a write; it must never be what stops it.
  it('runs the write unwatched when the watch cannot start, and says so', () => {
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...a: unknown[]) => { errors.push(a) }
    try {
      expect(startWatchSafely(() => { throw new Error('no key') }, 'patch_submission')).toBeNull()
    } finally {
      console.error = original
    }
    expect(errors.map((e) => e.join(' ')).join('\n')).toMatch(/patch_submission.*no key/s)
  })

  it('has no watch to start on a run that sets none', () => {
    expect(startWatchSafely(undefined, 'patch_submission')).toBeNull()
  })
})

describe('runWatched', () => {
  const refusal = () => Object.assign(new Error('Salesforce API error (400)'), { permanent: true, status: 400 })

  async function settledRecord(retriesBefore: number) {
    const store = kv()
    const clock = new VirtualClock()
    const w = watch(store, clock)
    const done = runWatched(w, () => {}, async () => {
      w.note(REQ)
      await clock.delay(AT_RISK_AFTER_MS + 1)
      throw refusal()
    }, () => retriesBefore).catch(() => {})
    await clock.run()
    await done
    return store.store.size
  }

  it('clears the record on a refusal at the first attempt', async () => {
    expect(await settledRecord(0)).toBe(0)
  })

  // Only a transient failure is retried, so an earlier attempt may have landed:
  // a later refusal cannot speak for it, and the record stays for the read-back.
  it('keeps the record on a refusal after a retry, since an earlier attempt may have landed', async () => {
    expect(await settledRecord(1)).toBe(1)
  })
})
