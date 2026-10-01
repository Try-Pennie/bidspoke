import { describe, it, expect } from 'vitest'
import { readOnlyClient } from '../read-only-client'

// A recording stand-in for supabase-js: every call reports itself, so the test
// can tell a refused write from one that reached the client.
function recordingClient() {
  const calls: string[] = []
  const builder = (table: string): Record<string, unknown> => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit', 'gte', 'insert', 'update', 'upsert', 'delete']) {
      b[m] = (..._a: unknown[]) => { calls.push(`${table}.${m}`); return b }
    }
    b.then = (res: (v: unknown) => void) => res({ data: [], error: null })
    return b
  }
  return {
    calls,
    client: {
      from: (t: string) => builder(t),
      rpc: (n: string) => { calls.push(`rpc.${n}`); return Promise.resolve({ data: null, error: null }) },
      schema: () => ({ from: (t: string) => builder(t) }),
    },
  }
}

describe('readOnlyClient', () => {
  it('lets a select through', async () => {
    const { client, calls } = recordingClient()
    const ro = readOnlyClient(client as never)
    await ro.from('workflow_executions').select('id').eq('workflow_id', 'x').limit(5)
    expect(calls).toEqual(['workflow_executions.select', 'workflow_executions.eq', 'workflow_executions.limit'])
  })

  it.each(['insert', 'update', 'upsert', 'delete'])('throws on %s before the client sees it', (m) => {
    const { client, calls } = recordingClient()
    const ro = readOnlyClient(client as never) as unknown as { from: (t: string) => Record<string, (...a: unknown[]) => unknown> }
    expect(() => ro.from('workflows')[m]({})).toThrow(/read only/)
    expect(calls).toEqual([])
  })

  it('throws on a write reached after a select', () => {
    const { client } = recordingClient()
    const ro = readOnlyClient(client as never) as unknown as { from: (t: string) => { select: () => Record<string, () => unknown> } }
    expect(() => ro.from('workflows').select().update()).toThrow(/read only/)
  })

  it.each(['rest', 'storage', 'functions', 'auth', 'realtime', 'channel', 'removeAllChannels'])('refuses %s: everything but the read path is denied by default', (prop) => {
    const { client, calls } = recordingClient()
    const withMore = {
      ...client,
      rest: { from: (t: string) => client.from(t) },
      storage: { from: () => ({ upload: () => calls.push('storage.upload') }) },
      functions: { invoke: () => calls.push('functions.invoke') },
      auth: { admin: { deleteUser: () => calls.push('auth.deleteUser') } },
      realtime: {},
      channel: () => ({}),
      removeAllChannels: () => calls.push('removeAllChannels'),
    }
    const ro = readOnlyClient(withMore as never) as unknown as Record<string, unknown>
    expect(() => ro[prop]).toThrow(/read only/)
    expect(calls).toEqual([])
  })

  it('refuses any builder method that is not a read', () => {
    const { client } = recordingClient()
    const b = client.from('workflows') as Record<string, unknown>
    b.rpc = () => 'escaped'
    b.someFutureWrite = () => 'escaped'
    const ro = readOnlyClient({ ...client, from: () => b } as never) as unknown as { from: (t: string) => Record<string, () => unknown> }
    expect(() => ro.from('workflows').someFutureWrite()).toThrow(/read only/)
    expect(() => ro.from('workflows').rpc()).toThrow(/read only/)
  })

  it('throws on rpc and on another schema', () => {
    const { client, calls } = recordingClient()
    const ro = readOnlyClient(client as never) as unknown as { rpc: (n: string) => unknown; schema: (s: string) => unknown }
    expect(() => ro.rpc('purge_everything')).toThrow(/read only/)
    expect(() => ro.schema('porting')).toThrow(/read only/)
    expect(calls).toEqual([])
  })
})
