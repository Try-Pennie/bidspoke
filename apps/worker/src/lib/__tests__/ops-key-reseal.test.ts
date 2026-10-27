import { describe, expect, it, vi } from 'vitest'
import { OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT, readKeptReseal, runOpsKeyResealCheck, type OpsKeyResealDeps } from '../ops-key-reseal'
import { recoveryKey } from '../alert-recovery'
import { incidentSignal } from '../incident-signals'
import type { OpsResealReport } from '../ops-gateway-contract'
import { OPS_TICK_REPORT_FRESH_MS, OPS_TICK_REPORT_KEY } from '../ops-gateway'
import { opsKeyResealMessage, opsKeyResealRecoveredPhrase } from '../slack'
import { outboxEvents, transitions } from './_incident-events'

/**
 * The page for an ops key reseal that keeps leaving logins on the old key, or
 * a switch left on after it finished (#2486). The ops tick judges the switch
 * every minute (ops/reseal-watch.ts) and its report carries the verdict; the
 * bidding Worker pages a paged verdict to every organization with Slack
 * through the ops-key-reseal signal, and sends the all clear on any other.
 * No rotation is under way in production today, so every behaviour is proven
 * on verdicts the test builds.
 */

const NOW = Date.parse('2026-10-27T16:00:00.000Z')
const MIN = 60_000
const ORG_A = '0b4c6a2e-6f3e-4d8a-9a51-1d1c4a0f7a11'
const ORG_B = '7e2f9c10-3b6d-4f55-8c2a-5a9e0d3b6c22'
const iso = (ms: number) => new Date(ms).toISOString()

function fakeKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, _opts?: { expirationTtl?: number }) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  }
}

const verdict = (over: Partial<OpsResealReport> = {}): OpsResealReport => ({
  verdict: 'logins_left', mode: 'apply', since: iso(NOW - 134 * MIN), nothing_left_since: null, last_run_at: iso(NOW - MIN), last_run_left: 3, db_now: iso(NOW),
  ...over,
})
const OFF: OpsResealReport = { verdict: 'off', mode: null, since: null, nothing_left_since: null, last_run_at: null, last_run_left: null, db_now: null }
const judged = (report: OpsResealReport) => ({ judged: true as const, report })

function harness(kv = fakeKv(), orgs: string[] | null = [ORG_A]) {
  const sendAlert = vi.fn<OpsKeyResealDeps['sendAlert']>(async () => true)
  const sendRecovery = vi.fn<OpsKeyResealDeps['sendRecovery']>(async () => true)
  const orgsToTell = vi.fn<OpsKeyResealDeps['orgsToTell']>(async () => orgs)
  const run = (read: Awaited<ReturnType<OpsKeyResealDeps['readReseal']>>, at = NOW) => runOpsKeyResealCheck({
    kv, readReseal: async () => read, orgsToTell, sendAlert, sendRecovery, now: () => at,
  })
  return { kv, sendAlert, sendRecovery, orgsToTell, run }
}

const marker = (kv: ReturnType<typeof fakeKv>) => kv.store.get(recoveryKey(OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT))

/** The two dashes the style rule forbids as punctuation, and a spaced hyphen, built so no literal sits in the source. */
const DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013), ` ${'-'} `]

describe('the page', () => {
  it('pages nothing outside a rotation, or while a reseal runs inside its bounds', async () => {
    const h = harness()
    expect(await h.run(judged(OFF))).toMatchObject({ judged: true, paged: false, allClear: false, errors: [] })
    await h.run(judged(verdict({ verdict: 'running', since: iso(NOW - 30 * MIN) })))
    expect(h.sendAlert).not.toHaveBeenCalled()
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(outboxEvents(h.kv.store)).toEqual([])
  })

  it.each(['logins_left', 'preview_left_on', 'finished_left_on', 'switch_unknown'] as const)('pages %s to every organization with Slack, and opens one platform incident', async (v) => {
    const h = harness(fakeKv(), [ORG_A, ORG_B])
    const report = v === 'switch_unknown' ? { ...OFF, verdict: v } : verdict({ verdict: v, mode: v === 'preview_left_on' ? 'preview' : 'apply', nothing_left_since: v === 'finished_left_on' ? iso(NOW - 125 * MIN) : null })
    const out = await h.run(judged(report))
    expect(h.sendAlert.mock.calls.map(([org, alert]) => [org, alert.report.verdict])).toEqual([[ORG_A, v], [ORG_B, v]])
    expect(out.paged).toBe(true)
    expect(marker(h.kv)).toBe(iso(NOW))
    expect(transitions(h.kv.store)).toEqual([`opened ${OPS_KEY_RESEAL_SUBJECT}`, `paged ${OPS_KEY_RESEAL_SUBJECT}`])
    expect(outboxEvents(h.kv.store)[0]).toMatchObject({ signal: OPS_KEY_RESEAL_SIGNAL, scope: 'platform', subjectLabel: 'Ops key reseal' })
  })

  it('does not page again while the reminder interval runs, though the count left changes, and keeps the incident open', async () => {
    const h = harness()
    await h.run(judged(verdict()))
    await h.run(judged(verdict({ last_run_left: 2 })), NOW + 15 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(marker(h.kv)).toBe(iso(NOW))
  })

  it('posts at once when the verdict changes, a new fact, without opening a second incident', async () => {
    const h = harness()
    await h.run(judged(verdict()))
    await h.run(judged(verdict({ verdict: 'finished_left_on', nothing_left_since: iso(NOW - 120 * MIN), last_run_left: 0 })), NOW + 2 * MIN)
    expect(h.sendAlert.mock.calls.map(([, a]) => a.report.verdict)).toEqual(['logins_left', 'finished_left_on'])
    expect(transitions(h.kv.store)).toEqual([`opened ${OPS_KEY_RESEAL_SUBJECT}`, `paged ${OPS_KEY_RESEAL_SUBJECT}`, `paged ${OPS_KEY_RESEAL_SUBJECT}`])
  })

  it('arms nothing when the page reached no organization, so the next check tries again', async () => {
    const h = harness()
    h.sendAlert.mockResolvedValueOnce(false)
    const out = await h.run(judged(verdict()))
    expect(out.paged).toBe(false)
    expect(marker(h.kv)).toBeUndefined()
    await h.run(judged(verdict()), NOW + MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
    expect(marker(h.kv)).toBe(iso(NOW + MIN))
  })

  it('arms nothing when a send throws for every organization, says so, and never throws itself', async () => {
    const h = harness()
    h.sendAlert.mockRejectedValue(new Error('Slack is down'))
    const out = await h.run(judged(verdict()))
    expect(out.paged).toBe(false)
    expect(out.errors.join(' ')).toMatch(/Slack is down/)
    expect(marker(h.kv)).toBeUndefined()
  })

  it('tells nobody when the organizations cannot be read, says so, and arms nothing', async () => {
    const h = harness(fakeKv(), null)
    const out = await h.run(judged(verdict()))
    expect(h.sendAlert).not.toHaveBeenCalled()
    expect(out.paged).toBe(false)
    expect(out.errors.join(' ')).toMatch(/organizations could not be read/)
    expect(marker(h.kv)).toBeUndefined()
  })
})

describe('the all clear', () => {
  it('is sent once the switch is removed, with the phrase for what cleared it, and ends the incident', async () => {
    const h = harness()
    await h.run(judged(verdict()))
    const out = await h.run(judged(OFF), NOW + 30 * MIN)
    expect(h.sendRecovery).toHaveBeenCalledTimes(1)
    expect(h.sendRecovery.mock.calls[0]).toEqual([ORG_A, { phrase: 'is switched off', alertedAt: iso(NOW), endedAt: iso(NOW), firstHealthyAt: iso(NOW + 30 * MIN) }])
    expect(out.allClear).toBe(true)
    expect(transitions(h.kv.store).at(-1)).toBe(`ended ${OPS_KEY_RESEAL_SUBJECT} all_clear`)
    expect(marker(h.kv)).toBeUndefined()
  })

  it('is sent when a run moves every login, and the next page after it starts afresh', async () => {
    const h = harness()
    await h.run(judged(verdict()))
    await h.run(judged(verdict({ verdict: 'running', nothing_left_since: iso(NOW + MIN), last_run_left: 0 })), NOW + 2 * MIN)
    expect(h.sendRecovery.mock.calls[0][1].phrase).toBe('has moved every login to the new key')
    // Two hours later the switch is still on: a new incident, paged at once.
    await h.run(judged(verdict({ verdict: 'finished_left_on', nothing_left_since: iso(NOW + MIN), last_run_left: 0 })), NOW + 125 * MIN)
    expect(h.sendAlert).toHaveBeenCalledTimes(2)
    expect(marker(h.kv)).toBe(iso(NOW + 125 * MIN))
  })

  it('is owed only for a page that was delivered: a clear with no open incident sends nothing', async () => {
    const h = harness()
    await h.run(judged(OFF))
    expect(h.sendRecovery).not.toHaveBeenCalled()
  })

  it('keeps the incident open when the all clear reaches nobody, and sends it on the next check', async () => {
    const h = harness()
    await h.run(judged(verdict()))
    h.sendRecovery.mockResolvedValueOnce(false)
    const first = await h.run(judged(OFF), NOW + 5 * MIN)
    expect(first.allClear).toBe(false)
    expect(marker(h.kv)).toBe(iso(NOW))
    const second = await h.run(judged(OFF), NOW + 6 * MIN)
    expect(second.allClear).toBe(true)
    expect(h.sendRecovery).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['no report', { judged: false as const, why: 'there is no report from the ops tick' }],
    ['a stale report', { judged: false as const, why: 'the tick\'s report is 12 minutes old' }],
    ['a tick that could not judge', { judged: false as const, why: 'the tick did not judge the reseal' }],
  ])('treats %s as unjudged: no page, no all clear, the open incident kept alive', async (_label, read) => {
    const h = harness()
    await h.run(judged(verdict()))
    h.kv.put.mockClear()
    const out = await h.run(read, NOW + 15 * MIN)
    expect(out.judged).toBe(false)
    expect(h.sendRecovery).not.toHaveBeenCalled()
    expect(h.sendAlert).toHaveBeenCalledTimes(1)
    expect(h.kv.put).toHaveBeenCalledWith(recoveryKey(OPS_KEY_RESEAL_SIGNAL, OPS_KEY_RESEAL_SUBJECT), iso(NOW), expect.anything())
  })
})

describe('readKeptReseal (the verdict in the tick\'s kept report)', () => {
  const kept = (over: Record<string, unknown> = {}) => JSON.stringify({
    tick_id: 't', mode: 'observe', scheduled_time: null, started_at: iso(NOW - MIN), finished_at: iso(NOW - MIN), db_now: null, outcome: 'ok',
    problems: [], problem_keys: [], counts: {}, received_at: iso(NOW - MIN), reseal: verdict(), ...over,
  })
  const read = async (raw: string | null, at = NOW) => {
    const kv = fakeKv()
    if (raw !== null) kv.store.set(OPS_TICK_REPORT_KEY, raw)
    return readKeptReseal(kv, at)
  }

  it('reads the verdict of a report younger than the report window', async () => {
    expect(await read(kept())).toEqual({ judged: true, report: verdict() })
  })

  it.each([
    ['no report', null, /no report/],
    ['a report older than its window', kept({ received_at: iso(NOW - OPS_TICK_REPORT_FRESH_MS - 1) }), /minutes old/],
    ['a report that cannot be read', '{"reseal":', /could not be read/],
    ['a verdict that cannot be read', kept({ reseal: { verdict: 'stuck' } }), /could not be read/],
    ['an unreadable receipt time', kept({ received_at: 'soon' }), /could not be read/],
    ['a tick that judged no reseal', kept({ reseal: null }), /did not judge the reseal/],
    ['a report from an ops release before the watch', kept({ reseal: undefined }), /did not judge the reseal/],
  ])('is unjudged for %s, never off', async (_label, raw, why) => {
    const out = await read(raw)
    expect(out.judged).toBe(false)
    expect(out.judged === false && out.why).toMatch(why)
  })

  it('is unjudged, never off, when KV cannot be read', async () => {
    const kv = fakeKv()
    kv.get.mockRejectedValueOnce(new Error('KV did not answer'))
    expect(await readKeptReseal(kv, NOW)).toMatchObject({ judged: false })
  })
})

describe('the copy (plain title, short full sentences, what the reader must do)', () => {
  const words = (report: OpsResealReport) => {
    const m = opsKeyResealMessage({ report })
    return `${m.title}\n${m.sections.join('\n')}`
  }

  it('says a stuck rotation has run how long, what its last run left and when, that it will not move on its own, and not to delete the old key', () => {
    const text = words(verdict())
    expect(text).toBe([
      'An ops key rotation is stuck',
      'The ops key reseal has been moving ops connection logins to the new key for 2 hours 14 minutes, and its last run, at Oct 27, 11:59 AM EDT, still left 3 logins on the old key. It runs every minute, so a login still left after this long will not move on its own.',
      '*Fix:* search the bidspoke-worker-ops logs for ops_reseal to see which connections it cannot move and why. Do not delete the old key until a run reports nothing left, or those connections will stop working.',
    ].join('\n'))
    expect(words(verdict({ last_run_left: 1 }))).toMatch(/still left 1 login on the old key/)
  })

  it('says a failed last run, or none recorded, without inventing a count', () => {
    expect(words(verdict({ last_run_left: null }))).toMatch(/its last run, at Oct 27, 11:59 AM EDT, failed before it could count what was left\./)
    expect(words(verdict({ last_run_left: null, last_run_at: null }))).toMatch(/and no run has recorded what it left\./)
  })

  it('says a preview moves nothing and to set apply or remove it', () => {
    expect(words(verdict({ verdict: 'preview_left_on', mode: 'preview', since: iso(NOW - 125 * MIN) }))).toBe([
      'An ops key reseal is only previewing',
      'OPS_RESEAL has been set to preview on the ops Worker for 2 hours 5 minutes. A preview moves nothing, so logins still on the old key stay there.',
      '*Fix:* set OPS_RESEAL to apply in wrangler.ops.toml to move them, or remove it if no key rotation is under way.',
    ].join('\n'))
  })

  it('says a finished reseal left on since when, and to remove the switch and then the old key', () => {
    expect(words(verdict({ verdict: 'finished_left_on', nothing_left_since: iso(NOW - 166 * MIN), last_run_left: 0 }))).toBe([
      'An ops key reseal is finished but still switched on',
      'Every ops connection login has been on the new key since Oct 27, 9:14 AM EDT, but OPS_RESEAL is still set on the ops Worker, so the reseal goes on running every minute for nothing.',
      '*Fix:* remove OPS_RESEAL from wrangler.ops.toml, then delete the old key, as the steps for rotating the ops private key in the disaster recovery runbook say.',
    ].join('\n'))
  })

  it('says a switch naming no mode runs nothing', () => {
    expect(words({ ...OFF, verdict: 'switch_unknown' })).toBe([
      'The ops key reseal switch has a value it cannot use',
      'OPS_RESEAL on the ops Worker is set to something other than preview or apply, so no reseal runs and logins on the old key stay there.',
      '*Fix:* set it to apply in wrangler.ops.toml to move them, or remove it if no key rotation is under way.',
    ].join('\n'))
  })

  it('adds the reminder sentence on a repeat', () => {
    const m = opsKeyResealMessage({ report: verdict(), repeat: 'Reminder 2.' })
    expect(m.sections.at(-1)).toBe('Reminder 2.')
  })

  it('names what cleared it in the all clear', () => {
    expect(opsKeyResealRecoveredPhrase(OFF)).toBe('is switched off')
    expect(opsKeyResealRecoveredPhrase(verdict({ verdict: 'running', nothing_left_since: iso(NOW), last_run_left: 0 }))).toBe('has moved every login to the new key')
    expect(opsKeyResealRecoveredPhrase(verdict({ verdict: 'running', since: iso(NOW) }))).toBe('is moving logins to the new key')
    expect(opsKeyResealRecoveredPhrase(verdict({ verdict: 'running', mode: 'preview', since: iso(NOW) }))).toBe('is set to preview, which moves nothing')
  })

  it('carries no dash as punctuation', () => {
    const all = [
      verdict(), verdict({ last_run_left: null }), verdict({ last_run_left: null, last_run_at: null }),
      verdict({ verdict: 'preview_left_on', mode: 'preview' }), verdict({ verdict: 'finished_left_on', nothing_left_since: iso(NOW - 130 * MIN) }), { ...OFF, verdict: 'switch_unknown' as const },
    ]
    for (const r of all) for (const d of DASHES) expect(words(r).includes(d), JSON.stringify(d)).toBe(false)
  })
})

describe('the signal', () => {
  it('records its incidents as one platform signal named for itself', () => {
    expect(incidentSignal(OPS_KEY_RESEAL_SIGNAL)).toMatchObject({ signal: 'ops-key-reseal', scope: 'platform', subject: 'name', windowMinutes: null })
  })
})
