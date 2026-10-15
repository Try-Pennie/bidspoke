import { describe, expect, it } from 'vitest'
import { cleanupLedger, type CleanupOps } from './cleanup.ts'
import type { Ledger } from './ledger.ts'

const MARKER = 'realtime-spike-20261015t153012z'
const EMAIL = `org-b@${MARKER}.example.com`
const SLUG = `${MARKER}-example-com`

function ledgerWith(entries: Ledger['entries']): Ledger {
  return { version: 1, marker: MARKER, project: 'ref', startedAt: 'now', entries }
}

function recordingOps(overrides: Partial<CleanupOps> = {}): CleanupOps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    findUserIdByEmail: async (email) => {
      calls.push(`find ${email}`)
      return 'u-found'
    },
    deletePublicUser: async (id, email) => {
      calls.push(`public_user ${id} ${email}`)
      return 1
    },
    deleteAuthUser: async (id, email) => {
      calls.push(`auth_user ${id} ${email}`)
      return 'removed'
    },
    deleteOrganization: async (id, slug) => {
      calls.push(`organization ${id} ${slug}`)
      return 1
    },
    deleteAllowlist: async (email) => {
      calls.push(`allowlist ${email}`)
      return 1
    },
    ...overrides,
  }
}

const everything: Ledger['entries'] = [
  { kind: 'allowlist', key: EMAIL, id: null, state: 'created' },
  { kind: 'organization', key: SLUG, id: 'org-b', state: 'created' },
  { kind: 'auth_user', key: EMAIL, id: 'u-1', state: 'created' },
  { kind: 'public_user', key: EMAIL, id: 'u-1', state: 'created' },
]

describe('cleanupLedger', () => {
  it('removes what the ledger names, dependants first', async () => {
    const ops = recordingOps()
    const report = await cleanupLedger(ledgerWith(everything), ops)
    expect(ops.calls).toEqual([`public_user u-1 ${EMAIL}`, `auth_user u-1 ${EMAIL}`, `organization org-b ${SLUG}`, `allowlist ${EMAIL}`])
    expect(report.failed).toEqual([])
    expect(report.removed).toHaveLength(4)
  })

  it('removes a planned entry too, since an interrupt can land between the create and the id being written', async () => {
    const ops = recordingOps()
    const report = await cleanupLedger(
      ledgerWith([
        { kind: 'allowlist', key: EMAIL, id: null, state: 'created' },
        { kind: 'organization', key: SLUG, id: 'org-b', state: 'created' },
        { kind: 'auth_user', key: EMAIL, id: null, state: 'planned' },
      ]),
      ops,
    )
    // The auth user's id was never written, so it is found by email, and the
    // users row the signup trigger made with it is removed as well.
    expect(ops.calls).toEqual([`find ${EMAIL}`, `public_user u-found ${EMAIL}`, `auth_user u-found ${EMAIL}`, `organization org-b ${SLUG}`, `allowlist ${EMAIL}`])
    expect(report.failed).toEqual([])
  })

  it('reports a planned entry that was never created as absent, not as removed', async () => {
    const ops = recordingOps({ findUserIdByEmail: async () => null, deleteOrganization: async () => 0 })
    const report = await cleanupLedger(
      ledgerWith([
        { kind: 'organization', key: SLUG, id: 'org-b', state: 'planned' },
        { kind: 'auth_user', key: EMAIL, id: null, state: 'planned' },
      ]),
      ops,
    )
    expect(report.removed).toEqual([])
    // The users row the signup trigger would have made is looked for too.
    expect(report.absent).toEqual([`public_user ${EMAIL}`, `auth_user ${EMAIL}`, `organization ${SLUG} (org-b)`])
  })

  it('carries on past a failure and names what it could not remove', async () => {
    const ops = recordingOps({
      deleteOrganization: async () => {
        throw new Error('violates foreign key constraint')
      },
    })
    const report = await cleanupLedger(ledgerWith(everything), ops)
    expect(report.failed).toEqual([`organization ${SLUG} (org-b): violates foreign key constraint`])
    expect(ops.calls).toContain(`allowlist ${EMAIL}`)
  })

  it('refuses an entry whose key does not carry the ledger marker, and removes nothing for it', async () => {
    const ops = recordingOps()
    const report = await cleanupLedger(
      ledgerWith([{ kind: 'organization', key: 'pennie', id: 'org-real', state: 'created' }]),
      ops,
    )
    expect(ops.calls).toEqual([])
    expect(report.failed[0]).toMatch(/does not carry the marker/)
  })
})
