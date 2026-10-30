/**
 * An answer that arrives whole, but late (#3128).
 *
 * #2862 set the Achieve step's floor (ACHIEVE_MIN_WAIT_MS) to 4 s, so a step
 * starting more than 7.5 s after the answer skips the lead, and the gate saw no
 * difference, because no fixture had Achieve start late. A stub answer can now
 * carry `arrivesAfterMs`: the whole answer, after that much of the replay's own
 * time, so the Salesforce write through the Pipedream outcome relay before Achieve
 * can be slow and the pinned clock moves on with it, with nothing waiting for real.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PIPEDREAM_OUTCOME_RELAY_HOST, answerFetch, codeBundleRefusal, stubAnswer, type StubAnswer, type StubRequest, type WaitOnReplayTime } from '../stub-rules'
import { liftEngineTimers, type TimerHost } from '../engine-timers'
import { ACHIEVE_MIN_WAIT_MS, ACHIEVE_WINDOW_MARGIN_MS, achieveWait } from '../../../src/engine/nodes/achieve-offers'
import { CONTINUATION_WINDOW_MS } from '../../../src/lib/post-response-budget'
import type { VariantFile } from '../../harness/replay-env'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', '..', 'fixtures')
const mainFlow = JSON.parse(readFileSync(join(fixtures, 'variants', 'main-flow.json'), 'utf8')) as VariantFile
interface DefNode { id: string; namespace: string; type: string; config: Record<string, unknown> }
interface DefFile { definition: { nodes: DefNode[]; edges: Array<{ source: string; target: string }> } }
const mainFlowDefinition = (JSON.parse(readFileSync(join(fixtures, 'definitions', `${mainFlow.workflow_id}.json`), 'utf8')) as DefFile).definition

const post = (url: string): StubRequest => ({ method: 'POST', url: new URL(url), headers: {}, body: {} })
const outcomeRelay = post(`https://${PIPEDREAM_OUTCOME_RELAY_HOST}/`)
const answerOf = (scenario: string): StubAnswer => stubAnswer(outcomeRelay, { pipedream_outcome_post: scenario })!.answer

/** A wait that records what it was asked, answering each timed wait as elapsed unless the signal already aborted. */
function recordingWait(): { wait: WaitOnReplayTime; asked: Array<number | undefined> } {
  const asked: Array<number | undefined> = []
  const wait: WaitOnReplayTime = (signal, ms) => {
    asked.push(ms)
    return Promise.resolve(signal.aborted ? 'aborted' : 'elapsed')
  }
  return { wait, asked }
}

describe('the outcome relay answering late (#3128)', () => {
  it('has a scenario on each side of the Achieve cutoff, each the whole ok answer arriving late', () => {
    expect(answerOf('ok_after_7500ms')).toMatchObject({ status: 200, arrivesAfterMs: 7_500 })
    expect(answerOf('ok_after_7501ms')).toMatchObject({ status: 200, arrivesAfterMs: 7_501 })
    expect(answerOf('ok_after_7500ms').body).toEqual(answerOf('ok').body)
    expect(answerOf('ok_after_7500ms').ending).toBeUndefined()
    expect(answerOf('ok').arrivesAfterMs).toBeUndefined()
  })

  it('slows only the outcome relay, never the inquiry relay that runs before the answer', () => {
    const inquiry = stubAnswer(post('https://eo7mbko7xf69i3x.m.pipedream.net/'), { pipedream_outcome_post: 'ok_after_7501ms', pipedream: 'failed' })!
    expect(inquiry.rule).toBe('pipedream')
    expect(inquiry.answer).toMatchObject({ status: 500 })
    expect(inquiry.answer.arrivesAfterMs).toBeUndefined()
    // The outcome relay is answered by its own rule, whatever the catch all is set to.
    expect(stubAnswer(outcomeRelay, { pipedream: 'failed' })!.rule).toBe('pipedream_outcome_post')
  })

  it('the step just before achieve_tripoint_win in the Main Flow fixture posts to the outcome relay, so the late answer is what makes Achieve start late', () => {
    const { nodes, edges } = mainFlowDefinition
    const achieve = nodes.find((n) => n.namespace === 'achieve_tripoint_win')!
    const before = edges.filter((e) => e.target === achieve.id).map((e) => nodes.find((n) => n.id === e.source)!)
    expect(before.map((n) => [n.namespace, n.type])).toEqual([['tripoint_sf_post', 'webhook']])
    const hit = stubAnswer(post(String(before[0].config.url)), { pipedream_outcome_post: 'ok_after_7500ms' })!
    expect(hit.rule).toBe('pipedream_outcome_post')
    expect(hit.answer.arrivesAfterMs).toBe(7_500)
  })

  it('the two delays straddle the Achieve cutoff the head engine computes, so a change to the floor, the margin or the window moves one of them across it', () => {
    const cutoff = CONTINUATION_WINDOW_MS - ACHIEVE_WINDOW_MARGIN_MS - ACHIEVE_MIN_WAIT_MS
    expect(answerOf('ok_after_7500ms').arrivesAfterMs).toBe(cutoff)
    expect(answerOf('ok_after_7501ms').arrivesAfterMs).toBe(cutoff + 1)
    expect(achieveWait(CONTINUATION_WINDOW_MS - 7_500).send).toBe(true)
    expect(achieveWait(CONTINUATION_WINDOW_MS - 7_501).send).toBe(false)
  })

  it('Main Flow replays a Tripoint win with each late relay answer, as a live run only, with the Achieve screen open', () => {
    const late = mainFlow.variants.filter((v) => /^ok_after_/.test(v.stubs?.pipedream_outcome_post ?? ''))
    expect(late.map((v) => [v.name, v.stubs?.pipedream_outcome_post, v.stubs?.tripoint_create])).toEqual([
      ['achieve_starts_7500ms_after_answer', 'ok_after_7500ms', 'accepted'],
      ['achieve_starts_7501ms_after_answer', 'ok_after_7501ms', 'accepted'],
    ])
    for (const v of late) {
      // A test run has no window (continuationMsLeft is unset), so it could not see the cutoff.
      expect(v.also_run_as).toBeUndefined()
      // The lead reaches the window through the Achieve screen as the snapshot has it and
      // with the phone the generator gives it (#3138), so neither is overridden here.
      expect(v.env).toBeUndefined()
      expect(v.set).toBeUndefined()
    }
  })
})

describe('answerFetch with an answer that arrives late (#3128)', () => {
  it('waits exactly arrivesAfterMs on the replay time, then gives the whole answer', async () => {
    const { wait, asked } = recordingWait()
    const res = await answerFetch(answerOf('ok_after_7500ms'), new AbortController().signal, wait)
    expect(asked).toEqual([7_500])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })

  it('rejects with the signal\'s own reason when the request is aborted before the answer arrives', async () => {
    const controller = new AbortController()
    controller.abort()
    const err = await answerFetch(answerOf('ok_after_7500ms'), controller.signal, recordingWait().wait).catch((e: unknown) => e)
    expect(err).toBe(controller.signal.reason)
  })

  it('still waits for a request sent with no signal, since only the time ends the wait', async () => {
    const { wait, asked } = recordingWait()
    const res = await answerFetch(answerOf('ok_after_7501ms'), undefined, wait)
    expect(asked).toEqual([7_501])
    expect(res.status).toBe(200)
  })

  it('refuses by name an answer that is both late and fails to arrive whole', async () => {
    const both: StubAnswer = { ...answerOf('ok_after_7500ms'), ending: 'no_headers' }
    await expect(answerFetch(both, new AbortController().signal, recordingWait().wait)).rejects.toThrow('arrivesAfterMs')
  })

  it('under the gate\'s lift, moves the pinned clock on by exactly the delay, with nothing waiting for real', async () => {
    const moved: number[] = []
    const lift = liftEngineTimers(globalThis as unknown as TimerHost, { onAdvance: (ms) => { moved.push(ms) } })
    const started = performance.now()
    try {
      const res = await answerFetch(answerOf('ok_after_7501ms'), new AbortController().signal, (s, ms) => lift.waitFor(s, ms))
      expect(res.status).toBe(200)
      expect(moved).toEqual([7_501])
      expect(lift.fired()).toEqual([])
    } finally {
      lift.restore()
    }
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})

describe('codeBundleRefusal of a late answer (#3128)', () => {
  it('refuses a late answer for a code bundle, whose timers the lift cannot reach', () => {
    const hit = stubAnswer(outcomeRelay, { pipedream_outcome_post: 'ok_after_7500ms' })!
    const text = codeBundleRefusal(hit, 'Main Flow/x')
    expect(text).toContain('Main Flow/x')
    expect(text).toContain('pipedream_outcome_post/ok_after_7500ms')
  })
})
