/**
 * Guard against the recurring "node leaks a side effect in a shadow dry-run" bug
 * (#230). Shadow mode (apps/worker/src/engine/shadow.ts) requires every node that
 * performs an external side effect (HTTP fetch, KV write, Supabase write, Durable
 * Object call) to short-circuit under isShadowDryRun(ctx). Nothing enforced this:
 * the shadow-mode review caught that latency-gate.ts (`mark` -> kv.put) was missed
 * entirely, and a newly added node could leak the same way.
 *
 * This mirrors the partition-guard pattern from #220
 * (worker-big-table-pagination.test.ts): a pure classifier with synthetic-input
 * unit tests, plus an integration scan over the real node executors asserting the
 * tree is clean.
 *
 * Limitation (documented, accepted by #230): detection is text-based, so a node
 * that performs outbound work only by DELEGATING to an imported helper with none
 * of the marker tokens below won't be caught. The explicit pure/read-only
 * allowlist is the backstop — a new node is forced to be classified either way.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findShadowGuardViolations, SHADOW_EXEMPT_NODES } from '../../shadow-side-effect-guard'

describe('findShadowGuardViolations (classifier)', () => {
  it('flags a non-exempt node that fetches without a shadow guard', () => {
    const v = findShadowGuardViolations([
      { name: 'evil', content: 'export async function run() { await fetch("https://x") }' },
    ])
    expect(v.map((x) => x.node)).toEqual(['evil'])
  })

  it('passes a node that fetches but short-circuits under isShadowDryRun', () => {
    const v = findShadowGuardViolations([
      {
        name: 'good',
        content:
          'import { isShadowDryRun } from "../shadow"\n' +
          'export async function run(ctx) { if (isShadowDryRun(ctx)) return stub; await fetch("https://x") }',
      },
    ])
    expect(v).toEqual([])
  })

  it('passes a shadow-aware writing node even if it is not on the allowlist', () => {
    const v = findShadowGuardViolations([
      {
        name: 'writer',
        content: 'import { isShadowDryRun } from "../shadow"\nif (isShadowDryRun(ctx)) return; await kv.put(k, v)',
      },
    ])
    expect(v).toEqual([])
  })

  it('flags an allowlisted "pure" node that actually performs a write', () => {
    const v = findShadowGuardViolations([
      { name: 'branch', content: 'await supabase.from("t").insert(row)' },
    ])
    expect(v).toHaveLength(1)
    expect(v[0].node).toBe('branch')
    expect(v[0].reason).toMatch(/allowlist/i)
  })

  it('flags a non-exempt node with no outbound markers that is not classified', () => {
    const v = findShadowGuardViolations([
      { name: 'mystery', content: 'export function run() { return { output: {} } }' },
    ])
    expect(v).toHaveLength(1)
    expect(v[0].node).toBe('mystery')
    expect(v[0].reason).toMatch(/classif/i)
  })

  it('passes an exempt, genuinely pure node', () => {
    const v = findShadowGuardViolations([
      { name: 'transform', content: 'export function run() { return { output: mapFields(input) } }' },
    ])
    expect(v).toEqual([])
  })

  it('detects Durable Object calls as an outbound side effect', () => {
    const v = findShadowGuardViolations([
      { name: 'caps', content: 'const id = env.DAILY_CAP.idFromName("x"); await env.DAILY_CAP.get(id).fetch(u)' },
    ])
    expect(v.map((x) => x.node)).toEqual(['caps'])
  })
})

const dir = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = path.resolve(dir, '../../../../../..')
const NODES_DIR = path.join(REPO_ROOT, 'apps/worker/src/engine/nodes')

function listNodeFiles(): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = []
  for (const entry of readdirSync(NODES_DIR)) {
    const full = path.join(NODES_DIR, entry)
    if (statSync(full).isDirectory()) continue // __tests__
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
    if (entry === 'index.ts') continue // dispatcher, not a node executor
    out.push({ name: entry.replace(/\.ts$/, ''), content: readFileSync(full, 'utf8') })
  }
  return out
}

describe('every side-effecting node executor is shadow-mode aware (#230)', () => {
  it('no node performs an outbound side effect in a shadow dry-run without a guard', () => {
    const violations = findShadowGuardViolations(listNodeFiles())
    const report = violations.map((v) => `  ${v.node}: ${v.reason}`).join('\n')
    expect(
      violations,
      `Shadow side-effect guard violation(s):\n${report}\n\n` +
        `A node that performs HTTP/KV/DB/Durable-Object work must short-circuit under ` +
        `isShadowDryRun(ctx) (see apps/worker/src/engine/shadow.ts), or be added to ` +
        `SHADOW_EXEMPT_NODES if it is genuinely pure/read-only.`,
    ).toEqual([])
  })

  // The two Achieve screening helpers were added to SHADOW_EXEMPT_NODES on 2026-08-17. They are
  // helpers rather than executors: both only READ the execution context (the lead payload and
  // the credit report already pulled upstream) and reach nothing outside the isolate, so a
  // shadow dry-run may run them freely. This asserts the claim that earned them the exemption,
  // against the real files, so the exemption cannot quietly become a licence to add a call.
  it('holds the Achieve screening helpers to the pure claim that exempted them', () => {
    const files = listNodeFiles()
    for (const name of ['achieve-credit-report', 'achieve-screen']) {
      const file = files.find((f) => f.name === name)
      expect(file, `${name} is no longer a node file`).toBeDefined()
      expect(SHADOW_EXEMPT_NODES).toContain(name)
      // Judged by the guard itself rather than a regex copied from it, so the two cannot drift.
      expect(findShadowGuardViolations([file!])).toEqual([])
    }
  })

  it('keeps the allowlist honest — every exempt node still exists as a node file', () => {
    const names = new Set(listNodeFiles().map((f) => f.name))
    const stale = SHADOW_EXEMPT_NODES.filter((n) => !names.has(n)).sort()
    expect(stale, `SHADOW_EXEMPT_NODES references node(s) that no longer exist: ${stale.join(', ')}`).toEqual([])
  })
})
