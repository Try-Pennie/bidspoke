/**
 * The spike's Worker half (#2131), run ONLY under local `wrangler dev` (workerd)
 * by src/live.ts and never deployed: wrangler.toml beside it has no route and
 * workers_dev = false.
 *
 * Two jobs, both what PR4 would do from the production Worker:
 *   POST /rest-broadcast  the fallback sender: Realtime's REST broadcast with the
 *                         service key, private, to one topic. Answers the status.
 *   POST /subscribe       a subscriber outside the browser (decision 2): joins a
 *                         private topic with a person's JWT and streams NDJSON
 *                         lines, {"event":"status",...} then {"event":"message"}
 *                         or {"event":"timeout"}, so the caller can send once the
 *                         join is confirmed and time the receipt on its own clock.
 *
 * Keys and tokens arrive in the request body from the local caller, so nothing
 * is configured here and nothing is stored.
 */
import { createClient, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js'

interface Waiter {
  waitUntil(promise: Promise<unknown>): void
}

interface RestBody {
  supabaseUrl: string
  secretKey: string
  topic: string
  event: string
  payload: Record<string, unknown>
}

interface SubscribeBody {
  supabaseUrl: string
  publishableKey: string
  jwt: string
  topic: string
  event: string
  timeoutMs: number
}

async function restBroadcast(body: RestBody): Promise<Response> {
  const headers: Record<string, string> = { apikey: body.secretKey, 'Content-Type': 'application/json' }
  // A legacy JWT key also goes as the bearer; a new sb_secret_ key is an apikey only.
  if (body.secretKey.startsWith('eyJ')) headers.Authorization = `Bearer ${body.secretKey}`
  const res = await fetch(`${body.supabaseUrl}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages: [{ topic: body.topic, event: body.event, payload: body.payload, private: true }] }),
  })
  return Response.json({ status: res.status, body: await res.text() })
}

function subscribe(body: SubscribeBody, ctx: Waiter): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()
  let open = true
  const write = async (line: Record<string, unknown>) => {
    if (open) await writer.write(encoder.encode(`${JSON.stringify(line)}\n`))
  }

  const work = (async () => {
    const client = createClient(body.supabaseUrl, body.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    await client.realtime.setAuth(body.jwt)
    let finish: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const channel = client
      .channel(body.topic, { config: { private: true } })
      .on('broadcast', { event: body.event }, () => {
        void write({ event: 'message' }).then(finish)
      })
      .subscribe((status, err) => {
        void write({ event: 'status', status, detail: err ? err.message : null })
        if (status !== REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) finish()
      })
    const timer = setTimeout(() => {
      void write({ event: 'timeout' }).then(finish)
    }, body.timeoutMs)
    await finished
    clearTimeout(timer)
    await client.removeChannel(channel)
    open = false
    await writer.close()
  })().catch(async (err: unknown) => {
    await write({ event: 'status', status: 'UNREACHABLE', detail: err instanceof Error ? err.message : JSON.stringify(err) })
    open = false
    await writer.close()
  })
  ctx.waitUntil(work)
  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson' } })
}

export default {
  async fetch(request: Request, _env: unknown, ctx: Waiter): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/health') return new Response('ok')
    if (request.method !== 'POST') return new Response('POST only', { status: 405 })
    if (url.pathname === '/rest-broadcast') return restBroadcast((await request.json()) as RestBody)
    if (url.pathname === '/subscribe') return subscribe((await request.json()) as SubscribeBody, ctx)
    return new Response('not found', { status: 404 })
  },
}
