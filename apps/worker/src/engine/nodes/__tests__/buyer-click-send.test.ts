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
import { buildContext } from '../../context'
import {
  BUYER_CLICK_SEND_ROUTES,
  CLICK_CLAIM_DEADLINE_MS,
  CLICK_POST_TIMEOUT_MS,
  classifyClickAnswer,
  executeBuyerClickSendNode,
  type BuyerClickSendDeps,
} from '../buyer-click-send'
import { OBJECT_CALL_DEADLINE_MS } from '../../../lib/buyer-object-clients'

// The Liberty1 matcher lives in the node's CONFIG, never in the node's code.
const LIBERTY1_PATTERN = 'Records created successfully : (?<id>[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)'
const SF_ID = 'a0B5f00000XyZ12AAB'
const NOW = Date.UTC(2027, 8, 20, 18, 0) // 11:00 Pacific

const node = (over: Record<string, unknown> = {}): NodeDefinition => ({
  id: 'n-click',
  namespace: 'send_click',
  type: 'buyer_click_send',
  config: {
    partner_slug: 'liberty1',
    prospect_id: '{{trigger.payload.prospect}}',
    request_url: '{{steps.build.output.url}}',
    request_body: '{{steps.build.output.body}}',
    success_pattern: LIBERTY1_PATTERN,
    daily_lead_cap: 50,
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
} = {}): Harness {
  const h: Harness = { sold: [], freed: [], posts: [], members: new Set(opts.members ?? []), alerts: [], claims: [], logs: [], deps: undefined as never }
  h.deps = {
    saleClient: (key) => {
      expect(key).toEqual({ kind: 'click', partner_slug: 'liberty1', prospect_id: 'a0B000000000001AAA' })
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
    counter: (slug, nowMs) => {
      expect(slug).toBe('liberty1')
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
    post: async (url, body, o) => {
      h.posts.push({ url, body, timeoutMs: o.timeoutMs })
      const p = opts.post ?? answer(200, `Records created successfully : ${SF_ID}`)
      return typeof p === 'function' ? p() : p
    },
    alert: async (a) => {
      h.alerts.push(a)
      return opts.alert ? opts.alert(a) : 'posted'
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

  it('routes are the fixed handle list', () => {
    expect([...BUYER_CLICK_SEND_ROUTES]).toEqual(['sent', 'refused', 'unknown', 'already_sent', 'in_progress', 'needs_review', 'not_sent'])
  })
})

describe('a confirmed send', () => {
  it('claims with the deadline, posts the built body, marks sold with the partner lead id and payout 0, then counts the prospect', async () => {
    const h = harness()
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(h.claims).toEqual([{ partner_id: 'liberty1', execution_id: 'exec-1', deadline_ms: CLICK_CLAIM_DEADLINE_MS }])
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
    expect(at60.alerts).toEqual([expect.objectContaining({ kind: 'over_cap', partner_slug: 'liberty1', date: '2027-09-20', count: 60, daily_lead_cap: 50, threshold: 60, alert_over_percent: 120 })])
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

  it('honours a configured percent and a templated cap', async () => {
    const h = harness({ members: upTo(9) })
    const c = ctx()
    c.steps.profile = { output: { daily_lead_cap: 10 } } as never
    const r = await run(h, node({ daily_lead_cap: '{{steps.profile.output.daily_lead_cap}}', alert_over_percent: 100 }), c)
    expect(r.output).toMatchObject({ count: 10, over_cap: 'posted' })
  })

  it('a Slack failure is logged and never fails the node', async () => {
    const h = harness({ members: upTo(59), alert: async () => { throw new Error('slack is down') } })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'sent', over_cap: 'post_failed' })
    expect(h.logs.some((l) => l.event === 'buyer_click_alert_failed' && /slack is down/.test(String(l.error_message)))).toBe(true)
  })

  it('an unreadable cap pages cap_unreadable and still sends', async () => {
    const h = harness()
    const r = await run(h, node({ daily_lead_cap: '{{steps.nowhere.output.cap}}' }))
    expect(r.output).toMatchObject({ _route: 'sent', over_cap: 'cap_unreadable' })
    expect(h.alerts.map((a) => a.kind === 'page' && a.reason)).toEqual(['cap_unreadable'])
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

describe('the claim states', () => {
  it('sold: already sent, nothing posted, the earlier partner lead id reported', async () => {
    const h = harness({ claim: { state: 'sold', partner_id: 'liberty1', outcome: { buyer_reference: SF_ID, result_code: 'created', http_status: 200, payout_cents: 0 }, generation: 3 } })
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
    const h = harness({ claim: { state: 'in_doubt', partner_id: 'liberty1', generation: 2 } })
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
    ['no partner slug', { partner_slug: '' }, undefined, 'partner_slug_invalid'],
    ['no success pattern', { success_pattern: '' }, undefined, 'success_pattern_invalid'],
    ['a success pattern that does not compile', { success_pattern: '(' }, undefined, 'success_pattern_invalid'],
    ['a success pattern with no id group', { success_pattern: 'Records created' }, undefined, 'success_pattern_invalid'],
    ['an alert percent that is not a whole number', { alert_over_percent: 0 }, undefined, 'alert_over_percent_invalid'],
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
