/**
 * The script a session runs in Dan's logged in tab (#2171) is built from the very
 * transform.ts and apply.ts the other tests prove, by stripping their types. This
 * evaluates the built text as a browser would, with a stand in localStorage and
 * fetch, and checks it reads, refuses and PUTs as the module does.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import TRANSFORM_SOURCE from '../transform.ts?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import APPLY_SOURCE from '../apply.ts?raw'
import { buildTabScript, type TabArgs } from '../tab-bundle'
import { MAIN_FLOW_WORKFLOW_ID, PORT_STAGES, portMainFlow } from '../transform'
import { productionMainFlow } from './production-fixture'

const WORKER = 'https://worker.example.test'

/**
 * Node's own type stripper, the one scripts/main-flow-port-tab.ts uses. Reached
 * through process.getBuiltinModule because this package's Worker tsconfig has no
 * Node types; vitest runs this file on Node.
 */
const { stripTypeScriptTypes } = (globalThis as unknown as {
  process: { getBuiltinModule(id: 'node:module'): { stripTypeScriptTypes(code: string): string } }
}).process.getBuiltinModule('node:module')

/** base64url of UTF-8 text, as @supabase/ssr writes a session cookie. */
const base64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Evaluates the built text as the tab's console does, with only `document` and
 * `fetch` in reach. Evaluating text is the point of the test: it is exactly what
 * a session pastes into the tab.
 */
function runInTab(text: string, document: { cookie: string }, fetchFn: unknown): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the built script text is the thing under test
  return new Function('document', 'fetch', `return ${text}`)(document, fetchFn)
}

function build(args: TabArgs): string {
  return buildTabScript({ transformSource: TRANSFORM_SOURCE as string, applySource: APPLY_SOURCE as string, strip: (s) => stripTypeScriptTypes(s), args })
}

/** A browser with a signed in Supabase session and a worker holding Main Flow at version 1. */
function browser(definition: unknown) {
  const versions = [{ id: 'v-1', version_number: 1, definition }]
  const requests: Array<{ method: string; url: string; auth: string | undefined; body?: unknown }> = []
  const session = `base64-${base64url(JSON.stringify({ access_token: 'session-jwt', user: { email: 'gate@example.com' } }))}`
  // Split in two, as @supabase/ssr chunks a long session, beside an unrelated cookie.
  const document = { cookie: `theme=dark; sb-gate-auth-token.0=${encodeURIComponent(session.slice(0, 40))}; sb-gate-auth-token.1=${encodeURIComponent(session.slice(40))}` }
  const fetchFn = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const method = init.method ?? 'GET'
    requests.push({ method, url, auth: init.headers?.Authorization, ...(init.body ? { body: JSON.parse(init.body) } : {}) })
    const path = url.slice(WORKER.length)
    const newest = versions.at(-1)!
    if (method === 'PUT') {
      const body = JSON.parse(init.body!) as { definition: unknown }
      versions.push({ id: `v-${versions.length + 1}`, version_number: versions.length + 1, definition: body.definition })
      return new Response(JSON.stringify({ version_id: versions.at(-1)!.id }), { status: 200 })
    }
    if (path === `/api/workflows/${MAIN_FLOW_WORKFLOW_ID}`) return new Response(JSON.stringify({ definition: newest.definition, updated_at: `t${newest.version_number}` }), { status: 200 })
    if (path === `/api/workflows/${MAIN_FLOW_WORKFLOW_ID}/versions`) return new Response(JSON.stringify([...versions].reverse().map(({ id, version_number }) => ({ id, version_number }))), { status: 200 })
    const one = versions.find((v) => path === `/api/workflows/${MAIN_FLOW_WORKFLOW_ID}/versions/${v.id}`)
    if (one) return new Response(JSON.stringify(one), { status: 200 })
    return new Response('{"error":"not found"}', { status: 404 })
  }
  const run = (text: string) => runInTab(text, document, fetchFn) as Promise<Record<string, unknown>>
  return { run, requests, versions }
}

describe('the tab script', () => {
  it('previews read only, with the session token, and never prints it', async () => {
    const b = browser(productionMainFlow())
    const text = build({ action: 'preview', stage: 'canary_invalid_state', workerUrl: WORKER })
    const result = await b.run(text)
    expect(result).toMatchObject({ stage: 'canary_invalid_state', ports: ['invalid_state_sf_post'] })
    expect(b.requests.every((r) => r.method === 'GET' && r.auth === 'Bearer session-jwt')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('session-jwt')
    expect(text).not.toContain('session-jwt')
  })

  it('applies exactly what the module builds', async () => {
    const b = browser(productionMainFlow())
    const result = await b.run(build({ action: 'apply', stage: 'canary_invalid_state', workerUrl: WORKER }))
    expect(result).toMatchObject({ outcome: 'applied', before: { version_number: 1 }, after: { version_number: 2 } })
    expect(b.versions.at(-1)!.definition).toEqual(portMainFlow(productionMainFlow(), PORT_STAGES.canary_invalid_state))
  })

  it('refuses by name on a definition the transform does not recognise, sending nothing', async () => {
    const def = productionMainFlow()
    def.nodes = def.nodes.filter((n) => n.namespace !== 'tripoint_sf_post')
    const b = browser(def)
    const err = await b.run(build({ action: 'apply', stage: 'outcome_posts', workerUrl: WORKER })).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/tripoint_sf_post/)
    expect(b.requests.filter((r) => r.method === 'PUT')).toEqual([])
  })

  it('rolls back to the version the record names', async () => {
    const b = browser(productionMainFlow())
    const applied = await b.run(build({ action: 'apply', stage: 'canary_invalid_state', workerUrl: WORKER }))
    const result = await b.run(build({ action: 'rollback', record: { before: applied.before, after: applied.after } as never, workerUrl: WORKER }))
    expect(result).toMatchObject({ outcome: 'rolled_back', restored_from: { version_number: 1 } })
  })

  it('stops by name when no one is signed in', async () => {
    const text = build({ action: 'preview', stage: 'inquiry', workerUrl: WORKER })
    const err = await (runInTab(text, { cookie: 'theme=dark' }, async () => new Response('{}')) as Promise<unknown>).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/signed in/)
  })
})
