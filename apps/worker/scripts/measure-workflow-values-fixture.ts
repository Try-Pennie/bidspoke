/**
 * Measures the workflow values scanner's live fixture (#2142): the positive
 * control run against the live definitions, kept as a test.
 *
 * Hand run against a clone of Try-Pennie/bidspoke-workflows (the mirror every
 * canvas save writes). It scans the FULL definitions for every partner slug
 * given and records the answer, then keeps of each definition only what the
 * scanner reads (node identities, and of each string only the lines naming
 * `constants` or a `steps.<namespace>.output` path), with each Constants node's
 * data values dropped and its keys kept. `partner-workflow-values-live.test.ts`
 * scans that reduced copy and must reproduce the recorded answer, so the fixture
 * is measured from the definitions rather than shaped to pass (L48), and a
 * reduction that dropped evidence fails.
 *
 * The mirror carries no `is_active`, so every workflow is recorded as active.
 * Sub-account ids are placeholders: no live definition names one literally
 * (checked by the script, which refuses if one does).
 *
 * Run (from apps/worker):
 *   npx tsx scripts/measure-workflow-values-fixture.ts <clone>/workflows <mirror commit> tripoint,sofi,...
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { scanPartnerValueReaders, type ScannableWorkflow } from '../src/lib/partner-workflow-values'
import { summarize, type LiveFixture } from '../src/lib/__tests__/fixtures/workflow-values-live-shape'

const [dir, commit, slugList] = process.argv.slice(2)
if (!dir || !commit || !slugList) throw new Error('usage: measure-workflow-values-fixture.ts <workflows dir> <mirror commit> <slug,slug,...>')

const workflows: ScannableWorkflow[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => {
    const w = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { id: string; name: string; definition: unknown }
    return { id: w.id, name: w.name, is_active: true, definition: w.definition }
  })

const partners = slugList.split(',').map((slug) => ({ slug, subAccountIds: [`sub-account-of-${slug}`] }))

for (const w of workflows) {
  if (/subAccountIdsMap\s*\??\.?\s*\[\s*['"`]/.test(JSON.stringify(w.definition))) {
    throw new Error(`${w.id} names a sub-account id literally; record the real ids instead of placeholders`)
  }
}

// Every Constants node in the mirror is named `constants`, so a line that can
// read one names the word (checked here, which refuses otherwise).
for (const w of workflows) {
  const nodes = ((w.definition as { nodes?: Array<{ type?: unknown; namespace?: unknown }> } | null)?.nodes ?? [])
  for (const n of nodes) if (n.type === 'constants' && n.namespace !== 'constants') throw new Error(`${w.id} names its Constants node ${String(n.namespace)}; widen KEEP_LINE`)
}
const KEEP_LINE = /\bconstants\b/

function reduce(value: unknown, dropData: boolean): unknown {
  if (typeof value === 'string') return value.split('\n').filter((line) => KEEP_LINE.test(line)).join('\n')
  if (Array.isArray(value)) return value.map((v) => reduce(v, false))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (dropData && k === 'data' && v && typeof v === 'object') out[k] = Object.fromEntries(Object.keys(v).map((key) => [key, null]))
      else out[k] = reduce(v, false)
    }
    return out
  }
  return value
}

/** Whether anything the scanner reads is left: a non empty string. */
function keepsText(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.some(keepsText)
  if (value && typeof value === 'object') return Object.values(value).some(keepsText)
  return false
}

/** Drops the empty strings, empty arrays and empty objects a reduction leaves. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune).filter((v) => v !== undefined)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === null) out[k] = null
      else if (keepsText(v)) out[k] = prune(v)
    }
    return out
  }
  return typeof value === 'string' && value.length === 0 ? undefined : value
}

const reduced = workflows.map((w) => {
  const def = (w.definition ?? {}) as { nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> }
  const nodes = (def.nodes ?? [])
    .map((n) => ({ id: n.id, namespace: n.namespace, label: n.label, type: n.type, config: reduce(n.config, n.type === 'constants') }))
    .filter((n) => n.type === 'constants' || keepsText(n.config))
    .map((n) => ({ ...n, config: prune(n.config) }))
  const edges = (def.edges ?? [])
    .map((e) => ({ id: e.id, condition: reduce(e.condition, false) }))
    .filter((e) => keepsText(e.condition))
  return { id: w.id, name: w.name, is_active: w.is_active, definition: { nodes, edges } }
})

const fixture: LiveFixture = {
  about: 'Measured by scripts/measure-workflow-values-fixture.ts from Try-Pennie/bidspoke-workflows; see that script.',
  mirror_commit: commit,
  partners,
  workflows: reduced,
  expected: Object.fromEntries(partners.map((p) => [p.slug, summarize(scanPartnerValueReaders(workflows, p))])),
}

const out = resolve('src/lib/__tests__/fixtures/workflow-values-live.json')
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n')
console.log(`wrote ${out}: ${workflows.length} workflows, ${partners.length} partners`)
