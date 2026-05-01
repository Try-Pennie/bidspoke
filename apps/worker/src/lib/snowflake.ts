// Snowflake REST API client for the lead_sightings export job.
// Auth: key-pair JWT (RS256). Service user `bidspoke_service` with RSA_PUBLIC_KEY
// configured in Snowflake; private key lives in the SNOWFLAKE_PRIVATE_KEY worker secret.

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
  const body: Record<string, unknown> = {
    statement,
    timeout: 60,
    database: config.database,
    schema: config.schema,
    warehouse: config.warehouse,
    role: config.role,
  }
  if (bindings && bindings.length > 0) {
    const bindMap: Record<string, { type: string; value: string }> = {}
    for (let i = 0; i < bindings.length; i++) {
      bindMap[String(i + 1)] = { type: 'TEXT', value: bindings[i] == null ? '' : String(bindings[i]) }
    }
    body.bindings = bindMap
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'bidspoke-worker/1.0',
      'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Snowflake ${res.status}: ${text}`)
  }
  try {
    return JSON.parse(text) as SnowflakeStatementResponse
  } catch {
    return { message: text }
  }
}

// ============================================================
// Host / account name helpers
// ============================================================

export function snowflakeHost(account: string): string {
  // 'jyc55588.us-east-1' → 'jyc55588.us-east-1.snowflakecomputing.com'
  return `${account.toLowerCase()}.snowflakecomputing.com`
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
