/**
 * A check whose finding is measured from the database judges nothing on a tick
 * whose org list came from the saved copy (#1303 phase 1, coordinator review).
 *
 * The saved copy lets the list survive a database outage, which is what lets the
 * checks that need no database speak. A check that goes on to read the database
 * per org, though, then judges reads that failed: timeout-audit's reads swallow
 * their errors and return empty, so on an outage tick it recorded an all-clear,
 * and when the database came back it re-alerted an unchanged set as new. Before
 * the copy such a tick had no orgs and judged nothing, so every one of these
 * checks takes its list with 'measure-from-database', which refuses a list the
 * database did not answer. Each is driven here on a scheduled client whose list
 * read fails while the copy holds an org and every other read would answer:
 * it must ask the database nothing after the list and write nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../env'
import { registerScheduledSlack } from '../scheduled-slack'
import { runFailureRateCheck } from '../failure-rate'
import { runSlowExecutionCheck } from '../slow-execution-rate'
import { runUpstreamOutageCheck } from '../upstream-outage'
import { runVolumeAnomalyCheck } from '../volume-anomaly'
import { runTimeoutAuditCheck } from '../timeout-audit'
import { runRequiredEnvVarsCheck } from '../required-env-vars'
import { runBidRecordingCoverageCheck } from '../bid-recording-coverage'
import { runEmailDropRateCheck } from '../email-drop-rate'
import { fakeTimers, kvWithCopy, tableClient, TEST_KEY, type Answer } from './_scheduled-slack-doubles'

const ORG = 'org-1'
const CONN = { bot_token: 'xoxb-stored', default_channel: '#ops', config_alerts_enabled: true, volume_alerts_enabled: true }

/** A KV for the check's own state, recording every write. */
function stateKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed))
  const puts: string[] = []
  return {
    puts,
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { puts.push(k); store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

/** The scheduled client: the list read answers as given, every other read answers `otherwise`. */
async function scheduledClient(list: Answer, otherwise: Answer = { data: [] }) {
  const { client, asked } = tableClient({ service_connections: list }, otherwise)
  // The deadline runs out at once only for a read that never answers.
  registerScheduledSlack(client, { kv: await kvWithCopy({ [ORG]: CONN }), secretKeys: TEST_KEY, sleep: fakeTimers(list === 'stall' ? 'now' : 'never').sleep })
  return { client, asked }
}

let fetchSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, ts: '1' }), { status: 200 }))
})
afterEach(() => vi.restoreAllMocks())

type Run = (client: Parameters<typeof runFailureRateCheck>[0], kv: ReturnType<typeof stateKv>) => Promise<unknown>

const CHECKS: Array<[string, Run]> = [
  ['failure-rate', (c, kv) => runFailureRateCheck(c, kv as never, 'https://app.test')],
  ['slow-execution-rate', (c, kv) => runSlowExecutionCheck(c, kv as never, 'https://app.test')],
  ['upstream-outage', (c, kv) => runUpstreamOutageCheck(c, kv as never, 'https://app.test')],
  ['volume-anomaly', (c) => runVolumeAnomalyCheck(c)],
  ['timeout-audit', (c, kv) => runTimeoutAuditCheck(c, kv as never, 'https://app.test')],
  ['required-env-vars', (c) => runRequiredEnvVarsCheck(c, {} as Env)],
  ['bid-recording-coverage', (c, kv) => runBidRecordingCoverageCheck(c, kv as never, 'https://app.test')],
  ['email-drop-rate', (c, kv) => runEmailDropRateCheck(c, kv as never)],
]

describe('a check measured from the database, on a tick whose org list came from the saved copy', () => {
  it.each(CHECKS)('%s asks the database nothing after the list, writes nothing and posts nothing', async (_name, run) => {
    for (const list of ['stall', 'throw', { error: { message: 'upstream connect error' } }] as Answer[]) {
      const { client, asked } = await scheduledClient(list)
      const kv = stateKv()
      await run(client, kv)
      expect(asked).toEqual(['service_connections'])
      expect(kv.puts).toEqual([])
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each(CHECKS)('%s still reads on when the list answered live (the positive control)', async (_name, run) => {
    const { client, asked } = await scheduledClient({ data: [{ organization_id: ORG }] })
    await run(client, stateKv())
    expect(asked.length).toBeGreaterThan(1)
  })
})

describe('timeout-audit through an outage and back', () => {
  const SEEN = 'timeout-audit:sig:org-1'

  it('does not record an all-clear over a set it alerted, on an outage tick, so the return is not a new alert', async () => {
    const kv = stateKv({ [SEEN]: 'wf-1:node-a' })
    const { client } = await scheduledClient('throw', { error: { message: 'upstream connect error' } })
    await runTimeoutAuditCheck(client, kv as never, 'https://app.test')
    expect(kv.store.get(SEEN)).toBe('wf-1:node-a')
    expect(kv.puts).toEqual([])
  })

  it('does not judge an org whose own reads failed, even with a live list', async () => {
    const kv = stateKv({ [SEEN]: 'wf-1:node-a' })
    const { client, asked } = tableClient(
      { service_connections: { data: [{ organization_id: ORG }] } },
      { error: { message: 'upstream connect error' } },
    )
    registerScheduledSlack(client, { kv: await kvWithCopy({ [ORG]: CONN }), secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    await runTimeoutAuditCheck(client, kv as never, 'https://app.test')
    expect(asked).toContain('workflows')
    expect(kv.store.get(SEEN)).toBe('wf-1:node-a')
    expect(kv.puts).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not judge an org whose step durations could not be read at all', async () => {
    const kv = stateKv({ [SEEN]: 'wf-1:node-a' })
    const workflow = { id: 'wf-1', name: 'Main Flow', definition: { nodes: [{ id: 'n1', namespace: 'node_a', type: 'code', config: {} }], edges: [] } }
    const { client, asked } = tableClient({
      service_connections: { data: [{ organization_id: ORG }] },
      workflows: { data: [workflow] },
      'rpc:step_duration_percentiles_by_workflow': { error: { message: 'canceling statement due to statement timeout' } },
    })
    registerScheduledSlack(client, { kv: await kvWithCopy({ [ORG]: CONN }), secretKeys: TEST_KEY, sleep: fakeTimers('never').sleep })
    await runTimeoutAuditCheck(client, kv as never, 'https://app.test')
    expect(asked).toContain('rpc:step_duration_percentiles_by_workflow')
    expect(kv.puts).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
