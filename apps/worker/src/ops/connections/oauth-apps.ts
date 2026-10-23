/**
 * The OAuth apps the ops Worker holds for person bound logins (#2338, build PR
 * 13; Dan's decision of 2026-10-22, recorded on #2338).
 *
 * A person bound connection (an OAuth user login: "Sign in with your own
 * Google account", R17) is the person's refresh token, issued to one OAuth app.
 * Its token requests (the code exchange and every refresh, both in the
 * connection's ConnectionTokenObject) must name that app's client id, and for a
 * confidential web client, its client secret. Dan decided the secret lives ONLY
 * on the ops Worker, as its own secret: the connection's sealed login holds the
 * app's client id and the person's refresh token, never the secret, and the
 * bidding Worker never holds it, so rotating it is one secret change.
 *
 * So each service with a person bound login names here the ops Worker secret
 * that holds its app, as the client JSON the provider issues (Google Cloud's
 * "Download JSON": `{ "web": { "client_id", "client_secret", "token_uri", ... } }`,
 * or the two fields written flat). The client id is read from the same secret,
 * so the id the authorize link names (OpsConnections.signInClient) and the
 * secret the exchange sends cannot come from two homes and disagree (L83).
 *
 * clientFor decides what a token request names: the login's own client for a
 * service with no app here; for one with an app, the login's client id with the
 * app's secret, refusing a login that carries a secret of its own (the bidding
 * Worker never seals one), a login issued to another app than the one held (a
 * person signs in again: refused, so needs_reauth), and an app unset or
 * unreadable (not_allowed, by rule: the login is not at fault, nothing is
 * recorded against it).
 *
 * Neither function ever says what the secret holds: a read names only which
 * secret is unset or unreadable.
 */
import { GOOGLE_TOKEN_URI } from './minters/google'
import type { TokenObjectFailure } from './token-object-contract'

export interface OAuthAppDeclaration {
  /** The ops Worker secret holding the app's client JSON; listed in OPS_ALLOWED_SECRETS. */
  readonly secret: string
  /** The only token endpoint the app may name, when its JSON names one. */
  readonly tokenUri: string
}

/** The apps, by service key. A service not listed has no app on this Worker. */
export const OPS_OAUTH_APPS: Readonly<Record<string, OAuthAppDeclaration>> = {
  google: { secret: 'GOOGLE_OAUTH_CLIENT', tokenUri: GOOGLE_TOKEN_URI },
}

export type OAuthAppRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'unset'; readonly secret: string }
  | { readonly kind: 'malformed'; readonly secret: string }
  | { readonly kind: 'app'; readonly clientId: string; readonly clientSecret: string }

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** The service's app as the ops Worker holds it. Never throws, and never carries what an unreadable secret held. */
export function oauthAppOf(env: Readonly<Record<string, unknown>>, service: string): OAuthAppRead {
  if (!Object.hasOwn(OPS_OAUTH_APPS, service)) return { kind: 'none' }
  const declared = OPS_OAUTH_APPS[service]
  const raw = Object.hasOwn(env, declared.secret) ? env[declared.secret] : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: 'unset', secret: declared.secret }
  const malformed: OAuthAppRead = { kind: 'malformed', secret: declared.secret }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return malformed
  }
  if (!isRecord(parsed)) return malformed
  // A web client, as Google Cloud downloads it, or the two fields written flat. A desktop
  // ("installed") client cannot redirect to the Connections page, so it is not one.
  const app = isRecord(parsed.web) ? parsed.web : Object.hasOwn(parsed, 'installed') ? null : parsed
  if (app === null) return malformed
  const tokenUri = Object.hasOwn(app, 'token_uri') ? app.token_uri : declared.tokenUri
  if (!text(app.client_id) || !text(app.client_secret) || tokenUri !== declared.tokenUri) return malformed
  return { kind: 'app', clientId: app.client_id.trim(), clientSecret: app.client_secret }
}

const failure = (kind: TokenObjectFailure['kind'], reason: TokenObjectFailure['reason']): TokenObjectFailure => ({ ok: false, kind, reason, retryAtMs: null })

/**
 * The client a token request names, from an opened person bound login (whose
 * client_id the token object has already checked is a non empty string, and
 * whose client_secret is absent or a non empty string) and its service's app.
 */
export function clientFor(
  login: Readonly<Record<string, unknown>>, app: OAuthAppRead,
): { readonly ok: true; readonly clientId: string; readonly clientSecret: string | null } | TokenObjectFailure {
  const clientId = login.client_id as string
  const ownSecret = typeof login.client_secret === 'string' ? login.client_secret : null
  if (app.kind === 'none') return { ok: true, clientId, clientSecret: ownSecret }
  // The app's secret lives only on ops (Dan, 2026-10-22): a sealed one is not a login this Worker reads.
  if (Object.hasOwn(login, 'client_secret')) return failure('refused', 'login_malformed')
  if (app.kind === 'unset') return failure('not_allowed', 'oauth_app_unset')
  if (app.kind === 'malformed') return failure('not_allowed', 'oauth_app_malformed')
  // A refresh token answers only to the app it was issued to.
  if (app.clientId !== clientId) return failure('refused', 'client_id_mismatch')
  return { ok: true, clientId, clientSecret: app.clientSecret }
}
