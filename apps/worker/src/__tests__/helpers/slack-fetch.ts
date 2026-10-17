/**
 * Reading what a Slack sender posted, from a fetch double's recorded call
 * (#2331 phase 1b).
 *
 * Senders switched to createSlackClient post through slack-web-api-client,
 * which calls `fetch(request)` with ONE argument, a Request whose body is form
 * encoded (blocks as a JSON string, booleans as 'true' or 'false'). A sender
 * not yet switched still calls `fetch(url, { body: JSON })`. This reads either
 * shape into one record, so a test asserts on the message and not on the wire
 * format, and needs no change when its sender is switched.
 *
 * A fetch double answering a switched sender must give a `status` (the library
 * treats anything but 200 as an HTTP failure) and, for any status but 200,
 * `text()` and `headers`; a real Response has all of them, but its body reads
 * once, so return a new one per call (`mockImplementation`), not one shared
 * object (`mockResolvedValue`).
 */

/**
 * The message fields are typed as loosely as the `JSON.parse` of the old body
 * they replace, because the tests reading them index into Block Kit freely.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- as loose as the JSON.parse it replaces, see above */
export interface SlackPost {
  url: string
  /** The bearer token the call carried, or null when it carried none. */
  token: string | null
  channel: any
  text: any
  blocks: any
  [field: string]: any
}
/* eslint-enable @typescript-eslint/no-explicit-any */


function bearer(value: string | null | undefined): string | null {
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null
}

function decodeForm(form: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of form) {
    if (key === 'blocks' || key === 'attachments' || key === 'metadata') out[key] = JSON.parse(value)
    else if (value === 'true' || value === 'false') out[key] = value === 'true'
    else out[key] = value
  }
  return out
}

/** The message one recorded fetch call posted, whichever shape the sender used. */
export async function slackPostOf(call: readonly unknown[]): Promise<SlackPost> {
  const [input, init] = call as [unknown, { body?: unknown; headers?: Record<string, string> } | undefined]
  if (input instanceof Request) {
    const body = await input.clone().text()
    const contentType = input.headers.get('Content-Type') ?? ''
    const fields = contentType.includes('application/json') ? (JSON.parse(body) as Record<string, unknown>) : decodeForm(new URLSearchParams(body))
    return { ...fields, url: input.url, token: bearer(input.headers.get('Authorization')) } as SlackPost
  }
  const fields = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  const headers = init?.headers ?? {}
  return { ...fields, url: String(input), token: bearer(headers.Authorization ?? headers.authorization) } as SlackPost
}

/**
 * The message one recorded call posted, as JSON text of its fields only (no
 * url, no token), for a test that searched the raw JSON body for a phrase.
 */
export async function slackPostJsonOf(call: readonly unknown[]): Promise<string> {
  // url and token are dropped on purpose: they were never in the body.
  const { url, token, ...fields } = await slackPostOf(call)
  return JSON.stringify(fields)
}

/** The URL one recorded fetch call went to, whether it was given a Request or a URL. */
export function urlOf(call: readonly unknown[]): string {
  const input = call[0]
  return input instanceof Request ? input.url : String(input)
}

/** Every message a fetch double recorded posting to Slack, in order. Calls to anything else are left out. */
export async function slackPostsOf(mock: { mock: { calls: readonly (readonly unknown[])[] } }): Promise<SlackPost[]> {
  const posts: SlackPost[] = []
  for (const call of mock.mock.calls) {
    if (urlOf(call).startsWith('https://slack.com/api/')) posts.push(await slackPostOf(call))
  }
  return posts
}

/** A delivered Slack answer, new on every call so its body can be read. */
export function slackOk(extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: true, ts: '1.1', ...extra }), { status: 200, headers: { 'content-type': 'application/json' } })
}
