/**
 * A lead validation step that cannot read its configuration pages ONCE per
 * incident, and sends an all clear once it reads it whole again (#2589).
 *
 * The fault arrives at the lead rate (every lead reaching the step fails the
 * same way), so the per run page is suppressed and this reporter decides. The
 * clock is injected; nothing waits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LEAD_VALIDATION_CONFIG_SIGNAL,
  LEAD_VALIDATION_RECOVERY_WORDS,
  SIGHTING_REFRESH_MS,
  leadValidationSubject,
  reportLeadValidationEvent,
  type LeadValidationAlertDeps,
  type LeadValidationRun,
} from '../lead-validation-config-alert'
import { activeKey, recoveryKey, RECOVERY_REARM_MINUTES } from '../alert-recovery'
import { INCIDENT_OUTBOX_PREFIX } from '../incident-outbox'
import { incidentSignal } from '../incident-signals'
import type { AlertClaims } from '../alert-claim'
import { CONFIG_FAULT_WORDS, LeadValidationConfigFault, LeadValidationMissingValue, type LeadValidationEvent } from '../../engine/nodes/lead-validation'
import { sendLeadValidationConfigAlert } from '../slack'
import { slackOk, slackPostOf } from '../../__tests__/helpers/slack-fetch'

const WF = '0b6f6c1e-2a43-4c35-9a9e-3d1c55b7a001'
const RUN: LeadValidationRun = { orgId: '7c1d1a52-9f0e-4c58-8a37-0f4f3b9f2e10', workflowId: WF, workflowName: 'RML - Bidding Workflow (GigFi)', slackChannel: null }
const FAULT: LeadValidationEvent = {
  kind: 'config_fault',
  namespace: 'validate_bidding_and_state',
  faults: [{ check_id: 'amount', reference: 'steps.constants.output.maximumLoanAmount', problem: 'missing' }],
}
const EVALUATED: LeadValidationEvent = { kind: 'evaluated', namespace: 'validate_bidding_and_state' }
const SUBJECT = leadValidationSubject(WF, 'validate_bidding_and_state')

function makeKv() {
  const store = new Map<string, string>()
  const puts: string[] = []
  return {
    store,
    puts,
    kv: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => {
        puts.push(k)
        store.set(k, v)
      }),
      delete: vi.fn(async (k: string) => {
        store.delete(k)
      }),
    },
  }
}

/** A claim object honouring its keys and their TTL, as the Durable Object does. */
function makeClaims(now: () => number): AlertClaims & { held: Map<string, number> } {
  const held = new Map<string, number>()
  return {
    held,
    claim: vi.fn(async (key: string, ttlSeconds: number) => {
      const until = held.get(key)
      if (until !== undefined && until > now()) return false
      held.set(key, now() + ttlSeconds * 1000)
      return true
    }),
    release: vi.fn(async (key: string) => {
      held.delete(key)
    }),
  }
}

function harness(over: Partial<LeadValidationAlertDeps> = {}) {
  const { kv, store, puts } = makeKv()
  let now = Date.parse('2026-10-21T15:00:00Z')
  const claims = makeClaims(() => now)
  const sendPage = vi.fn(async () => true)
  const sendAllClear = vi.fn(async () => true)
  const lines: string[] = []
  const deps: LeadValidationAlertDeps = {
    kv,
    claims,
    resolveSlack: async () => ({ bot_token: 'xoxb', default_channel: '#alerts' }),
    sendPage,
    sendAllClear,
    now: () => now,
    silent: false,
    appUrl: 'https://app.test',
    log: (l) => lines.push(l),
    ...over,
  }
  return {
    deps, kv, store, puts, claims, sendPage, sendAllClear, lines,
    advance: (ms: number) => { now += ms },
    outbox: () => [...store.entries()].filter(([k]) => k.startsWith(INCIDENT_OUTBOX_PREFIX)).map(([, v]) => JSON.parse(v) as { type: string; signal: string; subject: string }),
  }
}

describe('a configuration fault pages once per incident, never once per lead', () => {
  it('the first fault pages, opens the incident and records the page', async () => {
    const h = harness()
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('paged')
    expect(h.sendPage).toHaveBeenCalledTimes(1)
    expect(h.sendPage.mock.calls[0]).toEqual([
      { bot_token: 'xoxb', default_channel: '#alerts' },
      '#alerts',
      {
        workflow_id: WF,
        workflow_name: 'RML - Bidding Workflow (GigFi)',
        namespace: 'validate_bidding_and_state',
        faults: FAULT.kind === 'config_fault' ? FAULT.faults : [],
        app_url: 'https://app.test',
      },
    ])
    expect(h.store.get(recoveryKey(LEAD_VALIDATION_CONFIG_SIGNAL, SUBJECT))).toBe('2026-10-21T15:00:00.000Z')
    expect(h.outbox().map((e) => e.type)).toEqual(['opened', 'paged'])
    expect(h.outbox()[0]).toMatchObject({ signal: LEAD_VALIDATION_CONFIG_SIGNAL, subject: SUBJECT })
  })

  it('a hundred leads failing the same way page once', async () => {
    const h = harness()
    const outcomes: string[] = []
    for (let i = 0; i < 100; i++) {
      outcomes.push(await reportLeadValidationEvent(h.deps, RUN, FAULT))
      h.advance(500)
    }
    expect(h.sendPage).toHaveBeenCalledTimes(1)
    expect(outcomes.filter((o) => o === 'paged')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'incident_open')).toHaveLength(99)
  })

  it('two isolates seeing it at once page once: the claim decides', async () => {
    const h = harness()
    const [a, b] = await Promise.all([reportLeadValidationEvent(h.deps, RUN, FAULT), reportLeadValidationEvent(h.deps, RUN, FAULT)])
    expect([a, b].sort()).toEqual(['claimed_elsewhere', 'paged'])
    expect(h.sendPage).toHaveBeenCalledTimes(1)
  })

  it('keeps the incident\'s running end, writing it at most once a minute however fast leads arrive', async () => {
    const h = harness()
    await reportLeadValidationEvent(h.deps, RUN, FAULT)
    const writesOf = (k: string) => h.puts.filter((p) => p === k).length
    const active = activeKey(LEAD_VALIDATION_CONFIG_SIGNAL, SUBJECT)
    expect(writesOf(active)).toBe(1)
    for (let i = 0; i < 30; i++) {
      h.advance(1_000)
      await reportLeadValidationEvent(h.deps, RUN, FAULT)
    }
    expect(writesOf(active)).toBe(1)
    h.advance(SIGHTING_REFRESH_MS)
    await reportLeadValidationEvent(h.deps, RUN, FAULT)
    expect(writesOf(active)).toBe(2)
  })

  it('a different step of the same workflow is its own incident', async () => {
    const h = harness()
    await reportLeadValidationEvent(h.deps, RUN, FAULT)
    expect(await reportLeadValidationEvent(h.deps, RUN, { ...FAULT, namespace: 'second_check' })).toBe('paged')
    expect(h.sendPage).toHaveBeenCalledTimes(2)
  })

  it('a page Slack refused is not an incident: the claim is freed and the next lead tries again', async () => {
    const h = harness()
    h.sendPage.mockResolvedValueOnce(false)
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('post_failed')
    expect(h.store.get(recoveryKey(LEAD_VALIDATION_CONFIG_SIGNAL, SUBJECT))).toBeUndefined()
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('paged')
  })

  it('a page that threw may have reached Slack, so its claim is kept and the next lead does not repeat it', async () => {
    const h = harness()
    h.sendPage.mockRejectedValueOnce(new Error('socket hang up'))
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('post_failed')
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('claimed_elsewhere')
    expect(h.sendPage).toHaveBeenCalledTimes(1)
  })

  it('an organization with no Slack is logged, not marked', async () => {
    const h = harness({ resolveSlack: async () => null })
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('no_slack')
    expect(h.store.size).toBe(0)
    expect(h.claims.held.size).toBe(0)
  })

  it('a test run logs the fault and touches nothing else', async () => {
    const h = harness({ silent: true })
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('logged')
    expect(await reportLeadValidationEvent(h.deps, RUN, EVALUATED)).toBe('logged')
    expect(h.kv.get).not.toHaveBeenCalled()
    expect(h.kv.put).not.toHaveBeenCalled()
    expect(h.sendPage).not.toHaveBeenCalled()
    expect(h.lines[0]).toBe(
      `[lead-validation] event=config_fault workflow=${WF} step=validate_bidding_and_state faults=amount:steps.constants.output.maximumLoanAmount:missing silent=true`,
    )
  })
})

describe('the all clear', () => {
  it('a step reading its configuration with no incident open sends nothing and writes nothing', async () => {
    const h = harness()
    expect(await reportLeadValidationEvent(h.deps, RUN, EVALUATED)).toBe('nothing_due')
    expect(h.kv.put).not.toHaveBeenCalled()
    expect(h.sendAllClear).not.toHaveBeenCalled()
  })

  it('is held while the fault was seen inside the re-arm window, then sent once, and the next fault is a new incident', async () => {
    const h = harness()
    await reportLeadValidationEvent(h.deps, RUN, FAULT)
    h.advance(60_000)
    expect(await reportLeadValidationEvent(h.deps, RUN, EVALUATED)).toBe('nothing_due')
    expect(h.sendAllClear).not.toHaveBeenCalled()

    h.advance(RECOVERY_REARM_MINUTES * 60_000)
    expect(await reportLeadValidationEvent(h.deps, RUN, EVALUATED)).toBe('all_clear')
    expect(h.sendAllClear).toHaveBeenCalledTimes(1)
    expect(h.sendAllClear.mock.calls[0]).toEqual([
      { bot_token: 'xoxb', default_channel: '#alerts' },
      '#alerts',
      {
        signal: LEAD_VALIDATION_RECOVERY_WORDS,
        subject: 'RML - Bidding Workflow (GigFi): validate_bidding_and_state',
        alertedAt: '2026-10-21T15:00:00.000Z',
        endedAt: '2026-10-21T15:00:00.000Z',
        recoveredPhrase: 'reads every setting its checks need again',
        url: `https://app.test/workflows/${WF}`,
      },
    ])
    expect(h.store.get(recoveryKey(LEAD_VALIDATION_CONFIG_SIGNAL, SUBJECT))).toBeUndefined()
    expect(h.outbox().map((e) => e.type)).toEqual(['opened', 'paged', 'ended'])

    expect(await reportLeadValidationEvent(h.deps, RUN, EVALUATED)).toBe('nothing_due')
    expect(await reportLeadValidationEvent(h.deps, RUN, FAULT)).toBe('paged')
    expect(h.sendPage).toHaveBeenCalledTimes(2)
  })
})

describe('the page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('names the workflow, the step, each check and its setting, and never a value', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => slackOk({ ts: '1.2' }))
    vi.stubGlobal('fetch', fetchMock)
    const delivered = await sendLeadValidationConfigAlert({ bot_token: 'xoxb' }, '#rml', {
      workflow_id: WF,
      workflow_name: 'RML - Bidding Workflow (GigFi)',
      namespace: 'validate_bidding_and_state',
      faults: [
        { check_id: 'amount', reference: 'steps.constants.output.maximumLoanAmount', problem: 'not_a_number' },
        { check_id: null, reference: null, problem: 'config_invalid', detail: 'No checks set' },
      ],
      app_url: 'https://app.test',
    })
    expect(delivered).toBe(true)
    const post = await slackPostOf(fetchMock.mock.calls[0])
    const text = JSON.stringify(post.blocks)
    expect(post.channel).toBe('#rml')
    expect(text).toContain('Lead Validation Setting Missing')
    expect(text).toContain('RML - Bidding Workflow (GigFi)')
    expect(text).toContain('Check `amount` reads `steps.constants.output.maximumLoanAmount`, which is not a number')
    expect(text).toContain("The step's settings cannot be run: No checks set")
    expect(text).toContain(`https://app.test/workflows/${WF}`)
  })
})

describe('one wording for a fault, wherever it is read', () => {
  it('the page, the run\'s failure message and a lead value that cannot be judged say each problem the same way', async () => {
    for (const problem of ['missing', 'not_a_number', 'not_a_list'] as const) {
      const words = CONFIG_FAULT_WORDS[problem]
      const fault = { check_id: 'c', reference: 'steps.constants.output.k', problem }
      expect(new LeadValidationConfigFault('v', [fault]).message).toBe(`Lead validation setting missing: check c reads steps.constants.output.k, which ${words}`)
      expect(new LeadValidationMissingValue('c', 'trigger.payload.x', problem).message).toBe(`Lead validation check c could not be judged: trigger.payload.x ${words}`)

      const fetchMock = vi.fn().mockImplementation(async () => slackOk({ ts: '1.2' }))
      vi.stubGlobal('fetch', fetchMock)
      await sendLeadValidationConfigAlert({ bot_token: 'xoxb' }, '#rml', { workflow_id: WF, workflow_name: 'W', namespace: 'v', faults: [fault], app_url: 'https://app.test' })
      expect(JSON.stringify((await slackPostOf(fetchMock.mock.calls[0])).blocks)).toContain(`Check \`c\` reads \`steps.constants.output.k\`, which ${words}`)
      vi.unstubAllGlobals()
    }
  })
})

describe('the incident signal', () => {
  it('is registered as the organization\'s, keyed on the workflow, judging a state, named as its all clear names it', () => {
    expect(incidentSignal(LEAD_VALIDATION_CONFIG_SIGNAL)).toMatchObject({ scope: 'org', subject: 'workflow', windowMinutes: null })
    expect(incidentSignal(LEAD_VALIDATION_CONFIG_SIGNAL).label.toLowerCase()).toBe(LEAD_VALIDATION_RECOVERY_WORDS)
    expect(SUBJECT.startsWith(WF)).toBe(true)
  })
})
