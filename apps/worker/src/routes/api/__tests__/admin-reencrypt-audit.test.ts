/**
 * The key rotation re-lock's own audit record lands (#2689).
 *
 * POST /api/admin/reencrypt-secrets with dryRun false records the run in
 * audit_log, whose entity_id and changed_by are uuid columns. It used to pass
 * the string SECRET_ENCRYPTION_KEY and an email, which Postgres refuses, and
 * the audit write reports that only to the console: production held 0
 * recovery_secret rows (read 2026-10-22). Here the audit write is the real one
 * (lib/audit is not mocked), against a store that refuses a value that is not a
 * uuid in a uuid column with Postgres's own code, so a row only counts as
 * landed if Postgres would have taken it.
 *
 * Who may call it: any signed in user (every /api/admin route). Whose data: it
 * re-locks every organization's stored secrets (lib/secret-reencrypt.ts); the
 * record names the caller's organization and the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('../../../lib/secret-reencrypt')

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { reencryptSecrets } from '../../../lib/secret-reencrypt'
import api from '../index'

const ORG = '0a000000-0000-4000-8000-000000002689'
const USER = 'aa000000-0000-4000-8000-000000002689'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** audit_log as Postgres holds it: entity_id, changed_by and organization_id are uuid columns. */
function store() {
  const landed: Record<string, unknown>[] = []
  const client = {
    rpc(fn: string) {
      if (fn === 'auth_user_with_allowlist') {
        return Promise.resolve({ data: [{ id: USER, organization_id: ORG, email: 'dan@trypennie.com', display_name: 'Dan Wright', allowed: true }], error: null })
      }
      return Promise.resolve({ data: null, error: { code: '42883', message: `no function ${fn}` } })
    },
    from(table: string) {
      if (table !== 'audit_log') throw new Error(`the double holds audit_log only, not ${table}`)
      return {
        insert(row: Record<string, unknown>) {
          for (const col of ['organization_id', 'entity_id', 'changed_by']) {
            const v = row[col]
            if (v !== null && v !== undefined && !(typeof v === 'string' && UUID.test(v))) {
              return Promise.resolve({ data: null, error: { code: '22P02', message: `invalid input syntax for type uuid: "${String(v)}"` } })
            }
          }
          landed.push(row)
          return Promise.resolve({ data: null, error: null })
        },
      }
    },
  }
  return { client, landed }
}

function env(): Env {
  return { SUPABASE_JWKS_URL: 'https://fake.jwks', WORKFLOW_CACHE: {}, SECRET_ENCRYPTION_KEY: 'primary-key', SECRET_ENCRYPTION_KEY_NEXT: 'next-key' } as unknown as Env
}

async function post(body: unknown) {
  return api.request('/admin/reencrypt-secrets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    body: JSON.stringify(body),
  }, env(), recordingContext())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyJwt).mockResolvedValue({ sub: USER, email: 'dan@trypennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' })
  vi.mocked(reencryptSecrets).mockResolvedValue({ ok: true, tables: [] } as never)
})
afterEach(() => vi.restoreAllMocks())

describe('the re-lock records its run in audit_log (#2689)', () => {
  it('lands one row: its own run id as entity_id, the caller as changed_by, the counts, no key', async () => {
    const db = store()
    vi.mocked(createSupabaseClient).mockReturnValue(db.client as never)
    const res = await post({ dryRun: false })
    expect(res.status).toBe(200)
    expect(db.landed).toHaveLength(1)
    const [row] = db.landed
    expect(row).toMatchObject({ organization_id: ORG, entity_type: 'recovery_secret', action: 'secrets_reencrypted', changed_by: USER, changes: { ok: true, tables: [] } })
    expect(row.entity_id).toMatch(UUID)
    expect(JSON.stringify(row)).not.toMatch(/next-key|primary-key/)
    const answer = (await res.json()) as { audited: boolean; run_id: string }
    expect(answer).toMatchObject({ audited: true, run_id: row.entity_id })
  })

  it('gives each run its own record', async () => {
    const db = store()
    vi.mocked(createSupabaseClient).mockReturnValue(db.client as never)
    await post({ dryRun: false })
    await post({ dryRun: false })
    expect(db.landed).toHaveLength(2)
    expect(db.landed[0].entity_id).not.toBe(db.landed[1].entity_id)
  })

  it('says so when the record does not land, rather than answering as if it did', async () => {
    const db = store()
    // A permanent refusal (a CHECK), which the audit write does not retry, so no real backoff runs here (L524).
    db.client.from = () => ({ insert: () => Promise.resolve({ data: null, error: { code: '23514', message: 'new row for relation "audit_log" violates check constraint' } }) })
    vi.mocked(createSupabaseClient).mockReturnValue(db.client as never)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await post({ dryRun: false })
    expect(res.status).toBe(200)
    expect((await res.json()) as { audited: boolean }).toMatchObject({ audited: false })
  })

  it('writes no record for a preview', async () => {
    const db = store()
    vi.mocked(createSupabaseClient).mockReturnValue(db.client as never)
    await post({})
    expect(db.landed).toEqual([])
  })
})
