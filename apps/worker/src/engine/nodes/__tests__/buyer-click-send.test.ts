/**
 * buyer_click_send (#1542): claim, post and count one click in one step, so a
 * prospect is never sent to a buyer twice and the day's count is exact.
 *
 * Every claim state (claimed, sold, in_flight, in_doubt, unreadable), every
 * send outcome (confirmed, refused, and each shape of unknown), the resume and
 * replay refusal, the idempotent count under a repeat, the over cap notice once
 * a day, and a Slack failure that never fails the node. Clock, post, timers and
 * every object are injected, so nothing waits and nothing leaves the process.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Timers } from '@bidspoke/buyer-profile'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { ClaimResult } from '../../../durable-objects/lead-sale'
import type { SaleOutcomeRecord } from '../../../durable-objects/buyer-ledger'
import type { PartnerCallResult } from '../../../lib/post-to-partner'
import type { ClickAlert, ClickAlertOutcome } from '../../../lib/buyer-click-alert'
import { NODE_TRAITS } from '@bidspoke/node-types'
import { buildContext } from '../../context'
import {
  BUYER_CLICK_SEND_ROUTES,
  CLICK_CLAIM_DEADLINE_MS,
  CLICK_POST_TIMEOUT_MS,
  classifyClickAnswer,
  executeBuyerClickSendNode,
  type BuyerClickSendDeps,
  type ProfileCap,
  type HeldClickRecord,
} from '../buyer-click-send'
import { clickCounterObjectName, leadSaleObjectName, OBJECT_CALL_DEADLINE_MS } from '../../../lib/buyer-object-clients'

// The Liberty1 matcher lives in the node's CONFIG, never in the node's code.
const LIBERTY1_PATTERN = 'Records created successfully : (?<id>[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)'
const SF_ID = 'a0B5f00000XyZ12AAB'
/** Liberty1's partner_configs id: the claim and the count are keyed on this, never the slug (#1553). */
const PARTNER_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
const NOW = Date.UTC(2027, 8, 20, 18, 0) // 11:00 Pacific

const node = (over: Record<string, unknown> = {}): NodeDefinition => ({
  id: 'n-click',
  namespace: 'send_click',
  type: 'buyer_click_send',
  config: {
    partner_id: PARTNER_ID,
    prospect_id: '{{trigger.payload.prospect}}',
    request_url: '{{steps.build.output.url}}',
    request_body: '{{steps.build.output.body}}',
    success_pattern: LIBERTY1_PATTERN,
    ...over,
  },
})

function ctx(over: Partial<ExecutionContext> = {}): ExecutionContext {
  const c = buildContext({ prospect: 'a0B000000000001AAA' }, 'liberty-proxy', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1')
  c.steps.build = { output: { url: 'https://example.my.salesforce-sites.com/services/apexrest/lead', body: { FirstName: 'Test' } } } as never
  return Object.assign(c, over)
}

const answer = (status: number, text: string, isHtml = false): PartnerCallResult => {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status, text, json, isHtml, headers: {} }
}

interface Harness {
  deps: BuyerClickSendDeps
  sold: Array<{ generation: number; outcome: SaleOutcomeRecord }>
  freed: number[]
  posts: Array<{ url: string; body: unknown; timeoutMs: number }>
  members: Set<string>
  alerts: ClickAlert[]
  claims: Array<Record<string, unknown>>
  logs: Array<Record<string, unknown>>
  saleKeys: string[]
  counterNames: string[]
  resolved: string[]
  holds: HeldClickRecord[]
}

function harness(opts: {
  claim?: ClaimResult | (() => Promise<ClaimResult>)
  post?: PartnerCallResult | (() => Promise<PartnerCallResult>)
  soldFails?: boolean
  freeFails?: boolean
  addFails?: boolean
  alert?: (a: ClickAlert) => Promise<ClickAlertOutcome>
  members?: string[]
  timers?: Timers
  /** What the partner id resolves to: a slug, null for no such partner in the org, or a read that throws. */
  partner?: string | null | (() => Promise<{ slug: string } | null>)
  /** The expected slug on the post, when the resolver renames the partner. */
  slug?: string
  /** Shared across runs, so a second run sees the first run's count. */
  memberSet?: Set<string>
  /** The profile's daily cap: a number, null for a profile holding none, 'none' for no enabled profile, or a read that throws. */
  cap?: number | null | 'none' | (() => Promise<ProfileCap>)
  /** The held click record write throws (#1552). */
  holdFails?: boolean
} = {}): Harness {
  const slug = opts.slug ?? (typeof opts.partner === 'string' ? opts.partner : 'liberty1')
  const h: Harness = {
    sold: [], freed: [], posts: [], members: opts.memberSet ?? new Set(opts.members ?? []), alerts: [], claims: [], logs: [],
    saleKeys: [], counterNames: [], resolved: [], holds: [], deps: undefined as never,
  }
  h.deps = {
    profileCap: async (partnerId) => {
      expect(partnerId).toBe(PARTNER_ID)
      const c = opts.cap === undefined ? 50 : opts.cap
      if (typeof c === 'function') return c()
      return c === 'none' ? { found: false } : { found: true, cap: c, soldOn: 'click' }
    },
    resolvePartner: async (partnerId) => {
      h.resolved.push(partnerId)
      const p = opts.partner === undefined ? 'liberty1' : opts.partner
      if (typeof p === 'function') return p()
      return p === null ? null : { slug: p }
    },
    saleClient: (key) => {
      // The real naming, so a key built from the slug would fail here (L15).
      h.saleKeys.push(leadSaleObjectName(key))
      expect(key).toEqual({ kind: 'click', partner_id: PARTNER_ID, prospect_id: 'a0B000000000001AAA' })
      return {
        claim: async (body) => {
          h.claims.push(body as unknown as Record<string, unknown>)
          const c = opts.claim ?? { state: 'claimed', generation: 1 }
          return typeof c === 'function' ? c() : c
        },
        sold: async (generation, outcome) => {
          if (opts.soldFails) throw new Error('lead sale sold did not answer within 5000 ms')
          h.sold.push({ generation, outcome })
          return generation + 1
        },
        free: async (generation) => {
          if (opts.freeFails) throw new Error('lead sale free answered 500')
          h.freed.push(generation)
          return generation + 1
        },
      }
    },
    counter: (partnerId, nowMs) => {
      h.counterNames.push(clickCounterObjectName(partnerId, nowMs).name)
      expect(partnerId).toBe(PARTNER_ID)
      expect(nowMs).toBe(NOW)
      return {
        date: '2027-09-20',
        addMember: async (m) => {
          if (opts.addFails) throw new Error('click counter add answered 500')
          const added = !h.members.has(m)
          h.members.add(m)
          return { added, count: h.members.size }
        },
      }
    },
    post: async (target, body, o) => {
      // The buyer's own slug, so an error or a log names the buyer that answered.
      expect(target.slug).toBe(slug)
      h.posts.push({ url: target.url, body, timeoutMs: o.timeoutMs })
      const p = opts.post ?? answer(200, `Records created successfully : ${SF_ID}`)
      return typeof p === 'function' ? p() : p
    },
    alert: async (a) => {
      h.alerts.push(a)
      return opts.alert ? opts.alert(a) : 'posted'
    },
    recordHold: async (hold) => {
      if (opts.holdFails) throw new Error('record_held_click failed: relation does not exist')
      h.holds.push(hold)
    },
    clock: () => NOW,
    timers: opts.timers,
    log: (fields) => h.logs.push(fields),
    localDev: false,
  }
  return h
}

const run = (h: Harness, n = node(), c = ctx()) => executeBuyerClickSendNode(n, c, h.deps)

describe('the deadline constants carry their reasoning', () => {
  it('the claim deadline outlives the post and the two object calls after it, with margin', () => {
    expect(CLICK_POST_TIMEOUT_MS).toBe(20_000)
    expect(CLICK_CLAIM_DEADLINE_MS).toBeGreaterThan(CLICK_POST_TIMEOUT_MS + 2 * OBJECT_CALL_DEADLINE_MS)
  })

  it('routes are exactly the handles the node type declares, so the two lists cannot drift', () => {
    expect([...BUYER_CLICK_SEND_ROUTES]).toEqual(NODE_TRAITS.buyer_click_send.staticHandles)
  })
})

describe('a confirmed send', () => {
  it('claims with the deadline, posts the built body, marks sold with the partner lead id and payout 0, then counts the prospect', async () => {
    const h = harness()
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(h.claims).toEqual([{ partner_id: PARTNER_ID, execution_id: 'exec-1', deadline_ms: CLICK_CLAIM_DEADLINE_MS }])
    expect(h.posts).toEqual([{ url: 'https://example.my.salesforce-sites.com/services/apexrest/lead', body: { FirstName: 'Test' }, timeoutMs: CLICK_POST_TIMEOUT_MS }])
    expect(h.sold).toEqual([{ generation: 1, outcome: { buyer_reference: SF_ID, result_code: 'created', http_status: 200, payout_cents: 0 } }])
    expect([...h.members]).toEqual(['a0B000000000001AAA'])
    expect(r.output).toMatchObject({ _route: 'sent', reason: 'sent', partner_lead_id: SF_ID, status: 200, count: 1, counted: true, count_date: '2027-09-20' })
    expect(h.alerts).toEqual([])
  })

  it('reads the success line when Salesforce returns it as a JSON string', async () => {
    const h = harness({ post: answer(200, JSON.stringify(`Records created successfully : ${SF_ID.slice(0, 15)}`)) })
    expect((await run(h)).output).toMatchObject({ _route: 'sent', partner_lead_id: SF_ID.slice(0, 15) })
  })

  it('a repeat add of a prospect already counted today does not count it again', async () => {
    const h = harness({ members: ['a0B000000000001AAA'] })
    expect((await run(h)).output).toMatchObject({ _route: 'sent', count: 1, counted: false })
  })

  it('a count that fails after the sale pages count_failed and still routes sent', async () => {
    const h = harness({ addFails: true })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'sent', reason: 'sent', count: null, counted: false })
    expect(h.alerts.map((a) => a.kind === 'page' && a.reason)).toEqual(['count_failed'])
    expect(r.output.pages).toEqual([{ reason: 'count_failed', outcome: 'posted' }])
  })

  it('a sold mark that fails pages sold_mark_failed, still counts the click and routes sent', async () => {
    const h = harness({ soldFails: true })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'sent', counted: true, count: 1 })
    expect(h.alerts.map((a) => a.kind === 'page' && a.reason)).toEqual(['sold_mark_failed'])
  })
})

describe('the over cap notice', () => {
  const upTo = (n: number) => Array.from({ length: n }, (_, i) => `p-${i}`)

  it('posts when the count after an add reaches 120 percent of the cap (60 at 50), not before', async () => {
    const at59 = harness({ members: upTo(58) })
    expect((await run(at59)).output).toMatchObject({ count: 59, over_cap: 'not_due' })
    expect(at59.alerts).toEqual([])

    const at60 = harness({ members: upTo(59) })
    const r = await run(at60)
    expect(r.output).toMatchObject({ count: 60, over_cap: 'posted' })
    expect(at60.alerts).toEqual([expect.objectContaining({ kind: 'over_cap', partner_id: PARTNER_ID, partner_slug: 'liberty1', date: '2027-09-20', count: 60, daily_lead_cap: 50, threshold: 60, alert_over_percent: 120 })])
  })

  it('once a day: a later click the same day is told the notice is already out', async () => {
    let posted = false
    const alert = async (a: ClickAlert): Promise<ClickAlertOutcome> => {
      if (a.kind !== 'over_cap') return 'posted'
      if (posted) return 'claimed_elsewhere'
      posted = true
      return 'posted'
    }
    const h = harness({ members: upTo(59), alert })
    expect((await run(h)).output.over_cap).toBe('posted')
    const again = harness({ members: upTo(60), alert })
    expect((await run(again)).output.over_cap).toBe('claimed_elsewhere')
  })

  it('honours a configured percent against the profile cap', async () => {
    const h = harness({ members: upTo(9), cap: 10 })
    const r = await run(h, node({ alert_over_percent: 100 }))
    expect(r.output).toMatchObject({ count: 10, over_cap: 'posted', daily_lead_cap: 10 })
  })

  // #1543, L83: the cap has one home, the buyer profile, which buyer_click_check
  // stops offering against. A cap still stored on the node is ignored and shown.
  it('reads the cap from the buyer profile, never the node config, and reports a stale node value as ignored', async () => {
    const h = harness({ members: upTo(9), cap: 10 })
    const r = await run(h, node({ daily_lead_cap: 500, alert_over_percent: 100 }))
    expect(r.output).toMatchObject({ count: 10, over_cap: 'posted', daily_lead_cap: 10, daily_lead_cap_ignored: 500 })
  })

  it('a Slack failure is logged and never fails the node', async () => {
    const h = harness({ members: upTo(59), alert: async () => { throw new Error('slack is down') } })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'sent', over_cap: 'post_failed' })
    expect(h.logs.some((l) => l.event === 'buyer_click_alert_failed' && /slack is down/.test(String(l.error_message)))).toBe(true)
  })

  it('a profile that cannot be read pages cap_unreadable and still sends: the click already happened', async () => {
    const h = harness({ cap: async () => { throw new Error('buyer profiles read failed for org org-1: timeout') } })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'sent', counted: true, over_cap: 'cap_unreadable', daily_lead_cap: null })
    expect(h.alerts.map((a) => a.kind === 'page' && a.reason)).toEqual(['cap_unreadable'])
  })

  it('an enabled profile holding no cap pages cap_unreadable too', async () => {
    const h = harness({ cap: null })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'sent', over_cap: 'cap_unreadable' })
    expect(h.alerts.map((a) => a.kind === 'page' && a.reason)).toEqual(['cap_unreadable'])
  })

  it('a cap of zero is no readable cap (the one isCap rule), never a notice on every click (#1557)', async () => {
    const h = harness({ cap: 0, members: upTo(3) })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'sent', over_cap: 'cap_unreadable', daily_lead_cap: null })
    expect(h.alerts.map((a) => (a.kind === 'page' ? a.reason : a.kind))).toEqual(['cap_unreadable'])
  })

  it('a profile sold on the offer is an unreadable cap: its leads cap is never judged against clicks (#1557)', async () => {
    const h = harness({ cap: async () => ({ found: true, cap: 50, soldOn: 'offer' }), members: upTo(80) })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'sent', over_cap: 'cap_unreadable', daily_lead_cap: null })
    expect(h.alerts.map((a) => (a.kind === 'page' ? a.reason : a.kind))).toEqual(['cap_unreadable'])
    const page = h.alerts[0]
    expect(page.kind === 'page' && page.detail).toMatch(/sold on the offer/)
  })

  it('no enabled profile (switched off while offers were out) is recorded as no_enabled_profile and pages nothing', async () => {
    const h = harness({ cap: 'none', members: upTo(80) })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'sent', counted: true, over_cap: 'no_enabled_profile', daily_lead_cap: null })
    expect(h.alerts).toEqual([])
  })
})

describe('a refused send', () => {
  it('a 4xx carrying the buyer own error frees the claim so a later click can retry, and routes refused with the reason', async () => {
    const h = harness({ post: answer(400, '{"error":"Duplicate SSN"}') })
    const r = await run(h)
    expect(h.freed).toEqual([1])
    expect(h.sold).toEqual([])
    expect(h.members.size).toBe(0)
    expect(r.output).toMatchObject({ _route: 'refused', reason: 'refused_by_buyer', status: 400, claim_freed: true })
    expect(r.output.detail).toMatch(/Duplicate SSN/)
    expect(h.alerts).toEqual([])
  })

  it('a refusal whose claim cannot be freed pages free_failed and still routes refused', async () => {
    const h = harness({ post: answer(422, 'Missing field: Email'), freeFails: true })
    const r = await run(h)
    expect(r.output).toMatchObject({ _route: 'refused', claim_freed: false })
    expect(h.alerts.map((a) => a.kind === 'page' && a.reason)).toEqual(['free_failed'])
  })
})

describe('an unknown send keeps the claim held, pages and routes unknown', () => {
  const cases: Array<[string, () => Promise<PartnerCallResult>, RegExp]> = [
    ['a timeout', () => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), /no answer/],
    ['a network error', () => Promise.reject(new Error('Network connection lost.')), /no answer/],
    ['a 5xx', async () => answer(503, 'Service Unavailable'), /http 503/],
    ['an HTML page with a 2xx', async () => answer(200, '<html><body>Maintenance</body></html>', true), /HTML page/],
    ['an HTML page with a 4xx', async () => answer(404, '<!DOCTYPE html><html>Site Down</html>', true), /HTML page/],
    ['a 2xx that is not the success shape', async () => answer(200, 'Records created successfully : not-an-id!'), /not the configured success shape/],
    ['a 2xx with extra text around the success line', async () => answer(200, `OK. Records created successfully : ${SF_ID} and more`), /not the configured success shape/],
    ['an empty 2xx', async () => answer(200, ''), /not the configured success shape/],
    ['an empty 4xx', async () => answer(400, ''), /empty/],
    ['a 429', async () => answer(429, 'Too many requests'), /http 429/],
    ['a 3xx', async () => answer(302, ''), /http 302/],
  ]
  for (const [name, post, detail] of cases) {
    it(name, async () => {
      const h = harness({ post })
      const r = await run(h)
      expect(r.failure).toBeUndefined()
      expect(r.output).toMatchObject({ _route: 'unknown', reason: 'outcome_unknown' })
      expect(r.output.detail).toMatch(detail)
      expect(h.freed).toEqual([])
      expect(h.sold).toEqual([])
      expect(h.members.size).toBe(0)
      expect(h.alerts).toEqual([expect.objectContaining({ kind: 'page', reason: 'outcome_unknown', prospect_id: 'a0B000000000001AAA' })])
    })
  }

  it('a post that never settles is ended by the node own deadline, proven with timers fired by hand', async () => {
    const pending: Array<{ fn: () => void; ms: number }> = []
    const timers: Timers = { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length }, clearTimeout: () => undefined }
    const h = harness({ post: () => new Promise<PartnerCallResult>(() => undefined), timers })
    const p = run(h)
    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0))
    expect(pending[0].ms).toBeGreaterThan(CLICK_POST_TIMEOUT_MS)
    expect(pending[0].ms).toBeLessThan(CLICK_CLAIM_DEADLINE_MS)
    pending.forEach((t) => t.fn())
    expect((await p).output).toMatchObject({ _route: 'unknown', reason: 'outcome_unknown' })
  })
})

describe('a held claim is recorded so a person can find it on the partner page (#1552)', () => {
  const base = { partner_id: PARTNER_ID, prospect_id: 'a0B000000000001AAA', workflow_id: 'wf-1', execution_id: 'exec-1', trace_id: 'trace-1' }

  it('an unknown answer records the hold with its reason and detail', async () => {
    const h = harness({ post: answer(503, 'Service Unavailable') })
    const r = await run(h)
    expect(h.holds).toEqual([{ ...base, reason: 'outcome_unknown', detail: r.output.detail, partner_lead_id: null }])
    expect(r.output.hold_recorded).toBe(true)
    expect(r.output.hold_record_error).toBeUndefined()
  })

  it('a post with no answer at all records the hold', async () => {
    const h = harness({ post: () => Promise.reject(new Error('Network connection lost.')) })
    await run(h)
    expect(h.holds.map((x) => x.reason)).toEqual(['outcome_unknown'])
  })

  it('a claim found in doubt records the sighting', async () => {
    const h = harness({ claim: { state: 'in_doubt', partner_id: PARTNER_ID, generation: 2 } })
    const r = await run(h)
    expect(h.holds).toEqual([expect.objectContaining({ ...base, reason: 'claim_in_doubt', partner_lead_id: null })])
    expect(r.output.hold_recorded).toBe(true)
  })

  it('a sold mark that fails records the hold with the lead id the buyer gave, so the person need not look it up', async () => {
    const h = harness({ soldFails: true })
    await run(h)
    expect(h.holds).toEqual([expect.objectContaining({ ...base, reason: 'sold_mark_failed', partner_lead_id: SF_ID })])
  })

  it('a refusal whose claim cannot be freed records the hold', async () => {
    const h = harness({ post: answer(422, 'Missing field: Email'), freeFails: true })
    await run(h)
    expect(h.holds).toEqual([expect.objectContaining({ ...base, reason: 'free_failed', partner_lead_id: null })])
  })

  it('nothing is recorded when nothing is held: sent, refused and freed, already sent, in progress, report only', async () => {
    const runs: Harness[] = [
      harness(),
      harness({ post: answer(400, 'Duplicate SSN') }),
      harness({ claim: { state: 'sold', partner_id: PARTNER_ID, outcome: { buyer_reference: SF_ID, result_code: 'created', http_status: 200, payout_cents: 0 }, generation: 3 } }),
      harness({ claim: { state: 'in_flight', holder_execution_id: 'exec-0', since: NOW - 3000, generation: 1 } }),
    ]
    for (const h of runs) {
      const r = await run(h)
      expect(h.holds, r.output._route).toEqual([])
      expect(r.output.hold_recorded, r.output._route).toBeUndefined()
    }
    const test = harness({ post: answer(503, 'down') })
    await run(test, node(), ctx({ isTest: true }))
    expect(test.holds).toEqual([])
  })

  it('a record that fails is logged and reported on the step, never fails the node, and the page still goes out', async () => {
    const h = harness({ post: answer(503, 'down'), holdFails: true })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'unknown', hold_recorded: false })
    // The page sends the person to the execution for why, so the step carries it.
    expect(r.output.hold_record_error).toMatch(/relation does not exist/)
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'page', reason: 'outcome_unknown', hold_recorded: false })])
    expect(h.logs.some((l) => l.event === 'buyer_click_hold_record_failed' && /relation does not exist/.test(String(l.error_message)))).toBe(true)
  })

  it('each held page says whether its hold was recorded, so the page never points at a list that lacks the click', async () => {
    const cases: Array<[string, Parameters<typeof harness>[0]]> = [
      ['outcome_unknown', { post: answer(503, 'down') }],
      ['claim_in_doubt', { claim: { state: 'in_doubt', partner_id: PARTNER_ID, generation: 2 } }],
      ['sold_mark_failed', { soldFails: true }],
      ['free_failed', { post: answer(422, 'Missing field: Email'), freeFails: true }],
    ]
    for (const [reason, opts] of cases) {
      for (const holdFails of [false, true]) {
        const h = harness({ ...opts, holdFails })
        await run(h)
        const held = h.alerts.filter((a) => a.kind === 'page' && a.reason === reason)
        expect(held, `${reason} holdFails=${holdFails}`).toEqual([expect.objectContaining({ hold_recorded: !holdFails })])
      }
    }
  })

  it('a page that holds nothing carries no word on a hold', async () => {
    const h = harness({ addFails: true })
    await run(h)
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'page', reason: 'count_failed', hold_recorded: null })])
  })
})

describe('the claim states', () => {
  it('sold: already sent, nothing posted, the earlier partner lead id reported', async () => {
    const h = harness({ claim: { state: 'sold', partner_id: PARTNER_ID, outcome: { buyer_reference: SF_ID, result_code: 'created', http_status: 200, payout_cents: 0 }, generation: 3 } })
    const r = await run(h)
    expect(h.posts).toEqual([])
    expect(r.output).toMatchObject({ _route: 'already_sent', reason: 'already_sent', partner_lead_id: SF_ID })
    expect(h.alerts).toEqual([])
  })

  it('in_flight under another execution: in progress, nothing posted', async () => {
    const h = harness({ claim: { state: 'in_flight', holder_execution_id: 'exec-0', since: NOW - 3000, generation: 1 } })
    const r = await run(h)
    expect(h.posts).toEqual([])
    expect(r.output).toMatchObject({ _route: 'in_progress', reason: 'claim_in_progress' })
    expect(r.output.detail).toMatch(/exec-0/)
  })

  it('in_doubt: needs review, nothing posted, and it pages', async () => {
    const h = harness({ claim: { state: 'in_doubt', partner_id: PARTNER_ID, generation: 2 } })
    const r = await run(h)
    expect(h.posts).toEqual([])
    expect(r.output).toMatchObject({ _route: 'needs_review', reason: 'claim_in_doubt' })
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'page', reason: 'claim_in_doubt' })])
  })

  it('a claim that cannot be read fails the step transient by name and sends nothing', async () => {
    const h = harness({ claim: () => Promise.reject(new Error('lead sale claim did not answer within 5000 ms')) })
    const r = await run(h)
    expect(h.posts).toEqual([])
    expect(r.failure).toMatchObject({ errorType: 'transient', reason: 'claim_unavailable' })
    expect(r.failure?.message).toMatch(/buyer_click_send claim_unavailable/)
  })
})

describe('refusals before any claim', () => {
  it('a resumed execution is refused permanently by name, before any claim or send', async () => {
    for (const recovery of ['resume', 'replay'] as const) {
      const h = harness()
      const r = await run(h, node(), ctx({ recovery }))
      expect(r.failure, recovery).toMatchObject({ errorType: 'permanent', reason: 'recovery_run_refused' })
      expect(h.claims).toEqual([])
      expect(h.posts).toEqual([])
    }
  })

  it('refuses retries set on the node: they are ignored and reported', async () => {
    const h = harness()
    const r = await run(h, node({ retries: 3 }))
    expect(r.output).toMatchObject({ _route: 'sent', retries_ignored: 3 })
  })

  const bad: Array<[string, Record<string, unknown>, ExecutionContext | undefined, string]> = [
    ['no partner id', { partner_id: '' }, undefined, 'partner_id_invalid'],
    ['a slug where the partner id belongs', { partner_id: 'liberty1' }, undefined, 'partner_id_invalid'],
    ['a config from before #1553 that names the partner by slug only', { partner_id: undefined, partner_slug: 'liberty1' }, undefined, 'partner_id_invalid'],
    ['no success pattern', { success_pattern: '' }, undefined, 'success_pattern_invalid'],
    ['a success pattern that does not compile', { success_pattern: '(' }, undefined, 'success_pattern_invalid'],
    ['a success pattern with no id group', { success_pattern: 'Records created' }, undefined, 'success_pattern_invalid'],
    ['an alert percent of zero', { alert_over_percent: 0 }, undefined, 'alert_over_percent_invalid'],
    ['an alert percent past 1000', { alert_over_percent: 1001 }, undefined, 'alert_over_percent_invalid'],
    ['an alert percent that is a fraction', { alert_over_percent: 1.5 }, undefined, 'alert_over_percent_invalid'],
    ['an alert percent that is a numeric string', { alert_over_percent: '120' }, undefined, 'alert_over_percent_invalid'],
    ['an empty prospect id', { prospect_id: '{{trigger.payload.missing}}' }, undefined, 'prospect_id_empty'],
    ['a url that is not https', { request_url: 'http://example.com/x' }, undefined, 'request_url_invalid'],
    ['a body that is not an object', { request_body: 'plain text' }, undefined, 'request_body_invalid'],
  ]
  for (const [name, config, c, reason] of bad) {
    it(name, async () => {
      const h = harness()
      const r = await run(h, node(config), c ?? ctx())
      expect(r.failure).toMatchObject({ errorType: 'permanent', reason })
      expect(h.claims).toEqual([])
      expect(h.posts).toEqual([])
    })
  }
})

describe('the partner is named by id and resolved for its slug (#1553)', () => {
  it('a slug rename keeps the claim and the count: the same id finds the same claim object and the same counter', async () => {
    const members = new Set<string>()
    const before = harness({ partner: 'liberty1', memberSet: members })
    const first = await run(before)
    expect(first.output).toMatchObject({ _route: 'sent', partner_id: PARTNER_ID, partner_slug: 'liberty1', count: 1, counted: true })

    // The partner is renamed between two clicks on the same prospect.
    const after = harness({ partner: 'liberty-one', memberSet: members })
    const second = await run(after)
    expect(after.saleKeys).toEqual(before.saleKeys)
    expect(after.counterNames).toEqual(before.counterNames)
    expect(before.saleKeys[0]).toBe(`sale:click:${PARTNER_ID}:a0B000000000001AAA`)
    expect(before.counterNames[0]).toBe(`clicks-${PARTNER_ID}-2027-09-20`)
    // The prospect is already in the day's set under the id, so the rename neither resets nor double counts it.
    expect(second.output).toMatchObject({ partner_slug: 'liberty-one', count: 1, counted: false })
  })

  it('the resolved slug names the buyer in the post, the alerts and the output', async () => {
    const h = harness({ partner: 'liberty-one', post: answer(503, 'down') })
    const r = await run(h)
    expect(h.resolved).toEqual([PARTNER_ID])
    expect(r.output).toMatchObject({ partner_id: PARTNER_ID, partner_slug: 'liberty-one' })
    expect(h.alerts).toEqual([expect.objectContaining({ partner_id: PARTNER_ID, partner_slug: 'liberty-one' })])
  })

  it('a partner id the org does not hold fails permanently by name, and claims, posts, counts and pages nothing', async () => {
    const h = harness({ partner: null })
    const r = await run(h)
    expect(r.failure).toMatchObject({ errorType: 'permanent', reason: 'partner_not_found' })
    expect(r.failure?.message).toContain(PARTNER_ID)
    expect(r.output).toMatchObject({ partner_id: PARTNER_ID, partner_slug: null })
    expect(h.claims).toEqual([])
    expect(h.posts).toEqual([])
    expect(h.members.size).toBe(0)
    expect(h.alerts).toEqual([])
  })

  it('a partner read that fails is its own transient reason, not a missing partner (L11), and sends nothing', async () => {
    const h = harness({ partner: () => Promise.reject(new Error('partner_constants load failed for org org-1: timeout')) })
    const r = await run(h)
    expect(r.failure).toMatchObject({ errorType: 'transient', reason: 'partner_unreadable' })
    expect(r.failure?.message).toMatch(/timeout/)
    expect(h.claims).toEqual([])
    expect(h.posts).toEqual([])
  })

  it('a test run resolves the partner too, so an unresolvable one shows before launch', async () => {
    const h = harness({ partner: null })
    const r = await run(h, node(), ctx({ isTest: true }))
    expect(r.failure).toMatchObject({ reason: 'partner_not_found' })
  })
})

describe('report only: a test run, shadow or local dev touches nothing', () => {
  it('routes not_sent with the body fingerprint and makes no claim, post, count or alert', async () => {
    for (const c of [ctx({ isTest: true }), ctx({ shadow_mode: 'dry_run' })]) {
      const h = harness()
      const r = await run(h, node(), c)
      expect(r.output).toMatchObject({ _route: 'not_sent', reason: 'report_only', mode_effective: 'report_only' })
      expect(r.output.would_send_body_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(h.claims).toEqual([])
      expect(h.posts).toEqual([])
      expect(h.alerts).toEqual([])
    }
    const local = harness()
    local.deps.localDev = true
    expect((await run(local)).output._route).toBe('not_sent')
    expect(local.claims).toEqual([])
  })
})

describe('classifyClickAnswer', () => {
  const pattern = new RegExp(`^(?:${LIBERTY1_PATTERN})$`)
  it('confirms only the anchored success line and captures the id', () => {
    expect(classifyClickAnswer(answer(201, `  Records created successfully : ${SF_ID}\n`), pattern)).toEqual({ kind: 'confirmed', partnerLeadId: SF_ID })
    expect(classifyClickAnswer(answer(200, `Records created successfully : ${SF_ID}x`), pattern).kind).toBe('unknown')
  })

  it('a 4xx buyer error is refused, a 408 is unknown', () => {
    expect(classifyClickAnswer(answer(409, 'duplicate'), pattern).kind).toBe('refused')
    expect(classifyClickAnswer(answer(408, 'timeout'), pattern).kind).toBe('unknown')
  })
})
