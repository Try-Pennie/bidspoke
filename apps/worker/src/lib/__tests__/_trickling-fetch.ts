/**
 * A buyer trickling its answer (#3089), for the tests of postToPartner and of
 * the two nodes that post through it: a fetch whose headers arrive at once and
 * whose body arrives as `chunks`, one every `everyMs`, on whatever clock
 * setTimeout is (a faked one in every test, so nothing waits for real, L524).
 *
 * `honoursAbort` errors the body with the signal's reason when the call's
 * signal aborts, as the platform's fetch does. Without it the body goes on arriving whatever the
 * signal says, so only the call itself can end the wait.
 */
import { vi } from 'vitest'

export function tricklingFetch(chunks: string[], everyMs: number, honoursAbort: boolean) {
  const signals: AbortSignal[] = []
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined
    if (signal) signals.push(signal)
    let next = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Errored with the signal's own reason, as the fetch standard's abort does to a body being read.
        if (honoursAbort) signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      },
      pull(controller) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              controller.enqueue(new TextEncoder().encode(chunks[next]))
              next += 1
              if (next === chunks.length) controller.close()
            } catch {
              // Already errored by the abort: nothing more arrives.
            }
            resolve()
          }, everyMs)
        })
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, signals, calls: fetchImpl }
}

/** Eight chunks five seconds apart: the body's last byte would arrive at 40 s, well past a 20 s limit. */
export const PAST_THE_LIMIT = ['{"ok"', ':true', ',"data"', ':{"id"', ':"L1"', ',"x":', '1}', '}']

/**
 * A buyer whose answer is cut off part way (#3091): the headers arrive at once
 * with `status`, then the first piece of the body, then the body read fails
 * with `cause`, as a connection reset or an abort from outside the call does
 * to a body being read. The call's own signal is never touched, so nothing in
 * postToPartner aborted it.
 */
export function cutOffFetch(status: number, firstPiece: string, cause: unknown) {
  const signals: AbortSignal[] = []
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal)
    let sent = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(new TextEncoder().encode(firstPiece))
          return
        }
        controller.error(cause)
      },
    })
    return new Response(stream, { status, headers: { 'content-type': 'application/json' } })
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, signals }
}
