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

export interface SnowflakeStatementResponse {
  resultSetMetaData?: {
    numRows?: number
    rowType?: Array<{ name: string; type: string }>
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

export async function executeStatement(
  config: SnowflakeConfig,
  statement: string,
  bindings?: unknown[],
): Promise<SnowflakeStatementResponse> {
  const privateKey = await importPrivateKey(config.privateKeyPem)
  const jwt = await signSnowflakeJwt(config, privateKey)
  const url = `https://${snowflakeHost(config.account)}/api/v2/statements`
  // Snowflake stores unquoted identifiers uppercase. Send uppercase to match
  // regardless of how the secret is set.
  const body: Record<string, unknown> = {
    statement,
    timeout: 60,
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
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504])

export function isTransientSnowflakeError(status: number): boolean {
  return TRANSIENT_STATUSES.has(status)
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
      retryable = isTransientSnowflakeError(res.status)
      error = new Error(`Snowflake ${res.status}: ${text}`)
    } catch (e) {
      // fetch rejected, so no response ever arrived. Always retryable: the
      // requestId contract covers the ambiguity about whether it executed.
      retryable = true
      error = e instanceof Error ? e : new Error(formatErr(e))
    }

    if (!retryable || attempt >= maxAttempts) throw error
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
    return pollStatement(config, headers, handle, pollOpts)
  }
  return parseResponse(text)
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
    if (!res.ok) throw new Error(`Snowflake poll ${res.status}: ${text}`)
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
