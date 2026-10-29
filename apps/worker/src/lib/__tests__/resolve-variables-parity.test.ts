/**
 * The money lane's env loader and the one variable resolver agree (#2997,
 * phase 1 of #2982, L370).
 *
 * The loader keeps its own loop rather than calling resolveVariables: its KV
 * cache holds the organization's values and each workflow's apart, in a
 * format the release before still reads (expand before contract, ADR 0007),
 * and lays them together at each run. So instead of one call site, these
 * shared rows prove the two pick the same value for every name and workflow.
 *
 * One deliberate difference is left out of the fixtures: a secret that will
 * not decrypt. The loader skips an organization one and withholds a
 * workflow's own as empty, so a money run keeps running (#391); the ops
 * gateway refuses that run by name (ops-gateway-run-variables.test.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadEnvVars } from '../env-loader'
import { resolveVariables } from '../resolve-variables'
import { decryptSecret, encryptSecret } from '../secret-crypto'

const KEY = btoa('0'.repeat(32))
const ORG = '6f1c2b8e-0d3a-4c1e-9a55-1b2c3d4e5f60'
const WF = '00000000-0000-4000-8000-0000000019a1'
const OTHER_WF = '00000000-0000-4000-8000-0000000019a2'
const NO_ROWS_WF = '00000000-0000-4000-8000-0000000019a3'

interface Row { key: string; value: string | null; is_secret: boolean; scope: string; workflow_id: string | null }

const org = (key: string, value: string | null, is_secret = false): Row => ({ key, value, is_secret, scope: 'global', workflow_id: null })
const own = (workflowId: string | null, key: string, value: string | null, is_secret = false): Row => ({ key, value, is_secret, scope: 'workflow', workflow_id: workflowId })

/** Every rule at least once, in saved order. Secrets are stored as ciphertext. */
async function sharedRows(): Promise<Row[]> {
  const enc = (s: string) => encryptSecret(s, KEY)
  return [
    org('PLAIN', 'org plain'),
    org('TWICE', 'older'),
    org('TWICE', 'newer'),
    org('BLANKED', 'shows through'),
    org('BLANKED', ''),
    org('OVERRIDDEN', 'org value'),
    own(WF, 'OVERRIDDEN', 'workflow value'),
    own(WF, 'OWN_ONLY', 'only mine'),
    own(OTHER_WF, 'OWN_ONLY', 'only theirs'),
    own(WF, 'OWN_BLANK', ''),
    org('OWN_BLANK', 'org under a blank own row'),
    org('SECRET', await enc('org secret'), true),
    own(WF, 'SECRET', await enc('workflow secret'), true),
    org('ORG_SECRET', await enc('org only secret'), true),
    org('SECRET_OVER_PLAIN', 'plain first'),
    org('SECRET_OVER_PLAIN', await enc('secret later'), true),
    own(WF, 'SALESFORCE_CLIENT_ID', 'a workflow may not hold this'),
    org('SALESFORCE_CLIENT_ID', 'the organization\'s'),
    own(null, 'NOBODYS', 'a workflow row naming no workflow'),
    org('NULLED', null),
  ]
}

function rowsDb(rows: Row[]): SupabaseClient {
  const result = { data: rows, error: null }
  const chain = {
    select: () => chain, order: () => chain, range: () => chain, eq: () => chain, is: () => chain,
    then: (resolve: (r: unknown) => void) => resolve(result),
  }
  return { from: () => chain } as unknown as SupabaseClient
}

function memoryKv(): KVNamespace {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    getWithMetadata: vi.fn(async (k: string) => ({ value: store.get(k) ?? null, metadata: null })),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v) }),
    delete: vi.fn(async (k: string) => { store.delete(k) }),
  } as unknown as KVNamespace
}

/** What the resolver picks for a workflow, secrets decrypted as the gateway serves them. */
async function resolvedFor(rows: Row[], workflowId: string): Promise<Record<string, string>> {
  const names = [...new Set(rows.map((r) => r.key))]
  const out: Record<string, string> = {}
  for (const [name, row] of resolveVariables(rows, workflowId, names)) {
    out[name] = row.is_secret ? await decryptSecret(row.value as string, KEY) : (row.value as string)
  }
  return out
}

describe('the env loader and resolveVariables pick the same values', () => {
  it.each([['the workflow with its own rows', WF], ['another workflow with its own rows', OTHER_WF], ['a workflow with none', NO_ROWS_WF]])('for %s', async (_label, workflowId) => {
    const rows = await sharedRows()
    const loaded = await loadEnvVars(ORG, memoryKv(), rowsDb(rows), KEY, { workflowId })
    const resolved = await resolvedFor(rows, workflowId)
    expect(resolved).toEqual(loaded)
    // Not vacuous: the fixtures reach several rules for this workflow.
    expect(Object.keys(resolved).length).toBeGreaterThanOrEqual(7)
  })

  it('and the fixtures exercise each rule for the workflow with its own rows', async () => {
    const resolved = await resolvedFor(await sharedRows(), WF)
    expect(resolved).toMatchObject({
      TWICE: 'newer', BLANKED: 'shows through', OVERRIDDEN: 'workflow value', OWN_ONLY: 'only mine', OWN_BLANK: 'org under a blank own row',
      SECRET: 'workflow secret', ORG_SECRET: 'org only secret', SECRET_OVER_PLAIN: 'secret later', SALESFORCE_CLIENT_ID: 'the organization\'s',
    })
    expect(resolved).not.toHaveProperty('NOBODYS')
    expect(resolved).not.toHaveProperty('NULLED')
  })
})
