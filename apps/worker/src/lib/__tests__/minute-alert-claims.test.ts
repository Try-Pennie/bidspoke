/**
 * Claims for the minute alerts (#2062, #1303 phase 4).
 *
 * runCronTickOnce already stops a second delivery of the SAME minute. What it
 * cannot stop is a stalled tick overlapping the NEXT minute's, so the minute
 * alerts take a claim before they post: a page claims first and then reads its
 * cooldown (L157), and an all-clear claims only once recoveryDue and the
 * evidence check have both said it is owed, so a quiet minute makes no call to
 * the claim object at all. Every clock and timer here is injected (L524).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  MINUTE_ALERT_CLAIM_TTL_SECONDS,
  minuteAlertClaimKey,
  minuteAllClearClaim,
  postMinutePage,
} from '../alert-fanout'
import { announceRecovery, recoveryKey, type IncidentContext } from '../alert-recovery'
import { CLAIM_DEADLINE_MS, makeAlertClaims } from '../alert-claim'
import { SCHEDULED_SLACK_READ_DEADLINE_MS } from '../scheduled-slack'
import { MINUTE_JOB_DEADLINE_MS } from '../../index'
import { claimLedger, gate, overlap, until } from './_claims-double'

afterEach(() => vi.restoreAllMocks())

const ORG = '77777777-7777-4777-8777-777777777777'
const incident: IncidentContext = { scope: { kind: 'org', organizationId: ORG }, subjectLabel: 'Main Flow' }
const MIN = 60_000
const T0 = Date.parse('2026-10-15T04:00:00Z')

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string) => { store.set(k, v); return Promise.resolve() },
    delete: (k: string) => { store.delete(k); return Promise.resolve() },
  }
}

describe('the claim TTL covers the worst case from claim to cooldown write', () => {
  it('outlasts the minute job deadline, which bounds the 3 s lookup, the claim deadline and the post (the post has no deadline of its own)', () => {
    // Everything a claimant does between its claim and its cooldown write runs
    // inside one minute job, and past MINUTE_JOB_DEADLINE_MS the minute stops
    // waiting and Cloudflare cancels the calls it left (#2058). The lookup and
    // the claim's own deadline are inside that bound.
    expect(SCHEDULED_SLACK_READ_DEADLINE_MS + CLAIM_DEADLINE_MS).toBeLessThan(MINUTE_JOB_DEADLINE_MS)
    expect(MINUTE_ALERT_CLAIM_TTL_SECONDS * 1000).toBeGreaterThanOrEqual(MINUTE_JOB_DEADLINE_MS)
    // alert-fanout.ts says six times over: the margin it claims is held here too.
    expect(MINUTE_ALERT_CLAIM_TTL_SECONDS * 1000).toBeGreaterThanOrEqual(6 * MINUTE_JOB_DEADLINE_MS)
    expect(MINUTE_ALERT_CLAIM_TTL_SECONDS).toBe(5 * 60)
  })

  it('is the TTL every minute page and all-clear claim asks for', async () => {
    const { claims, ttls } = claimLedger()
    await postMinutePage({ claims, key: minuteAlertClaimKey('page', 'failure-rate', 'wf-1:X'), inCooldown: async () => false, send: async () => true })
    const kv = fakeKv({ [recoveryKey('failure-rate', 'wf-1:X')]: new Date(T0 - 90 * MIN).toISOString() })
    await announceRecovery(kv, 'failure-rate', 'wf-1:X', null, incident, async () => true, { now: T0, claim: minuteAllClearClaim(claims, 'failure-rate', 'wf-1:X') })
    expect([...ttls.values()]).toEqual([MINUTE_ALERT_CLAIM_TTL_SECONDS, MINUTE_ALERT_CLAIM_TTL_SECONDS])
  })
})

describe('the overlap helper', () => {
  it('refuses to wait under fake timers rather than hang', async () => {
    vi.useFakeTimers()
    try {
      await expect(until(() => false)).rejects.toThrow(/fake timers/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the claim keys', () => {
  it('are their own namespace, apart from every existing alert claim key', () => {
    const page = minuteAlertClaimKey('page', 'slow-spike', 'wf-1')
    const clear = minuteAlertClaimKey('all-clear', 'slow-spike', 'wf-1')
    expect(page).toBe('minute-alert:page:slow-spike:wf-1')
    expect(clear).toBe('minute-alert:all-clear:slow-spike:wf-1')
    // The existing claim keys: volume-cliff:<wf>, db-unreachable:<org>, <prefix>-recovery-<id>.
    for (const k of [page, clear]) {
      expect(k.startsWith('volume-cliff:')).toBe(false)
      expect(k.startsWith('db-unreachable:')).toBe(false)
      expect(k).not.toMatch(/-recovery-/)
    }
    expect(page).not.toBe(clear)
  })
})

describe('postMinutePage: claim first, then read the cooldown (L157)', () => {
  it('claims before the read that decides, so a cooldown written while it claimed stops the post', async () => {
    const log: string[] = []
    const { claims } = claimLedger(log)
    let cooldown = false
    const wrapped = {
      claim: async (k: string, ttl: number) => {
        const won = await claims.claim(k, ttl)
        // The other tick posts and writes its cooldown just as this one claims.
        cooldown = true
        return won
      },
      release: claims.release,
    }
    const send = vi.fn(async () => true)
    const outcome = await postMinutePage({
      claims: wrapped,
      key: 'minute-alert:page:x:1',
      inCooldown: async () => { log.push(`cooldown read ${cooldown}`); return cooldown },
      send,
    })
    expect(outcome).toBe('in_cooldown')
    expect(send).not.toHaveBeenCalled()
    // The read that decided is the one after the claim; the claim is freed.
    expect(log).toEqual(['cooldown read false', 'claim minute-alert:page:x:1', 'cooldown read true', 'release minute-alert:page:x:1'])
  })

  it('makes no claim while a cooldown plainly stands (the first read can only ever skip)', async () => {
    const { claims, log } = claimLedger()
    const outcome = await postMinutePage({ claims, key: 'k', inCooldown: async () => true, send: async () => true })
    expect(outcome).toBe('in_cooldown')
    expect(log).toEqual([])
  })

  it('posts once when two overlapping ticks reach the post together', async () => {
    const { claims, log } = claimLedger()
    let cooldown = false
    const held = gate<boolean>()
    const send = vi.fn(() => held.promise)
    const outcomes: string[] = []
    const tick = () => postMinutePage({ claims, key: 'k', inCooldown: async () => cooldown, send }).then((o) => { if (o === 'sent') cooldown = true; outcomes.push(o) })
    await overlap(tick, () => held.open(true), () => log.length === 2)
    expect(outcomes.sort()).toEqual(['claimed_elsewhere', 'sent'])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the claim on a delivered post, so a tick behind it cannot post again inside the TTL', async () => {
    const { claims, held } = claimLedger()
    expect(await postMinutePage({ claims, key: 'k', inCooldown: async () => false, send: async () => true })).toBe('sent')
    expect(held.has('k')).toBe(true)
  })

  it('frees the claim when Slack refuses the post, so the next tick can retry', async () => {
    const { claims, held } = claimLedger()
    expect(await postMinutePage({ claims, key: 'k', inCooldown: async () => false, send: async () => false })).toBe('not_sent')
    expect(held.has('k')).toBe(false)
  })

  // A throw cannot say whether Slack took the post: a timeout or a connection
  // lost after the request went out may have landed. So a throwing post KEEPS
  // the claim for its TTL (at worst the page is late, never doubled), and only
  // an answer Slack gave refusing it frees the claim.
  it('keeps the claim, logs, and rethrows when the post throws, since Slack may have taken it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { claims, held, log } = claimLedger()
    await expect(postMinutePage({ claims, key: 'k', inCooldown: async () => false, send: async () => { throw new Error('connection lost') } })).rejects.toThrow('connection lost')
    expect(held.has('k')).toBe(true)
    expect(log).toEqual(['claim k'])
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/k: the post threw, so it may have reached Slack; the claim is kept/)
  })

  it('frees the claim and rethrows when the cooldown read after the claim throws, since nothing was posted', async () => {
    const { claims, held } = claimLedger()
    let reads = 0
    const send = vi.fn(async () => true)
    const inCooldown = async () => { if (++reads === 2) throw new Error('KV GET failed: 500'); return false }
    await expect(postMinutePage({ claims, key: 'k', inCooldown, send })).rejects.toThrow('KV GET failed')
    expect(send).not.toHaveBeenCalled()
    expect(held.has('k')).toBe(false)
  })

  it('does not post again from the next tick after a post that threw once Slack had taken it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { claims } = claimLedger()
    const delivered: string[] = []
    // Slack accepted the post, then the answer was lost on the way back.
    const throwsAfterAcceptance = async () => { delivered.push('page'); throw new Error('Network connection lost.') }
    await expect(postMinutePage({ claims, key: 'k', inCooldown: async () => false, send: throwsAfterAcceptance })).rejects.toThrow()
    // The cooldown was never written; the next minute's tick runs.
    expect(await postMinutePage({ claims, key: 'k', inCooldown: async () => false, send: async () => { delivered.push('page'); return true } })).toBe('claimed_elsewhere')
    expect(delivered).toEqual(['page'])
  })

  it('still answers not_sent when freeing the claim after a refused post throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const claims = { claim: async () => true, release: async () => { throw new Error('release refused') } }
    expect(await postMinutePage({ claims, key: 'k', inCooldown: async () => false, send: async () => false })).toBe('not_sent')
  })

  it('fails open and logs when the claim object cannot be asked', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ns = { idFromName: () => { throw new Error('object unreachable') }, get: () => { throw new Error('unused') } } as unknown as DurableObjectNamespace
    const send = vi.fn(async () => true)
    const outcome = await postMinutePage({ claims: makeAlertClaims(ns), key: 'minute-alert:page:x:1', inCooldown: async () => false, send })
    expect(outcome).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/claim minute-alert:page:x:1 failed, posting without it: .*object unreachable/)
  })
})

describe('announceRecovery claims an all-clear only once it is owed', () => {
  const id = 'wf-1:ACRO'
  const owed = () => fakeKv({ [recoveryKey('failure-rate', id)]: new Date(T0 - 90 * MIN).toISOString() })

  it('makes no claim call when nothing is due', async () => {
    const { claims, log } = claimLedger()
    const send = vi.fn(async () => true)
    expect(await announceRecovery(fakeKv(), 'failure-rate', id, null, incident, send, { now: T0, claim: minuteAllClearClaim(claims, 'failure-rate', id) })).toBe(false)
    expect(log).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('makes no claim call inside the re-arm window', async () => {
    const { claims, log } = claimLedger()
    const kv = owed()
    kv.store.set(`failure-rate-active:${id}`, new Date(T0 - MIN).toISOString())
    await announceRecovery(kv, 'failure-rate', id, null, incident, async () => true, { now: T0, claim: minuteAllClearClaim(claims, 'failure-rate', id) })
    expect(log).toEqual([])
  })

  it('makes no claim call while the evidence check holds the all-clear', async () => {
    const { claims, log } = claimLedger()
    await announceRecovery(owed(), 'failure-rate', id, null, incident, async () => true, { now: T0, hasEvidence: () => false, claim: minuteAllClearClaim(claims, 'failure-rate', id) })
    expect(log).toEqual([])
  })

  it('claims after the evidence check and before the send', async () => {
    const log: string[] = []
    const { claims } = claimLedger(log)
    await announceRecovery(owed(), 'failure-rate', id, null, incident, async () => { log.push('send'); return true }, {
      now: T0,
      hasEvidence: () => { log.push('evidence'); return true },
      claim: minuteAllClearClaim(claims, 'failure-rate', id),
    })
    expect(log).toEqual(['evidence', `claim minute-alert:all-clear:failure-rate:${id}`, 'send'])
  })

  it('posts once when two overlapping ticks find it owed together', async () => {
    const kv = owed()
    const { claims, log } = claimLedger()
    const held = gate<boolean>()
    const send = vi.fn(() => held.promise)
    const outcomes: boolean[] = []
    const tick = () => announceRecovery(kv, 'failure-rate', id, null, incident, send, { now: T0, claim: minuteAllClearClaim(claims, 'failure-rate', id) }).then((o) => { outcomes.push(o) })
    await overlap(tick, () => held.open(true), () => log.length === 2)
    expect(outcomes.sort()).toEqual([false, true])
    expect(send).toHaveBeenCalledTimes(1)
    expect(kv.store.has(recoveryKey('failure-rate', id))).toBe(false)
  })

  it('re-reads the marker after the claim: an all-clear another tick settled meanwhile is not sent again', async () => {
    const kv = owed()
    const { claims } = claimLedger()
    const wrapped = {
      claim: async (k: string, ttl: number) => {
        const won = await claims.claim(k, ttl)
        // The other tick's claim expired after it settled; this one wins on a stale judgement.
        kv.store.delete(recoveryKey('failure-rate', id))
        return won
      },
      release: claims.release,
    }
    const send = vi.fn(async () => true)
    expect(await announceRecovery(kv, 'failure-rate', id, null, incident, send, { now: T0, claim: { claims: wrapped, key: 'k', ttlSeconds: 300 } })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('frees the claim when the marker it re-read is gone', async () => {
    const kv = owed()
    const { claims, held } = claimLedger()
    const wrapped = {
      claim: async (k: string, ttl: number) => {
        const won = await claims.claim(k, ttl)
        kv.store.delete(recoveryKey('failure-rate', id))
        return won
      },
      release: claims.release,
    }
    await announceRecovery(kv, 'failure-rate', id, null, incident, async () => true, { now: T0, claim: { claims: wrapped, key: 'k', ttlSeconds: 300 } })
    expect(held.size).toBe(0)
  })

  it('still returns false when freeing the claim after a refused all-clear throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const claims = { claim: async () => true, release: async () => { throw new Error('release refused') } }
    expect(await announceRecovery(owed(), 'failure-rate', id, null, incident, async () => false, { now: T0, claim: { claims, key: 'k', ttlSeconds: 300 } })).toBe(false)
    expect(err.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/release k failed: .*release refused/)
  })

  it('frees the claim and keeps the incident when the all-clear does not deliver', async () => {
    const kv = owed()
    const { claims, held } = claimLedger()
    expect(await announceRecovery(kv, 'failure-rate', id, null, incident, async () => false, { now: T0, claim: minuteAllClearClaim(claims, 'failure-rate', id) })).toBe(false)
    expect(held.size).toBe(0)
    expect(kv.store.has(recoveryKey('failure-rate', id))).toBe(true)
  })

  it('keeps the claim and the incident, and logs, when the all-clear throws, since Slack may have taken it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = owed()
    const { claims, held } = claimLedger()
    expect(await announceRecovery(kv, 'failure-rate', id, null, incident, async () => { throw new Error('boom') }, { now: T0, claim: minuteAllClearClaim(claims, 'failure-rate', id) })).toBe(false)
    expect(held.size).toBe(1)
    expect(kv.store.has(recoveryKey('failure-rate', id))).toBe(true)
    const logged = err.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged).toMatch(/all-clear failed for wf-1:ACRO: Error: boom/)
    expect(logged).toMatch(/may have reached Slack; the claim is kept/)
  })

  it('does not send the all-clear again from the next tick after one that threw once Slack had taken it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const kv = owed()
    const { claims } = claimLedger()
    const delivered: string[] = []
    const opts = { now: T0, claim: minuteAllClearClaim(claims, 'failure-rate', id) }
    await announceRecovery(kv, 'failure-rate', id, null, incident, async () => { delivered.push('all-clear'); throw new Error('Network connection lost.') }, opts)
    expect(await announceRecovery(kv, 'failure-rate', id, null, incident, async () => { delivered.push('all-clear'); return true }, opts)).toBe(false)
    expect(delivered).toEqual(['all-clear'])
  })

  it('fails open and logs when the claim object cannot be asked', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ns = { idFromName: () => { throw new Error('object unreachable') }, get: () => { throw new Error('unused') } } as unknown as DurableObjectNamespace
    const send = vi.fn(async () => true)
    expect(await announceRecovery(owed(), 'failure-rate', id, null, incident, send, { now: T0, claim: minuteAllClearClaim(makeAlertClaims(ns), 'failure-rate', id) })).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/posting without it/)
  })
})
