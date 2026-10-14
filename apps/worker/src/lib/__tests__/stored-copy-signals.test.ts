/**
 * The stored copy alerts (#1848): one while leads are being served from stored
 * copies, one when a copy has not been confirmed within its 30 minute maximum,
 * and one when the sweep that repairs and confirms copies keeps failing.
 *
 * The first must reach Slack in the very outage it describes, so its tests run
 * with the database refusing every request and the Slack connection coming from
 * the encrypted last-good copy the volume check keeps in KV (L71). Every clock
 * is injected; nothing sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  STORED_COPY_SERVING_ALERT_MINUTES,
  STORED_COPY_SERVING_KEY,
  STORED_COPY_SERVING_WINDOW_MINUTES,
  STORED_COPY_STALE_JOB,
  STORED_COPY_SWEEP_JOB,
  SWEEP_FAILING_ALERT_AFTER_MS,
  findStaleCopies,
  runStoredCopyChecks,
  type StoredCopyCheckDeps,
} from '../stored-copy-signals'
import { LEDGER_KEY_TTL_SECONDS, STORED_COPY_LEDGER_PREFIX } from '../stored-copy-ledger'
import { STORED_COPY_KINDS, STORED_COPY_MAX_AGE_MS, STORED_COPY_RECONFIRM_AFTER_MS, STORED_COPY_REFUSALS, confirmedAt, type StoredCopyRefusal } from '../stored-copy-age'
import { bidMatrixLastGoodKey } from '../bid-matrix-lookup'
import { SLACK_CONNS_LASTGOOD_KEY } from '../volume-cliff'
import { encryptSecret } from '../secret-crypto'
import { endpointLastGoodKey } from '../endpoint-copies'
import { partnerLastGoodKey } from '../partner-last-good'
import { workflowCopyKey } from '../../engine/definition-loader'
import { envVarsLastGoodKey } from '../env-loader'
import { partnerConstantsLastGoodKey } from '../partner-constants-loader'
import { buyerProfilesLastGoodKey } from '../buyer-profile-loader'
import { RECOVERY_REARM_MINUTES } from '../alert-recovery'
import type { SweepResult } from '../stored-copy-sweep'
// @ts-expect-error Vite resolves ?raw to the file's text; no ambient declaration here.
import DEFINITION_LOADER_SOURCE from '../../engine/definition-loader.ts?raw'

const KEY = btoa('1'.repeat(32))
const ORG = 'org-1'
const T0 = Date.parse('2026-10-07T19:00:30Z')
const MINUTE = 60_000

/** A KV double on an injected clock: expiry, metadata, and list with metadata, as Workers KV. */
function fakeKv(clock: { now: number }) {
  const store = new Map<string, { value: string; metadata: unknown; expiresAt: number | null }>()
  const live = (k: string) => {
    const e = store.get(k)
    if (!e) return null
    if (e.expiresAt !== null && e.expiresAt <= clock.now) { store.delete(k); return null }
    return e
  }
  return {
    store,
    failList: false,
    async get(k: string, type?: string) {
      const e = live(k)
      if (!e) return null
      return type === 'json' ? JSON.parse(e.value) : e.value
    },
    async getWithMetadata(k: string) {
      const e = live(k)
      return { value: e?.value ?? null, metadata: e?.metadata ?? null }
    },
    async put(k: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }) {
      store.set(k, { value, metadata: opts?.metadata ?? null, expiresAt: opts?.expirationTtl ? clock.now + opts.expirationTtl * 1000 : null })
    },
    async delete(k: string) { store.delete(k) },
    async list(this: { failList: boolean }, opts: { prefix?: string } = {}) {
      if (this.failList) throw new Error('KV list failed: 503')
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? '') && live(k)).sort().map((name) => ({ name, metadata: store.get(name)?.metadata }))
      return { keys, list_complete: true, cursor: undefined }
    },
  }
}
type Kv = ReturnType<typeof fakeKv>

/** A database that refuses everything, recording what was asked of it. */
function downDb() {
  const asked: string[] = []
  const builder = (table: string) => {
    asked.push(table)
    const result = { data: null, error: { message: 'upstream connect error', code: '' }, status: 503 }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'limit', 'abortSignal']) chain[m] = () => chain
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
    return chain
  }
  return { asked, client: { from: builder } as unknown as SupabaseClient }
}

/** A database whose only answer is one Slack connection. */
function slackDb(config: Record<string, unknown>) {
  const asked: string[] = []
  const builder = (table: string) => {
    asked.push(table)
    const result = { data: [{ organization_id: ORG, config }], error: null, status: 200 }
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'limit', 'abortSignal']) chain[m] = () => chain
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
    return chain
  }
  return { asked, client: { from: builder } as unknown as SupabaseClient }
}

const SLACK_CONFIG = { bot_token: 'xoxb-test', default_channel: 'C-ALERTS', volume_alerts_enabled: true }

async function rememberSlack(kv: Kv, config: Record<string, unknown> = SLACK_CONFIG) {
  await kv.put(SLACK_CONNS_LASTGOOD_KEY, await encryptSecret(JSON.stringify({ [ORG]: config }), KEY))
}

/** One isolate's ledger entry for a minute, as flushStoredCopyLedger writes it. */
async function ledgerMinute(kv: Kv, clock: { now: number }, minutesAgo: number, k: Record<string, unknown>, isolate = 'iso-a') {
  const minute = Math.floor(clock.now / MINUTE) - minutesAgo
  await kv.put(`${STORED_COPY_LEDGER_PREFIX}${minute}:${isolate}`, '', { metadata: { m: minute, k }, expirationTtl: LEDGER_KEY_TTL_SECONDS })
}

const served = (s: number, a = 4 * MINUTE) => ({ workflow_definition: { s, r: [], a } })

/** Refusal counts as the ledger stores them: positionally, in the shared order. */
const refusedAs = (counts: Partial<Record<StoredCopyRefusal, number>>) => STORED_COPY_REFUSALS.map((r) => counts[r] ?? 0)

const cleanSweep: SweepResult = { checked: 3, repaired: [], reconfirmed: [], failed: [] }

interface Posted { channel: string; title: string; errors: string[]; context?: string; fixHint?: string; repeat?: string }

function harness(opts: { db?: { client: SupabaseClient; asked: string[] }; sweep?: SweepResult; postOk?: boolean } = {}) {
  const clock = { now: T0 }
  const kv = fakeKv(clock)
  const copies = fakeKv(clock)
  const db = opts.db ?? downDb()
  const posted: Posted[] = []
  const recoveries: { channel: string; subject: string }[] = []
  const notified: { job: string; errors: string[]; remedy: unknown; keys?: readonly string[] }[] = []
  const claimsHeld = new Set<string>()
  const deps = (): StoredCopyCheckDeps => ({
    kv: kv as unknown as StoredCopyCheckDeps['kv'],
    copies: copies as unknown as KVNamespace,
    supabase: db.client,
    secretKeys: KEY,
    appUrl: 'https://app.test',
    sweep: opts.sweep ?? cleanSweep,
    now: () => clock.now,
    claims: {
      claim: async (key) => { if (claimsHeld.has(key)) return false; claimsHeld.add(key); return true },
      release: async (key) => { claimsHeld.delete(key) },
    },
    post: async (slack, message) => {
      if (opts.postOk === false) return false
      posted.push({ channel: slack.default_channel, ...message })
      return true
    },
    postRecovery: async (_slack, channel, payload) => {
      recoveries.push({ channel, subject: payload.subject })
      return true
    },
    notify: async (_supabase, job, errors, _kv, remedy, _now, meaning) => {
      notified.push({ job, errors, remedy, keys: meaning?.keys })
    },
  })
  return { clock, kv, copies, db, posted, recoveries, notified, claimsHeld, deps }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('the thresholds', () => {
  it('reads a window the ledger keys outlive, with room for KV to list a late write', () => {
    expect(LEDGER_KEY_TTL_SECONDS).toBeGreaterThanOrEqual((STORED_COPY_SERVING_WINDOW_MINUTES + 1) * 60)
  })

  it('needs copies used in more minutes than a healthy day produces, and fewer than an outage fills', () => {
    // Measured 2026-10-07: two lead reads missed their deadline in two and a half
    // healthy hours, each in a minute of its own. Two minutes in five would page
    // about daily on that rate; an outage uses copies every minute.
    expect(STORED_COPY_SERVING_ALERT_MINUTES).toBeGreaterThanOrEqual(3)
    expect(STORED_COPY_SERVING_ALERT_MINUTES).toBeLessThanOrEqual(STORED_COPY_SERVING_WINDOW_MINUTES)
  })

  it('pages a failing sweep after one confirmation interval, well before an idle copy ages out', () => {
    expect(SWEEP_FAILING_ALERT_AFTER_MS).toBe(STORED_COPY_RECONFIRM_AFTER_MS)
    expect(SWEEP_FAILING_ALERT_AFTER_MS * 2).toBeLessThan(STORED_COPY_MAX_AGE_MS)
  })
})

describe('while leads are being served from stored copies', () => {
  it('posts from the last-good Slack copy with the database refusing, naming each copy, how often and how old', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    await ledgerMinute(h.kv, h.clock, 2, served(40, 9 * MINUTE))
    await ledgerMinute(h.kv, h.clock, 1, served(50, 10 * MINUTE))
    await ledgerMinute(h.kv, h.clock, 0, { ...served(10, 11 * MINUTE), env_vars: { s: 30, r: [], a: 2 * MINUTE } }, 'iso-b')

    const r = await runStoredCopyChecks(h.deps())

    expect(r.serving).toBe('posted')
    expect(h.db.asked).toEqual([]) // the Slack token came from KV, not the database that is down
    expect(h.posted).toHaveLength(1)
    const [post] = h.posted
    expect(post.channel).toBe('C-ALERTS')
    expect(post.title).toBe('Leads are being served from stored copies')
    expect(post.errors.join('\n')).toContain('3 of the last 5 minutes')
    expect(post.errors).toContain('The workflow definition was served from a stored copy at least 100 times; the oldest was last confirmed 11 minutes ago.')
    expect(post.errors).toContain('The environment variables were served from a stored copy at least 30 times; the oldest was last confirmed 2 minutes ago.')
    expect(post.context).toMatch(/30 minutes after it was last confirmed/)
    expect(post.fixHint).toMatch(/status\.supabase\.com/)
    // #835: a copy is served on ANY failed read, not only a slow one, so the
    // lead sentence may not claim the database was merely slow.
    expect(post.errors[0]).toMatch(/failed or timed out/)
    expect(post.errors[0]).not.toMatch(/did not answer in time/)
  })

  // A copy that was there but could not be read or used is not "no copy" (L11).
  it('says a stored copy could not be used, not that there was none, when one existed', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, { workflow_definition: { s: 0, r: refusedAs({ copy_unusable: 4 }), a: null } })
    await runStoredCopyChecks(h.deps())
    const text = h.posted.flatMap((p) => p.errors).join('\n')
    expect(text).toMatch(/could not be read or was not fit to serve/)
    expect(text).not.toMatch(/there was no stored copy/)
  })

  it('reads the live Slack connection only when there is no last-good copy', async () => {
    const h = harness({ db: slackDb(SLACK_CONFIG) })
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, served(5))
    const r = await runStoredCopyChecks(h.deps())
    expect(r.serving).toBe('posted')
    expect(h.db.asked).toEqual(['service_connections'])
  })

  it('says nothing for copies used in fewer minutes than the threshold, the shape of a healthy day', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    for (let ago = 0; ago < STORED_COPY_SERVING_ALERT_MINUTES - 1; ago++) await ledgerMinute(h.kv, h.clock, ago, served(3))
    const r = await runStoredCopyChecks(h.deps())
    expect(r.serving).toBe('below_threshold')
    expect(h.posted).toEqual([])
  })

  it('leaves out minutes before the window', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    for (const ago of [STORED_COPY_SERVING_WINDOW_MINUTES, STORED_COPY_SERVING_WINDOW_MINUTES + 1, 0]) await ledgerMinute(h.kv, h.clock, ago, served(3))
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('below_threshold')
  })

  it('holds a repeat inside the cooldown, and posts at once when copies start being refused', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, served(5))
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('posted')

    h.clock.now += MINUTE
    h.claimsHeld.clear()
    await ledgerMinute(h.kv, h.clock, 0, served(5))
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('cooldown')

    h.clock.now += MINUTE
    h.claimsHeld.clear()
    await ledgerMinute(h.kv, h.clock, 0, { env_vars: { s: 0, r: refusedAs({ copy_too_old: 7 }), a: null } }, 'iso-c')
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('posted')
    const last = h.posted.at(-1)!
    expect(last.title).toBe('Leads are being refused: stored copies are past their limit or missing')
    expect(last.errors).toContain('The environment variables were refused at least 7 times because the stored copy was past the 30 minute limit.')
  })

  it('posts nothing to an organization that turned volume alerts off', async () => {
    const h = harness()
    await rememberSlack(h.kv, { ...SLACK_CONFIG, volume_alerts_enabled: false })
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, served(5))
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('no_slack')
    expect(h.posted).toEqual([])
  })

  it('a post Slack refused releases the claim and records nothing, so the next tick tries again', async () => {
    const h = harness({ postOk: false })
    await rememberSlack(h.kv)
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, served(5))
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('post_failed')
    expect(h.claimsHeld.size).toBe(0)
    expect(await h.kv.get(`${STORED_COPY_SERVING_KEY}:cooldown`)).toBeNull()
  })

  it('stays quiet while another tick holds the claim', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, served(5))
    h.claimsHeld.add(STORED_COPY_SERVING_KEY)
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('claimed_elsewhere')
    expect(h.posted).toEqual([])
  })

  it('announces the all-clear once copies have not been used for the re-arm window, and only then', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, served(5))
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('posted')

    // Quiet, but not yet for the re-arm window.
    h.clock.now += (STORED_COPY_SERVING_WINDOW_MINUTES + 1) * MINUTE
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('quiet')
    expect(h.recoveries).toEqual([])

    h.clock.now += RECOVERY_REARM_MINUTES * MINUTE
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('recovered')
    expect(h.recoveries).toEqual([{ channel: 'C-ALERTS', subject: 'Stored copy use' }])
    // Settled: the next healthy tick owes nothing.
    h.clock.now += MINUTE
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('quiet')
    expect(h.recoveries).toHaveLength(1)
  })

  it('holds the all-clear while copies are still used now and then, below the threshold, and counts the re-arm from the last use', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    for (const ago of [0, 1, 2]) await ledgerMinute(h.kv, h.clock, ago, served(5))
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('posted')

    // A copy is used in one minute of every five: never enough to page again,
    // and never a stop either.
    let lastUseAt = h.clock.now
    for (let i = 1; i <= RECOVERY_REARM_MINUTES + 10; i++) {
      h.clock.now += MINUTE
      if (i % 5 === 0) {
        await ledgerMinute(h.kv, h.clock, 0, served(1))
        lastUseAt = h.clock.now
      }
      expect((await runStoredCopyChecks(h.deps())).serving).not.toBe('recovered')
    }
    expect(h.recoveries).toEqual([])

    // The all-clear comes the re-arm window after the last use, and not before.
    h.clock.now = lastUseAt + (RECOVERY_REARM_MINUTES - 1) * MINUTE
    expect((await runStoredCopyChecks(h.deps())).serving).not.toBe('recovered')
    h.clock.now += 2 * MINUTE
    expect((await runStoredCopyChecks(h.deps())).serving).toBe('recovered')
    expect(h.recoveries).toHaveLength(1)
  })

  it('says it could not measure when the ledger cannot be read, and still runs the other two checks', async () => {
    const h = harness()
    h.kv.failList = true
    const r = await runStoredCopyChecks(h.deps())
    expect(r.serving).toBe('unmeasured')
    expect(h.notified.map((n) => n.job).sort()).toEqual([STORED_COPY_STALE_JOB, STORED_COPY_SWEEP_JOB])
  })
})

describe('a stored copy that has gone stale', () => {
  async function liveWorkflowCopy(copies: Kv, writtenAt: number, extra: Record<string, unknown> = {}) {
    await copies.put(workflowCopyKey('wf-1'), JSON.stringify({
      is_active: true, lane: 'money', workflow_version_id: 'v1', version_number: 1, row_updated_at: '2026-10-06T00:00:00+00:00',
      written_at: new Date(writtenAt).toISOString(),
      workflow: { definition: {}, workflow_version_id: 'v1', workflow_name: 'Engine Bidding', org_id: ORG, slack_channel: null, lane: 'money' },
      ...extra,
    }))
  }

  it('finds none when every copy was confirmed inside the maximum age', async () => {
    const h = harness()
    await liveWorkflowCopy(h.copies, T0 - 5 * MINUTE)
    await h.copies.put(endpointLastGoodKey('engine', '/bid'), '{}', confirmedAt(T0 - 4 * MINUTE))
    await h.copies.put(partnerLastGoodKey('p-1'), '{"slug":"tripoint"}', confirmedAt(T0 - 3 * MINUTE))
    await h.copies.put(envVarsLastGoodKey(ORG), 'blob', confirmedAt(T0 - 2 * MINUTE))
    await h.copies.put(partnerConstantsLastGoodKey(ORG), '{}', confirmedAt(T0 - 2 * MINUTE))
    await h.copies.put(buyerProfilesLastGoodKey(ORG), JSON.stringify({ loaded_at: new Date(T0 - MINUTE).toISOString() }))
    expect(await findStaleCopies(h.copies as unknown as KVNamespace, T0)).toEqual({ stale: [], unmeasured: [] })
  })

  it('finds each copy past the maximum age, or with no readable time, naming what it is a copy of', async () => {
    const h = harness()
    const old = T0 - STORED_COPY_MAX_AGE_MS - 12 * MINUTE
    await liveWorkflowCopy(h.copies, old)
    await h.copies.put(endpointLastGoodKey('engine', '/bid'), '{}', confirmedAt(old))
    await h.copies.put(partnerLastGoodKey('p-1'), '{"slug":"tripoint"}', confirmedAt(old))
    await h.copies.put(envVarsLastGoodKey(ORG), 'blob') // written before stamps existed
    await h.copies.put(partnerConstantsLastGoodKey(ORG), '{}', confirmedAt(old))
    await h.copies.put(buyerProfilesLastGoodKey(ORG), JSON.stringify({ loaded_at: new Date(old).toISOString() }))
    await h.copies.put(bidMatrixLastGoodKey('cfg-1', true), '{"config":{},"rows":[]}', confirmedAt(old))

    const { stale } = await findStaleCopies(h.copies as unknown as KVNamespace, T0)
    // Every kind of stored copy there is, so a kind added later is judged too.
    expect(new Set(stale.map((s) => s.copy))).toEqual(new Set(STORED_COPY_KINDS))
    expect(stale.map((s) => [s.copy, s.subject, s.reason]).sort()).toEqual([
      ['bid_matrix', 'cfg-1 (sell off)', 'copy_too_old'],
      ['buyer_profiles', ORG, 'copy_too_old'],
      ['custom_endpoint', 'engine/bid', 'copy_too_old'],
      ['env_vars', ORG, 'copy_age_unknown'],
      ['partner_config', 'tripoint', 'copy_too_old'],
      ['partner_constants', ORG, 'copy_too_old'],
      ['workflow_definition', 'Engine Bidding', 'copy_too_old'],
    ])
  })

  it('does not judge a workflow tombstone or an unverified copy, which refuse whatever their age, nor an organization no live workflow copy names', async () => {
    const h = harness()
    const old = T0 - STORED_COPY_MAX_AGE_MS - MINUTE
    await h.copies.put(workflowCopyKey('wf-off'), JSON.stringify({ is_active: false, written_at: new Date(old).toISOString(), workflow: null }))
    await liveWorkflowCopy(h.copies, old, { unverified: true })
    await h.copies.put(envVarsLastGoodKey('org-gone'), 'blob', confirmedAt(old))
    expect((await findStaleCopies(h.copies as unknown as KVNamespace, T0)).stale).toEqual([])
  })

  // A copy KV would not hand back is unmeasured, never skipped as if it were not
  // live: a read failure must not read as a fresh copy (L215).
  it('reports a workflow copy it could not read as unmeasured, rather than skipping it', async () => {
    const h = harness()
    await liveWorkflowCopy(h.copies, T0)
    const reading = Object.assign(Object.create(h.copies), {
      get: async () => { throw new Error('KV get failed: 500') },
    }) as unknown as KVNamespace
    const { unmeasured } = await findStaleCopies(reading, T0)
    expect(unmeasured.join('\n')).toMatch(/workflow-def-lastgood:.*KV get failed: 500/)
  })

  it('alerts through the shared alerter with one finding per stale copy, keyed on the copy so a growing age is not a new problem', async () => {
    const h = harness()
    await h.copies.put(endpointLastGoodKey('engine', '/bid'), '{}', confirmedAt(T0 - 42 * MINUTE))
    await runStoredCopyChecks(h.deps())
    const stale = h.notified.find((n) => n.job === STORED_COPY_STALE_JOB)!
    expect(stale.errors).toEqual(['The stored copy of the custom endpoint for engine/bid was last confirmed 42 minutes ago, past the 30 minute limit.'])
    expect(stale.keys).toEqual([endpointLastGoodKey('engine', '/bid')])
    expect(stale.remedy).toMatchObject({ title: 'Stored copies have gone stale' })
  })

  // #835: the fix said to search the logs for "prewarm" and "stored-copy-sweep",
  // but the prewarm swallows its loaders' errors and each loader logs under its
  // own tag, so for most copies that search found nothing.
  it('names the log tag of the job that confirms each stale copy', async () => {
    const h = harness()
    await h.copies.put(endpointLastGoodKey('engine', '/bid'), '{}', confirmedAt(T0 - 42 * MINUTE))
    await runStoredCopyChecks(h.deps())
    const sweepOnly = (h.notified.find((n) => n.job === STORED_COPY_STALE_JOB)!.remedy as { fixHint: string }).fixHint
    expect(sweepOnly).toContain('[stored-copy-sweep]')
    expect(sweepOnly).not.toContain('[env-loader]')
  })

  // The definition loader logs JSON events rather than a bracketed tag, so the fix
  // names the event prefix every one of those lines carries, verbatim.
  it('names the exact string the definition loader logs a workflow copy failure under', async () => {
    const h = harness()
    await liveWorkflowCopy(h.copies, T0 - STORED_COPY_MAX_AGE_MS - MINUTE)
    await runStoredCopyChecks(h.deps())
    const fix = (h.notified.find((n) => n.job === STORED_COPY_STALE_JOB)!.remedy as { fixHint: string }).fixHint
    const named = fix.match(/`(workflow_definition_copy[^`]*)`/)?.[1]
    expect(named).toBeDefined()
    expect(DEFINITION_LOADER_SOURCE).toContain(`logEvent('${named}`)
  })

  it('points an environment copy at the loader that logs its failures', async () => {
    const h = harness()
    const old = T0 - STORED_COPY_MAX_AGE_MS - MINUTE
    await liveWorkflowCopy(h.copies, T0)
    await h.copies.put(envVarsLastGoodKey(ORG), 'blob', confirmedAt(old))
    await runStoredCopyChecks(h.deps())
    const fix = (h.notified.find((n) => n.job === STORED_COPY_STALE_JOB)!.remedy as { fixHint: string }).fixHint
    expect(fix).toContain('[env-loader]')
    expect(fix).not.toContain('[stored-copy-sweep]')
  })

  it('clears its alert when every copy is fresh', async () => {
    const h = harness()
    await runStoredCopyChecks(h.deps())
    expect(h.notified.find((n) => n.job === STORED_COPY_STALE_JOB)?.errors).toEqual([])
  })

  it('neither alerts nor clears when a kind of copy could not be read, since silence there is not health', async () => {
    const h = harness()
    h.copies.failList = true
    await runStoredCopyChecks(h.deps())
    expect(h.notified.find((n) => n.job === STORED_COPY_STALE_JOB)).toBeUndefined()
  })

  it('waits while stored copies are in use: the outage alert already speaks, and copies age because the database is down', async () => {
    const h = harness()
    await rememberSlack(h.kv)
    await ledgerMinute(h.kv, h.clock, 0, served(1))
    await h.copies.put(endpointLastGoodKey('engine', '/bid'), '{}', confirmedAt(T0 - 42 * MINUTE))
    const r = await runStoredCopyChecks(h.deps())
    expect(r.suppressed).toBe(true)
    expect(h.notified).toEqual([])
  })
})

describe('a stored copy sweep that keeps failing', () => {
  const failing: SweepResult = { checked: 0, repaired: [], reconfirmed: [], failed: ['ep-lastgood:engine:/bid: KV delete failed: 429', 'partner copies: upstream connect error'] }

  it('says nothing until it has failed for a whole confirmation interval, then names each failure', async () => {
    const h = harness({ sweep: failing })
    await runStoredCopyChecks(h.deps())
    expect(h.notified.find((n) => n.job === STORED_COPY_SWEEP_JOB)?.errors).toEqual([])

    h.clock.now += SWEEP_FAILING_ALERT_AFTER_MS
    await runStoredCopyChecks(h.deps())
    const sweep = h.notified.filter((n) => n.job === STORED_COPY_SWEEP_JOB).at(-1)!
    expect(sweep.errors).toEqual([
      'The sweep could not repair or confirm ep-lastgood:engine:/bid: KV delete failed: 429.',
      'The sweep could not repair or confirm partner copies: upstream connect error.',
    ])
    expect(sweep.keys).toEqual(['ep-lastgood:engine:/bid', 'partner copies'])
    expect(sweep.remedy).toMatchObject({ title: 'The stored copy sweep keeps failing' })
    expect((sweep.remedy as { context: string }).context).toMatch(/every run since/)
  })

  it('starts counting again after one clean run', async () => {
    const h = harness({ sweep: failing })
    await runStoredCopyChecks(h.deps())
    h.clock.now += SWEEP_FAILING_ALERT_AFTER_MS - MINUTE
    await runStoredCopyChecks({ ...h.deps(), sweep: cleanSweep })
    h.clock.now += MINUTE
    await runStoredCopyChecks(h.deps())
    expect(h.notified.filter((n) => n.job === STORED_COPY_SWEEP_JOB).at(-1)?.errors).toEqual([])
  })
})
