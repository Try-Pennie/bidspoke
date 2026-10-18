/**
 * POST /api/admin/seal-canary: the production half of the ops key restore drill
 * (#2333, phase 3 of #1689).
 *
 * The route seals the fixed canary text to the ops PUBLIC key a kid names and
 * hands the envelope back, so scripts/restore-drill/open-seal-canary.ts can
 * prove the escrowed private key opens what production seals. What matters:
 *
 * - it seals under a kid committed in keys.ts and refuses any other by name;
 * - it stores nothing: no service_connections row, so nothing appears in GET
 *   /api/connections and no canary service enters that table's CHECK;
 * - the audit row actually LANDS, keyed by a generated uuid it returns, naming
 *   the caller's user id. The row is read back from audit_log, not inferred from
 *   a write having been attempted: the reencrypt route's audit writes a string
 *   entity id and an email as changed_by, which audit_log's uuid entity_id and
 *   users(id) foreign key refuse, and the best effort writer drops it silently.
 *
 * The Supabase double below holds audit_log to the column types and the foreign
 * key the real table has (supabase/migrations/20260402000002_core_tables.sql);
 * supabase/tests/audit_log_seal_canary.test.sql proves the real table refuses
 * the same rows this double refuses, so the double cannot be kinder than it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordingContext } from '../../../test-setup/wait-until'
import type { Env } from '../../../index'

const testRing = vi.hoisted(() => ({}) as Record<string, string>)

vi.mock('../../../lib/jwt')
vi.mock('../../../lib/supabase')
vi.mock('@bidspoke/connection-seal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bidspoke/connection-seal')>()
  // The committed public key's private half is in 1Password, not here, so the
  // route seals to a key pair this file generates, under the same kids shape.
  return { ...actual, OPS_CONNECTION_PUBLIC_KEYS: testRing }
})

import { verifyJwt } from '../../../lib/jwt'
import { createSupabaseClient } from '../../../lib/supabase'
import { open, RESTORE_DRILL_CANARY, restoreDrillAad } from '@bidspoke/connection-seal'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USER_ID = '3b4b7f61-2a51-4c2e-9d55-0c7d3c1b9e01'
const ORG_ID = '8d0f5a1c-6e2b-4b0a-a7c4-5f9e3d2c1b00'
const testUser = { id: USER_ID, organization_id: ORG_ID, email: 'dan@pennie.com' }
const validPayload = { sub: USER_ID, email: 'dan@pennie.com', exp: 9999999999, iat: 1, aud: 'authenticated' }
const mockCtx = recordingContext()

const CURRENT = 'ops-2026-10'
const NEXT = 'ops-2027-01'
const privateRing: Record<string, string> = {}

function toPem(der: ArrayBuffer, label: string): string {
  let binary = ''
  for (const b of new Uint8Array(der)) binary += String.fromCharCode(b)
  return `-----BEGIN ${label}-----\n${btoa(binary).match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`
}

async function addPair(kid: string) {
  // Cast: the Workers types give generateKey and exportKey union results that the DOM types do not.
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['encrypt', 'decrypt'],
  )) as CryptoKeyPair
  testRing[kid] = toPem((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer, 'PUBLIC KEY')
  privateRing[kid] = toPem((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer, 'PRIVATE KEY')
}

beforeAll(async () => {
  await Promise.all([addPair(CURRENT), addPair(NEXT)])
}, 120_000)

type Row = Record<string, unknown>

/**
 * A database double holding audit_log to the real table's rules: uuid
 * organization_id and entity_id (22P02 otherwise), changed_by a users(id) or
 * null (22P02 for a non uuid, 23503 for an unknown user), and the NOT NULLs.
 * Every table touched is recorded, so "stores nothing" is checked, not assumed.
 */
function databaseDouble(opts: { users: string[]; refuseAuditWith?: { code: string; message: string } }) {
  const auditLog: Row[] = []
  const touched: string[] = []

  function refuse(row: Row): { code: string; message: string } | null {
    if (opts.refuseAuditWith) return opts.refuseAuditWith
    for (const col of ['organization_id', 'entity_type', 'entity_id', 'action']) {
      if (row[col] === undefined || row[col] === null) return { code: '23502', message: `null value in column "${col}"` }
    }
    for (const col of ['organization_id', 'entity_id']) {
      if (typeof row[col] !== 'string' || !UUID.test(row[col] as string)) {
        return { code: '22P02', message: `invalid input syntax for type uuid (${col})` }
      }
    }
    const by = row.changed_by
    if (by !== null && by !== undefined) {
      if (typeof by !== 'string' || !UUID.test(by)) return { code: '22P02', message: 'invalid input syntax for type uuid (changed_by)' }
      if (!opts.users.includes(by)) return { code: '23503', message: 'audit_log_changed_by_fkey' }
    }
    return null
  }

  const client = {
    from(table: string) {
      return {
        insert(row: Row) {
          touched.push(`insert ${table}`)
          if (table !== 'audit_log') return Promise.resolve({ error: { code: '42P01', message: `unexpected table ${table}` } })
          const error = refuse(row)
          if (!error) auditLog.push({ id: crypto.randomUUID(), changed_at: new Date().toISOString(), ...row })
          return Promise.resolve({ error })
        },
        select() {
          touched.push(`select ${table}`)
          return {
            eq(col: string, value: unknown) {
              const rows = table === 'audit_log' ? auditLog.filter((r) => r[col] === value) : []
              return Promise.resolve({ data: rows, error: null })
            },
          }
        },
        update() { touched.push(`update ${table}`); return { eq: () => Promise.resolve({ error: null }) } },
        upsert() { touched.push(`upsert ${table}`); return Promise.resolve({ error: null }) },
        delete() { touched.push(`delete ${table}`); return { eq: () => Promise.resolve({ error: null }) } },
      }
    },
    rpc(name: string) {
      if (name === 'auth_user_with_allowlist') return Promise.resolve({ data: [{ ...testUser, allowed: true }], error: null })
      touched.push(`rpc ${name}`)
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${name}` } })
    },
  }
  /** Reads audit_log back the way any reader would: by entity id. */
  const readAudit = async (entityId: string) =>
    (await client.from('audit_log').select().eq('entity_id', entityId)).data as Row[]
  return { client, touched, readAudit }
}

function env(): Env {
  return { SUPABASE_JWKS_URL: 'https://fake.jwks' } as unknown as Env
}

async function makeApp() {
  const { default: api } = await import('../index')
  return api
}

describe('POST /admin/seal-canary (#2333)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>
  let db: ReturnType<typeof databaseDouble>

  const useDb = (d: ReturnType<typeof databaseDouble>) => {
    db = d
    vi.mocked(createSupabaseClient).mockReturnValue(d.client as unknown as ReturnType<typeof createSupabaseClient>)
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.mocked(verifyJwt).mockResolvedValue(validPayload)
    useDb(databaseDouble({ users: [USER_ID] }))
    app = await makeApp()
  })

  const post = (body: unknown, headers: Record<string, string> = { Authorization: 'Bearer tok' }) =>
    app.request(
      '/admin/seal-canary',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) },
      env(),
      mockCtx,
    )

  it('refuses a caller with no token, sealing and writing nothing', async () => {
    const res = await post({ kid: CURRENT }, {})
    expect(res.status).toBe(401)
    expect(db.touched).toEqual([])
  })

  it('seals the canary under the kid asked and returns an envelope that opens to it with that kid\'s private key', async () => {
    const res = await post({ kid: CURRENT })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { drill_id: string; kid: string; envelope: { kid: string }; audited: boolean }
    expect(body.kid).toBe(CURRENT)
    expect(body.envelope.kid).toBe(CURRENT)
    expect(await open(privateRing, body.envelope, restoreDrillAad(CURRENT))).toBe(RESTORE_DRILL_CANARY)
    // Not under the other kid's key: the envelope is bound to the kid it names.
    await expect(open({ [CURRENT]: privateRing[NEXT] }, body.envelope, restoreDrillAad(CURRENT))).rejects.toMatchObject({
      code: 'seal_unwrap_failed',
    })
  })

  it('seals under the NEXT kid too, once one is committed beside the current one', async () => {
    const res = await post({ kid: NEXT })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { envelope: unknown }
    expect(await open(privateRing, body.envelope, restoreDrillAad(NEXT))).toBe(RESTORE_DRILL_CANARY)
  })

  it('writes one audit row that reads back keyed by the returned drill id, naming the caller and the kid', async () => {
    const res = await post({ kid: CURRENT })
    const body = (await res.json()) as { drill_id: string; audited: boolean }
    expect(body.drill_id).toMatch(UUID)
    expect(body.audited).toBe(true)

    const rows = await db.readAudit(body.drill_id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      organization_id: ORG_ID,
      entity_type: 'ops_key_restore_drill',
      entity_id: body.drill_id,
      action: 'canary_sealed',
      changed_by: USER_ID,
      changes: { kid: CURRENT },
    })
  })

  it('gives every call its own drill id', async () => {
    const a = (await (await post({ kid: CURRENT })).json()) as { drill_id: string }
    const b = (await (await post({ kid: CURRENT })).json()) as { drill_id: string }
    expect(a.drill_id).not.toBe(b.drill_id)
    expect(await db.readAudit(a.drill_id)).toHaveLength(1)
    expect(await db.readAudit(b.drill_id)).toHaveLength(1)
  })

  it('stores nothing but its audit row: no service_connections write, no other table touched', async () => {
    await post({ kid: CURRENT })
    expect(db.touched).toEqual(['insert audit_log'])
  })

  it('says so when its audit row did not land, rather than reading as recorded (L11)', async () => {
    // A permanent refusal (as a schema drift would give), so the writer's retry
    // ladder stops at once rather than waiting out its delays.
    useDb(databaseDouble({ users: [USER_ID], refuseAuditWith: { code: '42P01', message: 'relation "audit_log" does not exist' } }))
    const res = await post({ kid: CURRENT })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { drill_id: string; audited: boolean }
    expect(body.audited).toBe(false)
    expect(await db.readAudit(body.drill_id)).toEqual([])
  })

  it('refuses a kid that is not committed in keys.ts, by name, sealing and writing nothing', async () => {
    const res = await post({ kid: 'ops-1999-01' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('kid_unknown')
    expect(body.message).toContain('ops-1999-01')
    expect(body.message).toContain(CURRENT)
    expect(db.touched).toEqual([])
  })

  it('refuses a kid every object answers to but no key ring holds', async () => {
    const res = await post({ kid: 'constructor' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('kid_unknown')
    expect(db.touched).toEqual([])
  })

  it('refuses a missing, non string or malformed kid, and a body that is not JSON, writing nothing', async () => {
    for (const body of [{}, { kid: 7 }, { kid: null }, { kid: 'Not A Kid' }, 'not json']) {
      const res = await post(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(db.touched).toEqual([])
  })
})
