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
