// Integrations management: the Slack connection (Phase 1.7).
// POST   /api/integrations/slack/resolve   validate a token, return the workspace name and channel list
// POST   /api/integrations/slack           save or replace the Slack connection, once Slack accepts the token
// GET    /api/integrations/slack           the current Slack connection (token never returned)
// GET    /api/integrations/slack/channels  search channels by name
// PATCH  /api/integrations/slack/settings  alert toggles and channels
// DELETE /api/integrations/slack           disconnect
//
// Who may call these: any signed in user of the organization (jwtAuth). Whose
// data: only the caller's organization's Slack ALERT row, every read and write
// scoped by organization_id from the verified token, never from the request.
//
// The alert row (#2332, phase 2 of #1689). Once release 2 lets an organization
// hold an ops Slack connection beside the alert bot's row, every read here goes
// through onlySlackAlertRow (lib/slack-connection.ts): service_type 'slack',
// name 'slack', sealed_for 'bidding_ring' or the legacy unsealed form. So
// Settings never shows, edits, searches with or disconnects an ops connection.
// More than one candidate answers 409 with the named refusal
// slack_alert_connection_ambiguous and touches nothing, rather than reading as
// "not connected" (which is what PostgREST's more than one row error did).
//
// The token (#2331, phase 1 of #1689). POST seals the bot token into
// service_connections.credential_enc with the Worker's key ring and, in this
// release, keeps config.bot_token beside it (dual write): the code before this
// release, the wrangler rollback target, reads only config.bot_token, so the
// old field must stay readable until the contract release (L640). Every read
// of the token here goes through resolveSlackConnection (lib/slack-connection.ts),
// which opens the ciphertext first. The browser roles can no longer read the
// table at all (migration 20261017120000), which is what closed the exposure.
//
// The audit record (#2331, F119). The table's own trigger writes one audit_log
// row per change, naming the user from updated_by (every write here sets it)
// or, for the Disconnect, from delete_service_connection's actor, the way
// partner_configs is audited (#1409). So these routes write no audit row of
// their own: one record per change, not two, and the record exists whenever
// the change does, since the trigger runs in the same transaction.
//
// The saved Slack copy (#2060): alerts post from an encrypted copy of every
// org's connection while the database is down (lib/slack-copy.ts). POST, PATCH
// and DELETE each edit that org's entry in the copy with editSlackCopyEntry,
// after the database write, so an outage does not post to a connection just
// removed or a category just switched off. A request cut off between the two
// loses at worst the copy edit, which the next healthy minute repairs. The edit
// leaves the copy's save time alone (see editSlackCopyEntry).
//
// When KV refuses the edit, the change still answers 200, because it WAS saved
// and recorded, with stored_copy_warning beside it (lib/stored-copy.ts) and the
// failure logged; everything the edit needs (the key ring included) is read
// inside copyCleared, so nothing about the copy can fail the request. A copy no
// reader can decrypt is left alone without a warning, since nobody can post
// from it. The next minute the database probe's read answers rewrites the whole
// copy from the database (database-reachability.ts), which bounds how long a
// stale entry can last while the database is up. KV is eventually consistent,
// so a reader in another location can still see the old entry for up to about
// a minute.

import { Hono, type Context } from 'hono'
import { dbError, dbErrorUnlessNotFound, requireRowOr404, rowsTouched } from '../../lib/api-error'
import { fetchJson } from '../../lib/json'
import { createSlackClient, slackBodyOf, slackCallFailure, slackNetworkCause } from '../../lib/slack-client'
import type { Env } from '../../index'
import type { AuthVariables } from '../../middleware/jwt-auth'
import { createSupabaseClient } from '../../lib/supabase'
import { copyCleared, copyWarning } from '../../lib/stored-copy'
import { editSlackCopyEntry } from '../../lib/slack-copy'
import {
  onlySlackAlertRow,
  pickSlackAlertRow,
  resolveSlackConnection,
  slackAlertAmbiguityLine,
  slackTokenProblemLine,
  SLACK_ALERT_AMBIGUOUS,
  SLACK_ALERT_CONNECTION_NAME,
  SLACK_ALERT_READ_LIMIT,
  SLACK_ROW_COLUMNS,
  type SlackConnection,
  type SlackConnectionRow,
} from '../../lib/slack-connection'
import { encryptSecret, secretKeys, type SecretKeys } from '../../lib/secret-crypto'
import { formatErr } from '../../lib/format-error'

type Variables = AuthVariables

const integrations = new Hono<{ Bindings: Env; Variables: Variables }>()

/** The read of the caller's organization's Slack alert row (#2332): never an ops row, and enough rows to see two. */
function alertRowQuery(supabase: ReturnType<typeof createSupabaseClient>, orgId: string, columns: string) {
  return onlySlackAlertRow(supabase.from('service_connections').select(columns).eq('organization_id', orgId)).limit(SLACK_ALERT_READ_LIMIT)
}

/** More than one alert row: refused by name, logged, and nothing is read from or written to either. */
function ambiguousAlertRow(c: Context<{ Bindings: Env; Variables: Variables }>, orgId: string, what: string, count: number) {
  console.error(slackAlertAmbiguityLine(`integrations ${what} for org ${orgId}`, count))
  return c.json({ error: SLACK_ALERT_AMBIGUOUS }, 409)
}

integrations.post('/slack/resolve', async (c) => {
  const body = await c.req.json<{ bot_token: string }>()
  if (!body.bot_token) return c.json({ error: 'bot_token is required' }, 400)

  const token = body.bot_token.trim()
  // Through the one Slack client (#2331), each answer read as its body as
  // before (slackBodyOf), so the page is told exactly what it was.
  const slack = createSlackClient({ bot_token: token })

  const authData = await slackBodyOf('auth.test', () => slack.auth.test())
  if (!authData.ok) {
    return c.json({ error: `Invalid token: ${authData.error ?? 'auth.test failed'}` }, 400)
  }

  const chanData = await slackBodyOf('conversations.list', () =>
    slack.conversations.list({ types: ['public_channel', 'private_channel'], exclude_archived: true, limit: 1000 }),
  )

  const channels = chanData.ok
    ? (chanData.channels ?? []).map((ch) => ({ id: ch.id ?? '', name: ch.name ?? '' })).sort((a, b) => a.name.localeCompare(b.name))
    : []

  return c.json({ workspace_name: authData.team ?? '', channels })
})

/**
 * Ask Slack whether the token works before it is sealed (#2331): auth.test
 * through the one client. `ok` for a token Slack accepts; `refused` with
 * Slack's code for one it rejects. Anything that is not an answer about the
 * token (a 429, a 5xx, a body that is not JSON, no answer at all) throws, so
 * the save answers the generic 500 and writes nothing: a token Slack could
 * not be asked about is neither saved nor called invalid. A 429 is never
 * waited for.
 */
async function verifySlackToken(token: string): Promise<{ kind: 'ok' } | { kind: 'refused'; slackError: string | null }> {
  try {
    const answer = await createSlackClient({ bot_token: token }).auth.test()
    // The library throws only for ok:false WITH a code; without one it returns.
    if (answer.ok) return { kind: 'ok' }
    return { kind: 'refused', slackError: answer.error ?? null }
  } catch (e) {
    const failure = slackCallFailure(e)
    if (failure?.kind === 'api') return { kind: 'refused', slackError: failure.error }
    if (failure?.kind === 'http') {
      throw new Error(`auth.test answered HTTP ${failure.status}${failure.retryAfter ? ` (Retry-After ${failure.retryAfter} s, not waited for)` : ''}, so the token could not be checked`, { cause: e })
    }
    throw slackNetworkCause(e)
  }
}

integrations.post('/slack', async (c) => {
  const { orgId, userId, email } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{
    bot_token: string
    default_channel: string
    workspace_name?: string
  }>()

  if (!body.bot_token) return c.json({ error: 'bot_token is required' }, 400)
  if (!body.default_channel) return c.json({ error: 'default_channel is required' }, 400)

  // The token is checked with Slack before anything is sealed or written
  // (#2331): a token Slack rejects is refused by name, slack_token_invalid,
  // and Slack's own code is passed back beside it.
  const verified = await verifySlackToken(body.bot_token)
  if (verified.kind === 'refused') {
    console.error(`[integrations] slack_token_invalid: Slack refused the token for org ${orgId} (${verified.slackError ?? 'no code'}), so nothing was saved`)
    return c.json({ error: 'slack_token_invalid', slack_error: verified.slackError }, 400)
  }

  // config.bot_token stays beside the sealed copy in this release (dual write,
  // see the header): the rollback target reads only it.
  const config = {
    bot_token: body.bot_token,
    default_channel: body.default_channel,
    workspace_name: body.workspace_name ?? null,
  }

  let keys: SecretKeys
  let credentialEnc: string
  try {
    keys = secretKeys(c.env)
    credentialEnc = await encryptSecret(body.bot_token, keys)
  } catch (e) {
    console.error(`[integrations] the Slack token could not be sealed for org ${orgId}, so nothing was saved: ${formatErr(e)}`)
    return c.json({ error: 'slack_token_seal_failed: the token could not be sealed, so nothing was saved' }, 500)
  }

  // Upsert: the org's one alert row. The table's trigger audits it, naming
  // updated_by.
  //
  // #2332 (phase 2 of #1689): the row is named 'slack' and the conflict target
  // is UNIQUE (organization_id, service_type, name), from migration
  // 20261017150000, which backfilled that name onto every existing row. The old
  // UNIQUE (organization_id, service_type) still holds until release 2, so any
  // other name here would hit it and error instead of updating. No ops_key row
  // may be named 'slack' (service_connections_alert_name_reserved), so this
  // upsert can only ever land on an alert row, never on an ops connection's
  // credential_enc. This code deploys only once that migration is applied: the
  // deploy refuses while a merged migration is unapplied (#1829).
  const { error } = await supabase
    .from('service_connections')
    .upsert(
      {
        organization_id: orgId,
        service_type: 'slack',
        name: SLACK_ALERT_CONNECTION_NAME,
        auth_type: 'oauth',
        // The token is in credential_enc, not a Cloudflare secret (#2332).
        cf_secret_key: null,
        config,
        credential_enc: credentialEnc,
        sealed_for: 'bidding_ring',
        updated_by: userId,
        updated_by_email: email,
      },
      { onConflict: 'organization_id,service_type,name' }
    )
    .select('id')
    .single()

  if (error) return dbError(c, error)

  const copyEdited = await copyCleared(
    async () => {
      const entry = await copyEntryFor(keys, orgId, { config, credential_enc: credentialEnc })
      if (entry !== KEEP_ENTRY) await editSlackCopyEntry(c.env.IDEMPOTENCY, keys, orgId, entry)
    },
    `the saved Slack copy for org ${orgId}`,
  )

  return c.json({ ok: true, ...copyWarning(copyEdited) })
})

integrations.get('/slack', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const { data: rows } = await alertRowQuery(supabase, orgId, 'config, updated_at, updated_by_email')
  const picked = pickSlackAlertRow(rows as unknown as { config: unknown; updated_at: string; updated_by_email: string | null }[] | null)
  if (picked.kind === 'ambiguous') return ambiguousAlertRow(c, orgId, 'read', picked.count)
  const data = picked.row

  if (!data) return c.json({ connected: false })

  const cfg = data.config as Record<string, unknown> | null
  return c.json({
    connected: true,
    workspace_name: (cfg?.workspace_name as string | undefined) ?? null,
    default_channel: (cfg?.default_channel as string | undefined) ?? null,
    // Default true so existing connections keep getting volume alerts.
    volume_alerts_enabled: cfg?.volume_alerts_enabled !== false,
    matrix_alerts_enabled: cfg?.matrix_alerts_enabled !== false,
    config_alerts_enabled: cfg?.config_alerts_enabled !== false,
    backup_alerts_enabled: cfg?.backup_alerts_enabled !== false,
    matrix_alerts_channel: (cfg?.matrix_alerts_channel as string | undefined) ?? null,
    // never return the token
    updated_at: data.updated_at,
    updated_by_email: data.updated_by_email,
  })
})

// GET /api/integrations/slack/channels?q=foo — search channels by name substring.
// Requires q (>= 3 chars). Slack's conversations.list has no native query param,
// so we paginate through the workspace and filter server-side. Capped at 50 matches
// to keep the UI responsive on large workspaces.
integrations.get('/slack/channels', async (c) => {
  const { orgId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  if (q.length < 3) return c.json({ channels: [] })

  const { data: rows, error: readError } = await alertRowQuery(supabase, orgId, SLACK_ROW_COLUMNS)
  const readBlocked = dbErrorUnlessNotFound(c, readError)
  if (readBlocked) return readBlocked
  const picked = pickSlackAlertRow(rows as unknown as SlackConnectionRow[] | null)
  if (picked.kind === 'ambiguous') return ambiguousAlertRow(c, orgId, 'channel search', picked.count)

  const resolved = await resolveSlackConnection(picked.row, secretKeys(c.env))
  const subject = `integrations channel search for org ${orgId}`
  if (resolved.kind === 'unreadable') {
    console.error(slackTokenProblemLine(subject, resolved, false))
    return c.json({ error: `${resolved.reason}: the saved Slack token cannot be read; save the connection again` }, 500)
  }
  if (resolved.kind === 'none') return c.json({ error: 'Slack is not connected' }, 404)
  if (resolved.problem) console.error(slackTokenProblemLine(subject, resolved.problem, true))
  const token = resolved.connection.bot_token

  const matches: Array<{ id: string; name: string }> = []
  const MAX_MATCHES = 50
  const MAX_PAGES = 20  // 20 pages × 1000 = 20k channels ceiling
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://slack.com/api/conversations.list')
    url.searchParams.set('types', 'public_channel,private_channel')
    url.searchParams.set('exclude_archived', 'true')
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)

    const chanData = await fetchJson<{
      ok: boolean
      channels?: Array<{ id: string; name: string }>
      response_metadata?: { next_cursor?: string }
      error?: string
    }>(url.toString(), { headers: { Authorization: `Bearer ${token}` } })

    if (!chanData.ok) return c.json({ error: `Slack API error: ${chanData.error ?? 'unknown'}` }, 502)

    for (const ch of chanData.channels ?? []) {
      if (ch.name.toLowerCase().includes(q)) {
        matches.push({ id: ch.id, name: ch.name })
        if (matches.length >= MAX_MATCHES) break
      }
    }

    if (matches.length >= MAX_MATCHES) break
    cursor = chanData.response_metadata?.next_cursor
    if (!cursor) break
  }

  matches.sort((a, b) => a.name.localeCompare(b.name))
  return c.json({ channels: matches })
})

// PATCH /api/integrations/slack/settings — toggle alert preferences or change the
// default channel without re-uploading the bot token.
integrations.patch('/slack/settings', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  const body = await c.req.json<{ volume_alerts_enabled?: boolean; default_channel?: string; matrix_alerts_enabled?: boolean; matrix_alerts_channel?: string | null; config_alerts_enabled?: boolean; backup_alerts_enabled?: boolean }>()

  const { data: rows, error: existingErr } = await alertRowQuery(supabase, orgId, `id, ${SLACK_ROW_COLUMNS}`)

  const existingBlocked = dbErrorUnlessNotFound(c, existingErr)
  if (existingBlocked) return existingBlocked
  const picked = pickSlackAlertRow(rows as unknown as ({ id: string } & SlackConnectionRow)[] | null)
  if (picked.kind === 'ambiguous') return ambiguousAlertRow(c, orgId, 'settings change', picked.count)
  const existing = picked.row
  if (!existing) return c.json({ error: 'Slack is not connected' }, 404)

  const nextConfig = {
    ...((existing.config as Record<string, unknown> | null) ?? {}),
    ...(body.volume_alerts_enabled !== undefined ? { volume_alerts_enabled: body.volume_alerts_enabled } : {}),
    ...(body.default_channel ? { default_channel: body.default_channel } : {}),
    ...(body.matrix_alerts_enabled !== undefined ? { matrix_alerts_enabled: body.matrix_alerts_enabled } : {}),
    ...(body.matrix_alerts_channel !== undefined ? { matrix_alerts_channel: body.matrix_alerts_channel || null } : {}),
    ...(body.config_alerts_enabled !== undefined ? { config_alerts_enabled: body.config_alerts_enabled } : {}),
    ...(body.backup_alerts_enabled !== undefined ? { backup_alerts_enabled: body.backup_alerts_enabled } : {}),
  }

  const updateBlocked = await requireRowOr404(c, 'Slack is not connected', () =>
    supabase
      .from('service_connections')
      .update({ config: nextConfig, updated_by: userId })
      .eq('id', existing.id)
      .eq('organization_id', orgId)
      .select('id')
  )
  if (updateBlocked) return updateBlocked

  // The copy entry is the new settings with the token the row holds, opened
  // from credential_enc, so a row with no plaintext copy stays in the copy.
  const copyEdited = await copyCleared(
    async () => {
      // The ring is read in here, so a missing key can fail only the copy edit.
      const keys = secretKeys(c.env)
      const entry = await copyEntryFor(keys, orgId, { config: nextConfig, credential_enc: existing.credential_enc })
      if (entry !== KEEP_ENTRY) await editSlackCopyEntry(c.env.IDEMPOTENCY, keys, orgId, entry)
    },
    `the saved Slack copy for org ${orgId}`,
  )

  return c.json({ ok: true, ...copyWarning(copyEdited) })
})

integrations.delete('/slack', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)

  // The alert row first (#2332): more than one candidate is refused before
  // anything is deleted, and the saved copy is left as it is.
  const { data: rows, error: readError } = await alertRowQuery(supabase, orgId, 'id')
  if (readError) return dbError(c, readError)
  const picked = pickSlackAlertRow(rows as unknown as { id: string }[] | null)
  if (picked.kind === 'ambiguous') return ambiguousAlertRow(c, orgId, 'disconnect', picked.count)

  // Disconnecting a Slack that was never connected is a no-op, not an error, so
  // this stays 200. delete_service_connection deletes with the caller named as
  // the actor, so the table's trigger audits the removed row under this user
  // (#2331); a delete that matched nothing is audited by nobody (#588).
  //
  // It deletes the organization's Slack rows that are not ops_key rows
  // (migration 20261017150000, F124), so it can never remove an ops
  // connection. It does not take the alert row's name, so when it removes any
  // row other than the alert row just read (none can exist: no writer creates
  // a non ops Slack row under another name), that is said by name.
  if (picked.row) {
    const alertRowId = picked.row.id
    const { blocked, rows: deleted } = await rowsTouched<{ id: string }>(c, 'service_connections.slack_disconnect', () =>
      supabase.rpc('delete_service_connection', { p_organization_id: orgId, p_service_type: 'slack', p_actor: userId })
    )
    if (blocked) return blocked
    const others = deleted.map((r) => r.id).filter((id) => id !== alertRowId)
    if (others.length > 0) {
      console.error(`[integrations] slack_disconnect_removed_other_rows: Disconnect for org ${orgId} removed ${others.length} Slack row(s) besides the alert row ${alertRowId}: ${others.join(', ')}`)
    }
  }

  // Removed from the copy even when the delete matched no row: the database now
  // holds no connection for this org, so neither should the copy.
  const copyEdited = await copyCleared(
    () => editSlackCopyEntry(c.env.IDEMPOTENCY, secretKeys(c.env), orgId, null).then(() => undefined),
    `the saved Slack copy for org ${orgId}`,
  )

  return c.json({ ok: true, ...copyWarning(copyEdited) })
})

/** The copy entry is left exactly as it is. */
const KEEP_ENTRY = Symbol('keep the saved copy entry')

/**
 * The org's entry in the saved copy, from a row as it now stands (#2331): the
 * connection, null when the row holds none (the entry is removed, as before),
 * or KEEP_ENTRY when its token cannot be opened, said by name, rather than
 * deleting the last good copy of a connection that still exists (L105).
 */
async function copyEntryFor(keys: SecretKeys, orgId: string, row: SlackConnectionRow): Promise<SlackConnection | null | typeof KEEP_ENTRY> {
  const resolved = await resolveSlackConnection(row, keys)
  const subject = `integrations saved copy for org ${orgId}`
  if (resolved.kind === 'unreadable') {
    console.error(slackTokenProblemLine(subject, resolved, false))
    return KEEP_ENTRY
  }
  if (resolved.kind === 'connection' && resolved.problem) console.error(slackTokenProblemLine(subject, resolved.problem, true))
  return resolved.kind === 'connection' ? resolved.connection : null
}

export default integrations
