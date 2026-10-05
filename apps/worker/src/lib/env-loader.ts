// KV-cached env var loader: avoids a Supabase round-trip on every execution.
// Cache is per-org, TTL 300s. Invalidated explicitly on any env var mutation.
// Pre-warmed by the scheduled cron in index.ts.
//
// #391: a transient DB error must NEVER be cached as an empty env map. Doing so
// blanked the non-secret Salesforce creds for the full 300s TTL and caused a
// 2026-06-26 lead outage (a brief connection-pool blip cascaded into ~5 min of
// failures). So: only cache a SUCCESSFUL load, and keep a long-lived "last-good"
// copy to serve during a blip so creds don't go blank at all.
//
// #491: the cached map holds DECRYPTED secrets, so it is now encrypted at rest in
// KV. Secrets are encrypted in Postgres precisely so they are not lying around in
// the clear, and decrypting them into a plaintext cache undid that: anyone able to
// read the KV namespace (a leaked Cloudflare token) could read every live
// credential. The last-good copy has no TTL, so a rotated or deleted credential's
// plaintext sat there indefinitely. Both keys now hold ciphertext, and invalidation
// re-warms last-good so a superseded credential does not survive its own rotation.
//
// #1681: a variable can be saved against ONE workflow (scope 'workflow'). Until
// then the loader read only the org wide rows, so such a value never reached the
// run it was saved for. A run now gets the org values with its own workflow's
// values laid over them, its own winning on a shared key, and never another
// workflow's.
//
// How that is cached, and why:
// - ONE database read per organization loads every row, org wide and per
//   workflow, and ONE pair of copies per organization holds the result. The
//   values for a particular workflow are picked out when a run asks, never
//   stored per workflow. So invalidation stays a single organization's keys,
//   reached by every save exactly as before, and the last-good copy covers every
//   workflow at once. A cache key per workflow would need every save to find
//   and clear every workflow's key, and a missed one serves a stale value.
// - The org values stay in the entries they always lived in, `env-vars-<org>` and
//   its last-good copy, in the same flat format. That is expand before contract
//   (ADR 0007) for a cache: the release before this one still reads those two
//   entries, so rolling back hands its runs what it expects rather than an
//   object with no credentials in it.
// - An org with NO workflow values (every org in production when this shipped)
//   gets exactly what the release before wrote: those two entries, the same flat
//   map, one encryption. Nothing else is written, so its cache and the
//   randomness the money gate pins are the same as before, byte for byte.
// - An org WITH workflow values also gets a pair beside them,
//   `env-vars-<org>-workflow-scoped` and its last-good copy, and the org entry
//   carries one extra value, under a key no stored variable can have (MARKER),
//   naming the load that wrote that pair and, for each workflow, the NAMES of
//   its own keys (never a value). So the org entry itself says whether there is
//   anything beside it, and a run is served from the cache only when the pair it
//   names is there and came from the same load. A missing or mismatched pair
//   reloads, so a run is never handed the org values alone because its own copy
//   expired, was deleted, or lost a race a moment earlier.
// - While the database is down, a workflow last-good copy that is missing or
//   unreadable cannot be reloaded. The org values are served, but every key the
//   marker names for a workflow is withheld from that workflow's runs, exactly as
//   an undecryptable workflow secret is: the org's credential is never sent where
//   a workflow saved its own, and nothing else goes blank (#391).

import type { SupabaseClient } from '@supabase/supabase-js'
import { formatErr } from './format-error'
import { isOrgOnlyEnvKey } from './org-only-env-keys'
import { fetchAllPaged } from './paginate'
import { decryptSecret, encryptSecret, type SecretKeyInput } from './secret-crypto'

const TTL = 300
const cacheKey = (orgId: string) => `env-vars-${orgId}`
const lastGoodKey = (orgId: string) => `env-vars-${orgId}-lastgood`
const workflowCacheKey = (orgId: string) => `env-vars-${orgId}-workflow-scoped`
const workflowLastGoodKey = (orgId: string) => `env-vars-${orgId}-workflow-scoped-lastgood`

/**
 * The most pages of 1,000 rows one organization's read may take: 50,000 rows.
 * Production held 60 on 2026-10-05; the bound only stops a read that never ends
 * from running unbounded, and such a read is refused, never cached.
 */
export const ENV_READ_MAX_PAGES = 50

interface EnvRow {
  key: string
  value: string | null
  is_secret: boolean
  scope: string
  workflow_id: string | null
}

/**
 * Which values a load is for (#1681). A run names its workflow, so it gets that
 * workflow's own values over the org ones. A caller with no workflow (the cache
 * prewarm, the scheduled Salesforce jobs) asks for the org values only, and says
 * so: there is no default, so a run that forgets its workflow fails to compile
 * rather than silently running without the values saved for it (L168).
 */
export type EnvVarsFor = { workflowId: string } | 'global-only'

/**
 * The per workflow values, keyed by workflow id. A value of `null` is a secret
 * saved for that workflow that could not be decrypted: it is WITHHELD from the
 * workflow's runs, never replaced by the org value of the same key.
 */
type WorkflowScoped = Record<string, Record<string, string | null>>

interface OrgEnv {
  global: Record<string, string>
  workflows: WorkflowScoped
}

/**
 * The key, inside the org entry, holding the marker: a JSON string naming the
 * load that also wrote the workflow copies and, per workflow, the names of its
 * own keys. It starts with a NUL, which a Postgres text column cannot hold, so no
 * stored variable can ever collide with it. The release before this one would
 * see it as one more env value holding ids and names, which nothing reads.
 */
const MARKER = '\u0000workflow-scoped-load'

interface Marker {
  load: string
  /** Workflow id to the names of the keys that workflow saved its own value for. */
  keys: Record<string, string[]>
}

function parseMarker(raw: unknown): Marker | null {
  if (typeof raw !== 'string') return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!isPlainObject(v) || typeof v.load !== 'string' || !isPlainObject(v.keys)) return null
    const keys: Record<string, string[]> = {}
    for (const [workflowId, names] of Object.entries(v.keys)) {
      if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) return null
      keys[workflowId] = names as string[]
    }
    return { load: v.load, keys }
  } catch {
    return null
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// Read an encrypted entry out of KV. A blob we cannot decrypt is treated as a
// MISS, never as an error: that is what a SECRET_ENCRYPTION_KEY rotation (a
// documented operation) leaves behind, and also what the pre-#491 plaintext entries
// look like on the first deploy after this ships. In both cases the right move is
// the same, fall through to the DB and rewrite the entry, which self-heals them.
async function readEncrypted(
  kv: KVNamespace,
  key: string,
  secretEncryptionKey: SecretKeyInput
): Promise<Record<string, unknown> | null> {
  const blob = await kv.get(key)
  if (!blob) return null
  try {
    const parsed: unknown = JSON.parse(await decryptSecret(blob, secretEncryptionKey))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Read one org entry and, when it names one, the workflow copy beside it.
 *
 * `exact` (the short cache) trusts the workflow copy only when it came from the
 * load the org entry names, and otherwise reports a miss so the caller reloads.
 * `lenient` (last-good, read while the database is down) takes whatever workflow
 * copy is there: two last-good copies disagree only when two successful loads
 * raced moments apart, and either is better than nothing during an outage. When
 * there is no readable workflow copy at all, it withholds every key the marker
 * names for each workflow rather than letting the org value stand in for it.
 */
async function readCopies(
  orgId: string,
  kv: KVNamespace,
  keys: { org: string; workflows: string },
  secretEncryptionKey: SecretKeyInput,
  match: 'exact' | 'lenient'
): Promise<OrgEnv | null> {
  const entry = await readEncrypted(kv, keys.org, secretEncryptionKey)
  if (!entry) return null
  const global = Object.fromEntries(
    Object.entries(entry).filter((pair): pair is [string, string] => pair[0] !== MARKER && typeof pair[1] === 'string')
  )
  // The load that wrote this entry found no workflow values, and says so itself.
  if (!Object.hasOwn(entry, MARKER)) return { global, workflows: {} }

  const marker = parseMarker(entry[MARKER])
  const copy = await readEncrypted(kv, keys.workflows, secretEncryptionKey)
  const workflows = copy && isPlainObject(copy.workflows) ? (copy.workflows as WorkflowScoped) : null
  if (match === 'exact') return marker && workflows && copy?.load === marker.load ? { global, workflows } : null
  if (workflows) return { global, workflows }

  // The database is down and the workflow copy is missing or unreadable. The org
  // values are served (blanking them is the #391 outage), and each workflow's own
  // keys are withheld, as an undecryptable workflow secret is, so the org's value
  // is never sent where a workflow saved its own.
  if (!marker) {
    // Only a fault in this file's own writer gets here: the entry is encrypted
    // with an authenticated cipher, so a marker it wrote cannot arrive garbled.
    console.error(`[env-loader] the last-good copy for org ${orgId} names workflow values, but neither they nor their key names can be read; serving the org values only`)
    return { global, workflows: {} }
  }
  const withheld: WorkflowScoped = {}
  for (const [workflowId, names] of Object.entries(marker.keys)) {
    withheld[workflowId] = Object.fromEntries(names.map((name) => [name, null]))
    console.error(`[env-loader] the workflow scoped last-good copy for org ${orgId} is missing or unreadable; withholding ${names.join(', ')} for workflow ${workflowId} until the database answers`)
  }
  return { global, workflows: withheld }
}

/** The org values with one workflow's own laid over them, or the org values alone. */
function valuesFor(orgEnv: OrgEnv, scope: EnvVarsFor): Record<string, string> {
  if (scope === 'global-only') return { ...orgEnv.global }
  // An own property test, so a workflow id can never resolve to something the
  // object inherits (L738).
  const own = Object.hasOwn(orgEnv.workflows, scope.workflowId) ? orgEnv.workflows[scope.workflowId] : {}
  // A withheld secret is handed over EMPTY rather than left out. Left out, the org
  // value of the same key would show through here, and a code node's sandbox
  // would fill it from the Worker secret of the same name (buildSandboxEnv lays
  // the Worker secrets underneath these values), which is the org's copy too. An
  // empty credential fails at the call that needs it; the org's one would be sent.
  // Anything but a string is treated the same way. Built with fromEntries so a
  // stored key can only ever become an own property.
  return Object.fromEntries([
    ...Object.entries(orgEnv.global),
    ...Object.entries(own).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : '']),
  ])
}

async function loadOrgEnv(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  secretEncryptionKey: SecretKeyInput
): Promise<OrgEnv> {
  const cached = await readCopies(orgId, kv, { org: cacheKey(orgId), workflows: workflowCacheKey(orgId) }, secretEncryptionKey, 'exact')
  if (cached) return cached

  // Load ALL user env vars, including is_secret ones, so nodes (code-node `env`
  // global and {{env.X}} template resolution) can read the credentials they
  // exist to use (Dan 2026-06-26). is_secret is a UI-masking flag, not an access
  // gate. Secret values are stored ENCRYPTED (secret-crypto), so they MUST be
  // decrypted here. Injecting the raw ciphertext is what broke Equifax on
  // 2026-06-26 (the node sent the encrypted blob as the password, a 401), so a
  // secret that fails to decrypt is never passed through raw; for code, Webhook
  // and Salesforce nodes the Cloudflare worker-secret binding remains the fallback
  // for an org secret (buildSandboxEnv).
  // Platform master secrets (worker bindings) are blocked separately in
  // lib/sandbox-env.ts.
  //
  // Every scope in one read (#1681); the rows are split by scope below. What is
  // read is cached as the organization's whole set, so it is every row or none:
  // PostgREST answers at most 1,000 rows and says nothing, so the read pages on
  // a unique key (created_at first, so of two org rows sharing a key the newer
  // wins, then id, so no row is skipped or read twice between pages, L746) and
  // a read not finished within the bound is refused rather than returned short.
  let data: EnvRow[]
  try {
    data = await fetchAllPaged<EnvRow>(
      (from, to) =>
        supabase
          .from('environment_variables')
          .select('key, value, is_secret, scope, workflow_id')
          .eq('organization_id', orgId)
          .order('created_at')
          .order('id')
          .range(from, to),
      `environment_variables read for org ${orgId}`,
      { maxPages: ENV_READ_MAX_PAGES }
    )
  } catch (e) {
    // Do NOT cache on error: that is the #391 outage. Fall back to the last-good
    // copy (the config vars rarely change) so a transient blip degrades
    // gracefully instead of blanking creds; empty only if we never had a good load.
    // A failure on any page is the same failure, so a partial read is never used.
    console.error(`[env-loader] load failed for org ${orgId}, not caching: ${formatErr(e)}`)
    const lastGood = await readCopies(orgId, kv, { org: lastGoodKey(orgId), workflows: workflowLastGoodKey(orgId) }, secretEncryptionKey, 'lenient')
    return lastGood ?? { global: {}, workflows: {} }
  }

  const global: Record<string, string> = {}
  const workflows: WorkflowScoped = {}
  for (const row of data) {
    if (!row.value) continue
    // A workflow scoped row that names no workflow belongs to no run.
    const workflowId = row.scope === 'workflow' ? row.workflow_id : null
    if (row.scope !== 'global' && !workflowId) continue
    // The Salesforce connection is the organization's only (org-only-env-keys).
    // The API refuses one for a workflow; a row that got in some other way is
    // left out and named, never applied.
    if (workflowId && isOrgOnlyEnvKey(row.key)) {
      console.error(`[env-loader] ignoring ${row.key} saved for workflow ${workflowId} in org ${orgId}: it is the organization's Salesforce connection`)
      continue
    }

    let value: string | null = row.value
    if (row.is_secret) {
      try {
        value = await decryptSecret(row.value, secretEncryptionKey)
      } catch {
        // Created pre-encryption or key rotated: never poison the env with
        // ciphertext (the 2026-06-26 Equifax outage). An org secret is skipped;
        // a workflow's own is withheld, so the org value cannot stand in for it.
        value = null
        console.error(
          workflowId
            ? `[env-loader] could not decrypt secret ${row.key} saved for workflow ${workflowId} in org ${orgId}; withholding it from that workflow's runs`
            : `[env-loader] could not decrypt secret ${row.key} for org ${orgId}; skipping`
        )
      }
    }

    if (workflowId) {
      ;(workflows[workflowId] ??= {})[row.key] = value
    } else if (value !== null) {
      global[row.key] = value
    }
  }

  // Encrypted at rest (#491): these carry the decrypted secrets. Short cache for
  // the hot path; long-lived last-good (no TTL) for blip resilience.
  if (Object.keys(workflows).length === 0) {
    // Exactly what the release before wrote, in the same order, with the one
    // encryption it made.
    const serialized = await encryptSecret(JSON.stringify(global), secretEncryptionKey)
    await kv.put(cacheKey(orgId), serialized, { expirationTtl: TTL })
    await kv.put(lastGoodKey(orgId), serialized)
    // Nothing reads a workflow copy while the org entry names no load, but one an
    // earlier load left would keep a deleted workflow secret's ciphertext in KV
    // for good, so it goes (#491). Tidying only: a failed delete is logged and
    // never fails the run waiting on this load.
    try {
      await Promise.all([kv.delete(workflowCacheKey(orgId)), kv.delete(workflowLastGoodKey(orgId))])
    } catch (e) {
      console.error(`[env-loader] could not remove the workflow scoped copies for org ${orgId}: ${formatErr(e)}`)
    }
    return { global, workflows }
  }

  const load = crypto.randomUUID()
  // The marker carries each workflow's key NAMES, never a value, so the org entry
  // holds no workflow credential however it is read.
  const marker: Marker = {
    load,
    keys: Object.fromEntries(Object.entries(workflows).map(([workflowId, values]) => [workflowId, Object.keys(values)])),
  }
  const orgBlob = await encryptSecret(JSON.stringify({ ...global, [MARKER]: JSON.stringify(marker) }), secretEncryptionKey)
  const workflowsBlob = await encryptSecret(JSON.stringify({ load, workflows }), secretEncryptionKey)
  // The workflow copies first, so an org entry naming this load is never held
  // before the copy it names.
  await kv.put(workflowCacheKey(orgId), workflowsBlob, { expirationTtl: TTL })
  await kv.put(workflowLastGoodKey(orgId), workflowsBlob)
  await kv.put(cacheKey(orgId), orgBlob, { expirationTtl: TTL })
  await kv.put(lastGoodKey(orgId), orgBlob)
  return { global, workflows }
}

export async function loadEnvVars(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  secretEncryptionKey: SecretKeyInput,
  scope: EnvVarsFor
): Promise<Record<string, string>> {
  return valuesFor(await loadOrgEnv(orgId, kv, supabase, secretEncryptionKey), scope)
}

export async function invalidateEnvCache(
  orgId: string,
  kv: KVNamespace,
  supabase: SupabaseClient,
  secretEncryptionKey: SecretKeyInput
): Promise<void> {
  // The org entry first: once it is gone every read is a miss, whatever is beside it.
  await kv.delete(cacheKey(orgId))
  await kv.delete(workflowCacheKey(orgId))

  // Re-warm, rather than only dropping the short key (#491). Last-good has no TTL,
  // so a rotated or deleted credential used to sit in it forever. Loading fresh here
  // overwrites it with only the current values, so the superseded one leaves KV.
  // One load covers the org values and every workflow's (#1681).
  //
  // Overwrite, never delete: last-good is what keeps creds from going blank during a
  // DB blip (#391), and deleting it would reopen that outage for the window after
  // every edit. If this re-warm's read fails, last-good keeps its previous contents
  // (stale, but encrypted at rest, and purged by the next successful load) rather
  // than leaving the org with nothing to fall back on. The caller has just committed
  // a DB write, so the read is overwhelmingly likely to succeed.
  try {
    await loadOrgEnv(orgId, kv, supabase, secretEncryptionKey)
  } catch (e) {
    console.error(
      `[env-loader] cache re-warm after mutation failed for org ${orgId}: ${formatErr(e)}`
    )
  }
}
