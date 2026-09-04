/**
 * The one Salesforce credential resolver (#1174).
 *
 * The org-resolution half is what is new here: a worker-level caller with no
 * organization of its own has to find the one holding the global credentials,
 * and must refuse rather than guess when that is not exactly one, because
 * reading Salesforce as the wrong tenant is worse than not running.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSalesforceCredentialOrg } from '../salesforce-creds'

function db(result: { data?: unknown[] | null; error?: { message: string } | null }) {
  const filters: Record<string, unknown> = {}
  const client = {
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col: string, val: unknown) => { filters[col] = val; return b },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: result.data ?? [], error: result.error ?? null }).then(resolve),
      }
      return b
    },
  }
  return { client: client as unknown as SupabaseClient, filters }
}

describe('resolveSalesforceCredentialOrg', () => {
  it('names the single organization holding the global credentials', async () => {
    const { client, filters } = db({ data: [{ organization_id: 'org-a' }] })
    await expect(resolveSalesforceCredentialOrg(client)).resolves.toEqual({ orgId: 'org-a', error: null })
    // Scoped to the global instance url, which is the value that only ever lives
    // in the store, so its presence is what identifies the holder.
    expect(filters).toEqual({ key: 'SALESFORCE_INSTANCE_URL', scope: 'global' })
  })

  it('collapses duplicate rows for one organization', async () => {
    const { client } = db({ data: [{ organization_id: 'org-a' }, { organization_id: 'org-a' }] })
    await expect(resolveSalesforceCredentialOrg(client)).resolves.toEqual({ orgId: 'org-a', error: null })
  })

  it('refuses when two organizations hold them, rather than picking one', async () => {
    const out = await resolveSalesforceCredentialOrg(
      db({ data: [{ organization_id: 'org-a' }, { organization_id: 'org-b' }] }).client,
    )
    expect(out.orgId).toBeNull()
    expect(out.error).toContain('several_orgs_hold_salesforce_credentials')
  })

  it('reports none holding them as its own outcome', async () => {
    const out = await resolveSalesforceCredentialOrg(db({ data: [] }).client)
    expect(out).toEqual({ orgId: null, error: 'no_org_holds_salesforce_credentials' })
  })

  it('reports a failed lookup separately from finding nothing', async () => {
    // A table that cannot be read and a table with no such row are different
    // facts, and only one of them means somebody should add a credential.
    const out = await resolveSalesforceCredentialOrg(db({ data: null, error: { message: 'timeout' } }).client)
    expect(out.orgId).toBeNull()
    expect(out.error).toContain('salesforce_cred_org_lookup_failed')
  })

  it('ignores a row whose organization is not a usable id', async () => {
    const out = await resolveSalesforceCredentialOrg(db({ data: [{ organization_id: null }, { organization_id: '' }] }).client)
    expect(out.error).toBe('no_org_holds_salesforce_credentials')
  })
})
