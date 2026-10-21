/**
 * Backfill PD_Completed_Timestamp__c on the older fallback Submissions (#2581).
 *
 * Until Main Flow version 173 (2026-10-21) the Send Fallback Salesforce node never
 * wrote PD_Completed_Timestamp__c, and trypennie skips a resubmit only when it is
 * set (Halo-lab-Trypennie/trypennie#559). This stamps each such Submission with
 * its own CreatedDate, in the flow's format (UTC, whole seconds, no zone suffix).
 * It touches only records matching, at the moment of writing:
 *
 *   InternalDebtRouting__c = 20000 AND PD_Completed_Timestamp__c = null AND XBC_SO__c != null
 *
 * The logic, its safety rules and its tests are in
 * src/lib/fallback-pd-timestamp-backfill.ts and its __tests__ file.
 *
 * SIDE EFFECTS IN SALESFORCE, read 2026-10-21 and to be decided before --apply.
 * Every update runs Submission__c's own automation, which this script cannot
 * switch off (the Apex bypass, LeadScoreSubmissionBackfillBatch.enableBypass, is
 * a static only Apex can set):
 *   - SubmissionTrigger (before and after update). After update,
 *     SubmissionService.updateRelatedLeadForSubmission writes the Submission's
 *     CreditFreeze__c onto its Lead__c, so a Lead that has a newer Submission can
 *     have CreditFreeze__c set back to this older Submission's value, and each
 *     such Lead update runs the Lead's own automation.
 *   - Custom_Event_30_Helper, an active record triggered flow on create and
 *     update, whose entry criteria were not read.
 * The --limit 50 run is the place to observe these on 50 records first.
 *
 * WHAT IT PRINTS. Counts, CreatedDate values and Salesforce Ids, never any other
 * field: Submissions carry SSNs and contact details, and no other field is even
 * selected. It never prints a credential.
 *
 * CREDENTIALS. Read from the shell environment, then from apps/worker/.dev.vars
 * for any name the shell does not set. Either of:
 *   1. SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET
 *      (the client credentials app the Worker uses), or
 *   2. SUPABASE_URL, SUPABASE_SECRET_KEY and SECRET_ENCRYPTION_KEY, which let it
 *      read those three from the organization's environment_variables store, the
 *      way every scheduled Salesforce job does (lib/salesforce-creds.ts). Where a
 *      name is in both the store and the shell, the store wins.
 * The token is fetched with the Worker's own getSalesforceToken and held in memory.
 *
 * RUN, from apps/worker, in this order:
 *   1. Dry run (the default; writes nothing, prints the count, the earliest and
 *      latest CreatedDate and five sample Ids):
 *        npx tsx scripts/backfill-fallback-pd-timestamp.ts
 *   2. A first write of 50, then check those Ids in Salesforce:
 *        npx tsx scripts/backfill-fallback-pd-timestamp.ts --apply --limit 50
 *   3. The full run (safe to repeat: a record already stamped is skipped):
 *        npx tsx scripts/backfill-fallback-pd-timestamp.ts --apply
 *
 * Apply mode writes one JSON line per record (Id, outcome, the value written,
 * any Salesforce status codes) to a results file in the system temp directory,
 * or to the path in BACKFILL_RESULTS_FILE, and prints where it is.
 *
 * EXIT CODES. 0 finished; 1 stopped or failed (more than 1% of one batch failed,
 * a request failed as a whole, or the read was refused; whatever was already
 * written stays written, and a re-run resumes safely); 2 a usage or credentials
 * problem, nothing read.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import type { Env } from '../src/index'
import { getSalesforceToken, salesforceTokenCacheKey } from '../src/engine/nodes/salesforce'
import { pickSalesforceCreds, resolveSalesforceCredentialOrg, resolveSalesforceCredsFor, type SalesforceCreds } from '../src/lib/salesforce-creds'
import { parseBackfillArgs, runBackfill, salesforceSubmissionStore } from '../src/lib/fallback-pd-timestamp-backfill'
import { formatErr } from '../src/lib/format-error'
import { loadDevVars } from './lib/dev-vars'

/** The shell's values, then .dev.vars for anything the shell leaves unset. No value is printed. */
function readVars(): Record<string, string> {
  let fromFile: Record<string, string> = {}
  try {
    fromFile = loadDevVars()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const out: Record<string, string> = { ...fromFile }
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && v.trim()) out[k] = v
  return out
}

/** The Worker's KV, in memory: getSalesforceToken and the env loader cache through it. */
function memoryKv(): KVNamespace {
  const m = new Map<string, string>()
  return {
    get: (k: string) => Promise.resolve(m.get(k) ?? null),
    put: (k: string, v: string) => {
      m.set(k, v)
      return Promise.resolve()
    },
    delete: (k: string) => {
      m.delete(k)
      return Promise.resolve()
    },
  } as unknown as KVNamespace
}

const SUPABASE_NAMES = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SECRET_ENCRYPTION_KEY']

async function resolveCreds(vars: Record<string, string>, env: Env): Promise<{ creds: SalesforceCreds; orgId: string } | { error: string }> {
  const direct = pickSalesforceCreds({}, vars)
  if (direct.creds) return { creds: direct.creds, orgId: 'backfill-local' }

  const missingSupabase = SUPABASE_NAMES.filter((n) => !vars[n])
  if (missingSupabase.length) {
    return {
      error:
        `Salesforce credentials not found. Set either ${direct.missing.join(', ')} (missing), ` +
        `or ${missingSupabase.join(', ')} (missing) so they can be read from the organization store.`,
    }
  }
  const supabase = createClient(vars.SUPABASE_URL, vars.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
  const lookup = await resolveSalesforceCredentialOrg(supabase)
  const orgId = lookup.orgId
  if (!orgId) return { error: `could not find the organization holding the Salesforce credentials: ${lookup.error ?? 'no reason given'}` }
  const resolved = await resolveSalesforceCredsFor(env, supabase, orgId)
  if (!resolved.creds) return { error: `Salesforce credentials missing from the organization store and the shell: ${resolved.missing.join(', ')}` }
  return { creds: resolved.creds, orgId }
}

async function main(): Promise<number> {
  const args = parseBackfillArgs(process.argv.slice(2))
  if ('error' in args) {
    console.error(`${args.error}\nusage: npx tsx scripts/backfill-fallback-pd-timestamp.ts [--apply [--limit N]]`)
    return 2
  }

  const vars = readVars()
  const kv = memoryKv()
  const env = { ...vars, WORKFLOW_CACHE: kv } as unknown as Env
  const found = await resolveCreds(vars, env)
  if ('error' in found) {
    console.error(found.error)
    return 2
  }
  const { creds, orgId } = found

  const store = salesforceSubmissionStore({
    instanceUrl: creds.instanceUrl,
    token: () => getSalesforceToken(env, orgId, creds.instanceUrl, creds.clientId, creds.clientSecret),
    evictToken: () => kv.delete(salesforceTokenCacheKey(orgId)),
  })

  let onResult: ((r: object) => void) | undefined
  if (args.apply) {
    const file = vars.BACKFILL_RESULTS_FILE || join(tmpdir(), `fallback-pd-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
    writeFileSync(file, '')
    console.log(`Per record results: ${file}`)
    onResult = (r) => appendFileSync(file, `${JSON.stringify(r)}\n`)
  }

  const result = await runBackfill(store, args, { print: (l) => console.log(l), onResult })
  return result.exitCode
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    // Any batch already sent stays written; the results file lists it, and a re-run resumes safely.
    console.error(`backfill failed: ${formatErr(e)}`)
    process.exit(1)
  },
)
