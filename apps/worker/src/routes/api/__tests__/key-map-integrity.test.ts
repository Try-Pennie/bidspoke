/**
 * The API_KEY_MAP rebuild, and the ordering obligation soft delete puts on it
 * (#877 Phase B0, #883).
 *
 * `rebuildKeyMap` derives the live `API_KEY_MAP` Cloudflare secret from
 * `api_sources` on every mutation of the Sources page. Two things about it are
 * worth a suite of its own.
 *
 * First, it discarded the select's error. On a failed read `data` is null, so
 * every key in the table vanished from `dbMap`, every key in the current secret
 * was "preserved" instead, and the merged result was the point-in-time snapshot
 * the function's own comment says it exists to avoid. The caller then wrote that
 * to the live secret and answered 200. A newly created source's key silently
 * never reached production and the page said it had (L12).
 *
 * The second half of #877, the obligation to filter tombstoned rows once
 * `api_sources` gains `deleted_at`, is enforced by a source-scanning guard in
 * apps/web (`__guards__/worker/key-map-soft-delete-ordering.test.ts`), which is
 * where every guard that reads worker source already lives, because apps/worker
 * typechecks against @cloudflare/workers-types and cannot read a file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit')
vi.mock('../../../lib/cf-secrets')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { setCfSecret } from '../../../lib/cf-secrets'
import { makeSupabase } from './_supabase-mock'

const USER_ORG = 'org-abc'
const testUser = { id: 'user-1', organization_id: USER_ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }

// One manually-seeded key (no org, cannot live in api_sources) plus one that
// does come from the table. The manual one must survive; that is what makes the
// preserve logic load-bearing rather than incidental.
const LIVE_MAP = JSON.stringify({ manualkey: 'seeded_by_hand', tablekey: 'website_form' })

const testEnv = {
  SUPABASE_JWKS_URL: 'https://fake.jwks',
  WORKFLOW_CACHE: {},
  API_KEY_MAP: LIVE_MAP,
  CLOUDFLARE_ACCOUNT_ID: 'acct-123',
  CLOUDFLARE_API_TOKEN: 'tok-abc',
} as unknown as Env

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function request(app: Awaited<ReturnType<typeof makeApp>>, method: string, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: body ? JSON.stringify(body) : undefined,
    },
    testEnv,
    mockCtx,
  )
}

const writtenMaps = () =>
  vi.mocked(setCfSecret).mock.calls.map((c) => JSON.parse(c[1] as string) as Record<string, string>)

describe('rebuildKeyMap when the api_sources read fails', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(setCfSecret).mockResolvedValue(undefined as unknown as ReturnType<typeof setCfSecret> extends Promise<infer R> ? R : never)
    app = await makeApp()
  })

  // The defect. A read that failed must not be allowed to look like a table
  // with nothing in it, because the two produce different maps and only one of
  // them is true.
  it('does not write a key map at all, and does not answer success', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        api_sources: [
          // The create path inserts first, so this is the insert, and it
          // SUCCEEDS. That matters: if the insert failed, the route would answer
          // 500 for a reason unrelated to the rebuild and the test would pass
          // while proving nothing (L140).
          { insertResult: { id: 'src-new' } },
          // The rebuild's own read, which fails.
          { listError: { message: 'connection reset by peer', code: '08006' } },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )

    const res = await request(app, 'POST', '/sources', { name: 'new_partner' })

    expect(setCfSecret).not.toHaveBeenCalled()
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = (await res.json()) as { error?: string }
    // Names the cause rather than a generic failure, so the operator knows the
    // key map was not touched (L11).
    expect(JSON.stringify(body)).toMatch(/key map/i)
  })

  // L33: the insert happens BEFORE the rebuild, so refusing to write the map
  // without also undoing the insert leaves exactly the half-created source (in
  // the table, absent from the auth map) that the setCfSecret catch block
  // already exists to prevent. It would also block re-creating the source with a
  // 409 on a name the operator can see nothing wrong with.
  it('rolls back the inserted row, so no half-created source is left behind', async () => {
    const supabase = makeSupabase({
      users: { single: testUser },
      api_sources: [
        { insertResult: { id: 'src-new' } },
        { listError: { message: 'connection reset by peer', code: '08006' } },
        // The rollback delete, which lands.
        { writeRows: [{ id: 'src-new' }] },
      ],
    })
    vi.mocked(createSupabaseClient).mockReturnValue(supabase as unknown as ReturnType<typeof createSupabaseClient>)

    const res = await request(app, 'POST', '/sources', { name: 'new_partner' })

    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(setCfSecret).not.toHaveBeenCalled()
    // Scoped to the org and the name, not a bare delete.
    const eq = supabase.eqCalls['api_sources'] ?? []
    expect(eq).toEqual(expect.arrayContaining([['organization_id', USER_ORG], ['name', 'new_partner']]))
  })

  it('still writes the map when the read succeeds, preserving manual keys', async () => {
    vi.mocked(createSupabaseClient).mockReturnValue(
      makeSupabase({
        users: { single: testUser },
        api_sources: [
          { insertResult: { id: 'src-new' } },
          { list: [{ name: 'website_form', api_key: 'tablekey' }, { name: 'new_partner', api_key: 'freshkey' }] },
        ],
      }) as unknown as ReturnType<typeof createSupabaseClient>,
    )

    await request(app, 'POST', '/sources', { name: 'new_partner' })

    const maps = writtenMaps()
    expect(maps.length).toBe(1)
    expect(maps[0]).toMatchObject({
      manualkey: 'seeded_by_hand',
      tablekey: 'website_form',
      freshkey: 'new_partner',
    })
  })
})
