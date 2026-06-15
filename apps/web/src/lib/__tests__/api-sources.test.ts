/**
 * Issue #100: sources.delete/assignWorkflow/unassignWorkflow interpolated the raw
 * name into the URL path, so a source named "a/b" or "100%leads" could be created
 * but never revoked/assigned. The path now encodeURIComponent's the name.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  }),
}))

import { api } from '../api'

function captureFetch() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
    text: async () => '',
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => vi.unstubAllGlobals())

describe('sources path encoding (#100)', () => {
  it('encodes the name when deleting a URL-special source', async () => {
    const f = captureFetch()
    await api.sources.delete('a/b')
    expect(f.mock.calls[0][0]).toContain('/api/sources/a%2Fb')
  })

  it('encodes the name when assigning a workflow', async () => {
    const f = captureFetch()
    await api.sources.assignWorkflow('100%leads', 'wf-1')
    expect(f.mock.calls[0][0]).toContain('/api/sources/100%25leads/workflows')
  })

  it('encodes both name and workflow id when unassigning', async () => {
    const f = captureFetch()
    await api.sources.unassignWorkflow('a/b', 'wf/2')
    expect(f.mock.calls[0][0]).toContain('/api/sources/a%2Fb/workflows/wf%2F2')
  })

  it('leaves a clean name unchanged', async () => {
    const f = captureFetch()
    await api.sources.delete('wallet_owl')
    expect(f.mock.calls[0][0]).toContain('/api/sources/wallet_owl')
  })
})
