/**
 * The organization scoped reads behind the money hosts (connection-money-targets.ts,
 * readMoneyHosts), bound to the bidding database. One home for both readers, so
 * the daily recheck judges against exactly what the save judged against:
 * - `routes/api/connections.ts`: an HTTP connection's save (#2337), which
 *   refuses a host bidding sends to;
 * - `lib/http-money-host-check.ts`: the daily recheck of every saved HTTP
 *   connection (#2761), since the money lane can start sending to a host after
 *   a connection to it was saved.
 *
 * Each read is scoped to the organization; one that comes back at its limit
 * throws, so a caller refuses or reports rather than checking against part of
 * a list. Measured 2026-10-23: 10 money workflows (440 KB of definitions) and a
 * handful of partner rows. Each error names only which read failed, never a
 * value: a partner endpoint or a Salesforce instance is not printed.
 *
 * Who may call it: the bidding Worker only, as service_role, which bypasses row
 * level security, so the organization filter here is the scoping.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import type { MoneyHostReads } from './connection-money-targets'
import { readOrgWorkflows } from './org-workflows'
import { resolveSalesforceCredsFor } from './salesforce-creds'

/** At most this many partner rows are read; a read that reaches it is not known to be whole, so it refuses. */
export const MONEY_HOST_READ_LIMIT = 1000

interface PartnerUrlRow {
  api_endpoint: string | null
  dedup_endpoint: string | null
  click_url: string | null
}

export function liveMoneyHostReads(supabase: SupabaseClient, env: Env): MoneyHostReads {
  return {
    salesforce: (organizationId) => resolveSalesforceCredsFor(env, supabase, organizationId),
    partnerUrls: async (organizationId) => {
      const { data, error } = await supabase
        .from('partner_configs')
        .select('api_endpoint, dedup_endpoint, click_url')
        .eq('organization_id', organizationId)
        .order('id')
        .limit(MONEY_HOST_READ_LIMIT)
      if (error) throw new Error('partner_configs read failed')
      if (!Array.isArray(data)) throw new Error('partner_configs read answered no rows')
      if (data.length >= MONEY_HOST_READ_LIMIT) throw new Error('partner_configs read reached its limit')
      return (data as PartnerUrlRow[]).flatMap((r) => [r.api_endpoint, r.dedup_endpoint, r.click_url].filter((v): v is string => typeof v === 'string'))
    },
    // The one organization workflows read (lib/org-workflows.ts): scoped, not soft deleted, paged; it throws rather than truncating.
    moneyDefinitions: async (organizationId) => (await readOrgWorkflows(supabase, organizationId, { lane: 'money' })).map((w) => JSON.stringify(w.definition)),
  }
}
