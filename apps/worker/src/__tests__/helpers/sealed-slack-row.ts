/**
 * A Slack alert row in the shape the database holds it (#2331's contract
 * release): the bot token sealed into credential_enc with a test key ring, and
 * NO bot_token in config. A reader takes the token from credential_enc only, so
 * a test double serving a Slack row builds it here and registers the ring on
 * its client (withSlackKeyRing), the way createSupabaseClient does in
 * production. A fixture that still carries config.bot_token describes a row the
 * database refuses (service_connections_no_plaintext_token) and reads as no
 * connection.
 *
 * The key is a placeholder of 32 sevens, the same one the scheduled Slack
 * doubles use (lib/__tests__/_scheduled-slack-doubles.ts).
 */
import { encryptSecret, type SecretKeys } from '../../lib/secret-crypto'
import { registerSlackKeyRing } from '../../lib/slack-key-ring'

export const SLACK_TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
export const SLACK_TEST_RING: SecretKeys = { encryptWith: SLACK_TEST_KEY, decryptWith: [SLACK_TEST_KEY] }

/** The row's columns as stored: config without the token, and the token sealed. Extra fields (organization_id, id) pass through. */
export async function sealedSlackRow<C extends Record<string, unknown>>(
  connection: C,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> & { config: Omit<C, 'bot_token'>; credential_enc: string | null }> {
  const { bot_token: token, ...config } = connection
  const credential_enc = typeof token === 'string' && token.length > 0 ? await encryptSecret(token, SLACK_TEST_RING) : null
  return { ...extra, config, credential_enc }
}

/** Register the test key ring on a client double, as createSupabaseClient does for a real one. Returns the client. */
export function withSlackKeyRing<T extends object>(client: T): T {
  registerSlackKeyRing(client, SLACK_TEST_RING)
  return client
}

/**
 * A route double's answer to the two Slack alert config saves of migration
 * 20261027170000 (#2643): save_slack_alert_token and save_slack_alert_settings
 * each merge what they were sent into `row`'s config (the token save also
 * replacing its sealed token) and return the row as written, which is what the
 * routes rebuild the saved Slack copy from. The settings route calls the five
 * argument save_slack_alert_settings of migration 20261027230000 (#2870), whose
 * p_actor_email this double does not record, since it holds only config and
 * the token. The real functions are proven in
 * supabase/tests/slack_alert_config_own_keys.test.sql and
 * supabase/tests/slack_alert_settings_changed_by.test.sql. Any other function
 * answers its rows from `others`, or null. Hand it to makeSupabase as `rpc`.
 */
export function answerSlackConfigSaves(row: Record<string, unknown> = {}, others: Record<string, unknown[]> = {}) {
  return async (name: string, args: unknown): Promise<{ data: unknown; error: unknown }> => {
    const sent = args as Record<string, unknown>
    const stored = row.config && typeof row.config === 'object' ? (row.config as Record<string, unknown>) : {}
    if (name === 'save_slack_alert_token') {
      Object.assign(row, { config: { ...stored, ...(sent.p_config as object) }, credential_enc: sent.p_credential_enc })
    } else if (name === 'save_slack_alert_settings') {
      Object.assign(row, { config: { ...stored, ...(sent.p_settings as object) } })
    } else {
      return { data: others[name] ?? null, error: null }
    }
    return { data: [{ id: row.id ?? 'sc-1', config: row.config, credential_enc: row.credential_enc ?? null }], error: null }
  }
}
