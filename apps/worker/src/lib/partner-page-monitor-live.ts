/**
 * The remote half of the partners page delivery monitor (#2135) that runs as
 * the Worker: the identity read, the ping and the run record, with the service
 * role client. The signed in half (sign in, Realtime join) is in
 * partner-page-monitor-realtime.ts; the judgement is in partner-page-monitor.ts
 * and is tested against doubles.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Env } from '../env'
import { formatErr } from './format-error'
import { recordFinishedJobRun } from './job-run-record'
import {
  measurePartnerPageDelivery,
  PARTNER_PAGE_MONITOR_JOB,
  type IdentityAnswer,
  type MeasureDeps,
  type MonitorDeps,
} from './partner-page-monitor'
import { joinPrivateTopic, signInAsMonitor } from './partner-page-monitor-realtime'

/**
 * The monitor's identity, by the one predicate (L261): the single organization
 * marked is_synthetic, and its single user. Anything else is refused by name.
 */
export async function findMonitorIdentity(supabase: SupabaseClient): Promise<IdentityAnswer> {
  const orgs = await supabase.from('organizations').select('id').eq('is_synthetic', true).limit(2)
  if (orgs.error) return { kind: 'unreadable', reason: `the monitor organization could not be read: ${formatErr(orgs.error)}` }
  const orgRows = (orgs.data ?? []) as Array<{ id: string }>
  if (orgRows.length === 0) return { kind: 'missing', reason: 'no organization is marked is_synthetic' }
  if (orgRows.length > 1) return { kind: 'ambiguous', reason: 'more than one organization is marked is_synthetic; the monitor needs exactly one' }
  const organizationId = orgRows[0].id

  const users = await supabase.from('users').select('email').eq('organization_id', organizationId).limit(2)
  if (users.error) return { kind: 'unreadable', reason: `the monitor user could not be read: ${formatErr(users.error)}` }
  const userRows = (users.data ?? []) as Array<{ email: string }>
  if (userRows.length === 0) return { kind: 'missing', reason: 'the monitor organization has no user' }
  if (userRows.length > 1) return { kind: 'ambiguous', reason: 'the monitor organization has more than one user; it needs exactly one' }
  return { kind: 'found', organizationId, email: userRows[0].email }
}

/** The production remote effects of one measurement. */
export function liveMeasureDeps(env: Env, supabase: SupabaseClient): MeasureDeps {
  return {
    password: env.PARTNER_PAGE_MONITOR_PASSWORD,
    findIdentity: () => findMonitorIdentity(supabase),
    signIn: signInAsMonitor(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY),
    join: (jwt, topic, onPayload) => joinPrivateTopic(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, jwt, topic, onPayload),
    ping: async (organizationId, saveId) => {
      const result = await supabase.rpc('monitor_partner_page_ping', { p_org: organizationId, p_save_id: saveId })
      const data: unknown = result.data
      const error = result.error
      if (error) {
        const details = (error as { details?: string | null }).details
        return { ok: false, reason: `${error.code ?? 'error'} ${error.message}${details ? ` (${details})` : ''}` }
      }
      const answer = (data ?? {}) as { partition_today?: unknown; partition_tomorrow?: unknown }
      if (typeof answer.partition_today !== 'boolean' || typeof answer.partition_tomorrow !== 'boolean') {
        return { ok: false, reason: 'the ping answered without the partition figures' }
      }
      return { ok: true, partitionToday: answer.partition_today, partitionTomorrow: answer.partition_tomorrow }
    },
    newSaveId: () => crypto.randomUUID(),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  }
}

/** The production dependencies of one run, as the five minute cron wires them. */
export function livePartnerPageMonitorDeps(
  env: Env,
  supabase: SupabaseClient,
  rest: Pick<MonitorDeps, 'kv' | 'claims' | 'resolveSlack' | 'senders'>,
): MonitorDeps {
  const startedAt = Date.now()
  return {
    ...rest,
    env: env as unknown as Record<string, string | undefined>,
    measure: () => measurePartnerPageDelivery(liveMeasureDeps(env, supabase)),
    // One finished job_runs row per run, written once the run has its outcome,
    // so pass and fail counts are a query (L557). A killed run leaves no row;
    // the cron heartbeat's vanished verdict covers that. Never throws.
    record: (outcome, summary) => recordFinishedJobRun(supabase, PARTNER_PAGE_MONITOR_JOB, startedAt, { outcome, summary }),
    now: Date.now,
    log: (line) => console.log(line),
  }
}
