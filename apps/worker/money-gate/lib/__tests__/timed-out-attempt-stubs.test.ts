/**
 * A Salesforce write before Achieve whose first attempts time out (#3138).
 *
 * #3128 made the Achieve step start late with one slow answer, which production
 * cannot produce: the outcome relay post (tripoint_sf_post) gives each attempt
 * 3,750 ms and retries twice after a 500 ms and then a 1 s backoff. What makes
 * Achieve start late in production is attempts timing out and the retries after
 * them. A stub scenario can now answer each attempt of one request differently,
 * and the replay runs the engine's own retry ladder on its own time: each
 * attempt's deadline and each backoff (the engine's step clock seam, #2163), so a
 * timed out attempt and its retry move the pinned clock exactly as production's
 * would, with nothing waiting for real.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PIPEDREAM_OUTCOME_RELAY_HOST, answerFetch, codeBundleRefusal, stubAnswer, type StubRequest } from '../stub-rules'
import { liftEngineTimers, type TimerHost } from '../engine-timers'
import { withRetry } from '../../../src/engine/retry'
import { classifyStepError } from '../../../src/engine/error-classifier'
import { achieveWait, ACHIEVE_FETCH_TIMEOUT_MS } from '../../../src/engine/nodes/achieve-offers'
import { CONTINUATION_WINDOW_MS } from '../../../src/lib/post-response-budget'
import type { VariantFile } from '../../harness/replay-env'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', 'fixtures')
const mainFlow = JSON.parse(readFileSync(join(fixtures, 'variants', 'main-flow.json'), 'utf8')) as VariantFile
interface DefNode { namespace: string; type: string; config: Record<string, unknown> }
const mainFlowNodes = (JSON.parse(readFileSync(join(fixtures, 'definitions', `${mainFlow.workflow_id}.json`), 'utf8')) as { definition: { nodes: DefNode[] } }).definition.nodes
const relayPost = mainFlowNodes.find((n) => n.namespace === 'tripoint_sf_post')!

const outcomeRelay: StubRequest = { method: 'POST', url: new URL(`https://${PIPEDREAM_OUTCOME_RELAY_HOST}/`), headers: {}, body: {} }

/**
 * The relay post's retry ladder as the engine runs it (withRetry, with the step's
 * own retries and deadline), each attempt answered by `scenario` through the
 * replay's fetch path, all on the replay's time. Returns where the replay's time
 * ended and how many retries the ladder used.
 */
async function replayRelayPost(scenario: string): Promise<{ endedAtMs: number; retries: number; status: number }> {
  let endedAtMs = 0
  const lift = liftEngineTimers(globalThis as unknown as TimerHost, { onAdvance: (ms) => { endedAtMs = ms } })
  const attempts = new Map<string, number>()
  const stats = { retries: 0 }
  try {
    const res = await withRetry(
      (signal) => answerFetch(stubAnswer(outcomeRelay, { pipedream_outcome_post: scenario }, attempts)!.answer, signal, (s, ms) => lift.waitFor(s, ms)),
      { retries: Number(relayPost.config.retries), backoff: 'exponential', timeout_ms: Number(relayPost.config.timeout_ms) },
      classifyStepError,
      stats,
      lift.stepClock.sleep,
      lift.stepClock.timer,
    )
    expect(lift.fired()).toEqual([])
    return { endedAtMs, retries: stats.retries, status: res.status }
  } finally {
    lift.restore()
  }
}

describe('the outcome relay timing out and answering a retry (#3138)', () => {
  it('answers each attempt of one request as the scenario says, counting only the requests its own rule answered', () => {
    const attempts = new Map<string, number>()
    const arms = { pipedream_outcome_post: 'no_answer_twice_then_ok' }
    const first = stubAnswer(outcomeRelay, arms, attempts)!
    // Another rule's request between attempts does not count as one.
    stubAnswer({ ...outcomeRelay, url: new URL('https://eo7mbko7xf69i3x.m.pipedream.net/') }, arms, attempts)
    const second = stubAnswer(outcomeRelay, arms, attempts)!
    const third = stubAnswer(outcomeRelay, arms, attempts)!
    expect([first.answer.ending, second.answer.ending, third.answer.ending]).toEqual(['no_headers', 'no_headers', undefined])
    expect(third.answer).toMatchObject({ status: 200, body: { success: true } })
    expect(stubAnswer(outcomeRelay, { pipedream_outcome_post: 'no_answer_then_ok' }, new Map())!.answer.ending).toBe('no_headers')
  })

  it('answers as the first attempt when no count is kept, as a code bundle\'s outbound service does', () => {
    expect(stubAnswer(outcomeRelay, { pipedream_outcome_post: 'no_answer_then_ok' })!.answer.ending).toBe('no_headers')
    expect(stubAnswer(outcomeRelay, { pipedream_outcome_post: 'no_answer_then_ok' })!.answer.ending).toBe('no_headers')
  })

  it('a code bundle is refused the first attempt by name, as any answer that does not arrive whole is', () => {
    const hit = stubAnswer(outcomeRelay, { pipedream_outcome_post: 'no_answer_then_ok' })!
    expect(codeBundleRefusal(hit, 'Main Flow/x')).toContain('pipedream_outcome_post/no_answer_then_ok')
  })

  it('the step the fixtures slow is the relay post, with the deadline and retries production gives it', () => {
    expect(relayPost).toMatchObject({ type: 'webhook', config: { url: `https://${PIPEDREAM_OUTCOME_RELAY_HOST}`, retries: 2, timeout_ms: 3750 } })
  })

  it('one timed out attempt and its retry end 4,250 ms in, the deadline and the first backoff, so Achieve still sends with what is left of the window', async () => {
    const run = await replayRelayPost('no_answer_then_ok')
    expect(run).toEqual({ endedAtMs: 3_750 + 500, retries: 1, status: 200 })
    const wait = achieveWait(CONTINUATION_WINDOW_MS - run.endedAtMs)
    expect(wait).toMatchObject({ send: true, shortened: true })
    expect(wait.waitMs).toBeLessThan(ACHIEVE_FETCH_TIMEOUT_MS)
  })

  it('two timed out attempts and a third that answers end 9,000 ms in, so Achieve skips the lead as the window spent', async () => {
    const run = await replayRelayPost('no_answer_twice_then_ok')
    expect(run).toEqual({ endedAtMs: 3_750 + 500 + 3_750 + 1_000, retries: 2, status: 200 })
    expect(achieveWait(CONTINUATION_WINDOW_MS - run.endedAtMs).send).toBe(false)
  })

  it('Main Flow replays each, keeping only the relay post\'s own deadline, as a live run with the screen as the snapshot has it', () => {
    const timed = mainFlow.variants.filter((v) => /^no_answer_/.test(v.stubs?.pipedream_outcome_post ?? ''))
    expect(timed.map((v) => [v.name, v.stubs?.pipedream_outcome_post, v.timed_steps])).toEqual([
      ['achieve_starts_after_a_timed_out_relay_attempt', 'no_answer_then_ok', ['tripoint_sf_post']],
      ['achieve_skips_after_two_timed_out_relay_attempts', 'no_answer_twice_then_ok', ['tripoint_sf_post']],
    ])
    for (const v of timed) {
      expect(v.also_run_as).toBeUndefined()
      expect(v.env).toBeUndefined()
      expect(v.set).toBeUndefined()
    }
  })
})
