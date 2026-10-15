import { describe, expect, it } from 'vitest'
import { liveCleanupOps, type CleanupClient } from './live.ts'
import type { SpikeConfig } from './cli.ts'

const config = { supabaseUrl: 'http://127.0.0.1:1', secretKey: 'k' } as SpikeConfig
const MARKER_EMAIL = 'org-b@realtime-spike-20261015t153012z.example.com'

/** A client double recording every filter a delete is narrowed by. */
function recordingClient(authEmail: string | null) {
  const filters: string[] = []
  const deletedAuth: string[] = []
  const query = (table: string) => {
    const chain = {
      delete: () => chain,
      select: () => Promise.resolve({ data: [{}], error: null }),
      eq: (column: string, value: string) => {
        filters.push(`${table}.${column}=${value}`)
        return chain
      },
    }
    return chain
  }
  const client = {
    from: query,
    auth: {
      admin: {
        getUserById: async (id: string) =>
          authEmail === null
            ? { data: { user: null }, error: { status: 404, message: 'User not found' } }
            : { data: { user: { id, email: authEmail } }, error: null },
        deleteUser: async (id: string) => {
          deletedAuth.push(id)
          return { error: null }
        },
      },
    },
  } as unknown as CleanupClient
  return { client, filters, deletedAuth }
}

describe('liveCleanupOps: a delete by id only touches the row that carries the marker', () => {
  it('narrows the users and organizations deletes by the marker bearing email and slug, not the id alone', async () => {
    const c = recordingClient(MARKER_EMAIL)
    const ops = liveCleanupOps(config, c.client)
    await ops.deletePublicUser('u-1', MARKER_EMAIL)
    await ops.deleteOrganization('org-b', 'realtime-spike-20261015t153012z-example-com')
    expect(c.filters).toEqual([
      'users.id=u-1',
      `users.email=${MARKER_EMAIL}`,
      'organizations.id=org-b',
      'organizations.slug=realtime-spike-20261015t153012z-example-com',
    ])
  })

  it('refuses to delete an auth user whose email is not the ledger\'s', async () => {
    const c = recordingClient('dan@trypennie.com')
    const ops = liveCleanupOps(config, c.client)
    await expect(ops.deleteAuthUser('u-real', MARKER_EMAIL)).rejects.toThrow(/refusing/)
    expect(c.deletedAuth).toEqual([])
  })

  it('deletes the auth user when its email is the ledger\'s, and reports absent when there is none', async () => {
    const c = recordingClient(MARKER_EMAIL)
    expect(await liveCleanupOps(config, c.client).deleteAuthUser('u-1', MARKER_EMAIL)).toBe('removed')
    expect(c.deletedAuth).toEqual(['u-1'])
    const gone = recordingClient(null)
    expect(await liveCleanupOps(config, gone.client).deleteAuthUser('u-1', MARKER_EMAIL)).toBe('absent')
  })
})
