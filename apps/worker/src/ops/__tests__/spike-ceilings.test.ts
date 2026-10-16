/**
 * Spike 0 (#1946): the ceiling probes the ops Worker runs only when armed.
 *
 * Nothing here deploys anything. These tests pin the parts that decide whether a
 * probe runs at all (the arm, its expiry, the one-claim-per-arming marker, the
 * lane), and that each probe stops at its own cap and reports what it reached,
 * with the clock, the sleep and the CPU burner injected (L524, L290): no test
 * waits for real.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createSpikeScheduled,
  cpuProbe,
  MAX_ARM_AHEAD_MS,
  parseSpikeArm,
  SPIKE_PREFIX,
  subrequestProbe,
  wallProbe,
  type ProbeRuntime,
  type SpikeEnv,
} from '../spike/ceilings'

const NOW = Date.parse('2026-10-20T15:00:00Z')
const arm = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ probe: 'cron_wall', nonce: 'spike-test-0001', until: new Date(NOW + 3_600_000).toISOString(), ...over })

/** A clock that only moves when the probe sleeps, as in workerd (L290). */
function fakeRuntime(over: Partial<ProbeRuntime> = {}): ProbeRuntime & { logs: Record<string, unknown>[]; clock: { t: number } } {
  const clock = { t: NOW }
  const logs: Record<string, unknown>[] = []
  return {
    clock,
    logs,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms
    },
    burn: () => {
      clock.t += 0
    },
    log: (e) => {
      logs.push(e)
    },
    limits: { wallCapMs: 60_000, wallStepMs: 10_000, cpuSliceUnits: 10, cpuMaxSlices: 5, cpuWallCapMs: 60_000, cpuLogEvery: 2, subrequestCap: 25, subrequestLogEvery: 10, fanout: 3, detachedCapMs: 30_000 },
    ...over,
  }
}

describe('parseSpikeArm', () => {
  it('is unarmed when the secret is unset or blank, which is the normal state', () => {
    expect(parseSpikeArm(undefined, NOW)).toEqual({ state: 'unarmed' })
    expect(parseSpikeArm('  ', NOW)).toEqual({ state: 'unarmed' })
  })

  it('arms a well formed value naming a known probe, a safe nonce and an expiry within the window', () => {
    expect(parseSpikeArm(arm(), NOW)).toEqual({ state: 'armed', arm: { probe: 'cron_wall', nonce: 'spike-test-0001', untilMs: NOW + 3_600_000 } })
  })

  it.each([
    ['not json', 'malformed'],
    ['[]', 'malformed'],
    [arm({ probe: 'drop_tables' }), 'unknown_probe'],
    [arm({ nonce: 'a/b' }), 'bad_nonce'],
    [arm({ nonce: 'short' }), 'bad_nonce'],
    [arm({ until: 'tomorrow' }), 'malformed'],
    [arm({ until: new Date(NOW - 1).toISOString() }), 'expired'],
    [arm({ until: new Date(NOW + MAX_ARM_AHEAD_MS + 1).toISOString() }), 'too_far_ahead'],
  ])('refuses %s by name (%s)', (raw, reason) => {
    expect(parseSpikeArm(raw, NOW)).toEqual({ state: 'refused', reason })
  })
})

describe('wallProbe', () => {
  it('waits in steps, logging elapsed time each step, and stops at its cap', async () => {
    const rt = fakeRuntime()
    const result = await wallProbe('caller', rt)
    expect(result).toEqual({ elapsedMs: 60_000, steps: 6 })
    const progress = rt.logs.filter((l) => l.stage === 'progress')
    expect(progress.map((l) => l.elapsed_ms)).toEqual([10_000, 20_000, 30_000, 40_000, 50_000, 60_000])
    expect(progress.every((l) => l.role === 'caller' && l.probe === 'wall')).toBe(true)
  })
})

describe('cpuProbe', () => {
  it('burns in slices, yielding between them so the clock and the log advance, and stops at its slice cap', async () => {
    const burned: number[] = []
    const rt = fakeRuntime({ burn: (units) => { burned.push(units) } })
    const result = await cpuProbe('callee', rt)
    expect(result).toEqual({ slices: 5, units: 50, stoppedBy: 'slice_cap' })
    expect(burned).toEqual([10, 10, 10, 10, 10])
    expect(rt.logs.filter((l) => l.stage === 'progress').map((l) => l.slices)).toEqual([2, 4])
  })

  it('stops at its wall cap when the slices never run out', async () => {
    const rt = fakeRuntime()
    rt.limits = { ...rt.limits, cpuMaxSlices: 1_000_000, cpuWallCapMs: 3 }
    const result = await cpuProbe('caller', rt)
    expect(result.stoppedBy).toBe('wall_cap')
    expect(result.slices).toBe(3)
  })
})

describe('subrequestProbe', () => {
  it('makes subrequests up to its cap, logging a count every so often', async () => {
    const rt = fakeRuntime()
    const sub = vi.fn(async () => {})
    expect(await subrequestProbe('caller', rt, sub)).toEqual({ completed: 25, error: null })
    expect(sub).toHaveBeenCalledTimes(25)
    expect(rt.logs.filter((l) => l.stage === 'progress').map((l) => l.completed)).toEqual([10, 20])
  })

  it('records how many completed when the platform refuses one, which is the ceiling', async () => {
    const rt = fakeRuntime()
    const sub = vi.fn(async (i: number) => {
      if (i === 12) throw new Error('Too many subrequests.')
    })
    expect(await subrequestProbe('caller', rt, sub)).toEqual({ completed: 12, error: 'Too many subrequests.' })
  })
})

/** An R2 double honouring the one precondition the claim uses. */
function bucket() {
  const store = new Map<string, string>()
  return {
    store,
    put: vi.fn(async (key: string, value: string, opts?: { onlyIf?: { etagDoesNotMatch?: string } }) => {
      if (opts?.onlyIf?.etagDoesNotMatch === '*' && store.has(key)) return null
      store.set(key, value)
      return { key } as unknown as R2Object
    }),
    head: vi.fn(async () => null),
  }
}

function env(over: Partial<SpikeEnv> & { bucket?: ReturnType<typeof bucket> } = {}) {
  const b = over.bucket ?? bucket()
  const self = { ping: vi.fn(async () => ({ lane: 'ops', entrypoint: 'OpsInternal' })), probe: vi.fn(async () => ({ ok: true })) }
  return { b, self, env: { LANE: 'ops', OPS_SPIKE_ARM: arm(), PORTING_TEE: b as unknown as R2Bucket, SELF: self, ...over } as SpikeEnv }
}

const controller = { scheduledTime: NOW, cron: '* * * * *', noRetry: () => {} } as unknown as ScheduledController
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

describe('the spike tick', () => {
  it('does nothing at all, and touches no binding, while unarmed', async () => {
    const { b, self, env: e } = env({ OPS_SPIKE_ARM: undefined })
    const rt = fakeRuntime()
    expect(await createSpikeScheduled(rt)(controller, e, ctx)).toBe('unarmed')
    expect(b.put).not.toHaveBeenCalled()
    expect(b.head).not.toHaveBeenCalled()
    expect(self.ping).not.toHaveBeenCalled()
    expect(rt.logs).toEqual([])
  })

  it('refuses by name, and runs nothing, when the lane is not ops', async () => {
    const { b, env: e } = env({ LANE: 'money' })
    const rt = fakeRuntime()
    expect(await createSpikeScheduled(rt)(controller, e, ctx)).toBe('lane_refused')
    expect(b.put).not.toHaveBeenCalled()
    expect(rt.logs).toEqual([{ event: 'spike_1946', stage: 'lane_refused', lane: 'money' }])
  })

  it('logs a refused arm by its reason and runs nothing', async () => {
    const { b, env: e } = env({ OPS_SPIKE_ARM: arm({ until: new Date(NOW - 1).toISOString() }) })
    const rt = fakeRuntime()
    expect(await createSpikeScheduled(rt)(controller, e, ctx)).toBe('refused')
    expect(b.put).not.toHaveBeenCalled()
    expect(rt.logs).toEqual([{ event: 'spike_1946', stage: 'arm_refused', reason: 'expired' }])
  })

  it('claims the arming once, so a later minute, an overlapping tick or a retry stands down', async () => {
    const { b, env: e } = env()
    const rt = fakeRuntime()
    const tick = createSpikeScheduled(rt)
    expect(await tick(controller, e, ctx)).toBe('ran')
    expect(await tick(controller, e, ctx)).toBe('stood_down')
    expect([...b.store.keys()].sort()).toEqual([`${SPIKE_PREFIX}spike-test-0001/claim.json`, `${SPIKE_PREFIX}spike-test-0001/result.json`])
    expect(rt.logs.filter((l) => l.stage === 'stood_down')).toHaveLength(1)
  })

  it('fails loudly, and runs nothing, when the claim cannot be written', async () => {
    const b = bucket()
    b.put.mockRejectedValueOnce(new Error('r2 down'))
    const { env: e } = env({ bucket: b })
    const rt = fakeRuntime()
    expect(await createSpikeScheduled(rt)(controller, e, ctx)).toBe('failed')
    expect(rt.logs).toContainEqual({ event: 'spike_1946', stage: 'claim_failed', probe: 'cron_wall', nonce: 'spike-test-0001', error: 'r2 down' })
    expect(rt.logs.some((l) => l.stage === 'progress')).toBe(false)
  })

  it('writes what the probe reached to the result object', async () => {
    const { b, env: e } = env()
    await createSpikeScheduled(fakeRuntime())(controller, e, ctx)
    const result = JSON.parse(b.store.get(`${SPIKE_PREFIX}spike-test-0001/result.json`) ?? '{}')
    expect(result).toMatchObject({ probe: 'cron_wall', nonce: 'spike-test-0001', outcome: 'completed', result: { elapsedMs: 60_000, steps: 6 } })
  })

  it('runs the subrequest probe against one fixed key under the spike prefix', async () => {
    const { b, env: e } = env({ OPS_SPIKE_ARM: arm({ probe: 'cron_subrequests' }) })
    await createSpikeScheduled(fakeRuntime())(controller, e, ctx)
    expect(b.head).toHaveBeenCalledTimes(25)
    expect(new Set(b.head.mock.calls.map((c) => (c as unknown[])[0]))).toEqual(new Set([`${SPIKE_PREFIX}subrequest-probe`]))
  })
})

describe('the dispatch probes go through the SELF binding, never a fetch', () => {
  it('dispatch_ping reaches OpsInternal and records what it answered', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { b, self, env: e } = env({ OPS_SPIKE_ARM: arm({ probe: 'dispatch_ping' }) })
    expect(await createSpikeScheduled(fakeRuntime())(controller, e, ctx)).toBe('ran')
    expect(self.ping).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.parse(b.store.get(`${SPIKE_PREFIX}spike-test-0001/result.json`) ?? '{}').result).toEqual({ lane: 'ops', entrypoint: 'OpsInternal' })
    fetchSpy.mockRestore()
  })

  it.each([
    ['dispatch_wall', 'wall'],
    ['dispatch_cpu', 'cpu'],
    ['dispatch_subrequests', 'subrequests'],
  ])('%s awaits the callee probe %s, carrying the arming nonce', async (probe, kind) => {
    const { self, env: e } = env({ OPS_SPIKE_ARM: arm({ probe }) })
    await createSpikeScheduled(fakeRuntime())(controller, e, ctx)
    expect(self.probe).toHaveBeenCalledWith({ kind, nonce: 'spike-test-0001' })
  })

  it('records a callee refusal as a failed probe naming the reason, never as completed', async () => {
    const { b, self, env: e } = env({ OPS_SPIKE_ARM: arm({ probe: 'dispatch_wall' }) })
    self.probe.mockResolvedValueOnce({ refused: 'nonce_mismatch' } as never)
    expect(await createSpikeScheduled(fakeRuntime())(controller, e, ctx)).toBe('failed')
    expect(JSON.parse(b.store.get(`${SPIKE_PREFIX}spike-test-0001/result.json`) ?? '{}')).toMatchObject({ outcome: 'failed', error: 'the callee refused: nonce_mismatch' })
  })

  it('dispatch_detached starts the callee without awaiting it and returns at once', async () => {
    let release: () => void = () => {}
    const { self, env: e } = env({ OPS_SPIKE_ARM: arm({ probe: 'dispatch_detached' }) })
    self.probe.mockImplementation(() => new Promise((r) => { release = () => r({ ok: true }) }))
    const rt = fakeRuntime()
    expect(await createSpikeScheduled(rt)(controller, e, ctx)).toBe('ran')
    expect(self.probe).toHaveBeenCalledWith({ kind: 'wall', nonce: 'spike-test-0001' })
    expect(rt.logs).toContainEqual(expect.objectContaining({ stage: 'detached_returned' }))
    release()
  })

  it('dispatch_detached records a callee that rejects after the caller returned, rather than an unhandled rejection', async () => {
    const { self, env: e } = env({ OPS_SPIKE_ARM: arm({ probe: 'dispatch_detached' }) })
    let reject: (err: Error) => void = () => {}
    self.probe.mockImplementation(() => new Promise((_r, j) => { reject = j }))
    const rt = fakeRuntime()
    await createSpikeScheduled(rt)(controller, e, ctx)
    reject(new Error('canceled'))
    await new Promise((r) => setImmediate(r))
    expect(rt.logs).toContainEqual(expect.objectContaining({ stage: 'detached_callee_failed', error: 'canceled' }))
  })

  it('dispatch_fanout makes concurrent dispatches and counts each outcome, the first refusal named', async () => {
    const { b, self, env: e } = env({ OPS_SPIKE_ARM: arm({ probe: 'dispatch_fanout' }) })
    self.ping
      .mockResolvedValueOnce({ lane: 'ops', entrypoint: 'OpsInternal' })
      .mockResolvedValueOnce({ lane: 'ops', entrypoint: 'OpsInternal' })
      .mockRejectedValueOnce(new Error('Subrequest depth limit exceeded'))
    await createSpikeScheduled(fakeRuntime())(controller, e, ctx)
    expect(self.ping).toHaveBeenCalledTimes(3)
    expect(JSON.parse(b.store.get(`${SPIKE_PREFIX}spike-test-0001/result.json`) ?? '{}').result).toEqual({ attempted: 3, fulfilled: 2, rejected: 1, firstError: 'Subrequest depth limit exceeded' })
  })

  it('records a missing SELF binding as a failure by name, rather than throwing out of the tick', async () => {
    const { env: e } = env({ OPS_SPIKE_ARM: arm({ probe: 'dispatch_ping' }), SELF: undefined })
    const rt = fakeRuntime()
    expect(await createSpikeScheduled(rt)(controller, e, ctx)).toBe('failed')
    expect(rt.logs).toContainEqual(expect.objectContaining({ stage: 'probe_failed', error: 'the SELF binding is not configured' }))
  })
})
