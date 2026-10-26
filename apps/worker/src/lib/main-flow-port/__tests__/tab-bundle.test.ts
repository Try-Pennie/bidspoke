/**
 * The script a session runs in Dan's logged in tab (#2171) is built from the very
 * transform.ts and apply.ts the other tests prove, by stripping their types. This
 * evaluates the built text as a browser would, with a stand in document.cookie,
 * and checks it reads, refuses and PUTs as the module does. Its fetch reaches the
 * worker's own workflow routes (save-route-backend.ts), so a request the save
 * route refuses fails here, as the 428 of 2026-10-26 would have (#2174).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../jwt')
vi.mock('../../supabase')
vi.mock('../../../engine/definition-loader')
vi.mock('../../audit')
vi.mock('../../github')
vi.mock('../../github-backup-alert')
vi.mock('../../buyer-profile-loader', async () => {
  const actual = await vi.importActual<typeof import('../../buyer-profile-loader')>('../../buyer-profile-loader')
  return { ...actual, loadBuyerProfiles: vi.fn() }
})

// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import TRANSFORM_SOURCE from '../transform.ts?raw'
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import APPLY_SOURCE from '../apply.ts?raw'
import { buildTabScript, type TabArgs } from '../tab-bundle'
import { PORT_STAGES, portMainFlow } from '../transform'
import { productionMainFlow } from './production-fixture'
import { prepare, saveRouteBackend, WORKER_URL as WORKER } from './save-route-backend'

let settleBackend: (() => Promise<void>) | null = null
beforeEach(() => prepare())
afterEach(async () => {
  await settleBackend?.()
  settleBackend = null
})

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

/** A browser with a signed in Supabase session, and the worker's routes holding live Main Flow at version 1. */
function browser(definition: unknown) {
  const backend = saveRouteBackend(definition, { versionNumber: 1 })
  settleBackend = backend.settle
  const session = `base64-${base64url(JSON.stringify({ access_token: 'session-jwt', user: { email: 'gate@example.com' } }))}`
  // Split in two, as @supabase/ssr chunks a long session, beside an unrelated cookie.
  const document = { cookie: `theme=dark; sb-gate-auth-token.0=${encodeURIComponent(session.slice(0, 40))}; sb-gate-auth-token.1=${encodeURIComponent(session.slice(40))}` }
  const run = (text: string) => runInTab(text, document, backend.fetchFn) as Promise<Record<string, unknown>>
  return { run, requests: backend.requests, versions: backend.versions }
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
    // The save route's version check (#2599), met from inside the tab: the row version read and a press made there.
    const [put] = b.requests.filter((r) => r.method === 'PUT')
    expect(put.auth).toBe('Bearer session-jwt')
    expect(put.body).toMatchObject({ expected_version: 2310, save_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
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
