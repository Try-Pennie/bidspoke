/**
 * The apply and rollback the tab script runs (#2171, #1680 plan point 11).
 *
 * The PUT route overwrites the whole definition with no version check, so the
 * apply reads the live version, transforms THAT, re-reads immediately before the
 * PUT and refuses when anything moved, then reads back what was stored. Rollback
 * re-PUTs the version read before the change under the same check, and refuses
 * to discard a canvas save made since the port. A fake of the workflow API keeps
 * a real version history, and can save "from the canvas" between any two calls.
 */
import { describe, expect, it } from 'vitest'
import { accessTokenFromCookies, applyPort, httpWorkflowApi, previewPort, rollbackPort, type WorkflowApi } from '../apply'
import { MainFlowPortRefusal, MAIN_FLOW_WORKFLOW_ID, portMainFlow, PORT_STAGES } from '../transform'
import { productionMainFlow } from './production-fixture'

interface Version { id: string; version_number: number; definition: unknown }

class FakeApi implements WorkflowApi {
  versions: Version[] = []
  updatedAt = '2026-10-15T00:00:00Z'
  puts: Array<{ definition: unknown; message: string }> = []
  deployErrors: Array<{ namespace: string; error: string }> | undefined

  constructor(definition: unknown) {
    this.save(definition)
  }

  save(definition: unknown) {
    const n = this.versions.length + 1
    this.versions.push({ id: `v-${n}`, version_number: n, definition: structuredClone(definition) })
    this.updatedAt = `2026-10-15T00:00:${String(n).padStart(2, '0')}Z`
  }

  async getWorkflow(id: string) {
    expect(id).toBe(MAIN_FLOW_WORKFLOW_ID)
    return { definition: structuredClone(this.versions.at(-1)!.definition), updated_at: this.updatedAt }
  }
  async listVersions() {
    return [...this.versions].reverse().map(({ id, version_number }) => ({ id, version_number }))
  }
  async getVersion(_id: string, versionId: string) {
    const v = this.versions.find((x) => x.id === versionId)
    if (!v) throw new Error(`no version ${versionId}`)
    return { definition: structuredClone(v.definition), version_number: v.version_number }
  }
  async putDefinition(_id: string, definition: unknown, message: string): ReturnType<WorkflowApi['putDefinition']> {
    this.puts.push({ definition, message })
    this.save(definition)
    return { version_id: this.versions.at(-1)!.id, deploy_errors: this.deployErrors }
  }
}

const stage = 'canary_invalid_state' as const

/** base64url of UTF-8 text, as @supabase/ssr writes a session cookie. */
const base64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('applyPort', () => {
  it('PUTs the transform of the live definition and reads it back', async () => {
    const api = new FakeApi(productionMainFlow())
    const result = await applyPort(api, stage)
    expect(result).toMatchObject({ outcome: 'applied', before: { version_id: 'v-1', version_number: 1 }, after: { version_id: 'v-2', version_number: 2 } })
    expect(api.puts).toHaveLength(1)
    expect(api.puts[0].definition).toEqual(portMainFlow(productionMainFlow(), PORT_STAGES[stage]))
    expect(api.puts[0].message).toMatch(/#1680.*canary_invalid_state.*version 1/)
  })

  it('transforms what is live now, not a copy: a canvas edit made before the apply is kept', async () => {
    const edited = productionMainFlow()
    edited.nodes.find((n) => n.namespace === 'mutate_bes')!.label = 'Edited on the canvas'
    const api = new FakeApi(edited)
    await applyPort(api, stage)
    const stored = api.versions.at(-1)!.definition as typeof edited
    expect(stored.nodes.find((n) => n.namespace === 'mutate_bes')!.label).toBe('Edited on the canvas')
  })

  it('refuses, and PUTs nothing, when the canvas is saved between the read and the PUT', async () => {
    const api = new FakeApi(productionMainFlow())
    // The second workflow read is the re-read just before the PUT.
    let reads = 0
    const original = api.getWorkflow.bind(api)
    api.getWorkflow = async (id: string) => {
      reads++
      if (reads === 2) {
        const d = productionMainFlow()
        d.nodes[0].label = 'saved meanwhile'
        api.save(d)
      }
      return original(id)
    }
    const result = await applyPort(api, stage)
    expect(result).toMatchObject({ outcome: 'refused_live_changed' })
    expect(api.puts).toHaveLength(0)
  })

  it('refuses by the transform\'s own reasons, and PUTs nothing, when the live definition is not the expected shape', async () => {
    const def = productionMainFlow()
    def.nodes = def.nodes.filter((n) => n.namespace !== 'invalid_state_sf_post')
    const api = new FakeApi(def)
    const err = await applyPort(api, stage).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(MainFlowPortRefusal)
    expect((err as MainFlowPortRefusal).reasons.join('\n')).toMatch(/invalid_state_sf_post/)
    expect(api.puts).toHaveLength(0)
  })

  it('does nothing when the stage is already live', async () => {
    const api = new FakeApi(portMainFlow(productionMainFlow(), PORT_STAGES[stage]))
    expect(await applyPort(api, stage)).toMatchObject({ outcome: 'nothing_to_do' })
    expect(api.puts).toHaveLength(0)
  })

  it('reports a code node the save could not deploy as a failure, with the rollback record', async () => {
    const api = new FakeApi(productionMainFlow())
    api.deployErrors = [{ namespace: 'inquiry_body_send_salesforce', error: 'upload refused' }]
    const result = await applyPort(api, stage)
    expect(result).toMatchObject({ outcome: 'applied_with_deploy_errors', deploy_errors: api.deployErrors, before: { version_id: 'v-1' } })
  })

  it('reports a save that landed between its PUT and the read back instead of claiming success', async () => {
    const api = new FakeApi(productionMainFlow())
    const put = api.putDefinition.bind(api)
    api.putDefinition = async (...args) => {
      const r = await put(...args)
      const d = productionMainFlow()
      d.nodes[0].label = 'saved right after'
      api.save(d)
      return r
    }
    expect(await applyPort(api, stage)).toMatchObject({ outcome: 'stored_differs', before: { version_id: 'v-1' } })
  })
})

describe('a save the apply cannot pin to its own version', () => {
  it('when the PUT answers no version id, the apply never names the newest version as its own', async () => {
    const api = new FakeApi(productionMainFlow())
    const put = api.putDefinition.bind(api)
    api.putDefinition = async (...args) => {
      await put(...args)
      // A canvas save lands straight after, and the PUT's answer names no version.
      api.save(productionMainFlow())
      return {}
    }
    const result = await applyPort(api, stage)
    expect(result).toMatchObject({ outcome: 'stored_differs', after: null })
    expect(JSON.stringify(result)).not.toContain('v-3')
  })

  it('a rollback over such an answer is likewise not pinned to someone else\'s version', async () => {
    const api = new FakeApi(productionMainFlow())
    const applied = await applyPort(api, stage)
    if (applied.outcome !== 'applied') throw new Error(applied.outcome)
    const put = api.putDefinition.bind(api)
    api.putDefinition = async (...args) => { await put(...args); return { version_id: 'v-unlisted' } }
    const result = await rollbackPort(api, { before: applied.before, after: applied.after })
    expect(result).toMatchObject({ outcome: 'stored_differs', after: null })
  })
})

describe('rollbackPort', () => {
  it('re-PUTs the version read before the change', async () => {
    const api = new FakeApi(productionMainFlow())
    const applied = await applyPort(api, stage)
    if (applied.outcome !== 'applied') throw new Error(applied.outcome)
    const result = await rollbackPort(api, { before: applied.before, after: applied.after })
    expect(result).toMatchObject({ outcome: 'rolled_back', restored_from: { version_id: 'v-1', version_number: 1 }, after: { version_number: 3 } })
    expect(api.versions.at(-1)!.definition).toEqual(productionMainFlow())
    expect(api.puts[1].message).toMatch(/rollback.*version 1/)
  })

  it('refuses to discard a canvas save made since the port', async () => {
    const api = new FakeApi(productionMainFlow())
    const applied = await applyPort(api, stage)
    if (applied.outcome !== 'applied') throw new Error(applied.outcome)
    api.save(portMainFlow(productionMainFlow(), PORT_STAGES[stage]))
    const result = await rollbackPort(api, { before: applied.before, after: applied.after })
    expect(result).toMatchObject({ outcome: 'refused_live_changed' })
    expect(api.puts).toHaveLength(1)
  })

  it('refuses, and PUTs nothing, when the canvas is saved between its read and its PUT', async () => {
    const api = new FakeApi(productionMainFlow())
    const applied = await applyPort(api, stage)
    if (applied.outcome !== 'applied') throw new Error(applied.outcome)
    let reads = 0
    const original = api.getWorkflow.bind(api)
    api.getWorkflow = async (id: string) => {
      reads++
      if (reads === 2) api.save(productionMainFlow())
      return original(id)
    }
    const result = await rollbackPort(api, { before: applied.before, after: applied.after })
    expect(result).toMatchObject({ outcome: 'refused_live_changed' })
    expect(api.puts).toHaveLength(1)
  })
})

describe('previewPort', () => {
  it('names what the stage would change and PUTs nothing', async () => {
    const api = new FakeApi(productionMainFlow())
    const preview = await previewPort(api, 'inquiry')
    expect(preview).toMatchObject({ live_version: { version_number: 1 }, ports: expect.arrayContaining(['invalid_state_sf_post', 'send_salesforce']), moves_inquiry: true })
    expect(preview.adds).toHaveLength(18)
    expect(preview.removes).toEqual(['send_salesforce_inquiry'])
    expect(api.puts).toHaveLength(0)
  })
})

describe('httpWorkflowApi', () => {
  it('calls the workflow routes with the bearer token and fails loudly on a non 2xx', async () => {
    const seen: Array<[string, string, string | undefined]> = []
    const fetchFn = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      seen.push([init?.method ?? 'GET', url, init?.headers?.Authorization])
      if (url.endsWith('/versions')) return new Response(JSON.stringify([{ id: 'v-9', version_number: 9 }]), { status: 200 })
      if (init?.method === 'PUT') return new Response(JSON.stringify({ error: 'Workflow has a loop' }), { status: 400 })
      return new Response(JSON.stringify({ definition: { nodes: [], edges: [] }, updated_at: 't' }), { status: 200 })
    }
    const api = httpWorkflowApi('https://worker.example.test/', 'jwt-token', fetchFn)
    await api.getWorkflow('wf-1')
    expect(await api.listVersions('wf-1')).toEqual([{ id: 'v-9', version_number: 9 }])
    const err = await api.putDefinition('wf-1', { nodes: [] }, 'm').then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/PUT .*wf-1 answered 400.*Workflow has a loop/)
    expect(seen).toEqual([
      ['GET', 'https://worker.example.test/api/workflows/wf-1', 'Bearer jwt-token'],
      ['GET', 'https://worker.example.test/api/workflows/wf-1/versions', 'Bearer jwt-token'],
      ['PUT', 'https://worker.example.test/api/workflows/wf-1', 'Bearer jwt-token'],
    ])
  })
})

describe('accessTokenFromCookies', () => {
  const session = JSON.stringify({ access_token: 'jwt-1', refresh_token: 'r', user: { user_metadata: { full_name: 'Zo\u00eb Gate' } } })
  const b64 = `base64-${base64url(session)}`

  it('reads a whole cookie, JSON or base64', () => {
    expect(accessTokenFromCookies(`a=1; sb-ref-auth-token=${encodeURIComponent(session)}`)).toBe('jwt-1')
    expect(accessTokenFromCookies(`sb-ref-auth-token=${encodeURIComponent(b64)}; a=1`)).toBe('jwt-1')
  })

  it('joins the chunks of a long session in order', () => {
    const parts = [b64.slice(0, 10), b64.slice(10, 30), b64.slice(30)]
    expect(accessTokenFromCookies(parts.map((p, i) => `sb-ref-auth-token.${i}=${encodeURIComponent(p)}`).reverse().join('; '))).toBe('jwt-1')
  })

  it('is null with no session, and ignores the PKCE verifier cookie', () => {
    expect(accessTokenFromCookies('theme=dark')).toBeNull()
    expect(accessTokenFromCookies('sb-ref-auth-token-code-verifier=abc')).toBeNull()
    expect(accessTokenFromCookies('sb-ref-auth-token=not-json')).toBeNull()
  })

  it('is null, never a throw, for a malformed base64 session such as a lost chunk', () => {
    expect(accessTokenFromCookies('sb-ref-auth-token=base64-%25%25not%20base64')).toBeNull()
    expect(accessTokenFromCookies(`sb-ref-auth-token.0=${encodeURIComponent(b64.slice(0, 11))}`)).toBeNull()
  })
})
