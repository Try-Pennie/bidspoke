/**
 * The client side of the alert claim (#1401).
 *
 * The claim exists so exactly one tick posts an alert, and it is asked on the
 * path of a scheduled check and of a live lead. On 2026-09-21 the question hung:
 * the partner reachability probe asked `claim partner-probe-control`, waited
 * 5 minutes 41 seconds, and was answered only when the platform gave up with
 * `Network connection lost.`. Cloudflare recorded that invocation as outcome ok,
 * wall time 343,168 ms, CPU time 17 ms, so nothing was killed and nothing was
 * working: the caller was simply waiting on a call with no deadline (L110).
 *
 * The existing catch is right, it fails open so a claim that cannot be asked
 * never silences an alert, but it could not run until the platform noticed. So
 * the deadline belongs to the caller, and these tests drive it through an
 * injected timer so no real time passes (L524).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeAlertClaims, CLAIM_DEADLINE_MS } from '../alert-claim'
import { CRON_JOBS } from '../cron-heartbeat'

/** A namespace whose object never answers: the failure measured on 2026-09-21. */
function hangingNamespace(): DurableObjectNamespace {
  const stub = { fetch: () => new Promise<Response>(() => {}) }
  return { idFromName: (n: string) => n, get: () => stub } as unknown as DurableObjectNamespace
}

/** A namespace that answers at once with the claim verdict it is given. */
function answeringNamespace(claimed: boolean, calls: string[] = []): DurableObjectNamespace {
  const stub = {
    fetch: (url: string) => {
      calls.push(url)
      return Promise.resolve(new Response(JSON.stringify({ claimed }), {
        headers: { 'content-type': 'application/json' },
      }))
    },
  }
  return { idFromName: (n: string) => n, get: () => stub } as unknown as DurableObjectNamespace
}

/** A namespace whose lookup itself throws, before any call can be made. */
function throwingLookupNamespace(): DurableObjectNamespace {
  return {
    idFromName: () => { throw new TypeError('Invalid Durable Object ID') },
    get: () => { throw new Error('unreachable') },
  } as unknown as DurableObjectNamespace
}

describe('makeAlertClaims deadline (#1401)', () => {
  let errors: string[]
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errors = []
    spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
  })
  afterEach(() => { spy.mockRestore() })

  it('fails open inside the deadline when the object never answers', async () => {
    const waited: number[] = []
    const claims = makeAlertClaims(hangingNamespace(), Date.now, {
      deadlineMs: 2000,
      delay: (ms: number) => { waited.push(ms); return Promise.resolve() },
    })

    await expect(claims.claim('partner-probe-control', 60)).resolves.toBe(true)
    expect(waited).toEqual([2000])
  })

  it('says the deadline was what failed, not some other error', async () => {
    const claims = makeAlertClaims(hangingNamespace(), Date.now, {
      deadlineMs: 2000,
      delay: () => Promise.resolve(),
    })

    await claims.claim('partner-probe-control', 60)

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('partner-probe-control')
    expect(errors[0]).toMatch(/2000\s*ms/)
    expect(errors[0]).toMatch(/deadline/i)
  })

  it('release returns inside the deadline when the object never answers', async () => {
    const waited: number[] = []
    const claims = makeAlertClaims(hangingNamespace(), Date.now, {
      deadlineMs: 2000,
      delay: (ms: number) => { waited.push(ms); return Promise.resolve() },
    })

    await expect(claims.release('partner-probe-control')).resolves.toBeUndefined()
    expect(waited).toEqual([2000])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/deadline/i)
  })

  // The positive control: without this, code that simply always returned true
  // would satisfy every test above (L159).
  it('still reports a losing claim when the object answers in time', async () => {
    const claims = makeAlertClaims(answeringNamespace(false), Date.now, {
      deadlineMs: 2000,
      delay: () => new Promise<void>(() => {}),
    })

    await expect(claims.claim('partner-probe-control', 60)).resolves.toBe(false)
    expect(errors).toEqual([])
  })

  it('still reports a winning claim when the object answers in time', async () => {
    const calls: string[] = []
    const claims = makeAlertClaims(answeringNamespace(true, calls), Date.now, {
      deadlineMs: 2000,
      delay: () => new Promise<void>(() => {}),
    })

    await expect(claims.claim('partner-probe-control', 60)).resolves.toBe(true)
    expect(calls).toEqual(['https://do/claim'])
    expect(errors).toEqual([])
  })

  // The default must be proved to be WIRED, not just to exist, and proved
  // against the constraint it has to satisfy rather than against its own
  // literal (L401): a hung object must not outlast the shortest allowance any
  // watched cron gives one of its runs.
  it('applies a default deadline shorter than the tightest cron run allowance', async () => {
    const waited: number[] = []
    const claims = makeAlertClaims(hangingNamespace(), Date.now, {
      delay: (ms: number) => { waited.push(ms); return Promise.resolve() },
    })

    await expect(claims.claim('partner-probe-control', 60)).resolves.toBe(true)
    expect(waited).toEqual([CLAIM_DEADLINE_MS])

    const tightestRunAllowance = Math.min(...CRON_JOBS.map((j) => j.maxRunMs))
    expect(CLAIM_DEADLINE_MS).toBeLessThan(tightestRunAllowance)
  })
  // Both entry points look the object up before they can call it, and a lookup
  // can throw outright rather than returning a rejected promise. Neither may
  // let that reach its caller: `release` is awaited bare on the live lead path
  // (partner-block-alert.ts) and twice in volume-cliff.ts, so a throw there
  // aborts the surrounding work instead of being logged and shrugged off.
  it('release stays quiet when looking the object up throws outright', async () => {
    const claims = makeAlertClaims(throwingLookupNamespace(), Date.now, {
      deadlineMs: 2000,
      delay: () => new Promise<void>(() => {}),
    })

    await expect(claims.release('partner-probe-control')).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('release partner-probe-control failed')
    expect(errors[0]).toContain('Invalid Durable Object ID')
  })

  it('claim fails open when looking the object up throws outright', async () => {
    const claims = makeAlertClaims(throwingLookupNamespace(), Date.now, {
      deadlineMs: 2000,
      delay: () => new Promise<void>(() => {}),
    })

    await expect(claims.claim('partner-probe-control', 60)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('claim partner-probe-control failed')
    expect(errors[0]).toContain('Invalid Durable Object ID')
  })
})

/**
 * A claim that guards a SEND rather than a post fails CLOSED (#2023). The
 * Salesforce read-back resends a write only under a claim keyed on the write and
 * the attempt; a claim that cannot be asked must mean "do not send", because a
 * duplicate resend can regress a record another writer moved, while a missed one
 * is retried next minute.
 */
describe('makeAlertClaims failing closed (#2023)', () => {
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { spy.mockRestore() })

  it('answers no when the object never answers', async () => {
    const claims = makeAlertClaims(hangingNamespace(), Date.now, { failClosed: true, delay: () => Promise.resolve() })
    await expect(claims.claim('sf-read-back-resend:x:1', 60)).resolves.toBe(false)
  })

  it('answers no when looking the object up throws', async () => {
    const claims = makeAlertClaims(throwingLookupNamespace(), Date.now, { failClosed: true, delay: () => new Promise<void>(() => {}) })
    await expect(claims.claim('sf-read-back-resend:x:1', 60)).resolves.toBe(false)
  })

  it('still answers yes to a won claim and no to a lost one', async () => {
    const won = makeAlertClaims(answeringNamespace(true), Date.now, { failClosed: true, delay: () => new Promise<void>(() => {}) })
    const lost = makeAlertClaims(answeringNamespace(false), Date.now, { failClosed: true, delay: () => new Promise<void>(() => {}) })
    await expect(won.claim('k', 60)).resolves.toBe(true)
    await expect(lost.claim('k', 60)).resolves.toBe(false)
  })
})
