/**
 * The signature on every dispatch to OpsInternal (#1949; #1698 1.4, L19).
 *
 * The SELF binding is the transport, and the public edge cannot reach a named
 * entrypoint at all (docs/ops-ceilings-spike.md P6). This is the defence in
 * depth behind it: every call carries an HMAC of its exact body, and OpsInternal
 * refuses one whose signature does not verify or whose signing time is more than
 * DISPATCH_MAX_SKEW_MS from its own clock.
 *
 * The key is derived from PORTING_CAPTURE_MASTER under its own label, as the
 * capture and redaction keys are (one master secret, a key per purpose), so no
 * further secret is needed and a key leaked from one purpose signs nothing else.
 * The comparison is the shared constant time verifier (@bidspoke/porting-evidence
 * verifyBodySignature), never a bespoke `===`.
 *
 * Not yet a replay guard: observe is read only, so a replayed observe changes
 * nothing. Run invocation (#1950) adds the nonce its `run` method needs before
 * any call here can cause a send.
 */
import { deriveHexKey, signBody, verifyBodySignature } from '@bidspoke/porting-evidence'
import { OpsInternalRefused } from './internal'
import type { DispatchItem } from './tick'

export const DISPATCH_KEY_LABEL = 'ops-internal-dispatch:v1'
/** A call signed further than this from the receiver's clock, either way, is refused. */
export const DISPATCH_MAX_SKEW_MS = 5 * 60_000

export interface DispatchEnvelope {
  v: 1
  tick_id: string
  signed_at: string
  item: DispatchItem
}

/** What crosses the binding: the exact bytes that were signed, and their signature. */
export interface SignedDispatch {
  body: string
  signature: string
}

const encoder = new TextEncoder()
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export async function dispatchKey(master: string | undefined): Promise<string> {
  if (typeof master !== 'string' || master === '') throw new OpsInternalRefused('dispatch_key_unset')
  return deriveHexKey(master, DISPATCH_KEY_LABEL)
}

export async function signDispatch(keyHex: string, envelope: DispatchEnvelope): Promise<SignedDispatch> {
  const body = JSON.stringify(envelope)
  return { body, signature: await signBody(keyHex, encoder.encode(body)) }
}

function isDispatchItem(v: unknown): v is DispatchItem {
  if (!isRecord(v)) return false
  if (v.kind === 'probe') return Object.keys(v).length === 1
  return v.kind === 'would_fire' && typeof v.workflowId === 'string' && typeof v.organizationId === 'string' &&
    typeof v.scheduledFor === 'string' && typeof v.dispatchAt === 'string'
}

/** The envelope, or a refusal by name: malformed, bad_signature or stale. */
export async function verifyDispatch(keyHex: string, signed: unknown, nowMs: number): Promise<DispatchEnvelope> {
  if (!isRecord(signed) || typeof signed.body !== 'string') throw new OpsInternalRefused('malformed')
  if (!(await verifyBodySignature(keyHex, encoder.encode(signed.body), typeof signed.signature === 'string' ? signed.signature : null))) {
    throw new OpsInternalRefused('bad_signature')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(signed.body)
  } catch {
    throw new OpsInternalRefused('malformed')
  }
  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.tick_id !== 'string' || typeof parsed.signed_at !== 'string' || !isDispatchItem(parsed.item)) {
    throw new OpsInternalRefused('malformed')
  }
  const at = Date.parse(parsed.signed_at)
  if (!Number.isFinite(at) || Math.abs(nowMs - at) > DISPATCH_MAX_SKEW_MS) throw new OpsInternalRefused('stale')
  return { v: 1, tick_id: parsed.tick_id, signed_at: parsed.signed_at, item: parsed.item }
}
