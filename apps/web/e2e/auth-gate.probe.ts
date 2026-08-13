/**
 * Issue #728: does the login gate actually run, and does it fail closed?
 *
 * This is a raw-HTTP probe, not a browser journey. It exists because the
 * existing browser spec asserted that /workflows "ends at /login", which still
 * passes with middleware.ts deleted: the API client redirects to /login on any
 * 401, so the assertion observed the union of three gates and could not say
 * which one acted. Being unable to tell "the gate ran and redirected" from "the
 * gate never ran and something else did" IS the failure mode.
 *
 * So every assertion here checks the `x-bidspoke-gate` header as well as the
 * status. A 307 to /login WITHOUT that header means the middleware did not run,
 * which is precisely what a misconfigured static-asset route would look like.
 *
 * It needs no credentials by construction: it never signs in, and it runs under
 * its own config with no global setup, so it cannot silently start depending on
 * a secret. It does still need a BUILD, which needs the NEXT_PUBLIC_* values at
 * compile time, and that is the vacuous-pass hazard this file guards against
 * below by refusing 'gate-unavailable'.
 */
import { test, expect, type APIRequestContext } from '@playwright/test'

/** Every path the gate must protect from an unauthenticated caller. */
const GATED_PATHS = [
  '/',
  '/dashboard',
  '/workflows',
  '/workflows/00000000-0000-0000-0000-000000000000',
  '/workflows/00000000-0000-0000-0000-000000000000/versions',
  '/workflows/00000000-0000-0000-0000-000000000000/executions/11111111-1111-1111-1111-111111111111',
  '/env',
  '/sources',
  '/endpoints',
  '/partners',
  '/integrations',
  '/access',
  '/settings',
  '/settings/access',
  '/settings/api-keys',
  '/migrate-code-workers',
]

/** Paths that must stay reachable without a session. */
const PUBLIC_PATHS = [
  '/login',
  '/access-denied',
  '/docs',
  '/docs/_nav.json',
  '/llms.txt',
]

async function probe(request: APIRequestContext, path: string) {
  const res = await request.get(path, { maxRedirects: 0 })
  return {
    status: res.status(),
    location: res.headers()['location'] ?? null,
    gate: res.headers()['x-bidspoke-gate'] ?? null,
  }
}

test.describe('the login gate, over raw HTTP, with no session', () => {
  for (const path of GATED_PATHS) {
    test(`redirects ${path} to /login and says the gate did it`, async ({ request }) => {
      const { status, location, gate } = await probe(request, path)

      // A build missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY makes createServerClient
      // throw, the catch-deny turns that into a redirect, and a test asserting only
      // "307 to /login" would pass while proving nothing about the gate's logic.
      // Refusing this value is what stops that vacuous pass.
      expect(gate, `${path} reported gate-unavailable: the gate could not run, so this run proves nothing`)
        .not.toBe('gate-unavailable')

      expect(status, `${path} was not redirected`).toBe(307)
      expect(location, `${path} redirected somewhere other than /login`).toContain('/login')
      // The positive signal. Without it, an unauthenticated 307 to /login is
      // indistinguishable from the middleware never having run.
      expect(gate, `${path} redirected without the gate header, so the middleware did not run`)
        .toBe('redirect-login')
    })
  }

  for (const path of PUBLIC_PATHS) {
    test(`serves ${path} without a session`, async ({ request }) => {
      const { status, gate } = await probe(request, path)
      expect(status, `${path} did not return 200`).toBe(200)
      expect(gate).not.toBe('gate-unavailable')
      expect(gate).not.toBe('redirect-login')
    })
  }

  // A markdown file under /docs is served to external readers and AI crawlers, so
  // it must not be swept into the gate by a matcher change.
  test('serves a raw docs markdown file without a session', async ({ request }) => {
    const { status } = await probe(request, '/docs/nodes/achieve-offers.md')
    expect([200, 404], 'a docs .md path must not be redirected to /login').toContain(status)
  })

  test('the gate header is present on every response it decides, including allows', async ({ request }) => {
    const gated = await probe(request, '/workflows')
    const login = await probe(request, '/login')
    expect(gated.gate).not.toBeNull()
    expect(login.gate).not.toBeNull()
    expect(gated.gate).not.toBe(login.gate)
  })
})
