// Snowflake REST API client for the lead_sightings export job.
// Auth: key-pair JWT (RS256). Service user `bidspoke_service` with RSA_PUBLIC_KEY
// configured in Snowflake; private key lives in the SNOWFLAKE_PRIVATE_KEY worker secret.

import { formatErr } from './format-error'

export interface SnowflakeConfig {
  account: string         // e.g., 'jyc55588.us-east-1' (URL prefix)
  user: string            // e.g., 'bidspoke_service'
  privateKeyPem: string   // RSA private key in PEM (PKCS#1 or PKCS#8)
  database: string
  schema: string
  warehouse: string
  role: string
}

/**
 * A statement Snowflake rejected, carrying the structured fields of the
 * rejection rather than only the prose.
 *
 * Added for the archive identity check (#914), which has to tell a PERMISSION
 * refusal from a sleeping warehouse. Classifying that by matching words in the
 * message is exactly the branch-on-substring L35 warns about: the wording is
 * Snowflake's to change, and an unrecognised message would fall to whichever
 * side the regex happened to leave.
 *
 * Existing callers read `.message` and are unaffected.
 */
export class SnowflakeStatementError extends Error {
  readonly status: number
  /** Snowflake's own error code, e.g. 003001 for insufficient privileges. */
  readonly code: string | null

  constructor(message: string, status: number, code: string | null) {
    super(message)
    this.name = 'SnowflakeStatementError'
    this.status = status
    this.code = code
  }
}

/** Pulls Snowflake's structured error code out of a response body, if it has one. */
export function snowflakeErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { code?: unknown }
    return typeof parsed.code === 'string' ? parsed.code : null
  } catch {
    return null
  }
}

export interface SnowflakeStatementResponse {
  resultSetMetaData?: {
    numRows?: number
    rowType?: Array<{ name: string; type: string }>
    /**
     * One entry per result partition. Partition 0 arrives inline as `data`; the
     * rest have to be fetched by statement handle. Absent for a result that fits
     * in one partition (#986).
     */
    partitionInfo?: Array<{ rowCount?: number }>
  }
  data?: unknown[][]
  message?: string
  code?: string
  statementHandle?: string
  statementStatusUrl?: string
}

// ============================================================
// Public API
// ============================================================

/**
 * The ceiling this timeout has to stay under, in seconds.
 *
 * NOT ours to set. The edge in front of Snowflake answers `error code: 524`
 * when the origin has not responded, measured twice on the archive at roughly
 * this point. A statement timeout past it would replace a clean cancellation,
 * which names the statement and the limit it hit, with an opaque gateway error
 * carrying neither.
 */
export const EDGE_TIMEOUT_CEILING_SECONDS = 100

/**
 * How long Snowflake may spend on one statement before cancelling it (#1447).
 *
 * Was 60, which was cancelling real writes. Measured 2026-09-22: the execution
 * archive stopped three runs in 40 hours on this limit, and the 15:23 UTC run
 * spent 642 seconds resubmitting one statement three times, each attempt
 * cancelled at 60 seconds, and archived nothing for its trouble.
 *
 * The statements are not large. A healthy hour uses 9 to 13 sends for about 25
 * MB, so roughly 2 MB each, and the two failures on one hour landed on its
 * second and its tenth send, which rules out a single pathological record and
 * leaves Snowflake itself being slow. So the remedy is room, not smaller work:
 * this costs nothing on a statement that was always going to finish quickly.
 *
 * Shared with the nightly exports, which hold their own wall budget, so a slow
 * statement now blocks one of them for up to this long instead of 60 seconds.
 */
export const STATEMENT_TIMEOUT_SECONDS = 90

/**
 * The request body for one statement, built where it can be read back.
 *
 * Its own function so the timeout it carries is provable without a signing key
 * or a network: a constant beside a literal in a request nobody can assemble in
 * a test is a number nothing checks (L3).
 */
export function statementRequestBody(
  config: SnowflakeConfig,
  statement: string,
  bindings?: unknown[],
): Record<string, unknown> {
  // Snowflake stores unquoted identifiers uppercase. Send uppercase to match
  // regardless of how the secret is set.
  const body: Record<string, unknown> = {
    statement,
    timeout: STATEMENT_TIMEOUT_SECONDS,
    database: config.database.toUpperCase(),
    schema: config.schema.toUpperCase(),
    warehouse: config.warehouse.toUpperCase(),
    role: config.role.toUpperCase(),
  }
  if (bindings && bindings.length > 0) {
    const bindMap: Record<string, { type: string; value: string }> = {}
    for (let i = 0; i < bindings.length; i++) {
      bindMap[String(i + 1)] = { type: 'TEXT', value: bindings[i] == null ? '' : String(bindings[i]) }
    }
    body.bindings = bindMap
  }
  return body
}

export async function executeStatement(
  config: SnowflakeConfig,
  statement: string,
  bindings?: unknown[],
): Promise<SnowflakeStatementResponse> {
  const privateKey = await importPrivateKey(config.privateKeyPem)
  const jwt = await signSnowflakeJwt(config, privateKey)
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements`
  const body = statementRequestBody(config, statement, bindings)

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${jwt}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'bidspoke-worker/1.0',
    'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
  }

  // A fresh requestId per statement. Resubmitting the SAME requestId with
  // retry=true is Snowflake's idempotency contract: it will not execute a
  // statement that already succeeded, which is what makes retrying a request
  // that died before we saw its response safe.
  const { status, text } = await postStatementWithRetry(url, headers, JSON.stringify(body), crypto.randomUUID())
  return resolveStatementResult(config, headers, status, text)
}

// Statuses worth resubmitting. 429/503/504 are Snowflake's own documented
// retryable set; 502 is the same Envoy-proxy class as the 503 that aborted the
// bids export on 2026-07-09 ("upstream connect error or disconnect/reset before
// headers"). 500 is deliberately NOT here: it can mean the statement itself
// failed server-side, and retrying would just hide a real error behind a delay.
//
// 408 and 524 are the two spellings of the SAME timeout the 504 above stands
// for, and they were added on 2026-09-22 after each one stopped an execution
// archive run that a resubmit would very likely have carried (#1440): a 524
// twice, which is the edge in front of Snowflake giving up on the origin, and a
// 408 carrying `Statement reached its statement or warehouse timeout of 60
// second(s) and was canceled`, which is Snowflake reporting the statement
// timeout this client itself sends (60 at the time, now
// STATEMENT_TIMEOUT_SECONDS). Neither can mean the statement failed, which is the
// ambiguity that keeps 500 off this list, so neither needs the body inspected.
//
// A 408 says the statement was CANCELED, so the resubmit is a genuine second
// attempt rather than a no-op de-duplicated by the requestId contract. That is
// the intended behaviour: the archive's hours succeed 35 runs in 39, so the
// slowness is a busy warehouse rather than a statement that can never fit, and
// a caller whose budget the attempts eat still stops cleanly on its own deadline
// instead of losing the whole run to one slow write.
const TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504, 524])

// The one 500 that is not a statement failure. On 2026-08-11 the 16:37 UTC
// sightings export died on its first MERGE with HTTP 500 and body
// `{"code":"ErrorCode{messageCode=370001}","message":"Idle timeout expired:
// 30001/30000 ms"}`. That is Snowflake timing out on its own side after 30s,
// which the blanket 500 rule above treated as fatal.
//
// Matched on the timeout WORDS, not on 370001: Snowflake uses 370001 as a
// generic internal-error code that also fires for genuinely broken SQL, so
// keying on the code would start silently retrying real failures. Resubmitting
// is safe for the same reason it is for a dropped connection: the requestId
// contract below means Snowflake will not re-run a statement that already
// succeeded, which is exactly the ambiguity a timeout leaves us with.
const TRANSIENT_500_BODY = /idle timeout expired/i

export function isTransientSnowflakeError(status: number, body?: string): boolean {
  if (TRANSIENT_STATUSES.has(status)) return true
  return status === 500 && body !== undefined && TRANSIENT_500_BODY.test(body)
}

export interface RetryOptions {
  maxAttempts?: number
  delaysMs?: number[]
  sleep?: (ms: number) => Promise<void>
}

// Bounded on purpose. The export's per-run wall-time budget (12 min, see
// sightings-export.ts) is spent across hundreds of batches, so a long retry
// ladder on any one batch would starve the drain. Worst case here is ~5s of
// waiting per batch, and exportTable's deadline check stops the run cleanly if
// a sustained Snowflake outage eats the budget anyway.
const RETRY_MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [1_000, 4_000]

/**
 * POST a statement, resubmitting on transient failures.
 *
 * Retries carry the original requestId plus retry=true so Snowflake dedupes a
 * statement that already ran. That matters most for the case we cannot observe:
 * a connection dropped before headers, where the MERGE may or may not have been
 * applied. Exported for unit testing.
 */
export async function postStatementWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  requestId: string,
  opts: RetryOptions = {},
): Promise<{ status: number; text: string }> {
  const maxAttempts = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS
  const delaysMs = opts.delaysMs ?? RETRY_DELAYS_MS
  const doSleep = opts.sleep ?? sleep

  for (let attempt = 1; ; attempt++) {
    const target = `${url}?requestId=${encodeURIComponent(requestId)}${attempt > 1 ? '&retry=true' : ''}`
    let retryable: boolean
    let error: Error

    try {
      const res = await fetch(target, { method: 'POST', headers, body })
      const text = await res.text()
      if (res.ok) return { status: res.status, text }
      retryable = isTransientSnowflakeError(res.status, text)
      error = new SnowflakeStatementError(`Snowflake ${res.status}: ${text}`, res.status, snowflakeErrorCode(text))
    } catch (e) {
      // fetch rejected, so no response ever arrived. Always retryable: the
      // requestId contract covers the ambiguity about whether it executed.
      retryable = true
      error = e instanceof Error ? e : new Error(formatErr(e))
    }

    if (!retryable || attempt >= maxAttempts) throw error
    // A silent retry makes one benign stall and a systemic Snowflake
    // degradation indistinguishable: a run where most batches retried looked
    // exactly like a clean run, so the first visible signal was a whole run
    // dying. Log every resubmit so the rate is countable before that.
    console.warn(
      `[snowflake] retrying statement ${requestId} (attempt ${attempt} of ${maxAttempts}): ${error.message}`,
    )
    await doSleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)])
  }
}

// Decide the result of a 2xx statement response. A 200 carries the completed
// result; a 202 means the statement is still running (it didn't finish within
// the body `timeout`, e.g. a cold-warehouse resume) and only carries a
// statementHandle to poll. Treating 202 as success would let the export stamp
// exported_at and purge the source rows 24h later even if the MERGE never
// completed — so poll the statement to a terminal state instead.
// Exported for unit testing.
export async function resolveStatementResult(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  status: number,
  text: string,
  pollOpts?: PollOptions,
): Promise<SnowflakeStatementResponse> {
  if (status === 202) {
    const parsed = parseResponse(text)
    const handle = parsed.statementHandle
    if (!handle) throw new Error(`Snowflake returned 202 without a statementHandle: ${text}`)
    const polled = await pollStatement(config, headers, handle, pollOpts)
    // The handle we polled with is the fallback, so a terminal body that does not
    // echo it can still have its later partitions fetched. Anything the body does
    // carry wins.
    return assembleResultPartitions(config, headers, { statementHandle: handle, ...polled })
  }
  return assembleResultPartitions(config, headers, parseResponse(text))
}

/**
 * Return the statement's WHOLE result, or refuse (#986).
 *
 * Snowflake chunks a large result set into partitions. Partition 0 comes inline
 * with the statement response and the rest are separate GETs, so reading `data`
 * alone silently answers with a prefix of the result. Nothing about a prefix
 * looks wrong: it parses, it has the right columns, and it arrives faster than
 * the whole thing would (L98).
 *
 * The row count is reconciled against `numRows` in BOTH directions of arrival,
 * the multi-partition fetch and the plain single-partition read, because a
 * truncation that comes with no `partitionInfo` at all would otherwise pass. Only
 * a SHORT result is refused: a surplus cannot be truncation, and a DML
 * statement's result is a one-row count whose `numRows` contract this code does
 * not own, so refusing on any inequality would risk the export path to catch a
 * case that carries no data-loss risk.
 *
 * A failed partition fetch throws rather than returning what it has. There is no
 * retry here on purpose: the callers that read multi-row results are scheduled
 * jobs whose next run measures the same day again, and a partial result that had
 * been retried into existence is indistinguishable from a complete one.
 */
export async function assembleResultPartitions(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  response: SnowflakeStatementResponse,
): Promise<SnowflakeStatementResponse> {
  const partitions = response.resultSetMetaData?.partitionInfo
  const declaredRows = response.resultSetMetaData?.numRows
  const rows: unknown[][] = [...(response.data ?? [])]

  if (partitions !== undefined && partitions.length > 1) {
    const handle = response.statementHandle
    if (!handle) {
      throw new Error(
        `Snowflake declared ${partitions.length} result partitions without a statementHandle to fetch them with, ` +
          `so only the ${rows.length} rows of partition 0 could be read`,
      )
    }
    for (let index = 1; index < partitions.length; index++) {
      rows.push(...(await fetchPartition(config, headers, handle, index, partitions.length)))
    }
  }

  if (typeof declaredRows === 'number' && rows.length < declaredRows) {
    throw new Error(
      `Snowflake returned ${rows.length} of the ${declaredRows} rows it declared for this statement, ` +
        `across ${partitions?.length ?? 1} partition(s), so the result is incomplete`,
    )
  }

  return { ...response, data: rows }
}

async function fetchPartition(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  handle: string,
  index: number,
  total: number,
): Promise<unknown[][]> {
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements/${handle}?partition=${index}`
  const res = await fetch(url, { method: 'GET', headers })
  const text = await res.text()
  if (!res.ok) {
    throw new SnowflakeStatementError(
      `Snowflake returned ${res.status} for partition ${index} of ${total}: ${text}`,
      res.status,
      snowflakeErrorCode(text),
    )
  }
  return parseResponse(text).data ?? []
}

interface PollOptions {
  intervalMs?: number
  maxAttempts?: number
}

const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 30 // ~60s of polling on top of the 60s server-side timeout

// Poll GET /api/v2/statements/{handle} until the statement reaches a terminal
// state. 202 = still running (keep polling); 2xx = complete (return the body);
// non-2xx = failed (throw, so the export batch fails and retries next run
// without stamping exported_at). Exhausting the attempts also throws.
// Exported for unit testing.
export async function pollStatement(
  config: SnowflakeConfig,
  headers: Record<string, string>,
  handle: string,
  pollOpts: PollOptions = {},
): Promise<SnowflakeStatementResponse> {
  const intervalMs = pollOpts.intervalMs ?? POLL_INTERVAL_MS
  const maxAttempts = pollOpts.maxAttempts ?? POLL_MAX_ATTEMPTS
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements/${handle}?partition=0`

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(intervalMs)
    const res = await fetch(url, { method: 'GET', headers })
    const text = await res.text()
    if (res.status === 202) continue // still running
    if (!res.ok) throw new SnowflakeStatementError(`Snowflake poll ${res.status}: ${text}`, res.status, snowflakeErrorCode(text))
    return parseResponse(text)
  }
  throw new Error(`Snowflake statement ${handle} did not complete after ${maxAttempts} polls`)
}

function parseResponse(text: string): SnowflakeStatementResponse {
  try {
    return JSON.parse(text) as SnowflakeStatementResponse
  } catch {
    return { message: text }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ============================================================
// Host / account name helpers
// ============================================================

export function snowflakeHost(account: string): string {
  // 'jyc55588.us-east-1' → 'jyc55588.us-east-1.snowflakecomputing.com'
  return `${account.toLowerCase()}.snowflakecomputing.com`
}

// Encode a string for a Snowflake single-quoted literal. Snowflake treats
// backslash as an escape character inside string literals, so a lone trailing
// backslash would escape the closing quote and break out of the literal (SQL
// injection / query corruption). Double backslashes first, then double quotes.
// Shared by every call site that hand-builds SQL text (export VALUES lists,
// schema-sync filters) so the escaping lives in exactly one place.
export function escapeSqlLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function accountForJwt(account: string): string {
  // JWT iss/sub uses just the account locator (no region), uppercased.
  return account.split('.')[0].toUpperCase()
}

// ============================================================
// JWT signer
// ============================================================

async function signSnowflakeJwt(config: SnowflakeConfig, privateKey: CryptoKey): Promise<string> {
  const fingerprint = await publicKeyFingerprint(privateKey)
  const account = accountForJwt(config.account)
  const user = config.user.toUpperCase()
  const iss = `${account}.${user}.SHA256:${fingerprint}`
  const sub = `${account}.${user}`
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iss, sub, iat: now, exp: now + 3600 }

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)))
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`
}

async function publicKeyFingerprint(privateKey: CryptoKey): Promise<string> {
  // Export private as JWK to get n + e, build a public-only JWK, import as
  // public key, then export as SPKI (DER) and SHA-256 hash that.
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey
  const publicJwk: JsonWebKey = {
    kty: 'RSA',
    n: jwk.n,
    e: jwk.e,
    alg: 'RS256',
    ext: true,
  }
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  )
  const spki = (await crypto.subtle.exportKey('spki', publicKey)) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', spki)
  // Snowflake expects standard base64 (with padding), not base64url.
  return bytesToBase64Standard(new Uint8Array(digest))
}

// ============================================================
// PEM parser — handles PKCS#1 and PKCS#8
// ============================================================

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const trimmed = pem.replace(/\r/g, '').trim()
  const isPkcs1 = trimmed.includes('BEGIN RSA PRIVATE KEY')
  const der = pemToDer(trimmed)
  const pkcs8 = isPkcs1 ? pkcs1ToPkcs8(der) : der

  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true, // extractable — needed so we can derive the public key for fingerprinting
    ['sign'],
  )
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  return base64ToBytes(b64)
}

// Wrap PKCS#1 RSAPrivateKey in PKCS#8 PrivateKeyInfo envelope.
// Layout:
//   SEQUENCE {
//     INTEGER 0,
//     AlgorithmIdentifier { OID rsaEncryption, NULL },
//     OCTET STRING <pkcs1 bytes>
//   }
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const algorithmId = new Uint8Array([
    0x30, 0x0d,                                                       // SEQUENCE, len 13
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID 1.2.840.113549.1.1.1
    0x05, 0x00,                                                       // NULL
  ])
  const version = new Uint8Array([0x02, 0x01, 0x00]) // INTEGER 0

  const octetHeader = derLengthPrefix(0x04, pkcs1.length)
  const innerLen = version.length + algorithmId.length + octetHeader.length + pkcs1.length
  const outerHeader = derLengthPrefix(0x30, innerLen)

  const out = new Uint8Array(outerHeader.length + innerLen)
  let i = 0
  out.set(outerHeader, i); i += outerHeader.length
  out.set(version, i); i += version.length
  out.set(algorithmId, i); i += algorithmId.length
  out.set(octetHeader, i); i += octetHeader.length
  out.set(pkcs1, i)
  return out
}

// DER tag + length, supporting short, 1-byte, and 2-byte length forms.
function derLengthPrefix(tag: number, length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([tag, length])
  if (length < 0x100) return new Uint8Array([tag, 0x81, length])
  return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff])
}

// ============================================================
// Base64 helpers
// ============================================================

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64Standard(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function bytesToBase64Standard(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
