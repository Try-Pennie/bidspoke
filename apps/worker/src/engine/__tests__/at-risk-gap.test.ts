/**
 * Measuring the at-risk watch's gap (#2055, from phase D of #2015).
 *
 * The watch records a post-answer Salesforce write only once it has been out for
 * 2 s, so a write whose record never lands (the KV write failed, the watch never
 * started, or the request's work was cancelled inside the write's first 2 s) is
 * a write nothing will ever read back. These drive the real watch through the
 * ledger, on a virtual clock, and read the evidence the ledger leaves in KV.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { VirtualClock } from '../../lib/__tests__/_virtual-clock'
import { startAtRiskWatch, atRiskKey, AT_RISK_AFTER_MS, AT_RISK_WRITE_PREFIX, type AtRiskKv } from '../at-risk-writes'
import {
  AtRiskLedger,
  AT_RISK_GAP_PREFIX,
  AT_RISK_GAP_TTL_SECONDS,
  RECORD_GRACE_MS,
  atRiskGapKey,
  parseAtRiskGapKey,
} from '../at-risk-gap'

const KEY = Buffer.from(new Uint8Array(32).map((_, i) => i + 5)).toString('base64')
const RUN = { orgId: 'org-1', workflowId: 'wf-1', executionId: '01a1-ex' }
const REQ = { object: 'Prospect__c', record_id: 'a06Ui00002sLkNuIAK', operation: 'update' as const, body: { BidStatus__c: 'Rejected' } }
const DAY = '1970-01-01'
const RECORD = atRiskKey(RUN.executionId, 'patch_prospect_reject')

function makeKv(opts: { recordFails?: boolean; gapFails?: boolean } = {}) {
  const store = new Map<string, { value: string; ttl?: number }>()
  const ops: string[] = []
  return {
    store,
    ops,
    gapKeys: () => [...store.keys()].filter((k) => k.startsWith(AT_RISK_GAP_PREFIX)).sort(),
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      if (opts.recordFails && k.startsWith(AT_RISK_WRITE_PREFIX)) throw new Error('KV PUT failed: 503 Service Unavailable')
      if (opts.gapFails && k.startsWith(AT_RISK_GAP_PREFIX)) throw new Error('KV PUT failed: 503 Service Unavailable')
      ops.push(`put ${k}`)
      store.set(k, { value: v, ttl: o?.expirationTtl })
    },
    delete: async (k: string) => {
      ops.push(`delete ${k}`)
      store.delete(k)
    },
  }
}

function setup(opts: { recordFails?: boolean; gapFails?: boolean; startThrows?: boolean; msUntilCancel?: (clock: VirtualClock) => number } = {}) {
  const clock = new VirtualClock()
  const kv = makeKv(opts)
  const ledger = new AtRiskLedger({
    kv,
    clock,
    run: { workflowId: RUN.workflowId, executionId: RUN.executionId },
    msUntilCancel: () => (opts.msUntilCancel ? opts.msUntilCancel(clock) : Number.POSITIVE_INFINITY),
  })
  const start = ledger.follow((stepNamespace: string, watchKv: AtRiskKv) => {
    if (opts.startThrows) throw new Error('SECRET_ENCRYPTION_KEY is not set')
    return startAtRiskWatch({ kv: watchKv, keys: KEY, clock, run: RUN, stepNamespace })
  })
  return { clock, kv, ledger, start }
}

/** Moves the clock to `ms` whether or not anything is waiting: the clock only moves to timers. */
async function advanceTo(clock: VirtualClock, ms: number) {
  void clock.delay(ms - clock.now())
  await clock.run(ms)
}

const gap = (kind: string, step = 'patch_prospect_reject') => atRiskGapKey(DAY, kind as never, RUN.executionId, step)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the gap key', () => {
  it('reads back what it was built from, a namespace with a colon in it included', () => {
    const key = atRiskGapKey('2026-10-18', 'missed', '01a14e9b-dfa4', 'odd:step')
    expect(key.startsWith(AT_RISK_GAP_PREFIX)).toBe(true)
    expect(parseAtRiskGapKey(key)).toEqual({ day: '2026-10-18', kind: 'missed', execution_id: '01a14e9b-dfa4', step_namespace: 'odd:step' })
  })

  it('refuses a key that is not one', () => {
    expect(parseAtRiskGapKey('at-risk-write:ex:step')).toBeNull()
    expect(parseAtRiskGapKey(`${AT_RISK_GAP_PREFIX}2026-10-18:nonsense:ex:step`)).toBeNull()
  })
})

describe('AtRiskLedger at the cut-off', () => {
  it('counts the run, and a running write whose record is in KV as held', async () => {
    const { clock, kv, ledger, start } = setup()
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await advanceTo(clock, 5_000)
    // The record is encrypted with real WebCrypto: wait for it, not for a number of turns.
    await vi.waitFor(() => expect(kv.store.has(RECORD)).toBe(true))
    await ledger.measureCutOff(['patch_prospect_reject'])
    expect(kv.gapKeys()).toEqual([atRiskGapKey(DAY, 'cut_off', RUN.executionId, '-'), gap('held')].sort())
    await w.settle('unknown')
  })

  it('counts a running write past its 2 s mark with no record as unrecorded, and says so', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { clock, kv, ledger, start } = setup({ recordFails: true })
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await advanceTo(clock, 5_000)
    await ledger.measureCutOff(['patch_prospect_reject'])
    expect(kv.gapKeys()).toContain(gap('unrecorded'))
    expect(kv.gapKeys()).not.toContain(gap('held'))
    expect(error.mock.calls.some((c) => String(c[0]).includes('[at-risk-gap]') && String(c[0]).includes('patch_prospect_reject'))).toBe(true)
  })

  it('counts a write whose watch never started as unrecorded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { clock, kv, ledger, start } = setup({ startThrows: true })
    expect(() => start('patch_prospect_reject')).toThrow('SECRET_ENCRYPTION_KEY')
    await advanceTo(clock, 5_000)
    await ledger.measureCutOff(['patch_prospect_reject'])
    expect(kv.gapKeys()).toContain(gap('unrecorded'))
  })

  it('ignores a running step that is not a watched write, and still counts the run', async () => {
    const { kv, ledger } = setup()
    await ledger.measureCutOff(['send_salesforce'])
    expect(kv.gapKeys()).toEqual([atRiskGapKey(DAY, 'cut_off', RUN.executionId, '-')])
  })

  it('looks again at a write still inside its first 2 s: caught up once it is recorded', async () => {
    const { clock, kv, ledger, start } = setup()
    await clock.run(1_000)
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await clock.run(1_500)
    const measured = ledger.measureCutOff(['patch_prospect_reject'])
    await clock.run(1_000 + AT_RISK_AFTER_MS)
    await vi.waitFor(() => expect(kv.store.has(RECORD)).toBe(true))
    await clock.run(1_000 + AT_RISK_AFTER_MS + RECORD_GRACE_MS)
    await measured
    expect(kv.gapKeys()).toEqual([atRiskGapKey(DAY, 'cut_off', RUN.executionId, '-'), gap('exposed'), gap('caught_up')].sort())
    await w.settle('unknown')
  })

  it('looks again at a write still inside its first 2 s: caught up when it settles first', async () => {
    const { clock, kv, ledger, start } = setup()
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await clock.run(500)
    const measured = ledger.measureCutOff(['patch_prospect_reject'])
    await clock.run(900)
    await w.settle('landed')
    await clock.run()
    await measured
    expect(kv.gapKeys()).toContain(gap('caught_up'))
    expect(kv.gapKeys()).not.toContain(gap('missed'))
  })

  it('looks again at a write still inside its first 2 s: missed when its record never lands', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { clock, kv, ledger, start } = setup({ recordFails: true })
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await clock.run(500)
    const measured = ledger.measureCutOff(['patch_prospect_reject'])
    await clock.run()
    await measured
    expect(kv.gapKeys()).toContain(gap('exposed'))
    expect(kv.gapKeys()).toContain(gap('missed'))
    expect(kv.gapKeys()).not.toContain(gap('caught_up'))
    await w.settle('unknown')
  })

  it('keeps its evidence for 8 days', async () => {
    const { kv, ledger } = setup()
    await ledger.measureCutOff([])
    const [only] = kv.gapKeys()
    expect(kv.store.get(only)?.ttl).toBe(AT_RISK_GAP_TTL_SECONDS)
    expect(AT_RISK_GAP_TTL_SECONDS).toBe(8 * 24 * 60 * 60)
    expect(JSON.parse(kv.store.get(only)!.value)).toMatchObject({ v: 1, workflow_id: 'wf-1', execution_id: RUN.executionId })
  })

  it('never throws into the run when its own evidence cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { clock, ledger, start } = setup({ gapFails: true })
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await advanceTo(clock, 5_000)
    await expect(ledger.measureCutOff(['patch_prospect_reject'])).resolves.toBeUndefined()
    await w.settle('unknown')
  })
})

describe('AtRiskLedger on a write that starts too late to be recorded', () => {
  it('writes nothing of its own for a write that starts with time to spare', async () => {
    const { clock, kv, start } = setup({ msUntilCancel: () => 20_000 })
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await clock.run(100)
    await w.settle('landed')
    await clock.run()
    expect(kv.gapKeys()).toEqual([])
  })

  it('counts a write that starts with less than 2 s before the request is cancelled', async () => {
    const { clock, kv, start } = setup({ msUntilCancel: (c) => 30_000 - (c.now() + 28_500) })
    start('patch_prospect_reject').note(REQ)
    // The request is cancelled here: nothing after it runs, so only the start is on record.
    await clock.run(1_000)
    expect(kv.gapKeys()).toEqual([gap('late_start')])
  })

  it('follows it up as caught up when it settles before the cancel', async () => {
    const { clock, kv, start } = setup({ msUntilCancel: () => 1_500 })
    const w = start('patch_prospect_reject')
    w.note(REQ)
    await clock.run(200)
    await w.settle('landed')
    await clock.run()
    expect(kv.gapKeys()).toEqual([gap('caught_up'), gap('late_start')].sort())
  })
})
