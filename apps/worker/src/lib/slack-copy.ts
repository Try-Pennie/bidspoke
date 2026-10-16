/**
 * The encrypted last-good copy of every organization's Slack connection (#1297).
 *
 * Every alert path looks the Slack token up in the database, so when the
 * database is down nobody could be told. The volume check therefore rewrites
 * this copy in KV on every healthy minute, ENCRYPTED because the token is a
 * secret and KV is not the place for plaintext (#491), and the paths that must
 * speak during an outage read it: the scheduled lookup (scheduled-slack.ts,
 * #1303), the volume check's own database alert, and the request path's block
 * and write-back alerts. One key, rewritten once a minute, well inside KV's one
 * write a second per key.
 *
 * Its shape is a flat map of organization id to connection config. A reserved
 * top level string key, `__saved_at`, may carry when it was written (#2060
 * writes it); parseSlackConnection drops a value that is not an object, so a
 * reader that predates the key still reads every organization.
 */
import { decryptSecret, encryptSecret, type SecretKeyInput } from './secret-crypto'
import { parseSlackConnection, type SlackConnection } from './slack-connection'
import { formatErr } from './format-error'

export const SLACK_CONNS_LASTGOOD_KEY = 'slack-conns-lastgood'

/** The reserved key naming when the copy was saved; never an organization id. */
export const SLACK_COPY_SAVED_AT_KEY = '__saved_at'

interface CopyKv {
  get(key: string): Promise<string | null>
}

/** What reading the copy found: the connections (with when they were saved, if known), no copy, or one that cannot be read. */
export type SlackCopyRead =
  | { kind: 'read'; connections: Map<string, SlackConnection>; savedAtMs: number | null }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string }

/**
 * Read and decrypt the copy, saying which of the three it found. A copy written
 * under a key since rotated away is `unreadable`, never a crash.
 */
export async function readSlackCopy(kv: CopyKv, secretKeys: SecretKeyInput): Promise<SlackCopyRead> {
  let blob: string | null
  try {
    blob = await kv.get(SLACK_CONNS_LASTGOOD_KEY)
  } catch (e) {
    return { kind: 'unreadable', detail: `KV read failed: ${formatErr(e)}` }
  }
  if (!blob) return { kind: 'absent' }
  try {
    return { kind: 'read', ...(await decryptCopy(blob, secretKeys)) }
  } catch (e) {
    return { kind: 'unreadable', detail: formatErr(e) }
  }
}

async function decryptCopy(blob: string, secretKeys: SecretKeyInput): Promise<{ connections: Map<string, SlackConnection>; savedAtMs: number | null }> {
  const parsed = JSON.parse(await decryptSecret(blob, secretKeys)) as Record<string, unknown>
  const connections = new Map<string, SlackConnection>()
  for (const [orgId, cfg] of Object.entries(parsed)) {
    if (orgId === SLACK_COPY_SAVED_AT_KEY) continue
    const conn = parseSlackConnection(cfg)
    if (conn) connections.set(orgId, conn)
  }
  const saved = parsed[SLACK_COPY_SAVED_AT_KEY]
  const savedAtMs = typeof saved === 'string' && Number.isFinite(Date.parse(saved)) ? Date.parse(saved) : null
  return { connections, savedAtMs }
}

/**
 * The copy as a plain map, for the readers that only need "who can be told"
 * (the request path's alerts and the volume check's database alert): empty when
 * there is no copy or it cannot be decrypted. A KV read that throws is thrown on,
 * as it always was, for those callers' own handling.
 */
export async function readLastGoodSlackConnections(kv: CopyKv, secretKeys: SecretKeyInput): Promise<Map<string, SlackConnection>> {
  const blob = await kv.get(SLACK_CONNS_LASTGOOD_KEY)
  if (!blob) return new Map()
  try {
    return (await decryptCopy(blob, secretKeys)).connections
  } catch (e) {
    // A blob written under a rotated key is a miss, not a crash.
    console.error(`[slack-copy] last-good Slack connections unreadable: ${formatErr(e)}`)
    return new Map()
  }
}

/** Rewrite the copy. Never throws: the caller's check must not fail because the safety copy could not be written. */
export async function rememberSlackConnections(
  kv: { put(key: string, value: string): Promise<void> },
  secretKeys: SecretKeyInput,
  connections: Map<string, SlackConnection>,
): Promise<void> {
  try {
    const blob = await encryptSecret(JSON.stringify(Object.fromEntries(connections)), secretKeys)
    await kv.put(SLACK_CONNS_LASTGOOD_KEY, blob)
  } catch (e) {
    console.error(`[slack-copy] last-good Slack connections write failed: ${formatErr(e)}`)
  }
}
