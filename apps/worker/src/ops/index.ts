/**
 * bidspoke-worker-ops: the minimal ops Worker (#1705, plan 0.R). One route.
 *
 *   POST /porting/capture/:hashid
 *
 * Caller: the porting capture steps pasted into Pipedream workflows, and
 * nothing else. Each signs its body with its workflow's key, derived here as
 * HMAC(PORTING_CAPTURE_MASTER, hashid), so the Worker holds one secret and a
 * key leaked outside Pipedream signs for its one workflow only. Inside the
 * Pipedream workspace there is no isolation: every key is a workspace wide
 * environment variable there (see signature.ts). Data reached: one R2
 * bucket, PORTING_TEE, written under this workflow's own prefix. No database,
 * no other binding, no other secret.
 *
 * Order, and why:
 * 1. Refuse by name an unset master secret (503) or a workflow that is not
 *    enrolled (404). The registry is in porting-registry.ts.
 * 2. Read at most MAX_BODY_BYTES, then verify the signature through the one
 *    shared constant time verifier. Nothing is parsed, counted or stored before
 *    this passes.
 * 3. Parse; refuse a body that is not JSON or names another workflow.
 * 4. Quarantine, never drop, a capture whose version is not current or whose
 *    event id, kind or sequence cannot be a key segment: Pipedream keeps no
 *    history to recover a dropped capture from.
 * 5. Redact (decision D5) before any write. If redaction throws, nothing is
 *    stored and the refusal is logged by code.
 * 6. Write `tee/<hashid>/<event_id>/<kind>/<seq>.json`, never overwriting: a
 *    key already present answers `duplicate` and writes nothing (L131).
 *
 * Logs carry an outcome code and the enrolled hashid only. Never a body, a
 * payload value or an error message (L658): a catch here binds nothing.
 */
import { SIGNATURE_HEADER, deriveHexKey, deriveWorkflowKey, redactCapture, verifyBodySignature } from '@bidspoke/porting-evidence'
import { PORTING_REGISTRY, type PortingRegistry } from './porting-registry'

export interface OpsEnv {
  PORTING_CAPTURE_MASTER?: string
  PORTING_TEE: R2Bucket
}

export interface OpsDeps {
  registry: PortingRegistry
  now: () => number
  redact: typeof redactCapture
}

/** A capture step sends at most 512 KiB; twice that is refused unread. */
export const MAX_BODY_BYTES = 1024 * 1024
const KINDS = new Set(['start', 'terminal', 'error', 'responded'])
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/
const SAFE_SEQ = /^[A-Za-z0-9._-]{1,64}$/
const ROUTE = /^\/porting\/capture\/([^/]+)$/

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function log(outcome: string, fields: Record<string, string | number> = {}) {
  console.log(JSON.stringify({ event: 'porting_capture', outcome, ...fields }))
}

const refuse = (status: number, code: string, fields: Record<string, string | number> = {}) => {
  log(code, fields)
  return json(status, { error: code })
}

/** Reads the body, stopping as soon as it passes the limit. Null when too large. */
async function readCapped(req: Request): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

async function shortHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createOpsHandler(deps: Partial<OpsDeps> = {}) {
  const registry = deps.registry ?? PORTING_REGISTRY
  const now = deps.now ?? (() => Date.now())
  const redact = deps.redact ?? redactCapture

  return async function handle(req: Request, env: OpsEnv): Promise<Response> {
    const url = new URL(req.url)
    const match = ROUTE.exec(url.pathname)
    if (!match) return json(404, { error: 'not_found' })
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })

    const master = env.PORTING_CAPTURE_MASTER
    if (!master) return refuse(503, 'master_secret_unset')
    let hashid: string
    try {
      hashid = decodeURIComponent(match[1])
    } catch {
      // A malformed percent escape throws URIError; answer it by name rather
      // than with an unhandled 500.
      return refuse(400, 'malformed_hashid')
    }
    if (!Object.prototype.hasOwnProperty.call(registry.enrolled, hashid)) return refuse(404, 'unknown_workflow')

    const bytes = await readCapped(req)
    if (bytes === null) return refuse(413, 'body_too_large', { hashid })

    const key = await deriveWorkflowKey(master, hashid)
    if (!(await verifyBodySignature(key, bytes, req.headers.get(SIGNATURE_HEADER)))) {
      return refuse(401, 'bad_signature', { hashid })
    }

    let envelope: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse(400, 'malformed_body', { hashid })
      envelope = parsed as Record<string, unknown>
    } catch {
      return refuse(400, 'malformed_body', { hashid })
    }
    if (envelope.hashid !== hashid) return refuse(400, 'hashid_mismatch', { hashid })

    // Quarantine rather than refuse: a capture that cannot be filed normally
    // is still the only copy there will ever be.
    const reasons: string[] = []
    const version = envelope.v
    if (typeof version !== 'number' || !registry.currentCaptureVersions.includes(version)) reasons.push('unknown_capture_version')
    const rawEvent = envelope.event_id
    let eventSeg: string
    if (typeof rawEvent === 'string' && SAFE_SEGMENT.test(rawEvent)) eventSeg = rawEvent
    else {
      reasons.push('unsafe_event_id')
      eventSeg = typeof rawEvent === 'string' ? `_unsafe_${await shortHash(rawEvent)}` : '_missing'
    }
    const rawKind = envelope.kind
    let kindSeg: string
    if (typeof rawKind === 'string' && KINDS.has(rawKind)) kindSeg = rawKind
    else {
      reasons.push('unknown_kind')
      kindSeg = 'unknown_kind'
    }
    const rawSeq = envelope.seq
    let seqSeg: string
    if (typeof rawSeq === 'string' && SAFE_SEQ.test(rawSeq)) seqSeg = rawSeq
    else {
      reasons.push('unsafe_seq')
      seqSeg = `_unsafe_${await shortHash(new TextDecoder().decode(bytes))}`
    }
    const quarantined = reasons.length > 0
    const objectKey = `${quarantined ? 'quarantine' : 'tee'}/${hashid}/${eventSeg}/${kindSeg}/${seqSeg}.json`

    let redacted: Awaited<ReturnType<typeof redactCapture>>
    try {
      redacted = await redact(envelope.payload ?? null, await deriveHexKey(master, 'porting-redaction:v1'))
    } catch {
      return refuse(500, 'redaction_failed', { hashid })
    }

    const stored = {
      v: version,
      hashid,
      event_id: rawEvent ?? null,
      kind: rawKind ?? null,
      site: typeof envelope.site === 'string' ? envelope.site : null,
      seq: rawSeq ?? null,
      sent_at: typeof envelope.sent_at === 'string' ? envelope.sent_at : null,
      prior_failures: typeof envelope.prior_failures === 'number' ? envelope.prior_failures : null,
      received_at: new Date(now()).toISOString(),
      quarantined,
      quarantine_reasons: reasons,
      redacted_count: redacted.redactedCount,
      payload: redacted.value,
    }

    // One conditional write, so the store itself refuses an overwrite. A read
    // then a write let two concurrent deliveries of one key both see it free
    // and the second replace the first. R2 answers null when the precondition
    // fails, which here means the key already exists.
    let written: R2Object | null
    try {
      written = await env.PORTING_TEE.put(objectKey, JSON.stringify(stored), {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          capture_version: String(version),
          quarantined: quarantined ? reasons.join(',') : 'no',
          redacted_count: String(redacted.redactedCount),
        },
      })
    } catch {
      return refuse(503, 'store_failed', { hashid })
    }
    if (written === null) {
      log('duplicate', { hashid })
      return json(200, { stored: false, duplicate: true })
    }

    log(quarantined ? 'quarantined' : 'stored', { hashid, kind: kindSeg, redacted_count: redacted.redactedCount })
    return json(202, { stored: true, quarantined })
  }
}

const handler = createOpsHandler()

export default {
  fetch(req: Request, env: OpsEnv): Promise<Response> {
    return handler(req, env)
  },
} satisfies ExportedHandler<OpsEnv>
