/**
 * The capture helper the instrumenter adds to Pipedream steps (#1705).
 *
 * This is GENERATED code: a fixed template with the workflow's constants
 * filled in, parsed into a syntax tree and spliced into a step's module. The
 * workflow's own code is never edited as text (see instrument.ts).
 *
 * What it guarantees, because it runs inside live Pipedream traffic:
 * - it never throws and never rethrows: every path is inside one try/catch;
 * - it never waits long: the request carries `AbortSignal.timeout`;
 * - it holds NO redaction rules (decision D5): it signs the body with this
 *   workflow's derived key and sends it, and the receiver redacts;
 * - it counts its own failures in module state and the next capture that
 *   succeeds carries the count as `prior_failures`;
 * - the payload is read through a function called INSIDE the try, so a payload
 *   that cannot be read (a missing step, a getter that throws) is a counted
 *   failure, not an exception in the workflow.
 *
 * Every call carries the run's event id (`steps.trigger.context.id`), the kind,
 * the site id, a sequence that is unique per call, and the capture version the
 * receiver uses to quarantine anything it does not recognise.
 */

import { CAPTURE_VERSION } from '../capture-version.ts'

export { CAPTURE_VERSION }

export const CAPTURE_FUNCTION = '__portingCapture'

/** Pipedream env var holding one workflow's derived key, hex. */
export const keyEnvName = (hashid: string) => `PORTING_KEY_${hashid}`

export interface CaptureConfig {
  hashid: string
  receiverBaseUrl: string
  /** Request timeout, ms. Short on purpose: the run must not wait on the recorder. */
  timeoutMs: number
  /** Largest body sent; a bigger payload is replaced by its size. */
  maxBytes: number
}

export const DEFAULT_TIMEOUT_MS = 2000
export const DEFAULT_MAX_BYTES = 512 * 1024

export function captureUrl(receiverBaseUrl: string, hashid: string): string {
  return `${receiverBaseUrl.replace(/\/+$/, '')}/porting/capture/${encodeURIComponent(hashid)}`
}

/** Module level declarations: the config constant, two counters and the capture function. */
export function captureHelperSource(config: CaptureConfig): string {
  const constants = JSON.stringify({
    version: CAPTURE_VERSION,
    hashid: config.hashid,
    url: captureUrl(config.receiverBaseUrl, config.hashid),
    keyEnv: keyEnvName(config.hashid),
    timeoutMs: config.timeoutMs,
    maxBytes: config.maxBytes,
  })
  return `// Porting capture (Bidspoke #1705), version ${CAPTURE_VERSION}. Records this run for the port comparison.
// It never throws, times out after ${config.timeoutMs} ms and changes nothing the workflow returns.
const __PORTING = ${constants}
let __portingFailures = 0
let __portingCount = 0
async function ${CAPTURE_FUNCTION}(steps, kind, site, payloadFn) {
  try {
    const env = (globalThis.process && globalThis.process.env) || {}
    const keyHex = env[__PORTING.keyEnv]
    if (typeof keyHex !== "string" || !/^[0-9a-f]{64}$/.test(keyHex)) {
      __portingFailures++
      return
    }
    let payload = null
    try {
      payload = JSON.parse(JSON.stringify(payloadFn ? payloadFn() : steps) ?? "null")
    } catch {
      payload = { unserialisable: true }
    }
    const eventId = (steps && steps.trigger && steps.trigger.context && steps.trigger.context.id) || null
    const envelope = {
      v: __PORTING.version,
      hashid: __PORTING.hashid,
      event_id: eventId,
      kind,
      site,
      seq: Date.now() + "." + __portingCount++ + "." + Math.random().toString(36).slice(2, 8),
      sent_at: new Date().toISOString(),
      prior_failures: __portingFailures,
      payload,
    }
    let text = JSON.stringify(envelope)
    if (text.length > __PORTING.maxBytes) {
      envelope.payload = { truncated: true, bytes: text.length }
      text = JSON.stringify(envelope)
    }
    const raw = new Uint8Array(32)
    for (let i = 0; i < 32; i++) raw[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16)
    const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const body = new TextEncoder().encode(text)
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body))
    const signature = "v1=" + Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")
    const res = await fetch(__PORTING.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-porting-signature": signature },
      body,
      signal: AbortSignal.timeout(__PORTING.timeoutMs),
    })
    try {
      if (res && res.body && typeof res.body.cancel === "function") await res.body.cancel()
    } catch {}
    if (res && res.ok) __portingFailures = 0
    else __portingFailures++
  } catch {
    __portingFailures++
  }
}
`
}

/** A whole capture step: the helper plus a run method making one call. */
export function captureStepSource(config: CaptureConfig, kind: 'start' | 'terminal' | 'responded', siteId: string): string {
  const payload = kind === 'start' ? '() => steps.trigger.event' : 'null'
  return `${captureHelperSource(config)}
export default defineComponent({
  name: "Porting capture",
  async run({ steps }) {
    await ${CAPTURE_FUNCTION}(steps, '${kind}', ${JSON.stringify(siteId)}, ${payload})
  },
})
`
}

/**
 * The error terminal. Pipedream has no per workflow error step: a failed run is
 * published to the workspace's $errors stream, and a separate workflow whose
 * trigger is the Pipedream "Workspace $error events" source receives it. This
 * step goes in that workflow; it ignores every other workflow's errors and keys
 * the capture by the FAILED run's id (`original_context.id`), so it pairs with
 * that run's start.
 */
export function errorListenerSource(config: CaptureConfig): string {
  return `${captureHelperSource(config)}
export default defineComponent({
  name: "Porting error terminal for ${config.hashid}",
  async run({ steps }) {
    try {
      const e = steps && steps.trigger && steps.trigger.event
      if (!e || !e.original_context || e.original_context.workflow_id !== '${config.hashid}') return
      const run = { trigger: { context: { id: e.original_context.id } } }
      await ${CAPTURE_FUNCTION}(run, 'error', 'error-listener', () => ({ error: e.error, original_context: e.original_context }))
    } catch {}
  },
})
`
}
