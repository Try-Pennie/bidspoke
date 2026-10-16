/**
 * The admin actions on held Salesforce writes (#471): list, replay (a preview
 * unless dryRun is false), and abandon.
 *
 * The decisions live in lib/writeback-replay.ts and are tested there. This proves
 * the wiring: who may call, that the caller's organization is the one used, that
 * a replay previews by default, the status each outcome answers with, and that
 * every action is audited without any lead value in the audit row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/audit')>()
  return { ...actual, writeAuditLog: vi.fn().mockResolvedValue(undefined) }
})
vi.mock('../../../lib/writeback-replay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/writeback-replay')>()
  return {
    ...actual,
    supabaseHeldWriteStore: vi.fn(() => ({ list: vi.fn().mockResolvedValue([{ id: 'w-1', status: 'pending' }]) })),
    salesforcePortFor: vi.fn(),
    previewReplay: vi.fn(),
    replayHeldWrite: vi.fn(),
    abandonHeldWrite: vi.fn(),
  }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { writeAuditLog } from '../../../lib/audit'
import { previewReplay, replayHeldWrite, abandonHeldWrite, supabaseHeldWriteStore } from '../../../lib/writeback-replay'

const ORG = 'org-abc'
const ID = '22222222-2222-2222-2222-222222222471'
const testUser = { id: 'user-1', organization_id: ORG, email: 'dan@pennie.com' }
const validPayload = { sub: 'user-1', email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const testEnv = { SUPABASE_JWKS_URL: 'https://fake.jwks', SECRET_ENCRYPTION_KEY: 'k' } as unknown as Env
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

function call(app: Awaited<ReturnType<typeof makeApp>>, method: string, path: string, body?: unknown, auth = true) {
  return app.request(
    path,
    {
      method,
      headers: { ...(auth ? { Authorization: 'Bearer tok' } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    testEnv,
    mockCtx,
  )
}

const PREVIEW = {
  kind: 'preview' as const,
  id: ID,
  execution_id: 'ex-1',
  step_namespace: 'patch_submission',
  sf_object: 'Submission__c',
  sf_record_id: 'a04Ui00000NkhG1IAJ',
  status: 'pending',
  attempts: 0,
  fields: [{ field: 'Email__c', send: 'p@example.com', current: 'old@example.com', differs: true }],
}

describe('the held Salesforce write actions', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    vi.mocked(createSupabaseClient).mockReturnValue({
      rpc: (name: string) =>
        name === 'auth_user_with_allowlist'
          ? Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
          : Promise.resolve({ data: null, error: null }),
    } as unknown as ReturnType<typeof createSupabaseClient>)
    app = await makeApp()
  })

  it('refuses a caller with no token, touching nothing', async () => {
    const res = await call(app, 'POST', `/admin/held-writes/${ID}/replay`, { dryRun: false }, false)
    expect(res.status).toBe(401)
    expect(replayHeldWrite).not.toHaveBeenCalled()
  })

  it('lists the caller\'s organization only', async () => {
    const res = await call(app, 'GET', '/admin/held-writes?status=pending')
    expect(res.status).toBe(200)
    const store = vi.mocked(supabaseHeldWriteStore).mock.results[0].value as { list: ReturnType<typeof vi.fn> }
    expect(store.list).toHaveBeenCalledWith(ORG, 'pending')
  })

  it('refuses a status that is not one the store holds', async () => {
    expect((await call(app, 'GET', '/admin/held-writes?status=everything')).status).toBe(400)
  })

  it('previews by default, sending nothing, and audits the preview without lead values', async () => {
    vi.mocked(previewReplay).mockResolvedValue(PREVIEW)
    const res = await call(app, 'POST', `/admin/held-writes/${ID}/replay`, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'preview', fields: PREVIEW.fields })
    expect(vi.mocked(previewReplay).mock.calls[0][1]).toBe(ORG)
    expect(replayHeldWrite).not.toHaveBeenCalled()
    const audit = vi.mocked(writeAuditLog).mock.calls[0]
    expect(audit[2]).toBe('held_salesforce_write')
    expect(audit[4]).toBe('held_write_replay_previewed')
    expect(JSON.stringify(audit[6])).not.toContain('p@example.com')
  })

  it('sends only when dryRun is false, and audits the outcome', async () => {
    vi.mocked(replayHeldWrite).mockResolvedValue({ kind: 'replayed', recorded: true })
    const res = await call(app, 'POST', `/admin/held-writes/${ID}/replay`, { dryRun: false })
    expect(res.status).toBe(200)
    expect(vi.mocked(replayHeldWrite).mock.calls[0][1]).toBe(ORG)
    expect(vi.mocked(writeAuditLog).mock.calls[0][4]).toBe('held_write_replayed')
    expect(vi.mocked(writeAuditLog).mock.calls[0][6]).toMatchObject({ outcome: 'replayed', recorded: true })
  })

  // #468: the replay asks the Salesforce read-back whether it holds the row's
  // write, through the at-risk record of that run's step in the binding the walk
  // writes it to, before anything is sent.
  it('hands the replay a read-back check that reads the row\'s own at-risk record', async () => {
    vi.mocked(replayHeldWrite).mockResolvedValue({ kind: 'replayed', recorded: true })
    const asked: string[] = []
    const env = { ...testEnv, IDEMPOTENCY: { get: async (k: string) => { asked.push(k); return null } } } as unknown as Env
    const res = await app.request(
      `/admin/held-writes/${ID}/replay`,
      { method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ dryRun: false }) },
      env,
      mockCtx,
    )
    expect(res.status).toBe(200)
    const deps = vi.mocked(replayHeldWrite).mock.calls[0][0]
    expect(await deps.readBackHolds('01920000-0000-7000-8000-000000000471', 'patch_submission')).toBe(false)
    expect(asked).toEqual(['at-risk-write:01920000-0000-7000-8000-000000000471:patch_submission'])
  })

  it('answers each outcome with a status that says what happened', async () => {
    const cases: Array<[Awaited<ReturnType<typeof replayHeldWrite>>, number]> = [
      [{ kind: 'not_found' }, 404],
      [{ kind: 'not_replayable', reason: 'the write is already replayed' }, 409],
      [{ kind: 'conflict' }, 409],
      [{ kind: 'unreadable', error: 'bad key' }, 500],
      [{ kind: 'no_salesforce', error: 'credentials missing' }, 502],
      [{ kind: 'refused', error: 'Salesforce API error (400)', recorded: true }, 200],
      [{ kind: 'still_pending', error: 'Salesforce API error (503)', recorded: true }, 200],
    ]
    for (const [result, status] of cases) {
      vi.mocked(replayHeldWrite).mockResolvedValueOnce(result)
      const res = await call(app, 'POST', `/admin/held-writes/${ID}/replay`, { dryRun: false })
      expect(res.status, result.kind).toBe(status)
      expect(await res.json()).toMatchObject({ kind: result.kind })
    }
  })

  it('says plainly when a write landed but could not be recorded', async () => {
    vi.mocked(replayHeldWrite).mockResolvedValue({ kind: 'replayed', recorded: false })
    const body = (await (await call(app, 'POST', `/admin/held-writes/${ID}/replay`, { dryRun: false })).json()) as { warning?: string }
    expect(body.warning).toMatch(/landed in Salesforce/)
  })

  it('refuses an id that is not a uuid and a dryRun that is not a boolean', async () => {
    expect((await call(app, 'POST', '/admin/held-writes/nope/replay', {})).status).toBe(400)
    expect((await call(app, 'POST', `/admin/held-writes/${ID}/replay`, { dryRun: 'no' })).status).toBe(400)
    expect(previewReplay).not.toHaveBeenCalled()
  })

  it('abandons inside the caller\'s organization and audits it', async () => {
    vi.mocked(abandonHeldWrite).mockResolvedValue({ kind: 'abandoned' })
    const res = await call(app, 'POST', `/admin/held-writes/${ID}/abandon`, { reason: 'fixed in Salesforce by hand' })
    expect(res.status).toBe(200)
    expect(vi.mocked(abandonHeldWrite).mock.calls[0][1]).toBe(ORG)
    expect(vi.mocked(writeAuditLog).mock.calls[0][4]).toBe('held_write_abandoned')
    expect(vi.mocked(writeAuditLog).mock.calls[0][6]).toMatchObject({ reason: 'fixed in Salesforce by hand' })
  })

  it('requires a reason to abandon', async () => {
    expect((await call(app, 'POST', `/admin/held-writes/${ID}/abandon`, {})).status).toBe(400)
    expect(abandonHeldWrite).not.toHaveBeenCalled()
  })
})
