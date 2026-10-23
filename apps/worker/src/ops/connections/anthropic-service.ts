/**
 * The ops Anthropic service as OpsConnections uses it (#2337, phase 7 of
 * #1689): an API key for one Anthropic workspace. Registered in services.ts.
 *
 * The login is `{ api_key }` (the static key minter's anthropic placement,
 * x-api-key, minters/static-key.ts); the target is `{ workspace_id }`. Every
 * request goes to api.anthropic.com, the one host declared, and carries the
 * key and the declared workspace (anthropic-workspace-id), both put on it by
 * connectionFetch, never by the caller. Anthropic runs a request with that
 * header in the workspace it names, so a key is only ever used in the
 * workspace its connection declares. The API version is the action's to send,
 * as the catalogue's Anthropic client sends it (ANTHROPIC_VERSION).
 *
 * THE EXPIRY SIGNAL is the static key minter's: a 401 (authentication_error).
 * connectionFetch renews once, which reads the same key again, and a second
 * 401 is needs_reauth. A refused key never ran the model, so the one repeat
 * cannot bill twice.
 *
 * WHAT VERIFY MEASURES, AND WHY NOTHING IS RECORDED. GET /v1/models, which
 * costs nothing, with the key and the declared workspace. A 200 proves the key
 * works in that workspace; Anthropic's `anthropic-organization-id` header
 * names the organization the key belongs to, and its `anthropic-workspace-id`
 * header, the workspace the request resolved to, must be the declared one, or
 * verify refuses it as verify_anthropic_workspace_mismatch. A different
 * workspace needs a new target, which is a new generation, so nothing is kept
 * about it.
 *
 * THE BIDDING KEY. The bidding Worker holds an Anthropic key of its own
 * (ANTHROPIC_API_KEY, or the anthropic_api_key setting) for drafting the
 * changelog, which moves no money. An ops connection is not refused for being
 * that key or its workspace (decided in #2337): Anthropic sets its rate and
 * spend limits per organization and workspace, so a refusal of the same key
 * would separate nothing the shared workspace does not already share, and a
 * refusal of the same workspace would turn away the organization's one
 * workspace for a use that is not money's.
 */
import { ANTHROPIC_VERSION } from '@bidspoke/service-catalogue/runtime'
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { targetFields, targetString } from './minters/login-fields'
import { STATIC_KEY_PLACEMENTS, staticKeyAuth } from './minters/static-key'
import { LoginMintError } from './refusals'
import type { OpsServiceEntry } from './ops-connections'
import type { AuthorizeInput } from './service-rules'

/** The one host an ops Anthropic connection reaches. */
export const ANTHROPIC_HOST = 'api.anthropic.com'

/** What verify asks: the models list, free, which every key may read. */
export const ANTHROPIC_VERIFY_URL = `https://${ANTHROPIC_HOST}/v1/models`

/** A workspace id Anthropic issues (wrkspc_...), and nothing a header could not carry. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The workspace a target declares. Throws LoginMintError (not_allowed, target_invalid) when it declares none, or one no header can carry. */
export function anthropicWorkspaceOf(target: unknown): string {
  const workspace = targetString(targetFields(target), 'workspace_id').trim()
  if (!WORKSPACE_ID.test(workspace)) throw new LoginMintError('not_allowed', 'target_invalid')
  return workspace
}

const header = (response: Response, name: string): string | null => {
  const value = response.headers.get(name)
  return value !== null && value.trim() !== '' ? value.trim() : null
}

export const anthropicIdentity: IdentityProbe = {
  kind: 'anthropic',
  async measure(fetch, target) {
    const workspace = anthropicWorkspaceOf(target)
    const response = await fetch(ANTHROPIC_VERIFY_URL, { method: 'GET', headers: { 'anthropic-version': ANTHROPIC_VERSION } })
    // Its status only: never Anthropic's body.
    if (!response.ok) throw new IdentityUnreadable(`the models list answered HTTP ${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new IdentityUnreadable('the models list answered a body that is not JSON')
    }
    const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    if (list === null || !Array.isArray(list.data)) throw new IdentityUnreadable('the models list answered no data list')
    const answeredWorkspace = header(response, 'anthropic-workspace-id')
    if (answeredWorkspace !== null && answeredWorkspace !== workspace) {
      throw new IdentityMismatch('Anthropic ran the request in another workspace than the target declares', 'verify_anthropic_workspace_mismatch')
    }
    return { kind: 'anthropic', workspaceId: workspace, organizationId: header(response, 'anthropic-organization-id') }
  },
}

export function anthropicServiceEntry(): OpsServiceEntry {
  const key = staticKeyAuth(STATIC_KEY_PLACEMENTS.anthropic)
  return {
    rules: {
      service: 'anthropic',
      declaredHosts: (target) => {
        anthropicWorkspaceOf(target)
        return [ANTHROPIC_HOST]
      },
      expired: key.expired,
      // The target is read first, so a connection declaring no workspace is refused by rule before its key is read.
      authorize: async (input: AuthorizeInput) => {
        const workspace = anthropicWorkspaceOf(input.target)
        const auth = await key.authorize(input)
        return { headers: { ...auth.headers, 'anthropic-workspace-id': workspace }, secrets: auth.secrets }
      },
    },
    identity: anthropicIdentity,
  }
}
