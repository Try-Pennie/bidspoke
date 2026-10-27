// The Slack alert connection (Phase 1.7). Since #2338 (build PR 14) the
// Integrations page is retired: the Connections page's Slack alerts login panel
// reads GET /slack, searches GET /slack/channels and saves PATCH
// /slack/settings, and its Reconnect saves a new token through
// saveSlackAlertConnection below, the one save of that token, which POST /slack
// calls too. POST /slack/resolve, POST /slack and DELETE /slack have no caller
// in the app since then: connecting a first alert bot, and disconnecting one,
// have no page (noted on #2338's PR 14).
// POST   /api/integrations/slack/resolve   validate a token, return the workspace name and channel list
// POST   /api/integrations/slack           save or replace the Slack connection, once Slack accepts the token
// GET    /api/integrations/slack           the current Slack connection (token never returned)
// GET    /api/integrations/slack/channels  search channels by name
// PATCH  /api/integrations/slack/settings  the alert switches and the default channel
// DELETE /api/integrations/slack           disconnect
//
// Who may call these: any signed in user of the organization (jwtAuth). Whose
// data: only the caller's organization's Slack ALERT row, every read and write
// scoped by organization_id from the verified token, never from the request.
//
// The alert row (#2332, phase 2 of #1689). Since release 2 (migration
// 20261019150000) an organization may hold an ops Slack connection beside the alert bot's row, every read here goes
// through onlySlackAlertRow (lib/slack-connection.ts): service_type 'slack',
// name 'slack', sealed_for 'bidding_ring' or the legacy unsealed form. So
// Settings never shows, edits, searches with or disconnects an ops connection.
// More than one candidate answers 409 with the named refusal
// slack_alert_connection_ambiguous and touches nothing, rather than reading as
// "not connected" (which is what PostgREST's more than one row error did).
//
// The token (#2331, phase 1 of #1689). POST seals the bot token into
// service_connections.credential_enc with the Worker's key ring, its only home
// since the contract release: config never carries it. Every read of the token
// here goes through resolveSlackConnection (lib/slack-connection.ts), which
// reads only the ciphertext. The browser roles can no longer read the table at
// all (migration 20261017120000), which is what closed the exposure.
//
// The audit record (#2331, F119). The table's own trigger writes one audit_log
// row per change, naming the user from updated_by (every write here sets it)
// or, for the Disconnect, from delete_service_connection_by_id's actor, the way
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
import { dbError, dbErrorUnlessNotFound, rowsTouched } from '../../lib/api-error'
import { createSlackClient, slackBodyOf } from '@bidspoke/slack-client'
import { verifySlackToken } from '../../lib/slack-token-check'
import type { Env } from '../../index'
import type { Json } from '../../types/database'
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
  SLACK_ALERT_READ_LIMIT,
  SLACK_ALERT_SETTINGS_KEYS,
  SLACK_ROW_COLUMNS,
  type SlackAlertTokenSaveConfig,
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
 * What the Settings page shows when Slack rejects a token on save, worded by
 * Dan (2026-10-17): Slack's own code in brackets, or no brackets when Slack
 * gave none.
 */
function slackTokenRefusedMessage(slackError: string | null): string {
  return slackError
    ? `Slack did not accept this token (${slackError}), so nothing was saved.`
    : 'Slack did not accept this token, so nothing was saved.'
}

// The token check before a save (#2331) is verifySlackToken in
// lib/slack-token-check.ts, which the Connections list asks too (#2338).

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
  // (#2331): a token Slack rejects is refused with the code
  // slack_token_invalid and Slack's own code beside it, and `error` carries
  // the sentence the Settings page shows (slackTokenRefusedMessage).
  const verified = await verifySlackToken(body.bot_token)
  if (verified.kind === 'refused') {
    console.error(`[integrations] slack_token_invalid: Slack refused the token for org ${orgId} (${verified.slackError ?? 'no code'}), so nothing was saved`)
    return c.json({ error: slackTokenRefusedMessage(verified.slackError), code: 'slack_token_invalid', slack_error: verified.slackError }, 400)
  }

  // The token is sealed into credential_enc and never kept in config (#2331's
  // contract release). Only the token save's own keys go into config (#2643),
  // so the alert switches a row already holds are kept as they stand.
  const saved = await saveSlackAlertConnection(c.env, supabase, { orgId, userId, email }, {
    bot_token: body.bot_token,
    config: { default_channel: body.default_channel, workspace_name: body.workspace_name ?? null },
  })
  if (saved.kind === 'seal_failed') return c.json({ error: 'slack_token_seal_failed: the token could not be sealed, so nothing was saved' }, 500)
  if (saved.kind === 'store_failed') return dbError(c, saved.error)
  return c.json({ ok: true, ...saved.copyWarning })
})

/** What saving the alert row's token came to: saved (with the saved copy's warning, when its edit failed), or refused before or at the write. */
export type SlackAlertSave =
  | { kind: 'saved'; copyWarning: ReturnType<typeof copyWarning> }
  | { kind: 'seal_failed' }
  | { kind: 'store_failed'; error: { code?: string; message: string } }

/** A row as save_slack_alert_token and save_slack_alert_settings return it: as written. */
interface WrittenAlertRow { id: string; config: unknown; credential_enc: string | null }

/**
 * The one save of the Slack alert row's bot token (#2331, #2338): seal it,
 * write it onto the organization's one alert row, then edit the saved Slack
 * copy. POST /slack calls it, and so does the Connections page's Reconnect on
 * the Slack alerts login (POST /api/connections/:id/reconnect), so there is one
 * way to save that token. The token is checked with Slack (verifySlackToken)
 * before either caller gets here.
 *
 * `config` holds only the keys the token save owns (#2643,
 * SLACK_ALERT_TOKEN_SAVE_KEYS): a Reconnect sends the workspace name Slack
 * gave, the first connect the channel too. save_slack_alert_token merges them
 * into the row's config in the one statement that writes the sealed token, so
 * the channel and the switches stay exactly as the row holds them when it
 * writes, even when a settings save lands at the same moment. Passing back the
 * config the caller had read, as this did before #2643, put back a switch
 * just turned off. The token itself is never in config (#2331's contract
 * release): it is sealed into credential_enc.
 *
 * Who: the caller's organization's row, from the verified token; updated_by
 * names the user, so the table's trigger audits the change under them.
 */
export async function saveSlackAlertConnection(
  env: Env,
  supabase: ReturnType<typeof createSupabaseClient>,
  who: { orgId: string; userId: string; email: string | null },
  save: { bot_token: string; config: SlackAlertTokenSaveConfig },
): Promise<SlackAlertSave> {
  const { orgId, userId, email } = who
  let keys: SecretKeys
  let credentialEnc: string
  try {
    keys = secretKeys(env)
    credentialEnc = await encryptSecret(save.bot_token, keys)
  } catch (e) {
    console.error(`[integrations] the Slack token could not be sealed for org ${orgId}, so nothing was saved: ${formatErr(e)}`)
    return { kind: 'seal_failed' }
  }

  // The org's one alert row (#2332): save_slack_alert_token upserts on UNIQUE
  // (organization_id, service_type, name 'slack'), as the Worker's own upsert
  // did. No ops_key row may be named 'slack' (service_connections_alert_name_reserved),
  // so it can only ever land on an alert row, never on an ops connection's
  // credential_enc. It seals a legacy unsealed row (sealed_for bidding_ring,
  // cf_secret_key cleared), and refuses a config key it does not own by name.
  // This code deploys only once migration 20261027120000 is applied: the deploy
  // refuses while a merged migration is unapplied (#1829).
  const { data, error } = await supabase.rpc('save_slack_alert_token', {
    p_organization_id: orgId,
    p_credential_enc: credentialEnc,
    p_config: save.config as Json,
    p_actor: userId,
    // The generated types call every argument text; a null email is passed as SQL NULL, which the nullable column takes.
    p_actor_email: email as string,
  })
  const written = (data as WrittenAlertRow[] | null)?.[0]
  if (error || !written) {
    return { kind: 'store_failed', error: error ?? { message: 'save_slack_alert_token returned no row' } }
  }

  // The copy entry is the row as written, so it carries the switches the row
  // holds now, not the ones this request started from.
  const copyEdited = await copyCleared(
    async () => {
      const entry = await copyEntryFor(keys, orgId, { config: written.config, credential_enc: written.credential_enc })
      if (entry !== KEEP_ENTRY) await editSlackCopyEntry(env.IDEMPOTENCY, keys, orgId, entry)
    },
    `the saved Slack copy for org ${orgId}`,
  )
  return { kind: 'saved', copyWarning: copyWarning(copyEdited) }
}

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
    console.error(slackTokenProblemLine(subject, resolved))
    return c.json({ error: `${resolved.reason}: the saved Slack token cannot be read; save the connection again` }, 500)
  }
  if (resolved.kind === 'none') return c.json({ error: 'Slack is not connected' }, 404)
  // Through the one Slack client (#2331), each page read as its body as
  // before (slackBodyOf), so the page is told exactly what it was.
  const slack = createSlackClient(resolved.connection)

  const matches: Array<{ id: string; name: string }> = []
  const MAX_MATCHES = 50
  const MAX_PAGES = 20  // 20 pages × 1000 = 20k channels ceiling
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const chanData = await slackBodyOf('conversations.list', () =>
      slack.conversations.list({ types: ['public_channel', 'private_channel'], exclude_archived: true, limit: 1000, cursor }),
    )

    if (!chanData.ok) return c.json({ error: `Slack API error: ${chanData.error ?? 'unknown'}` }, 502)

    for (const ch of chanData.channels ?? []) {
      const name = ch.name ?? ''
      if (name.toLowerCase().includes(q)) {
        matches.push({ id: ch.id ?? '', name })
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

// PATCH /api/integrations/slack/settings: toggle alert preferences or change the
// default channel without re-uploading the bot token.
//
// Only the settings in the body are sent, and save_slack_alert_settings merges
// them into the row's config in one statement (#2643), so a Reconnect landing
// at the same moment keeps the workspace name and token it saved, and this save
// keeps the switch it changed. Writing back the whole config this request had
// read, as it did before #2643, put back the Reconnect's old workspace name.
integrations.patch('/slack/settings', async (c) => {
  const { orgId, userId } = c.get('user')
  const supabase = createSupabaseClient(c.env)
  // matrix_alerts_channel is no longer taken (#2338): the bid matrix alerts post to the default channel.
  const raw = await c.req.json<unknown>()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'the settings must be an object' }, 400)
  const body = raw as Record<string, unknown>
  const settings: Record<string, string | boolean> = {}
  for (const key of SLACK_ALERT_SETTINGS_KEYS) {
    const value = body[key]
    if (value === undefined) continue
    if (key === 'default_channel') {
      // An empty channel leaves the saved one as it is, as it always has.
      if (typeof value !== 'string') return c.json({ error: 'default_channel must be a channel name' }, 400)
      if (value !== '') settings.default_channel = value
      continue
    }
    if (typeof value !== 'boolean') return c.json({ error: `${key} must be true or false` }, 400)
    settings[key] = value
  }

  const { data: rows, error: existingErr } = await alertRowQuery(supabase, orgId, 'id')

  const existingBlocked = dbErrorUnlessNotFound(c, existingErr)
  if (existingBlocked) return existingBlocked
  const picked = pickSlackAlertRow(rows as unknown as { id: string }[] | null)
  if (picked.kind === 'ambiguous') return ambiguousAlertRow(c, orgId, 'settings change', picked.count)
  const existing = picked.row
  if (!existing) return c.json({ error: 'Slack is not connected' }, 404)

  // No row back means the alert row went between the read and the write.
  const { rows: written, blocked } = await rowsTouched<WrittenAlertRow>(c, 'service_connections.slack_settings', () =>
    supabase.rpc('save_slack_alert_settings', {
      p_organization_id: orgId,
      p_connection_id: existing.id,
      p_settings: settings,
      p_actor: userId,
    }),
  )
  if (blocked) return blocked
  const row = written[0]
  if (!row) return c.json({ error: 'Slack is not connected' }, 404)

  // The copy entry is the row as written (the settings with the token the row
  // holds, opened from credential_enc, its only home), so the org stays in the
  // copy, with a token a Reconnect saved meanwhile rather than the one this
  // request would have read.
  const copyEdited = await copyCleared(
    async () => {
      // The ring is read in here, so a missing key can fail only the copy edit.
      const keys = secretKeys(c.env)
      const entry = await copyEntryFor(keys, orgId, { config: row.config, credential_enc: row.credential_enc })
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
  // this stays 200. delete_service_connection_by_id deletes with the caller
  // named as the actor, so the table's trigger audits the removed row under
  // this user (#2331); a delete that matched nothing is audited by nobody (#588).
  //
  // It deletes the alert row just read, by its id, within this organization and
  // never an ops_key row (migration 20261018150000, #2332). So now that release
  // 2 lets an organization hold another Slack row beside the alert row, the
  // Disconnect cannot remove it. (The delete by service type it replaced
  // removed every non ops Slack row of the organization, which is why #2374
  // logged slack_disconnect_removed_other_rows; that cannot happen now, as
  // supabase/tests/service_connections_delete_by_id.test.sql case B proves.)
  if (picked.row) {
    const alertRowId = picked.row.id
    const { blocked } = await rowsTouched<{ id: string }>(c, 'service_connections.slack_disconnect', () =>
      supabase.rpc('delete_service_connection_by_id', { p_organization_id: orgId, p_connection_id: alertRowId, p_actor: userId })
    )
    if (blocked) return blocked
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
    console.error(slackTokenProblemLine(subject, resolved))
    return KEEP_ENTRY
  }
  return resolved.kind === 'connection' ? resolved.connection : null
}

export default integrations
