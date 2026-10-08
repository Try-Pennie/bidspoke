/**
 * The answer journal (#1883): what a run answered, kept in KV for the strand
 * drain. A journal it cannot trust must read as no journal, never as an answer.
 */
import { describe, it, expect } from 'vitest'
import { putAnswerJournal, readAnswerJournal, ANSWER_JOURNAL_PREFIX, ANSWER_JOURNAL_TTL_SECONDS, type AnswerJournal } from '../unconfirmed-writes'

function kv() {
  const store = new Map<string, string>()
  const ttls = new Map<string, number | undefined>()
  return {
    store,
    ttls,
    async get(k: string) {
      return store.get(k) ?? null
    },
    async put(k: string, v: string, opts?: { expirationTtl?: number }) {
      store.set(k, v)
      ttls.set(k, opts?.expirationTtl)
    },
  }
}

const journal: AnswerJournal = {
  execution_id: 'ex-1',
  started_at: '2026-10-08T12:20:40.000Z',
  status: 'completed',
  outcome: 'completed',
  final_node_namespace: 'reject_response',
  final_node_id: 'node-9',
  completed_at: '2026-10-08T12:20:43.700Z',
  duration_ms: 3700,
  response_status: 200,
  response_body: { status: 'rejected' },
  error_message: null,
  failed_step_type: null,
  written_at: '2026-10-08T12:20:43.701Z',
}

describe('the answer journal', () => {
  it('round trips under the run id, kept at least two days', async () => {
    const store = kv()
    await putAnswerJournal(store, journal)
    expect(store.ttls.get(`${ANSWER_JOURNAL_PREFIX}ex-1`)).toBe(ANSWER_JOURNAL_TTL_SECONDS)
    expect(ANSWER_JOURNAL_TTL_SECONDS).toBeGreaterThanOrEqual(2 * 24 * 60 * 60)
    expect(await readAnswerJournal(store, 'ex-1')).toEqual(journal)
  })

  it('reads as no journal when there is none', async () => {
    expect(await readAnswerJournal(kv(), 'ex-1')).toBeNull()
  })

  it('refuses a value that is not JSON', async () => {
    const store = kv()
    store.store.set(`${ANSWER_JOURNAL_PREFIX}ex-1`, 'not json')
    expect(await readAnswerJournal(store, 'ex-1')).toBeNull()
  })

  it('refuses a journal written for another run', async () => {
    const store = kv()
    store.store.set(`${ANSWER_JOURNAL_PREFIX}ex-1`, JSON.stringify({ ...journal, execution_id: 'ex-2' }))
    expect(await readAnswerJournal(store, 'ex-1')).toBeNull()
  })

  it('refuses a journal whose status, duration or response status is not one the row can hold', async () => {
    const store = kv()
    for (const bad of [{ status: 'running' }, { duration_ms: 'soon' }, { response_status: null }]) {
      store.store.set(`${ANSWER_JOURNAL_PREFIX}ex-1`, JSON.stringify({ ...journal, ...bad }))
      expect(await readAnswerJournal(store, 'ex-1'), JSON.stringify(bad)).toBeNull()
    }
  })

  it('refuses a journal missing its status or completion time', async () => {
    const store = kv()
    const { status: _s, ...noStatus } = journal
    store.store.set(`${ANSWER_JOURNAL_PREFIX}ex-1`, JSON.stringify(noStatus))
    expect(await readAnswerJournal(store, 'ex-1')).toBeNull()
    const { completed_at: _c, ...noCompletion } = journal
    store.store.set(`${ANSWER_JOURNAL_PREFIX}ex-1`, JSON.stringify(noCompletion))
    expect(await readAnswerJournal(store, 'ex-1')).toBeNull()
  })
})
