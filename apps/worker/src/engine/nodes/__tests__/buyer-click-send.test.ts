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
import { DeadlineError, type ClickDelivery, type Timers } from '@bidspoke/buyer-profile'
import type { ExecutionContext, NodeDefinition } from '../../../types'
import type { ClaimResult } from '../../../durable-objects/lead-sale'
import type { SaleOutcomeRecord } from '../../../durable-objects/buyer-ledger'
import type { PartnerCallResult } from '../../../lib/post-to-partner'
import { clickAlertMessage, type ClickAlert, type ClickAlertOutcome } from '../../../lib/buyer-click-alert'
import { NODE_TRAITS } from '@bidspoke/node-types'
import { buildContext } from '../../context'
import {
  BUYER_CLICK_SEND_ROUTES,
  CLICK_ALERT_DEADLINE_MS,
  CLICK_CLAIM_DEADLINE_MS,
  CLICK_CLAIM_MARGIN_MS,
  CLICK_COUNT_RETRY_COST_MS,
  CLICK_HOLD_RECORD_DEADLINE_MS,
  CLICK_POST_TIMEOUT_MS,
  CLICK_RUN_BUDGET_MS,
  classifyClickAnswer,
  executeBuyerClickSendNode,
  readClickProfile,
  type BuyerClickSendDeps,
  type ProfileRead,
  type HeldClickRecord,
} from '../buyer-click-send'
import { clickCounterObjectName, leadSaleObjectName, OBJECT_CALL_DEADLINE_MS, ObjectAnswerUnreadableError, ObjectCallError, ObjectCallLostError } from '../../../lib/buyer-object-clients'

// A buyer's success line lives on its buyer PROFILE (#1639, #1671), never in the node's code or config.
const LIBERTY1_PATTERN = 'Records created successfully : (?<id>[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)'
const SF_ID = 'a0B5f00000XyZ12AAB'
/** Liberty1's partner_configs id: the claim and the count are keyed on this, never the slug (#1553). */
const PARTNER_ID = '3f1c2a9e-5b7d-4c8e-9a01-2b3c4d5e6f70'
const NOW = Date.UTC(2027, 8, 20, 18, 0) // 11:00 Pacific
const BUYER_URL = 'https://example.my.salesforce-sites.com/services/apexrest/lead'

/** The click delivery every harness profile holds unless a test says otherwise: one catch-all route. */
const DEFAULT_DELIVERY: ClickDelivery = { routes: [{ name: 'ALL', url: BUYER_URL, states: [] }], successPattern: LIBERTY1_PATTERN }

const node = (over: Record<string, unknown> = {}): NodeDefinition => ({
  id: 'n-click',
  namespace: 'send_click',
  type: 'buyer_click_send',
  config: {
    partner_id: PARTNER_ID,
    prospect_id: '{{trigger.payload.prospect}}',
    request_body: '{{steps.build.output.body}}',
    ...over,
  },
})

function ctx(over: Partial<ExecutionContext> = {}): ExecutionContext {
  const c = buildContext({ prospect: 'a0B000000000001AAA' }, 'liberty-proxy', 'wf-1', 'trace-1', {}, 'org-1', 'exec-1')
  c.steps.build = { output: { body: { FirstName: 'Test' } } } as never
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

/**
 * One ask of the click counter, as the double answers it (#1766). `answer` is the
 * real set: a prospect already there answers added false. `timeout` and
 * `transport` are no answer at all, and `lands` says whether the add was taken
 * anyway, as on 2026-10-05 when it landed 48 ms after the caller gave up.
 * `refused` (a 4xx), `error_status` (a 5xx) and `unreadable` are answers the
 * counter gave. `unrecognised` is a bare Error the client never raises, so the
 * node cannot say what it was. `hang` never settles. `takesMs` moves the clock
 * by that much.
 */
type CounterAsk = { kind: 'answer' | 'timeout' | 'transport' | 'refused' | 'error_status' | 'unreadable' | 'unrecognised' | 'hang'; lands?: boolean; takesMs?: number }

interface Harness {
  deps: BuyerClickSendDeps
  /** Every ask of the click counter, in order. */
  adds: string[]
  /** Moves the clock the node reads. */
  advance: (ms: number) => void
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
  profileReads: number
  /** Held click records started that never answer (holdHangs). */
  holdsHanging: number
}

function harness(opts: {
  claim?: ClaimResult | (() => Promise<ClaimResult>)
  post?: PartnerCallResult | (() => Promise<PartnerCallResult>)
  soldFails?: boolean
  freeFails?: boolean
  /** The counter refuses the add (a 4xx), so the click is known not to be counted. */
  addFails?: boolean
  /** The counter's answer to each ask in turn; an ask past the end answers. */
  counter?: CounterAsk[]
  /** How long the post takes on the node's clock. */
  postTakesMs?: number
  /** The counter cannot even be opened, so nothing is asked. */
  counterOpenFails?: boolean
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
  cap?: number | null | 'none' | (() => Promise<ProfileRead>)
  /** The held click record write throws (#1552). */
  holdFails?: boolean
  /** The held click record write never answers (#1849). */
  holdHangs?: boolean
  /** The enabled profile's click delivery (#1639); absent means DEFAULT_DELIVERY, null means the profile holds none. */
  delivery?: ClickDelivery | null
} = {}): Harness {
  const slug = opts.slug ?? (typeof opts.partner === 'string' ? opts.partner : 'liberty1')
  let now = NOW
  const h: Harness = {
    sold: [], freed: [], posts: [], members: opts.memberSet ?? new Set(opts.members ?? []), alerts: [], claims: [], logs: [],
    saleKeys: [], counterNames: [], resolved: [], holds: [], profileReads: 0, holdsHanging: 0, adds: [], advance: (ms) => { now += ms }, deps: undefined as never,
  }
  const script: CounterAsk[] = opts.counter ?? (opts.addFails ? [{ kind: 'refused' }] : [])
  h.deps = {
    readProfile: async (partnerId) => {
      expect(partnerId).toBe(PARTNER_ID)
      h.profileReads++
      const c = opts.cap === undefined ? 50 : opts.cap
      if (typeof c === 'function') return c()
      return c === 'none' ? { found: false } : { found: true, enabled: true, cap: c, soldOn: 'click', clickDelivery: opts.delivery === undefined ? DEFAULT_DELIVERY : opts.delivery }
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
      if (opts.counterOpenFails) throw new Error('click counter name: "x" is not a partner id')
      h.counterNames.push(clickCounterObjectName(partnerId, nowMs).name)
      expect(partnerId).toBe(PARTNER_ID)
      // Named from the clock as the count starts, so a retry counts on the same day.
      expect(nowMs).toBe(now)
      return {
        date: '2027-09-20',
        addMember: async (m) => {
          const ask = script[h.adds.length] ?? { kind: 'answer' }
          h.adds.push(m)
          if (ask.takesMs) h.advance(ask.takesMs)
          const take = () => {
            const added = !h.members.has(m)
            h.members.add(m)
            return { added, count: h.members.size }
          }
          switch (ask.kind) {
            case 'answer': return take()
            case 'timeout':
              if (ask.lands) take()
              throw new DeadlineError('click counter add', OBJECT_CALL_DEADLINE_MS)
            case 'transport':
              if (ask.lands) take()
              throw new ObjectCallLostError(new TypeError('Network connection lost.'))
            case 'unrecognised': throw new Error('something nobody classified')
            case 'refused': throw new ObjectCallError('click counter add', 400, '{"error":"bad_member"}')
            case 'error_status': throw new ObjectCallError('click counter add', 500, 'internal error')
            case 'unreadable': throw new ObjectAnswerUnreadableError('click counter add', '{"added":"yes"}')
            case 'hang': return new Promise<never>(() => undefined)
          }
        },
      }
    },
    post: async (target, body, o) => {
      // The buyer's own slug, so an error or a log names the buyer that answered.
      expect(target.slug).toBe(slug)
      h.posts.push({ url: target.url, body, timeoutMs: o.timeoutMs })
      if (opts.postTakesMs) h.advance(opts.postTakesMs)
      const p = opts.post ?? answer(200, `Records created successfully : ${SF_ID}`)
      return typeof p === 'function' ? p() : p
    },
    alert: async (a) => {
      h.alerts.push(a)
      return opts.alert ? opts.alert(a) : 'posted'
    },
    recordHold: async (hold) => {
      if (opts.holdHangs) {
        h.holdsHanging++
        return new Promise<void>(() => undefined)
      }
      if (opts.holdFails) throw new Error('record_held_click failed: relation does not exist')
      h.holds.push(hold)
    },
    clock: () => now,
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

  // #1766: the count's one retry lives inside the run's budget, which stops short of
  // the claim deadline by its whole margin, so a retry can never eat into the margin.
  it('the run budget is the claim deadline less its margin, and a retry costs the add at its full deadline plus the page after it', () => {
    expect(CLICK_RUN_BUDGET_MS + CLICK_CLAIM_MARGIN_MS).toBe(CLICK_CLAIM_DEADLINE_MS)
    expect(CLICK_CLAIM_MARGIN_MS).toBeGreaterThan(0)
    expect(CLICK_COUNT_RETRY_COST_MS).toBe(OBJECT_CALL_DEADLINE_MS + CLICK_ALERT_DEADLINE_MS)
    expect(CLICK_COUNT_RETRY_COST_MS).toBeLessThan(CLICK_RUN_BUDGET_MS)
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
    expect(h.posts).toEqual([{ url: BUYER_URL, body: { FirstName: 'Test' }, timeoutMs: CLICK_POST_TIMEOUT_MS }])
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

  it('a count the counter refuses after the sale pages count_failed and still routes sent', async () => {
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

  // The success line proves only that the buyer answered with an id: for Liberty1's
  // LeadConnector that is a run id for a queued trigger, not a created record (#1547).
  it('says a confirmed answer is receipt with an id, never that the buyer created a record, in the detail and both pages', async () => {
    const sent = await run(harness())
    expect(sent.output.detail).toBe(`the buyer confirmed receipt with id ${SF_ID}`)
    for (const opts of [{ addFails: true }, { soldFails: true }]) {
      const h = harness(opts)
      await run(h)
      const page = h.alerts[0]
      expect(page.kind === 'page' && page.detail).toMatch(new RegExp(`^the buyer confirmed receipt with id ${SF_ID}, and `))
      expect(page.kind === 'page' && page.detail).not.toMatch(/created/)
    }
  })
})

describe('a count with no answer is asked once more, and a page says only what it measured (#1766)', () => {
  /** The page as Slack would render it, from the alert the node raised. */
  const rendered = (h: Harness) => {
    const page = h.alerts.find((a) => a.kind === 'page')
    if (!page) throw new Error('no page was raised')
    const m = clickAlertMessage(page, 'https://app.test')
    return `${m.header}\n${m.body}`
  }

  it('an add that times out once and then answers is counted, pages nothing, and the step says it was asked twice', async () => {
    const h = harness({ counter: [{ kind: 'timeout' }, { kind: 'answer' }] })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(h.adds).toEqual(['a0B000000000001AAA', 'a0B000000000001AAA'])
    expect(r.output).toMatchObject({ _route: 'sent', reason: 'sent', count: 1, counted: true, count_date: '2027-09-20', over_cap: 'not_due' })
    expect(r.output.count_retried).toMatch(/click counter add did not answer within 5000 ms/)
    expect(r.output.count_error).toBeUndefined()
    expect(h.alerts).toEqual([])
    expect(r.output.pages).toEqual([])
    expect(h.logs.some((l) => l.event === 'buyer_click_count_no_answer' && l.retried === true)).toBe(true)
  })

  // The shape measured on 2026-10-05: the first add landed 48 ms after the caller gave up.
  // The set takes it once, so the retry reads the count the late add left and nothing pages.
  it('an add that landed after its deadline is not counted twice: the retry reads the same count and nothing pages', async () => {
    const h = harness({ counter: [{ kind: 'timeout', lands: true }, { kind: 'answer' }], members: ['a0B000000000009AAA'] })
    const r = await run(h)
    expect(h.members.size).toBe(2)
    expect(r.output).toMatchObject({ _route: 'sent', count: 2, counted: false })
    expect(r.output.count_retried).toMatch(/did not answer/)
    expect(h.alerts).toEqual([])
  })

  it('a transport error is no answer too, and is asked again', async () => {
    const h = harness({ counter: [{ kind: 'transport' }, { kind: 'answer' }] })
    const r = await run(h)
    expect(h.adds).toHaveLength(2)
    expect(r.output).toMatchObject({ count: 1, counted: true })
    expect(r.output.count_retried).toMatch(/Network connection lost/)
    expect(h.alerts).toEqual([])
  })

  it('an add that times out twice pages count_unknown, saying the click may not have been counted and never that the count reads low', async () => {
    const h = harness({ counter: [{ kind: 'timeout' }, { kind: 'timeout' }] })
    const r = await run(h)
    expect(r.failure).toBeUndefined()
    expect(h.adds).toHaveLength(2)
    expect(r.output).toMatchObject({ _route: 'sent', reason: 'sent', count: null, counted: false, over_cap: 'not_counted' })
    expect(r.output.pages).toEqual([{ reason: 'count_unknown', outcome: 'posted' }])
    const page = h.alerts[0]
    expect(page).toMatchObject({ kind: 'page', reason: 'count_unknown', hold_recorded: null })
    expect(page.kind === 'page' && page.detail).toBe(
      `the buyer confirmed receipt with id ${SF_ID}, and the day's count did not answer: click counter add did not answer within 5000 ms; asked again, it did not answer: click counter add did not answer within 5000 ms`,
    )
    expect(r.output.count_error).toBe(page.kind === 'page' && page.detail)
    const text = rendered(h)
    expect(text).toMatch(/liberty1 sent a click that may not have been counted/)
    expect(text).toMatch(/Today's click count did not say whether it took this click, so the click may not have been counted\./)
    expect(text).not.toMatch(/reads? low|could not be counted|did not take it/)
  })

  it('a counter that refuses the add is an answer: it is not asked again, and the page keeps saying the count reads low by this click', async () => {
    const h = harness({ counter: [{ kind: 'refused' }] })
    const r = await run(h)
    expect(h.adds).toHaveLength(1)
    expect(r.output.count_retried).toBeUndefined()
    expect(r.output.pages).toEqual([{ reason: 'count_failed', outcome: 'posted' }])
    const page = h.alerts[0]
    expect(page.kind === 'page' && page.detail).toBe(`the buyer confirmed receipt with id ${SF_ID}, and the day's count refused to add it: click counter add answered 400: {"error":"bad_member"}`)
    const text = rendered(h)
    expect(text).toMatch(/liberty1 sent a click that could not be counted/)
    expect(text).toMatch(/the count reads low by this click until it is added/)
    expect(text).not.toMatch(/may not have been counted/)
  })

  it('an answer the counter gave that cannot be read is not asked again, and the page says what is known: it answered, and whether it took the click is not', async () => {
    const h = harness({ counter: [{ kind: 'unreadable' }] })
    const r = await run(h)
    expect(h.adds).toHaveLength(1)
    expect(r.output.count_retried).toBeUndefined()
    expect(r.output.pages).toEqual([{ reason: 'count_unknown', outcome: 'posted' }])
    const page = h.alerts[0]
    expect(page.kind === 'page' && page.detail).toBe(`the buyer confirmed receipt with id ${SF_ID}, and the day's count answered, but its answer could not be read: click counter add answered an unreadable body: {"added":"yes"}`)
    const text = rendered(h)
    expect(text).toMatch(/did not say whether it took this click/)
    expect(text).not.toMatch(/reads? low/)
  })

  it('an error status from the counter is an answer that does not say whether it took the click: not asked again, paged as possibly not counted', async () => {
    const h = harness({ counter: [{ kind: 'error_status' }] })
    const r = await run(h)
    expect(h.adds).toHaveLength(1)
    expect(r.output.pages).toEqual([{ reason: 'count_unknown', outcome: 'posted' }])
    const page = h.alerts[0]
    expect(page.kind === 'page' && page.detail).toBe(`the buyer confirmed receipt with id ${SF_ID}, and the day's count answered with an error that does not say whether it took it: click counter add answered 500: internal error`)
  })

  // L35: only a deadline or a call lost in transit is no answer. An error the node cannot
  // classify is never treated as retryable, and never as a refusal either.
  it('an error the node cannot classify is not asked again, and pages count_unknown naming it as unclassified', async () => {
    const h = harness({ counter: [{ kind: 'unrecognised' }] })
    const r = await run(h)
    expect(h.adds).toHaveLength(1)
    expect(r.output.count_retried).toBeUndefined()
    expect(r.output.pages).toEqual([{ reason: 'count_unknown', outcome: 'posted' }])
    expect(r.output.count_error).toBe(`the buyer confirmed receipt with id ${SF_ID}, and the day's count failed in a way this node does not classify: something nobody classified`)
    expect(h.logs.some((l) => l.event === 'buyer_click_count_no_answer')).toBe(false)
  })

  it('a counter that cannot be opened was never asked, so the click is known not to be counted: count_failed, and no retry', async () => {
    const h = harness({ counterOpenFails: true })
    const r = await run(h)
    expect(h.adds).toEqual([])
    expect(r.output).toMatchObject({ _route: 'sent', count: null, counted: false, count_date: null, over_cap: 'not_counted' })
    expect(r.output.pages).toEqual([{ reason: 'count_failed', outcome: 'posted' }])
    expect(r.output.count_error).toBe(`the buyer confirmed receipt with id ${SF_ID}, and the day's count could not be asked: click counter name: "x" is not a partner id`)
  })

  it('a retry the counter refuses still pages count_unknown, because the first ask may have landed', async () => {
    const h = harness({ counter: [{ kind: 'timeout' }, { kind: 'refused' }] })
    const r = await run(h)
    expect(h.adds).toHaveLength(2)
    expect(r.output.pages).toEqual([{ reason: 'count_unknown', outcome: 'posted' }])
    expect(rendered(h)).not.toMatch(/reads? low/)
  })

  // The whole run after the claim is CLICK_RUN_BUDGET_MS. The retry is asked only
  // when it and the page after it both fit in what is left, so it is never the step
  // that carries the run past its budget.
  it('no retry is asked once the run budget cannot hold it: the post and the first add used the time, and the page says so', async () => {
    const h = harness({ postTakesMs: CLICK_POST_TIMEOUT_MS, counter: [{ kind: 'timeout', takesMs: OBJECT_CALL_DEADLINE_MS }] })
    const r = await run(h)
    expect(h.adds).toHaveLength(1)
    expect(r.output.count_retried).toBeUndefined()
    expect(r.output.pages).toEqual([{ reason: 'count_unknown', outcome: 'posted' }])
    const page = h.alerts[0]
    expect(page.kind === 'page' && page.detail).toBe(
      `the buyer confirmed receipt with id ${SF_ID}, and the day's count did not answer: click counter add did not answer within 5000 ms. It was not asked again, because too little of this click's time was left`,
    )
    expect(rendered(h)).toMatch(/may not have been counted/)
    expect(h.logs.some((l) => l.event === 'buyer_click_count_no_answer' && l.retried === false)).toBe(true)
  })

  it('the retry is asked when exactly its cost is left, and not one millisecond later', async () => {
    const elapsedAtRetry = CLICK_RUN_BUDGET_MS - CLICK_COUNT_RETRY_COST_MS
    const fits = harness({ postTakesMs: elapsedAtRetry - OBJECT_CALL_DEADLINE_MS, counter: [{ kind: 'timeout', takesMs: OBJECT_CALL_DEADLINE_MS }, { kind: 'answer' }] })
    expect((await run(fits)).output).toMatchObject({ counted: true })
    expect(fits.adds).toHaveLength(2)
    const late = harness({ postTakesMs: elapsedAtRetry - OBJECT_CALL_DEADLINE_MS + 1, counter: [{ kind: 'timeout', takesMs: OBJECT_CALL_DEADLINE_MS }, { kind: 'answer' }] })
    expect((await run(late)).output).toMatchObject({ counted: false, count: null })
    expect(late.adds).toHaveLength(1)
  })

  it('a retry that never settles is ended by the node at the object call deadline, proven with timers fired by hand', async () => {
    const pending: Array<{ fn: () => void; ms: number }> = []
    const timers: Timers = { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length }, clearTimeout: () => undefined }
    const h = harness({ counter: [{ kind: 'timeout' }, { kind: 'hang' }], timers })
    const p = run(h)
    await vi.waitFor(() => expect(h.adds).toHaveLength(2))
    const retryBound = pending[pending.length - 1]
    expect(retryBound.ms).toBe(OBJECT_CALL_DEADLINE_MS)
    retryBound.fn()
    const r = await p
    expect(r.output.pages).toEqual([{ reason: 'count_unknown', outcome: 'posted' }])
    expect(r.output.count_error).toMatch(/asked again, it did not answer: click counter add did not answer within 5000 ms/)
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

  // #1639: the profile now also says WHERE the click goes, so it is read once,
  // before anything is claimed, and the cap is judged from that same read. A
  // profile that cannot be read is a refusal, never a guess at the address (L75).
  it('a profile that cannot be read fails the step transiently by name, and claims, sends and counts nothing', async () => {
    const h = harness({ cap: async () => { throw new Error('buyer profiles read failed for org org-1: timeout') } })
    const r = await run(h)
    expect(r.failure).toMatchObject({ errorType: 'transient', reason: 'profile_unreadable' })
    expect(r.failure?.message).toMatch(/timeout/)
    expect(h.claims).toEqual([])
    expect(h.posts).toEqual([])
    expect(h.members.size).toBe(0)
  })

  it('reads the profile once per click, for the address and the cap alike', async () => {
    const h = harness({ members: upTo(59) })
    await run(h)
    expect(h.profileReads).toBe(1)
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

})

describe('the address and the success line from the buyer profile (#1639)', () => {
  const LC = 'https://services.leadconnectorhq.com/hooks/abc/webhook-trigger'
  const LC_PATTERN = '\\s*\\{[\\s\\S]*?"id"\\s*:\\s*"(?<id>[A-Za-z0-9]{15,20})"[\\s\\S]*\\}\\s*'
  const RUN_ID = 'Ab12Cd34Ef56Gh78Ij'
  const delivery: ClickDelivery = {
    routes: [
      { name: 'DV1', url: `${LC}/dv1`, states: ['WA', 'OR'] },
      { name: 'DI4', url: `${LC}/di4`, states: [] },
    ],
    successPattern: LC_PATTERN,
  }
  const lcAnswer = answer(200, `{"status":"Success: request sent to trigger execution server","id":"${RUN_ID}"}`)
  const withState = (state: unknown) => {
    const c = ctx()
    c.steps.build = { output: { url: 'https://example.my.salesforce-sites.com/services/apexrest/lead', body: { FirstName: 'Test' }, state } } as never
    return c
  }
  const stateNode = (over: Record<string, unknown> = {}) => node({ state: '{{steps.build.output.state}}', ...over })

  it('posts to the route listing the lead state and confirms with the profile success line', async () => {
    const h = harness({ delivery, post: lcAnswer })
    const r = await run(h, stateNode(), withState('WA'))
    expect(h.posts.map((p) => p.url)).toEqual([`${LC}/dv1`])
    expect(r.output).toMatchObject({
      _route: 'sent', partner_lead_id: RUN_ID, route_name: 'DV1', route_matched: 'state', route_state: 'WA', url_source: 'profile', pattern_source: 'profile',
    })
  })

  it('sends a state in no route to the catch-all', async () => {
    const h = harness({ delivery, post: lcAnswer })
    const r = await run(h, stateNode(), withState('TX'))
    expect(h.posts.map((p) => p.url)).toEqual([`${LC}/di4`])
    expect(r.output).toMatchObject({ route_name: 'DI4', route_matched: 'catch_all', route_state: 'TX' })
  })

  it('sends a lead with no state to the catch-all and records that it had none', async () => {
    const h = harness({ delivery, post: lcAnswer })
    const r = await run(h, stateNode(), withState(null))
    expect(h.posts.map((p) => p.url)).toEqual([`${LC}/di4`])
    expect(r.output).toMatchObject({ route_name: 'DI4', route_matched: 'no_state', route_state: null })
  })

  // #1671: the node's own address and success line are gone. A canvas saved before
  // that still carries both until someone clears them, and the node must ignore
  // them, so deploying the executor before the canvas is cleaned changes nothing.
  const STALE_URL = 'https://stale.example/services/apexrest/lead'
  const withStaleNodeAddress = (state: unknown) => {
    const c = withState(state)
    ;(c.steps.build as { output: Record<string, unknown> }).output.url = STALE_URL
    return c
  }
  const staleNode = (over: Record<string, unknown> = {}) => stateNode({ request_url: '{{steps.build.output.url}}', success_pattern: LIBERTY1_PATTERN, ...over })

  it('a node still carrying request_url and success_pattern is posted to the profile route, never the node address, and nothing notes the stale values', async () => {
    const h = harness({ delivery, post: lcAnswer })
    const r = await run(h, staleNode(), withStaleNodeAddress('OR'))
    expect(h.posts.map((p) => p.url)).toEqual([`${LC}/dv1`])
    expect(r.output).toMatchObject({ _route: 'sent', partner_lead_id: RUN_ID, url_source: 'profile', pattern_source: 'profile' })
    expect(r.output).not.toHaveProperty('node_success_pattern_superseded')
    expect(h.alerts).toEqual([])
  })

  it('judges the answer with the profile line, so a success line left on the node cannot confirm a click', async () => {
    const h = harness({ delivery, post: answer(200, `Records created successfully : ${SF_ID}`) })
    const r = await run(h, staleNode(), withStaleNodeAddress('WA'))
    expect(r.output).toMatchObject({ _route: 'unknown', pattern_source: 'profile' })
  })

  it('a malformed request_url or success_pattern left on the node fails nothing: neither is read', async () => {
    const h = harness({ delivery, post: lcAnswer })
    const r = await run(h, staleNode({ request_url: 'http://not-https.example', success_pattern: '(' }), withState('WA'))
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'sent', route_name: 'DV1' })
  })

  it('refuses by name, before any claim, a delivery with state routes on a node with no state template, rather than send every state to the catch-all', async () => {
    const h = harness({ delivery, post: lcAnswer })
    const r = await run(h, node(), withState('WA'))
    expect(r.failure).toMatchObject({ errorType: 'permanent', reason: 'state_template_unset' })
    expect(h.claims).toEqual([])
    expect(h.posts).toEqual([])
  })

  it('a delivery that is only a catch-all needs no state template', async () => {
    const h = harness({ delivery: { ...delivery, routes: [delivery.routes[1]] }, post: lcAnswer })
    const r = await run(h, node(), withState('WA'))
    expect(r.output).toMatchObject({ _route: 'sent', route_name: 'DI4', route_matched: 'no_state' })
  })

  const broken: Array<[string, ClickDelivery]> = [
    ['a stored success line with no id group', { ...delivery, successPattern: 'Success' }],
    ['a stored success line that does not compile', { ...delivery, successPattern: '(' }],
    ['stored routes with no catch-all', { ...delivery, routes: [delivery.routes[0]] }],
    ['a stored route address that is not https', { ...delivery, routes: [delivery.routes[0], { ...delivery.routes[1], url: 'http://x.example' }] }],
  ]
  for (const [name, d] of broken) {
    it(`${name} fails permanently by name before any claim or send`, async () => {
      const h = harness({ delivery: d, post: lcAnswer })
      const r = await run(h, stateNode(), withState('TX'))
      expect(r.failure).toMatchObject({ errorType: 'permanent', reason: 'click_delivery_invalid' })
      expect(h.claims).toEqual([])
      expect(h.posts).toEqual([])
    })
  }

  // #1671: with the node's own address gone, the profile's click delivery is the only
  // place a click can go. Every way of not having one is refused by name before the
  // claim, so nothing is held, sent or counted, and the message names the fix (L111).
  describe('no click delivery to send to', () => {
    const refusedBeforeAnything = (h: Harness) => {
      expect(h.claims).toEqual([])
      expect(h.posts).toEqual([])
      expect(h.members.size).toBe(0)
      expect(h.holds).toEqual([])
    }

    it('an enabled click profile holding no delivery is refused as click_delivery_unset, permanently, naming the profile setting to fill', async () => {
      const h = harness({ delivery: null })
      const r = await run(h, staleNode(), withStaleNodeAddress('WA'))
      expect(r.failure).toMatchObject({ errorType: 'permanent', reason: 'click_delivery_unset' })
      expect(r.failure?.message).toMatch(/Click delivery/)
      expect(r.failure?.message).toMatch(/buyer profile/)
      expect(r.failure?.message).toMatch(/nothing was sent/)
      refusedBeforeAnything(h)
    })

    it('with no delivery the node address is not a fallback, even when the node still carries a good one', async () => {
      const h = harness({ delivery: null })
      await run(h, staleNode(), withStaleNodeAddress('WA'))
      expect(h.posts.map((p) => p.url)).not.toContain(STALE_URL)
    })

    it('a buyer with no profile at all is refused as no_profile, naming the fix', async () => {
      const h = harness({ cap: 'none' })
      const r = await run(h, staleNode(), withStaleNodeAddress('WA'))
      expect(r.failure).toMatchObject({ errorType: 'permanent', reason: 'no_profile' })
      expect(r.failure?.message).toMatch(/no buyer profile/)
      refusedBeforeAnything(h)
    })

    it('a switched off profile holding no delivery is refused as click_delivery_unset', async () => {
      const h = harness({ cap: async () => ({ found: true, enabled: false, cap: null, soldOn: 'click', clickDelivery: null }) })
      const r = await run(h, staleNode(), withStaleNodeAddress('WA'))
      expect(r.failure).toMatchObject({ errorType: 'permanent', reason: 'click_delivery_unset' })
      refusedBeforeAnything(h)
    })

    it('a profile sold on the offer is refused as not_sold_on_click: an offer buyer holds no click delivery (#1557)', async () => {
      const h = harness({ cap: async () => ({ found: true, enabled: true, cap: 50, soldOn: 'offer', clickDelivery: null }) })
      const r = await run(h, staleNode(), withStaleNodeAddress('WA'))
      expect(r.failure).toMatchObject({ errorType: 'permanent', reason: 'not_sold_on_click' })
      expect(r.failure?.message).toMatch(/sold on the offer/)
      refusedBeforeAnything(h)
    })

    it('a profile that cannot be read is still refused as profile_unreadable, never sent to the node address (Dan, 2026-09-30)', async () => {
      const h = harness({ cap: async () => { throw new Error('kv and database both down') } })
      const r = await run(h, staleNode(), withStaleNodeAddress('WA'))
      expect(r.failure).toMatchObject({ errorType: 'transient', reason: 'profile_unreadable' })
      refusedBeforeAnything(h)
    })

    it('a test run shows the same refusal, so a canvas test finds a missing delivery before launch', async () => {
      const h = harness({ delivery: null })
      const c = withState('WA')
      c.isTest = true
      const r = await run(h, stateNode(), c)
      expect(r.failure).toMatchObject({ reason: 'click_delivery_unset' })
    })
  })

  // Dan, 2026-09-30: switching a click buyer's profile off stops new OFFERS only. A click
  // on an offer already shown still goes out, through that profile's click delivery, and
  // is recorded as before: the notice has no overshoot to warn about, so it pages nothing.
  describe('a switched off profile that holds a click delivery', () => {
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => `p-${i}`)
    const switchedOff = (): Promise<ProfileRead> => Promise.resolve({ found: true, enabled: false, cap: null, soldOn: 'click', clickDelivery: delivery })

    it('sends the click through its route and success line, claims and counts it, and pages nothing', async () => {
      const h = harness({ cap: switchedOff, post: lcAnswer, members: upTo(80) })
      const r = await run(h, stateNode(), withState('WA'))
      expect(r.failure).toBeUndefined()
      expect(h.posts.map((p) => p.url)).toEqual([`${LC}/dv1`])
      expect(r.output).toMatchObject({ _route: 'sent', partner_lead_id: RUN_ID, route_name: 'DV1', url_source: 'profile', counted: true, over_cap: 'no_enabled_profile', daily_lead_cap: null })
      expect(h.claims).toHaveLength(1)
      expect(h.alerts).toEqual([])
      expect(h.logs.some((l) => l.event === 'buyer_click_send_no_enabled_profile')).toBe(true)
    })

    it('a switched off profile sold on the offer is still refused as not_sold_on_click', async () => {
      const h = harness({ cap: async () => ({ found: true, enabled: false, cap: null, soldOn: 'offer', clickDelivery: null }) })
      const r = await run(h, stateNode(), withState('WA'))
      expect(r.failure).toMatchObject({ reason: 'not_sold_on_click' })
      expect(h.posts).toEqual([])
    })
  })

  it('a test run shows the route it would use, and sends nothing', async () => {
    const h = harness({ delivery })
    const c = withState('WA')
    c.isTest = true
    const r = await run(h, stateNode(), c)
    expect(r.output).toMatchObject({ _route: 'not_sent', route_name: 'DV1', url_source: 'profile' })
    expect(h.posts).toEqual([])
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
    // The profile read's own bound (#1639) is set first and settled; the post's is the one past the post timeout.
    await vi.waitFor(() => expect(pending.some((t) => t.ms > CLICK_POST_TIMEOUT_MS)).toBe(true))
    const postBound = pending.filter((t) => t.ms > CLICK_POST_TIMEOUT_MS)
    expect(postBound).toHaveLength(1)
    expect(postBound[0].ms).toBeLessThan(CLICK_CLAIM_DEADLINE_MS)
    postBound[0].fn()
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

  it('a record that runs out of time is reported as outcome unknown, not as not recorded, because it may have landed (#1849)', async () => {
    const pending: Array<{ fn: () => void; ms: number }> = []
    const timers: Timers = { setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length }, clearTimeout: () => undefined }
    const h = harness({ post: answer(503, 'down'), holdHangs: true, timers })
    const p = run(h)
    await vi.waitFor(() => expect(h.holdsHanging).toBe(1))
    // The newest bound is the record's: it is set as the write starts.
    const bound = pending[pending.length - 1]
    expect(bound.ms).toBe(CLICK_HOLD_RECORD_DEADLINE_MS)
    bound.fn()
    const r = await p
    expect(r.failure).toBeUndefined()
    expect(r.output).toMatchObject({ _route: 'unknown', hold_recorded: 'outcome_unknown' })
    expect(r.output.hold_record_error).toMatch(/did not answer within/)
    expect(h.alerts).toEqual([expect.objectContaining({ kind: 'page', reason: 'outcome_unknown', hold_recorded: 'outcome_unknown' })])
    expect(h.logs.some((l) => l.event === 'buyer_click_hold_record_failed' && l.hold_outcome === 'outcome_unknown')).toBe(true)
  })

  it('a record the database refused is reported as not recorded', async () => {
    const h = harness({ post: answer(503, 'down'), holdFails: true })
    await run(h)
    expect(h.logs.some((l) => l.event === 'buyer_click_hold_record_failed' && l.hold_outcome === 'not_recorded')).toBe(true)
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
    ['an alert percent of zero', { alert_over_percent: 0 }, undefined, 'alert_over_percent_invalid'],
    ['an alert percent past 1000', { alert_over_percent: 1001 }, undefined, 'alert_over_percent_invalid'],
    ['an alert percent that is a fraction', { alert_over_percent: 1.5 }, undefined, 'alert_over_percent_invalid'],
    ['an alert percent that is a numeric string', { alert_over_percent: '120' }, undefined, 'alert_over_percent_invalid'],
    ['an empty prospect id', { prospect_id: '{{trigger.payload.missing}}' }, undefined, 'prospect_id_empty'],
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

/**
 * The profile the node reads (Dan, 2026-09-30): the enabled profile from the one
 * cached snapshot, as buyer_select and buyer_click_check read it, and only when the
 * buyer is not in it, the switched off profile the same snapshot carries, for a
 * profile switched off after its offers went out (#1849: it used to be a row read
 * with no copy behind it). The reads through the real client are in
 * lib/__tests__/buyer-profile-switched-off.test.ts.
 */
describe('readClickProfile', () => {
  const DELIVERY: ClickDelivery = { routes: [{ name: 'ALL', url: 'https://a.example/x', states: [] }], successPattern: '(?<id>\\w+)' }
  const DOC = { routes: DELIVERY.routes, success_pattern: DELIVERY.successPattern }
  const enabledBuyer = { partner: { id: PARTNER_ID }, profile: { dailyLeadCap: 50, soldOn: 'click' as const, clickDelivery: DELIVERY } }

  it('an enabled buyer is answered from the snapshot', async () => {
    const r = await readClickProfile(PARTNER_ID, async () => ({ buyers: [enabledBuyer], switched_off: [] }))
    expect(r).toEqual({ found: true, enabled: true, cap: 50, soldOn: 'click', clickDelivery: DELIVERY })
  })

  it('a buyer the snapshot holds as switched off is answered with its delivery, and no cap', async () => {
    const r = await readClickProfile(PARTNER_ID, async () => ({ buyers: [], switched_off: [{ partner_id: PARTNER_ID, sold_on: 'click', click_delivery: DOC }] }))
    expect(r).toEqual({ found: true, enabled: false, cap: null, soldOn: 'click', clickDelivery: DELIVERY })
  })

  it('a buyer the snapshot holds in neither list is not found', async () => {
    expect(await readClickProfile(PARTNER_ID, async () => ({ buyers: [], switched_off: [] }))).toEqual({ found: false })
  })

  it('a snapshot read that fails throws, so the click is refused as profile_unreadable rather than guessed', async () => {
    await expect(readClickProfile(PARTNER_ID, async () => { throw new Error('kv and database both down') })).rejects.toThrow(/down/)
  })
})
