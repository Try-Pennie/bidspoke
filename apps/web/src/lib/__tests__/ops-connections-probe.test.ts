/**
 * .github/scripts/ops-connections-probe.mjs (#2335, PR 9 of phase 5): after the
 * Workers deploy, a real call through the bidding Worker's OPS_CONNECTIONS
 * binding, made by the deployed bidding Worker itself (GET
 * /api/admin/ops-connections-probe, signed in as the e2e user), and the run
 * fails unless it is answered. Cloudflare deploys a binding to a missing
 * entrypoint green and every call then throws (spike #2330), so this is the
 * check that the deploy really works.
 *
 * Clock, sleep and network are injected (L290, L524). Each outcome has its own
 * sentence (L11): answered passes; unexpected and not-signed-in fail at once;
 * unavailable, route-missing and unreachable are asked again until the budget,
 * because a new version reaches every edge over a few seconds.
 */
import { describe, expect, it } from 'vitest'
import { probeAfterDeploy, PROBE_PATH } from '../../../../../.github/scripts/ops-connections-probe.mjs'

type Answer = { status: number; body: unknown } | Error

function deps(answers: Answer[], opts: { budgetSeconds?: number; intervalSeconds?: number; signIn?: () => Promise<string> } = {}) {
  let clock = 0
  const asked: Array<{ url: string; token: string }> = []
  const slept: number[] = []
  let i = 0
  return {
    asked,
    slept,
    deps: {
      workerUrl: 'https://bidspoke-worker.example.workers.dev/',
      budgetSeconds: opts.budgetSeconds ?? 120,
      intervalSeconds: opts.intervalSeconds ?? 10,
      signIn: opts.signIn ?? (async () => 'session-access-token-value'),
      fetchProbe: async (url: string, token: string) => {
        asked.push({ url, token })
        const a = answers[Math.min(i++, answers.length - 1)]
        if (a instanceof Error) throw a
        return a
      },
      now: () => clock,
      sleep: async (ms: number) => { slept.push(ms); clock += ms },
    },
  }
}

const ANSWERED = { status: 200, body: { ok: true, method: 'health', answer: 'ops_connections_request_invalid' } }
const THREW = { status: 503, body: { error: 'ops_connections_unavailable', method: 'health', cause: 'threw', reference: '7a1c9e2b0d4f', message: 'x' } }

describe('probeAfterDeploy', () => {
  it('passes on the expected answer, asking the probe route of the deployed Worker with the session token', async () => {
    const { deps: d, asked } = deps([ANSWERED])
    const result = await probeAfterDeploy(d)
    expect(result.outcome).toBe('answered')
    expect(asked).toEqual([{ url: `https://bidspoke-worker.example.workers.dev${PROBE_PATH}`, token: 'session-access-token-value' }])
    expect(PROBE_PATH).toBe('/api/admin/ops-connections-probe')
  })

  it('asks again while the old version, which has no probe route, still answers', async () => {
    const { deps: d, slept } = deps([{ status: 404, body: { error: 'Not Found' } }, { status: 404, body: null }, ANSWERED])
    expect((await probeAfterDeploy(d)).outcome).toBe('answered')
    expect(slept).toEqual([10_000, 10_000])
  })

  it('fails, naming the cause and the reference, when the binding still throws at the end of the budget', async () => {
    const { deps: d, asked } = deps([THREW], { budgetSeconds: 30, intervalSeconds: 10 })
    const result = await probeAfterDeploy(d)
    expect(result.outcome).toBe('unavailable')
    expect(result.message).toContain('threw')
    expect(result.message).toContain('7a1c9e2b0d4f')
    expect(result.message).not.toMatch(/\b(down|offline|outage)\b/i)
    expect(asked.length).toBe(4)
  })

  it('passes once a throwing binding starts answering (the wrong order window ends)', async () => {
    const { deps: d } = deps([THREW, THREW, ANSWERED])
    expect((await probeAfterDeploy(d)).outcome).toBe('answered')
  })

  it('fails at once when ops answers something else, since that is its config, not propagation', async () => {
    const { deps: d, asked } = deps([{ status: 502, body: { error: 'ops_connections_probe_unexpected', answer: 'lane_not_ops' } }, ANSWERED])
    const result = await probeAfterDeploy(d)
    expect(result.outcome).toBe('unexpected')
    expect(result.message).toContain('lane_not_ops')
    expect(asked.length).toBe(1)
  })

  it('fails at once on a 200 that is not the expected answer', async () => {
    const { deps: d } = deps([{ status: 200, body: { ok: true, answer: 'something_else' } }])
    expect((await probeAfterDeploy(d)).outcome).toBe('unexpected')
  })

  it.each([401, 403])('fails at once as not signed in on %i, having measured nothing', async (status) => {
    const { deps: d } = deps([{ status, body: { error: 'Unauthorized' } }])
    const result = await probeAfterDeploy(d)
    expect(result.outcome).toBe('not-signed-in')
    expect(result.message).toMatch(/measured nothing/)
  })

  it('fails as not signed in when the sign in itself fails, asking nothing', async () => {
    const { deps: d, asked } = deps([ANSWERED], { signIn: async () => { throw new Error('the auth API answered 400') } })
    const result = await probeAfterDeploy(d)
    expect(result.outcome).toBe('not-signed-in')
    expect(asked).toEqual([])
  })

  it('reports unreachable when every ask fails on the network', async () => {
    const { deps: d } = deps([new Error('fetch failed')], { budgetSeconds: 20 })
    expect((await probeAfterDeploy(d)).outcome).toBe('unreachable')
  })

  it('names a 5xx that is not the route\'s own as an error answer, with its status', async () => {
    const { deps: d } = deps([{ status: 500, body: { error: 'Internal server error' } }], { budgetSeconds: 20 })
    const result = await probeAfterDeploy(d)
    expect(result.outcome).toBe('error-answer')
    expect(result.message).toContain('last 500')
  })

  it('asks again on a 200 whose body is not the route\'s answer (a page in front of the Worker), never reading it as ops answering', async () => {
    const { deps: d } = deps([{ status: 200, body: null }, ANSWERED])
    expect((await probeAfterDeploy(d)).outcome).toBe('answered')
    const stuck = deps([{ status: 200, body: null }], { budgetSeconds: 20 })
    const result = await probeAfterDeploy(stuck.deps)
    expect(result.outcome).toBe('unrecognised')
    expect(result.message).not.toContain('OpsConnections answered')
  })

  it('is bounded by the clock too: a slow sleep ends it before the count does', async () => {
    const { deps: d, asked } = deps([THREW], { budgetSeconds: 30, intervalSeconds: 10 })
    let clock = 0
    d.now = () => clock
    d.sleep = async () => { clock += 25_000 }
    await probeAfterDeploy(d)
    // The count allows 4 asks; the clock passes 30 s after the second sleep.
    expect(asked.length).toBe(3)
  })

  it('is bounded by a count of asks too, so a clock that never moves cannot spin it', async () => {
    const { deps: d, asked } = deps([THREW], { budgetSeconds: 30, intervalSeconds: 10 })
    d.sleep = async () => {}
    await probeAfterDeploy(d)
    expect(asked.length).toBe(4)
  })
})
