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
 * A run's item carries the variables the tick was served for it (#2998,
 * run-variables.ts), secret values included. The body is signed, not
 * encrypted: it crosses only this Worker's own SELF binding, is never stored
 * or logged, and is held by OpsInternal only for the run it names.
 *
 * Replay. A replayed observe changes nothing: it is read only. A replayed run
 * (#1950) is refused by the database, not here: its item carries the run's
 * claim token, which is its nonce, and start_run_execution starts a claim once
 * (only from claimed, and only under that token), so a replay inside the skew
 * window answers claim_lost and sends nothing, whichever copy arrives first.
 */
import { deriveHexKey, signBody, verifyBodySignature } from '@bidspoke/porting-evidence'
import { OpsInternalRefused } from './internal'
import { isDispatchedRunVariables } from './run-variables'
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isText = (v: unknown): v is string => typeof v === 'string' && v !== ''
const isTextOrNull = (v: unknown): boolean => v === null || isText(v)

/** The fields of a ClaimedRun, each with its check: a run item carries these and no others. */
const CLAIMED_RUN_FIELDS: Record<string, (v: unknown) => boolean> = {
  runRequestId: isText, organizationId: (v) => typeof v === 'string' && UUID.test(v), workflowId: isText, workflowVersion: isInt,
  triggerKind: isText, claimToken: isText, claimExpiresAt: isText, stateVersion: isInt, attempts: isInt, unchargedAttempts: isInt,
  maxAttempts: isInt, resumeReason: isTextOrNull, executionChainId: isText, resumedFromExecutionId: isTextOrNull,
  payload: () => true, payloadRef: isTextOrNull,
}

function isClaimedRun(v: unknown): boolean {
  if (!isRecord(v)) return false
  const keys = Object.keys(v)
  return keys.length === Object.keys(CLAIMED_RUN_FIELDS).length && keys.every((k) => Object.hasOwn(CLAIMED_RUN_FIELDS, k) && CLAIMED_RUN_FIELDS[k](v[k]))
}

function isDispatchItem(v: unknown): v is DispatchItem {
  if (!isRecord(v)) return false
  if (v.kind === 'probe') return Object.keys(v).length === 1
  // A run carries its variables (#2998): this start's, for this run only, secrets included.
  if (v.kind === 'run') return Object.keys(v).length === 3 && isClaimedRun(v.run) && isDispatchedRunVariables(v.variables)
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
