/**
 * Shared Slack-alert fan-out plumbing (#357).
 *
 * Several scheduled alerts (drain-stall, big-table-guard, sf-matrix-audit, ...)
 * each re-implemented the same three steps: look up the orgs with a Slack
 * connection, fan a per-org send out across them, and (for the once-per-incident
 * ones) gate the whole thing behind a KV cooldown that is set only after a
 * successful post. That boilerplate lived in ~8 near-identical copies, so a
 * change to the cooldown semantics or the multi-org handling had to be made in
 * every one. This module is the single home for it.
 *
 * It deliberately does NOT cover the per-workflow / per-org cooldown alerts
 * (failure-rate, slow-execution-rate, volume-cliff's db-unreachable path): those
 * key their cooldown on a workflow or a single org and announce recovery, which
 * is a different shape. They still share `slackOrgIds` for the org lookup.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logReadFailure } from './scheduled-read'

/**
 * The slice of KV this module uses: a get and a cooldown put. Narrower than
 * KVNamespace so a caller holding a minimal KV double (a test, or a helper typed
 * on get/put) can pass it without an unsafe cast; a real KVNamespace satisfies it.
 */
export interface CooldownKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

/** Deduped org ids that have a Slack connection. Empty (never throws) on a read failure. */
export async function slackOrgIds(supabase: SupabaseClient, logLabel: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  logReadFailure(logLabel, 'slack connections', error)
  return [...new Set((data ?? []).map((r) => (r as { organization_id: string }).organization_id))]
}

/**
 * Run `perOrg` once for each org with a Slack connection, in order, and return
 * each result. `perOrg` returns true when it delivered (or was a legitimate
 * no-op, e.g. the org opted out). Callers fold the array themselves: drain-stall
 * and big-table-guard want "any delivered" (`.some`), sf-matrix-audit wants
 * "every delivered" (`.every`).
 */
export async function forEachSlackOrg(
  supabase: SupabaseClient,
  logLabel: string,
  perOrg: (orgId: string) => Promise<boolean>,
): Promise<boolean[]> {
  const orgIds = await slackOrgIds(supabase, logLabel)
  const results: boolean[] = []
  for (const orgId of orgIds) results.push(await perOrg(orgId))
  return results
}

/**
 * A once-per-incident org alert: suppressed while `cooldownKey` is set, otherwise
 * fanned out to every Slack org, and the cooldown is set (for `ttlSeconds`) only
 * when at least one org was alerted. Returns whether anything was alerted.
 */
export async function rateLimitedOrgAlert(opts: {
  kv: CooldownKv
  cooldownKey: string
  ttlSeconds: number
  supabase: SupabaseClient
  logLabel: string
  perOrg: (orgId: string) => Promise<boolean>
}): Promise<boolean> {
  if (await opts.kv.get(opts.cooldownKey)) return false
  const results = await forEachSlackOrg(opts.supabase, opts.logLabel, opts.perOrg)
  const alerted = results.some(Boolean)
  if (alerted) await opts.kv.put(opts.cooldownKey, '1', { expirationTtl: opts.ttlSeconds })
  return alerted
}
