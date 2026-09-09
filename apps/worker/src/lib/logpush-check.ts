import type { SupabaseClient } from '@supabase/supabase-js'
import { logpushDifferences, type ObservedLogpush, type ObservedLogpushJob } from '../archive/logpush-drift'
import { EXPECTED_LOGPUSH_JOBS } from './logpush-expectation'
import { notifyExportFailure } from './export-alerts'

export const LOGPUSH_CHECK_JOB = 'logpush-destinations'

export interface LogpushCheckResult {
  observed: ObservedLogpush
  differences: string[]
  alerted: boolean
}

export interface LogpushCheckDeps {
  fetchJobs?: () => Promise<unknown>
  now?: () => number
}

/** Host of a destination_conf, without credentials, path or query. */
function hostOf(destinationConf: string): string {
  const withoutQuery = destinationConf.split('?')[0]
  const afterScheme = withoutQuery.replace(/^[a-z0-9+.-]+:\/\//i, '')
  return afterScheme.split('/')[0]
}

/**
 * A string from an untrusted JSON value, or ''.
 *
 * Not `String(v)`: the API's fields are `unknown`, and stringifying an object
 * yields '[object Object]', which then appears verbatim in the alert text and
 * tells whoever reads it nothing (#598 is that exact defect in another alert).
 */
function asText(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : JSON.stringify(err)
}

/**
 * Read the account's Logpush jobs and report every way they differ from the
 * committed expectation (#1010).
 *
 * Note the permission: Cloudflare's Logpush API requires `Logs Write` even for
 * a GET, so `CLOUDFLARE_LOGS_TOKEN` necessarily carries edit rights. Read-only
 * is not available for this API. Recorded here because a token that can change
 * what it only reads looks like an over-grant to anyone auditing it later.
 */
export async function checkLogpush(
  env: { CLOUDFLARE_LOGS_TOKEN?: string; CLOUDFLARE_ACCOUNT_ID?: string; IDEMPOTENCY?: unknown },
  supabase: SupabaseClient,
  deps: LogpushCheckDeps = {},
): Promise<LogpushCheckResult> {
  const now = deps.now ?? (() => Date.now())
  const observed: ObservedLogpush = { jobs: [], unreadable: [] }

  const fetchJobs =
    deps.fetchJobs ??
    (async () => {
      // Each missing input is its own message. "No token" and "the API refused
      // us" have different remedies, and one standing in for the other sends
      // whoever reads the alert to the wrong place (L11).
      if (env.CLOUDFLARE_LOGS_TOKEN === undefined || env.CLOUDFLARE_LOGS_TOKEN === '') {
        throw new Error('CLOUDFLARE_LOGS_TOKEN is not set on the worker')
      }
      if (env.CLOUDFLARE_ACCOUNT_ID === undefined || env.CLOUDFLARE_ACCOUNT_ID === '') {
        throw new Error('CLOUDFLARE_ACCOUNT_ID is not set on the worker')
      }
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/logpush/jobs`,
        { headers: { Authorization: `Bearer ${env.CLOUDFLARE_LOGS_TOKEN}` } },
      )
      return await res.json()
    })

  try {
    const body = (await fetchJobs()) as {
      success?: boolean
      errors?: Array<{ code?: number; message?: string }>
      result?: Array<Record<string, unknown>>
    }
    if (body.success !== true) {
      const why = (body.errors ?? []).map((e) => `${String(e.code)} ${String(e.message)}`).join('; ')
      observed.unreadable.push(`the Logpush job list was refused: ${why || 'no reason given'}`)
    } else if (!Array.isArray(body.result)) {
      // Success with no array is not an empty account, it is a shape we do not
      // understand, and reporting it as zero jobs would read as "nothing is
      // configured" (L215).
      observed.unreadable.push('the Logpush job list came back in an unrecognised shape')
    } else {
      observed.jobs = body.result.map((j): ObservedLogpushJob => {
        const oo = (j.output_options ?? {}) as { field_names?: unknown }
        const last = j.last_complete
        const lastRaw = typeof last === 'string' ? last : null
        const parsed = lastRaw === null ? null : Date.parse(lastRaw)
        return {
          id: Number(j.id),
          name: asText(j.name),
          destinationHost: hostOf(asText(j.destination_conf)),
          dataset: asText(j.dataset),
          enabled: j.enabled === true,
          fieldNames: Array.isArray(oo.field_names) ? oo.field_names.map(String) : [],
          // Never let NaN reach a comparison: it compares false against every
          // threshold and lands on the permissive side (L50).
          lastCompleteMs: parsed === null || Number.isNaN(parsed) ? null : parsed,
          lastCompleteRaw: lastRaw,
        }
      })
    }
  } catch (err) {
    observed.unreadable.push(`the Logpush job list could not be read: ${formatErr(err)}`)
  }

  const differences = logpushDifferences(observed, EXPECTED_LOGPUSH_JOBS, now())

  await notifyExportFailure(
    supabase,
    LOGPUSH_CHECK_JOB,
    differences,
    env.IDEMPOTENCY as never,
  )

  console.log(
    `[logpush-check] jobs=${String(observed.jobs.length)} ` +
      `unreadable=${String(observed.unreadable.length)} differences=${String(differences.length)}`,
  )

  return { observed, differences, alerted: differences.length > 0 }
}
