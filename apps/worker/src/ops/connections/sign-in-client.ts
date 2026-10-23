/**
 * OpsConnections.signInClient (#2338, build PR 13; R17): the client id of the
 * sign in app the ops Worker holds for a service (oauth-apps.ts), for the
 * bidding Worker's Sign in with Google link.
 *
 * WHO CALLS IT: only a Worker bound to the OpsConnections entrypoint, the
 * bidding Worker, from its sign in route, which takes a user JWT. WHOSE DATA:
 * none. It reads one secret of the ops Worker's own and answers its public
 * half; the request names the caller's organization only so the answer is
 * logged against it, as every OpsConnections call is. The secret never
 * crosses: an unset or unreadable app is answered by the secret's name alone.
 */
import type { SignInClientAnswer, SignInClientRequest } from '../../lib/ops-connections-contract'
import type { OAuthAppRead } from './oauth-apps'

export interface SignInClientDeps {
  /** The app the ops Worker holds for a service: oauthAppOf over its env. */
  app(service: string): OAuthAppRead
}

export function signInClient(deps: SignInClientDeps, request: SignInClientRequest): SignInClientAnswer {
  const read = deps.app(request.service)
  const refused = (code: 'sign_in_app_unset' | 'sign_in_app_malformed' | 'sign_in_not_offered', detail: string): SignInClientAnswer =>
    ({ ok: false, refused: code, detail, retry_at: null })
  switch (read.kind) {
    case 'none':
      return refused('sign_in_not_offered', `the ${request.service} service has no sign in on this Worker`)
    case 'unset':
      return refused('sign_in_app_unset', `${read.secret} is not set on bidspoke-worker-ops, so nobody can sign in to ${request.service} yet`)
    case 'malformed':
      return refused('sign_in_app_malformed', `${read.secret} on bidspoke-worker-ops is not a web client's JSON this Worker reads, so nobody can sign in to ${request.service}`)
    case 'app':
      return { ok: true, service: request.service, client_id: read.clientId }
  }
}
