/**
 * Read-only diagnostic for the timeout-floor audit. Prints, per Slack-connected
 * org, how many offending nodes exist and which channel the alert targets.
 * Does NOT post to Slack. Run: npx tsx scripts/diagnose-timeout-audit.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { getOrgTimeoutWarnings } from '../src/lib/timeout-audit'
import { getSlackConnection } from '../src/lib/slack'

const here = dirname(fileURLToPath(import.meta.url))
function loadDevVars(): Record<string, string> {
  const raw = readFileSync(resolve(here, '..', '.dev.vars'), 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    out[t.slice(0, eq).trim()] = val
  }
  return out
}

async function main() {
  const vars = loadDevVars()
  const supabase = createClient(vars.SUPABASE_URL, vars.SUPABASE_SECRET_KEY, { auth: { persistSession: false } })

  const { data: slackOrgs } = await supabase
    .from('service_connections')
    .select('organization_id')
    .eq('service_type', 'slack')
  const orgIds = [...new Set((slackOrgs ?? []).map((c) => c.organization_id as string))]
  console.log(`Slack-connected orgs: ${orgIds.length}`)

  for (const orgId of orgIds) {
    const warnings = await getOrgTimeoutWarnings(supabase, orgId)
    const totalNodes = warnings.reduce((n, w) => n + w.nodes.length, 0)
    const conn = await getSlackConnection(supabase, orgId)
    console.log(`\norg ${orgId}`)
    console.log(`  config_alerts_enabled: ${conn?.config_alerts_enabled}`)
    console.log(`  channel: ${conn?.default_channel ?? '(none)'}`)
    console.log(`  offending workflows: ${warnings.length}, nodes: ${totalNodes}`)
    for (const w of warnings) {
      console.log(`    - ${w.workflow_name}: ${w.nodes.map((n) => `${n.label || n.namespace}(${n.configured_ms}<${n.floor_ms})`).join(', ')}`)
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
