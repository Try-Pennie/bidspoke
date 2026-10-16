/**
 * Doubles for the scheduled Slack lookup tests (#1303): a Supabase client whose
 * reads answer, fail, throw or never answer, a timer the test controls, and a KV
 * holding the encrypted last-good copy of the Slack connections.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptSecret } from '../secret-crypto'
import { SLACK_CONNS_LASTGOOD_KEY } from '../slack-copy'

export const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
export const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))

/** One read's outcome: rows (or one row), an error object, a thrown fetch, or no answer at all. */
export type Answer = { data?: unknown; error?: { message: string; code?: string } } | 'throw' | 'stall'

export interface ReadCall {
  table: string
  /** Whether the read's abort signal fired (only a stalled read is ever aborted). */
  aborted: boolean
  /** What retry() was set to, or undefined when it was never called. */
  retry: boolean | undefined
}

/**
 * A client whose nth read answers with answers[n] (the last repeating). Every
 * builder method the lookups chain returns the builder; awaiting it settles.
 */
export function fakeClient(answers: Answer[]): { client: SupabaseClient; calls: ReadCall[] } {
  const calls: ReadCall[] = []
  let i = 0
  const client = {
    from(table: string) {
      const call: ReadCall = { table, aborted: false, retry: undefined }
      let signal: AbortSignal | undefined
      // A postgrest builder sends nothing until it is awaited, so a read is
      // counted (and takes its answer) only then; a builder made and dropped is no read.
      const settle = (): Promise<unknown> => {
        const answer = answers[Math.min(i, answers.length - 1)]
        i++
        calls.push(call)
        if (answer === 'throw') return Promise.reject(new TypeError('fetch failed'))
        if (answer === 'stall') {
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              call.aborted = true
              reject(new Error('This operation was aborted'))
            }, { once: true })
          })
        }
        return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null, status: answer.error ? 500 : 200 })
      }
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'limit', 'maybeSingle']) builder[m] = () => builder
      builder.retry = (enabled: boolean) => {
        call.retry = enabled
        return builder
      }
      builder.abortSignal = (s: AbortSignal) => {
        signal = s
        return builder
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject)
      return builder
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}

/**
 * The deadline timer. 'never' lets every read answer first (it only ends when the
 * read does); 'now' runs every deadline out at once, so a stalled read is given up.
 */
export function fakeTimers(mode: 'never' | 'now') {
  const asked: number[] = []
  const signals: AbortSignal[] = []
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => {
    asked.push(ms)
    signals.push(signal)
    if (mode === 'now') return Promise.resolve()
    return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  return { sleep, asked, signals }
}

export interface CountingKv {
  get(key: string): Promise<string | null>
  gets: string[]
}

export function kvWith(store: Record<string, string> = {}): CountingKv {
  const gets: string[] = []
  return {
    gets,
    async get(key: string) {
      gets.push(key)
      return store[key] ?? null
    },
  }
}

/** A KV holding a copy of the given connections, encrypted under `key`. */
export async function kvWithCopy(connections: Record<string, unknown>, key: string = TEST_KEY): Promise<CountingKv> {
  return kvWith({ [SLACK_CONNS_LASTGOOD_KEY]: await encryptSecret(JSON.stringify(connections), key) })
}

export const LIVE_CONN = { bot_token: 'xoxb-live', default_channel: '#live' }
export const STORED_CONN = { bot_token: 'xoxb-stored', default_channel: '#stored' }
