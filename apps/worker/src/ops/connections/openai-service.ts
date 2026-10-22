/**
 * The ops OpenAI service as OpsConnections uses it (#2337, phase 7 of #1689):
 * an API key for one OpenAI project. Registered in services.ts.
 *
 * The login is `{ api_key }` (the static key minter's bearer placement,
 * minters/static-key.ts); the target is `{ project_id }`. Every request goes to
 * api.openai.com, the one host declared, and carries the key as a bearer and
 * the declared project as OpenAI-Project, both put on it by connectionFetch,
 * never by the caller. OpenAI charges a request with that header to the
 * project it names, and refuses it when the key cannot act in that project, so
 * a key is only ever used in the project its connection declares.
 *
 * THE EXPIRY SIGNAL is the static key minter's: a 401. connectionFetch renews
 * once, which reads the same key again, and a second 401 is needs_reauth. A
 * refused key was never applied, so the one repeat cannot bill twice.
 *
 * WHAT VERIFY MEASURES, AND WHY NOTHING IS RECORDED. GET /v1/models, which
 * costs nothing, with the key and the declared project. A 200 proves the key
 * works in that project; OpenAI's `openai-organization` header names the
 * organization it is billed to, and where OpenAI answers an `openai-project`
 * header it must be the declared project, or verify refuses it as
 * verify_openai_project_mismatch. A different project needs a new target,
 * which is a new generation, so nothing is kept about it.
 *
 * Bidding holds no OpenAI key, so there is no money identity to compare with.
 */
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { targetFields, targetString } from './minters/login-fields'
import { STATIC_KEY_PLACEMENTS, staticKeyAuth } from './minters/static-key'
import { LoginMintError } from './refusals'
import type { OpsServiceEntry } from './ops-connections'
import type { AuthorizeInput } from './service-rules'

/** The one host an ops OpenAI connection reaches. */
export const OPENAI_HOST = 'api.openai.com'

/** What verify asks: the models list, free, which every key may read. */
export const OPENAI_VERIFY_URL = `https://${OPENAI_HOST}/v1/models`

/** A project id OpenAI issues (proj_...), and nothing a header could not carry. */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The project a target declares. Throws LoginMintError (not_allowed, target_invalid) when it declares none, or one no header can carry. */
export function openaiProjectOf(target: unknown): string {
  const project = targetString(targetFields(target), 'project_id').trim()
  if (!PROJECT_ID.test(project)) throw new LoginMintError('not_allowed', 'target_invalid')
  return project
}

const header = (response: Response, name: string): string | null => {
  const value = response.headers.get(name)
  return value !== null && value.trim() !== '' ? value.trim() : null
}

export const openaiIdentity: IdentityProbe = {
  kind: 'openai',
  async measure(fetch, target) {
    const project = openaiProjectOf(target)
    const response = await fetch(OPENAI_VERIFY_URL, { method: 'GET' })
    // Its status only: never OpenAI's body.
    if (!response.ok) throw new IdentityUnreadable(`the models list answered HTTP ${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new IdentityUnreadable('the models list answered a body that is not JSON')
    }
    const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null
    if (list === null || !Array.isArray(list.data)) throw new IdentityUnreadable('the models list answered no data list')
    const answeredProject = header(response, 'openai-project')
    if (answeredProject !== null && answeredProject !== project) {
      throw new IdentityMismatch('OpenAI answered for another project than the target declares', 'verify_openai_project_mismatch')
    }
    return { kind: 'openai', projectId: project, organization: header(response, 'openai-organization') }
  },
}

export function openaiServiceEntry(): OpsServiceEntry {
  const key = staticKeyAuth(STATIC_KEY_PLACEMENTS.bearer)
  return {
    rules: {
      service: 'openai',
      declaredHosts: (target) => {
        openaiProjectOf(target)
        return [OPENAI_HOST]
      },
      expired: key.expired,
      // The target is read first, so a connection declaring no project is refused by rule before its key is read.
      authorize: async (input: AuthorizeInput) => {
        const project = openaiProjectOf(input.target)
        const auth = await key.authorize(input)
        return { headers: { ...auth.headers, 'openai-project': project }, secrets: auth.secrets }
      },
    },
    identity: openaiIdentity,
  }
}
