/**
 * Spike 0 (#1946): measure the ops Worker's real ceilings, and prove it can
 * dispatch to itself, before the #1698 run engine is sized.
 *
 * What it measures, each a probe run at most once per arming:
 *
 *   cron_wall          how long a minute cron's scheduled() may wait (wall clock)
 *   cron_cpu           how much CPU a minute cron's scheduled() may burn
 *   cron_subrequests   how many subrequests one scheduled() may make
 *   dispatch_ping      that scheduled() reaches OpsInternal through the SELF binding
 *   dispatch_wall      the same wall probe, inside a dispatched sub-invocation
 *   dispatch_cpu       the same CPU probe, inside a dispatched sub-invocation
 *   dispatch_subrequests  the same subrequest probe, inside one
 *   dispatch_detached  whether a sub-invocation keeps running once its caller ends
 *   dispatch_fanout    how many concurrent dispatches one invocation may make
 *
 * INERT unless armed. The arm is the OPS_SPIKE_ARM secret, a JSON value naming
 * one probe, a nonce and an expiry at most MAX_ARM_AHEAD_MS ahead; unset is the
 * normal state, and an unarmed tick touches no binding and logs nothing. A
 * malformed, expired or too distant arm is refused by name and runs nothing. Each
 * arming runs once: its first tick claims `spike/1946/<nonce>/claim.json` with a
 * write that refuses to overwrite, so the next minute, an overlapping tick and
 * Cloudflare's retry of a killed cron (which carries the same scheduledTime) all
 * stand down. Re-arming means a new nonce.
 *
 * Several probes are built to be KILLED by the platform: the kill is the
 * measurement. Workers Logs records the invocation's outcome (exceededCpu,
 * exceededWallTime, exceededResources), its CPU and its wall time, and the
 * progress lines before it say how far the probe got. A probe that survives
 * writes `result.json` beside the claim. docs/ops-ceilings-spike.md says how to
 * arm each one and read its answer.
 *
 * Data touched: only keys under spike/1946/ in the PORTING_TEE bucket (one
 * claim, one result, and HEAD requests for one key that never exists). No
 * database, no network fetch, no other binding. Logs carry probe names, counts
 * and platform error messages, never a payload.
 *
 * The change that closes #1946 removes this module, OpsInternal.probe, the
 * spike cron and OPS_SPIKE_ARM from OPS_ALLOWED_SECRETS (#1946).
 */

import { formatErr } from '../../lib/format-error'

export const SPIKE_ISSUE = 1946
export const SPIKE_PREFIX = `spike/${SPIKE_ISSUE}/`
/** The one key the subrequest probe asks R2 about. It never exists. */
export const SUBREQUEST_PROBE_KEY = `${SPIKE_PREFIX}subrequest-probe`
/** An arm may name an expiry no further ahead than this, so a forgotten secret disarms itself. */
export const MAX_ARM_AHEAD_MS = 3 * 60 * 60 * 1000

export const PROBE_KINDS = [
  'cron_wall',
  'cron_cpu',
  'cron_subrequests',
  'dispatch_ping',
  'dispatch_wall',
  'dispatch_cpu',
  'dispatch_subrequests',
  'dispatch_detached',
  'dispatch_fanout',
] as const
export type ProbeKind = (typeof PROBE_KINDS)[number]

/** What a dispatched sub-invocation is asked to measure. */
export type CalleeProbeKind = 'wall' | 'cpu' | 'subrequests'
export interface CalleeProbeRequest {
  kind: CalleeProbeKind
  nonce: string
}

export interface SpikeArm {
  probe: ProbeKind
  nonce: string
  untilMs: number
}

export type ArmRefusal = 'malformed' | 'unknown_probe' | 'bad_nonce' | 'expired' | 'too_far_ahead'
export type ArmState = { state: 'unarmed' } | { state: 'refused'; reason: ArmRefusal } | { state: 'armed'; arm: SpikeArm }

const NONCE = /^[a-z0-9-]{8,64}$/

/** Reads OPS_SPIKE_ARM. Anything but a well formed, current arm runs nothing. */
export function parseSpikeArm(raw: string | undefined, nowMs: number): ArmState {
  if (raw === undefined || raw.trim() === '') return { state: 'unarmed' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'refused', reason: 'malformed' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'refused', reason: 'malformed' }
  const { probe, nonce, until } = parsed as Record<string, unknown>
  if (typeof probe !== 'string' || !(PROBE_KINDS as readonly string[]).includes(probe)) return { state: 'refused', reason: 'unknown_probe' }
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return { state: 'refused', reason: 'bad_nonce' }
  const untilMs = typeof until === 'string' ? Date.parse(until) : NaN
  if (!Number.isFinite(untilMs)) return { state: 'refused', reason: 'malformed' }
  if (untilMs <= nowMs) return { state: 'refused', reason: 'expired' }
  if (untilMs - nowMs > MAX_ARM_AHEAD_MS) return { state: 'refused', reason: 'too_far_ahead' }
  return { state: 'armed', arm: { probe: probe as ProbeKind, nonce, untilMs } }
}

export interface ProbeLimits {
  /** The wall probe stops here if nothing kills it first: past the documented 15 minute cron ceiling. */
  wallCapMs: number
  wallStepMs: number
  cpuSliceUnits: number
  cpuMaxSlices: number
  /** The CPU probe's backstop, in wall time, should the platform never stop it. */
  cpuWallCapMs: number
  cpuLogEvery: number
  /** Past the documented 10,000 default, so the refusal is reached. */
  subrequestCap: number
  subrequestLogEvery: number
  /** Past the documented 32 invocations per request chain. */
  fanout: number
  /** How long a detached callee waits: long enough to outlive its caller by minutes. */
  detachedCapMs: number
}

export const DEFAULT_LIMITS: ProbeLimits = {
  wallCapMs: 16 * 60 * 1000,
  wallStepMs: 10_000,
  cpuSliceUnits: 2_000_000,
  cpuMaxSlices: 100_000,
  cpuWallCapMs: 20 * 60 * 1000,
  cpuLogEvery: 50,
  subrequestCap: 12_000,
  subrequestLogEvery: 500,
  fanout: 40,
  detachedCapMs: 5 * 60 * 1000,
}

export interface ProbeRuntime {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Spend CPU proportional to `units`, with no I/O. */
  burn: (units: number) => void
  log: (event: Record<string, unknown>) => void
  limits: ProbeLimits
}

type Role = 'caller' | 'callee'

const errorText = (err: unknown) => formatErr(err).slice(0, 300)

function emit(rt: ProbeRuntime, fields: Record<string, unknown>) {
  rt.log({ event: 'spike_1946', ...fields })
}

/** Waits in steps, logging elapsed wall time, until its cap or the platform stops it. */
export async function wallProbe(role: Role, rt: ProbeRuntime, capMs = rt.limits.wallCapMs): Promise<{ elapsedMs: number; steps: number }> {
  const start = rt.now()
  let steps = 0
  let elapsed = 0
  while (elapsed < capMs) {
    await rt.sleep(Math.min(rt.limits.wallStepMs, capMs - elapsed))
    steps++
    elapsed = rt.now() - start
    emit(rt, { stage: 'progress', probe: 'wall', role, steps, elapsed_ms: elapsed })
  }
  return { elapsedMs: elapsed, steps }
}

/**
 * Burns CPU in slices with a one millisecond sleep between them: workerd's clock
 * advances only across I/O, and the sleep is what lets the progress line carry a
 * real elapsed time. The CPU figure itself comes from the platform's record.
 */
export async function cpuProbe(role: Role, rt: ProbeRuntime): Promise<{ slices: number; units: number; stoppedBy: 'slice_cap' | 'wall_cap' }> {
  const start = rt.now()
  let slices = 0
  while (slices < rt.limits.cpuMaxSlices) {
    if (rt.now() - start >= rt.limits.cpuWallCapMs) {
      return { slices, units: slices * rt.limits.cpuSliceUnits, stoppedBy: 'wall_cap' }
    }
    rt.burn(rt.limits.cpuSliceUnits)
    slices++
    await rt.sleep(1)
    if (slices % rt.limits.cpuLogEvery === 0) emit(rt, { stage: 'progress', probe: 'cpu', role, slices, elapsed_ms: rt.now() - start })
  }
  return { slices, units: slices * rt.limits.cpuSliceUnits, stoppedBy: 'slice_cap' }
}

/** Makes subrequests one at a time until its cap, or until the platform refuses one. */
export async function subrequestProbe(
  role: Role,
  rt: ProbeRuntime,
  subrequest: (i: number) => Promise<unknown>,
): Promise<{ completed: number; error: string | null }> {
  let completed = 0
  try {
    while (completed < rt.limits.subrequestCap) {
      await subrequest(completed)
      completed++
      if (completed % rt.limits.subrequestLogEvery === 0) emit(rt, { stage: 'progress', probe: 'subrequests', role, completed })
    }
  } catch (err) {
    return { completed, error: errorText(err) }
  }
  return { completed, error: null }
}

/** Runs one callee probe: what OpsInternal.probe does inside the dispatched sub-invocation. */
export async function runCalleeProbe(kind: CalleeProbeKind, rt: ProbeRuntime, bucket: R2Bucket): Promise<unknown> {
  switch (kind) {
    case 'wall':
      return wallProbe('callee', rt)
    case 'cpu':
      return cpuProbe('callee', rt)
    case 'subrequests':
      return subrequestProbe('callee', rt, () => bucket.head(SUBREQUEST_PROBE_KEY))
  }
}

/** The part of OpsInternal the spike dispatches to. */
export interface OpsInternalBinding {
  ping(): Promise<unknown>
  probe(request: CalleeProbeRequest): Promise<unknown>
}

export interface SpikeEnv {
  LANE?: string
  OPS_SPIKE_ARM?: string
  PORTING_TEE: R2Bucket
  /** A service binding to this Worker's own OpsInternal entrypoint (wrangler.ops.toml). */
  SELF?: OpsInternalBinding
}

export type SpikeTickOutcome = 'unarmed' | 'lane_refused' | 'refused' | 'stood_down' | 'ran' | 'failed'

export function realRuntime(log: (e: Record<string, unknown>) => void = (e) => console.log(JSON.stringify(e))): ProbeRuntime {
  let sink = 0
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    burn: (units) => {
      let x = sink | 0
      for (let i = 0; i < units; i++) x = (x * 1103515245 + 12345 + i) | 0
      sink = x
    },
    log,
    limits: DEFAULT_LIMITS,
  }
}

function selfOf(env: SpikeEnv): OpsInternalBinding {
  if (!env.SELF) throw new Error('the SELF binding is not configured')
  return env.SELF
}

/** OpsInternal.probe answers a refusal as a value; the caller turns it back into a failure. */
function refusedReason(result: unknown): string | null {
  if (result === null || typeof result !== 'object' || !('refused' in result)) return null
  const { refused } = result
  return typeof refused === 'string' ? refused : JSON.stringify(refused)
}

async function runProbe(arm: SpikeArm, env: SpikeEnv, rt: ProbeRuntime): Promise<unknown> {
  const call = async (kind: CalleeProbeKind) => {
    const result = await selfOf(env).probe({ kind, nonce: arm.nonce })
    const refused = refusedReason(result)
    if (refused !== null) throw new Error(`the callee refused: ${refused}`)
    return result
  }
  switch (arm.probe) {
    case 'cron_wall':
      return wallProbe('caller', rt)
    case 'cron_cpu':
      return cpuProbe('caller', rt)
    case 'cron_subrequests':
      return subrequestProbe('caller', rt, () => env.PORTING_TEE.head(SUBREQUEST_PROBE_KEY))
    case 'dispatch_ping':
      return selfOf(env).ping()
    case 'dispatch_wall':
      return call('wall')
    case 'dispatch_cpu':
      return call('cpu')
    case 'dispatch_subrequests':
      return call('subrequests')
    case 'dispatch_detached': {
      const startedAt = rt.now()
      // Not awaited, on purpose: whether the callee outlives this return is the
      // measurement. The handler is attached at once so a late rejection is a
      // logged outcome, never an unhandled one (L749).
      call('wall').then(
        (result) => emit(rt, { stage: 'detached_callee_finished', probe: arm.probe, nonce: arm.nonce, result }),
        (err) => emit(rt, { stage: 'detached_callee_failed', probe: arm.probe, nonce: arm.nonce, error: errorText(err) }),
      )
      emit(rt, { stage: 'detached_returned', probe: arm.probe, nonce: arm.nonce, at_ms: startedAt })
      return { detached: true, returnedAt: startedAt }
    }
    case 'dispatch_fanout': {
      const self = selfOf(env)
      const settled = await Promise.allSettled(Array.from({ length: rt.limits.fanout }, () => self.ping()))
      const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      return {
        attempted: settled.length,
        fulfilled: settled.length - rejected.length,
        rejected: rejected.length,
        firstError: rejected.length > 0 ? errorText(rejected[0].reason) : null,
      }
    }
  }
}

/** The ops Worker's scheduled() while the spike is in: inert unless armed. */
export function createSpikeScheduled(rt: ProbeRuntime = realRuntime()) {
  return async function spikeTick(controller: ScheduledController, env: SpikeEnv, _ctx: ExecutionContext): Promise<SpikeTickOutcome> {
    const armState = parseSpikeArm(env.OPS_SPIKE_ARM, rt.now())
    if (armState.state === 'unarmed') return 'unarmed'
    if (env.LANE !== 'ops') {
      emit(rt, { stage: 'lane_refused', lane: env.LANE ?? null })
      return 'lane_refused'
    }
    if (armState.state === 'refused') {
      emit(rt, { stage: 'arm_refused', reason: armState.reason })
      return 'refused'
    }
    const { arm } = armState
    const base = { probe: arm.probe, nonce: arm.nonce }

    let claimed: R2Object | null
    try {
      claimed = await env.PORTING_TEE.put(
        `${SPIKE_PREFIX}${arm.nonce}/claim.json`,
        JSON.stringify({ ...base, scheduledTime: controller.scheduledTime, claimedAt: new Date(rt.now()).toISOString() }),
        { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } },
      )
    } catch (err) {
      emit(rt, { stage: 'claim_failed', ...base, error: errorText(err) })
      return 'failed'
    }
    if (claimed === null) {
      emit(rt, { stage: 'stood_down', ...base, scheduled_time: controller.scheduledTime })
      return 'stood_down'
    }

    emit(rt, { stage: 'started', ...base, scheduled_time: controller.scheduledTime })
    const startedAt = rt.now()
    let outcome: 'completed' | 'failed'
    let result: unknown = null
    let error: string | null = null
    try {
      result = await runProbe(arm, env, rt)
      outcome = 'completed'
    } catch (err) {
      outcome = 'failed'
      error = errorText(err)
      emit(rt, { stage: 'probe_failed', ...base, error })
    }
    const record = { ...base, outcome, result, error, startedAt: new Date(startedAt).toISOString(), endedAt: new Date(rt.now()).toISOString() }
    emit(rt, { stage: 'finished', ...record })
    try {
      await env.PORTING_TEE.put(`${SPIKE_PREFIX}${arm.nonce}/result.json`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } })
    } catch (err) {
      emit(rt, { stage: 'result_write_failed', ...base, error: errorText(err) })
    }
    return outcome === 'completed' ? 'ran' : 'failed'
  }
}
