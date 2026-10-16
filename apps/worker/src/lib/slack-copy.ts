/**
 * The encrypted last-good copy of every organization's Slack connection (#1297).
 *
 * Every alert path looks the Slack token up in the database, so when the
 * database is down nobody could be told. The minute database probe
 * (database-reachability.ts, #2061; the volume check before it) therefore
 * rewrites this copy in KV on every healthy minute, ENCRYPTED because the token
 * is a secret and KV is not the place for plaintext (#491), and the paths that
 * must speak during an outage read it: the scheduled lookup (scheduled-slack.ts,
 * #1303), the database unreachable page, and the request path's block and
 * write-back alerts. One key, rewritten once a minute, well inside KV's one
 * write a second per key.
 *
 * Its shape is a flat map of organization id to connection config. A reserved
 * top level string key, `__saved_at`, carries when it was written (#2060);
 * parseSlackConnection drops a value that is not an object, so a reader that
 * predates the key still reads every organization, and a copy written before
 * the key reads with its age unknown. Both directions are tested
 * (slack-copy.test.ts).
 *
 * Kept current (#2060): every successful read of every organization's
 * connection rewrites it, an empty read included, and a failed read never does;
 * the Slack settings routes edit an organization's entry in the same request
 * that changes its connection (editSlackCopyEntry). It is used at ANY age, by
 * decision, with the reason beside STORED_COPY_MAX_AGE_MS (stored-copy-age.ts).
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
 * (the request path's alerts). It answers an empty map both when there is no
 * copy and when it cannot be decrypted; readSlackCopy tells those apart, for a
 * caller that must say which (L11). A KV read that throws is thrown on, as it
 * always was, for those callers' own handling.
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

/**
 * Rewrite the copy from a successful read of every organization's connection,
 * dated `savedAtMs` (#2060). An EMPTY map is written too: the database said no
 * organization has a connection, and keeping the previous copy would let an
 * outage post to organizations that had all disconnected. A failed read never
 * reaches here. Never throws: the caller's check must not fail because the
 * safety copy could not be written.
 */
export async function rememberSlackConnections(
  kv: { put(key: string, value: string): Promise<void> },
  secretKeys: SecretKeyInput,
  connections: Map<string, SlackConnection>,
  savedAtMs: number,
): Promise<void> {
  try {
    const copy: Record<string, unknown> = Object.fromEntries(connections)
    copy[SLACK_COPY_SAVED_AT_KEY] = new Date(savedAtMs).toISOString()
    await kv.put(SLACK_CONNS_LASTGOOD_KEY, await encryptSecret(JSON.stringify(copy), secretKeys))
  } catch (e) {
    console.error(`[slack-copy] last-good Slack connections write failed: ${formatErr(e)}`)
  }
}

/** What editing one organization's entry did. Only a refused KV read or write is a failure, and that throws. */
export type SlackCopyEdit = 'written' | 'unchanged' | 'no_copy' | 'unreadable'

/**
 * Set one organization's entry in the copy to `connection`, or remove it when
 * `connection` is null (#2060): the Slack settings routes call this after their
 * database write, so an org that disconnected or changed its settings is not
 * posted to from the old entry during an outage. Every other entry and the save
 * time are kept as they are: the save time dates the last read of EVERY
 * organization, which one org's edit is not.
 *
 * No copy, or the org already absent, writes nothing. A copy that cannot be
 * decrypted is left alone: no reader can post from it either, and the next
 * successful all-org read replaces it. Throws when KV refuses the read or the
 * write, for the route to report (stored-copy.ts copyCleared).
 *
 * Not atomic with the writer: a writer whose read began before the route's
 * database write can put the old entry back, until its next healthy minute.
 */
export async function editSlackCopyEntry(
  kv: CopyKv & { put(key: string, value: string): Promise<void> },
  secretKeys: SecretKeyInput,
  orgId: string,
  connection: SlackConnection | null,
): Promise<SlackCopyEdit> {
  if (orgId === SLACK_COPY_SAVED_AT_KEY) throw new Error(`${SLACK_COPY_SAVED_AT_KEY} is reserved and cannot name an organization`)
  const blob = await kv.get(SLACK_CONNS_LASTGOOD_KEY)
  if (!blob) return 'no_copy'
  let copy: Record<string, unknown>
  try {
    copy = JSON.parse(await decryptSecret(blob, secretKeys)) as Record<string, unknown>
  } catch (e) {
    console.warn(`[slack-copy] saved Slack copy unreadable, so org ${orgId} was not edited in it (nobody can post from it): ${formatErr(e)}`)
    return 'unreadable'
  }
  if (connection) {
    copy[orgId] = connection
  } else {
    if (!(orgId in copy)) return 'unchanged'
    delete copy[orgId]
  }
  await kv.put(SLACK_CONNS_LASTGOOD_KEY, await encryptSecret(JSON.stringify(copy), secretKeys))
  return 'written'
}
