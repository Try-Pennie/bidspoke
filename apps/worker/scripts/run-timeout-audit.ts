/**
 * Manually run the timeout-floor audit against production and post the Slack
 * alert now, instead of waiting for the 13:00 UTC cron.
 *
 * Uses a no-op KV (get -> null), so the once-a-day dedup signature is skipped:
 * the alert fires whenever there is anything to report, regardless of what the
 * prod cron has already seen. Reads SUPABASE_URL + SUPABASE_SECRET_KEY from
 * apps/worker/.dev.vars; the Slack bot token is read from the DB by
 * getSlackConnection, so nothing else is needed.
 *
 * Run:  npx tsx scripts/run-timeout-audit.ts        (from apps/worker)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { runTimeoutAuditCheck } from '../src/lib/timeout-audit'

const here = dirname(fileURLToPath(import.meta.url))

function loadDevVars(): Record<string, string> {
  const raw = readFileSync(resolve(here, '..', '.dev.vars'), 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

async function main() {
  const vars = loadDevVars()
  const url = vars.SUPABASE_URL
  const key = vars.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SECRET_KEY missing from .dev.vars')

  const appUrl = process.env.APP_URL ?? 'https://bidspoke.trypennie.dev'
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  // No-op KV: get -> null forces "signature changed" so the alert always posts;
  // put is a no-op so we don't touch the prod dedup state.
  const noopKv = {
    get: async () => null,
    put: async () => {},
  }

  console.log(`[run-timeout-audit] running against ${url} -> appUrl=${appUrl}`)
  await runTimeoutAuditCheck(supabase, noopKv, appUrl)
  console.log('[run-timeout-audit] done (check Slack; no post means no offending nodes or no Slack-connected org)')
}

main().catch((e) => {
  console.error('[run-timeout-audit] failed:', e)
  process.exit(1)
})
