/**
 * Read-only preview of the "timeouts that could be lower" audit against prod,
 * using the existing per-namespace step_duration_percentiles RPC (so it works
 * before the new grouped RPC migration is applied). Mirrors the threshold in
 * findOverProvisionedNodes: configured > 3x suggested, >= 50 completed runs.
 * Run: npx tsx scripts/diagnose-over-provisioned.ts
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { suggestedTimeoutMs, OVER_PROVISION_FACTOR, OVER_PROVISION_MIN_SAMPLE } from '../src/lib/timeout-audit'
import type { WorkflowDefinition } from '../src/types'

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
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: wfs } = await supabase
    .from('workflows')
    .select('id, name, definition, organization_id')
    .eq('is_active', true)
    .is('deleted_at', null)

  let flagged = 0
  for (const w of wfs ?? []) {
    const def = w.definition as WorkflowDefinition | null
    if (!Array.isArray(def?.nodes)) continue
    const hits: string[] = []
    for (const node of def.nodes) {
      const timeout = node.config?.timeout_ms
      if (typeof timeout !== 'number') continue
      const { data: rows } = await supabase.rpc('step_duration_percentiles', {
        p_workflow_id: w.id, p_namespace: node.namespace, p_since: since,
      })
      const r = (rows ?? [])[0] as { p99: number | null; max_ms: number | null; sample_size: number } | undefined
      if (!r || r.p99 == null || r.max_ms == null) continue
      const sample = Number(r.sample_size)
      if (sample < OVER_PROVISION_MIN_SAMPLE) continue
      const suggested = suggestedTimeoutMs(node.type, r.p99, r.max_ms)
      if (timeout > suggested * OVER_PROVISION_FACTOR) {
        hits.push(`${node.label || node.namespace}(${node.type}): set ${timeout}ms, suggested ~${suggested}ms (p99 ${r.p99}ms, ${sample} runs)`)
      }
    }
    if (hits.length) {
      flagged += hits.length
      console.log(`\n${w.name}:`)
      for (const h of hits) console.log(`  - ${h}`)
    }
  }
  console.log(`\nTotal over-provisioned nodes flagged: ${flagged}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
