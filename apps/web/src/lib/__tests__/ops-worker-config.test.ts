import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * The ops Worker's own config (#1709 part 3, plan 0.E): its lane, its code
 * namespace and that namespace's outbound Worker, and its tail consumer.
 *
 * src/ops/index.ts refuses every request unless LANE is "ops", so the var is
 * what lets it serve at all. The namespace's outbound Worker must be the ops
 * one, never the compare one (a shadow run's deny Worker, which Phase 2 must
 * not loosen) and never absent (the platform would then send ops code's
 * requests straight to the internet).
 */
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')

/** The bodies of every `[name]` or `[[name]]` table, each up to the next header. */
function tables(toml: string, name: string): string[] {
  const header = new RegExp(`^\\[{1,2}${name.replace(/\./g, '\\.')}\\]{1,2}\\s*$`)
  const out: string[] = []
  let current: string[] | null = null
  for (const line of toml.split('\n')) {
    if (/^\[/.test(line)) {
      if (current) out.push(current.join('\n'))
      current = header.test(line) ? [] : null
    } else if (current) current.push(line)
  }
  if (current) out.push(current.join('\n'))
  return out
}

/**
 * What is wrong with the config's Durable Object bindings, as sentences: each
 * binding must name a class the ops entry module exports, created by one of
 * the config's own migrations, and never a script_name (another Worker's
 * objects). Exported so its own red case can be planted.
 */
export function durableObjectProblems(toml: string, opsIndexSource: string): string[] {
  const created = new Set(
    tables(toml, 'migrations').flatMap((t) => {
      const list = /^new_(?:sqlite_)?classes = \[([^\]]*)\]$/m.exec(t)
      return list ? [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
    }),
  )
  const problems: string[] = []
  for (const binding of tables(toml, 'durable_objects.bindings')) {
    const name = /^name = "([^"]+)"$/m.exec(binding)?.[1] ?? '(unnamed)'
    const className = /^class_name = "([^"]+)"$/m.exec(binding)?.[1]
    const script = /^script_name = "([^"]+)"$/m.exec(binding)?.[1]
    if (script !== undefined) problems.push(`${name} names script_name ${script}, another Worker's object`)
    if (className === undefined) {
      problems.push(`${name} names no class_name`)
      continue
    }
    const exported = new RegExp(`^export \\{ ${className} \\} from '\\./[a-z-]+'$`, 'm').test(opsIndexSource)
    if (!exported) problems.push(`${name} names ${className}, which src/ops/index.ts does not export`)
    if (!created.has(className)) problems.push(`${name} names ${className}, which no migration in this config creates`)
  }
  return problems
}

describe('wrangler.ops.toml (#1709)', () => {
  const toml = read('apps/worker/wrangler.ops.toml')
  const opsIndex = read('apps/worker/src/ops/index.ts')

  it('reads the tables it asserts on, so a renamed header fails rather than passing on nothing', () => {
    expect(tables(toml, 'r2_buckets')).toHaveLength(1)
    expect(tables(toml, 'r2_buckets')[0]).toMatch(/^binding = "PORTING_TEE"$/m)
    expect(tables(toml, 'nothing_here')).toEqual([])
  })

  it('sets LANE to ops, without which the Worker serves nothing', () => {
    expect(tables(toml, 'vars')).toHaveLength(1)
    expect(tables(toml, 'vars')[0]).toMatch(/^LANE = "ops"$/m)
  })

  it('binds the ops code namespace with the ops outbound Worker, never the compare or bidding namespace', () => {
    const namespaces = tables(toml, 'dispatch_namespaces')
    expect(namespaces).toHaveLength(1)
    expect(namespaces[0]).toMatch(/^binding = "CODE_NODES_OPS"$/m)
    expect(namespaces[0]).toMatch(/^namespace = "bidspoke-code-nodes-ops"$/m)
    expect(namespaces[0]).toMatch(/^outbound = \{ service = "bidspoke-ops-outbound" \}$/m)
  })

  it('names the outbound Worker the ops-outbound app deploys', () => {
    expect(read('apps/ops-outbound/wrangler.toml')).toMatch(/^name = "bidspoke-ops-outbound"$/m)
  })

  it('sends its traces to the tail consumer, which skips them until Phase 1', () => {
    const tails = tables(toml, 'tail_consumers')
    expect(tails).toHaveLength(1)
    expect(tails[0]).toMatch(/^service = "bidspoke-worker-tail"$/m)
    expect(read('apps/worker-tail/wrangler.toml')).toMatch(/^name = "bidspoke-worker-tail"$/m)
  })

  it('still holds no binding of the bidding Worker: no KV, no database', () => {
    for (const name of ['kv_namespaces', 'd1_databases', 'hyperdrive']) {
      expect(tables(toml, name), name).toEqual([])
    }
  })

  /**
   * Durable Objects only of classes ops itself exports (#2334, phase 4 of
   * #1689). A binding with a script_name reaches another Worker's objects (the
   * bidding Worker's BulkheadObject, its buyer ledgers), which ops must never
   * hold (Hard Rule 1), so a binding names a class_name only, and every class
   * it names is exported from src/ops/index.ts and created by one of this
   * config's own migrations.
   */
  it('binds Durable Objects only of classes ops itself exports, never through a script_name', () => {
    expect(durableObjectProblems(toml, opsIndex)).toEqual([])
    expect(tables(toml, 'durable_objects.bindings').length).toBeGreaterThanOrEqual(1)
  })

  it('sees a binding to another Worker\'s object, a class ops does not export, and one no migration creates (seen red)', () => {
    const planted = `${toml}\n[[durable_objects.bindings]]\nname = "BULKHEAD"\nclass_name = "BulkheadObject"\nscript_name = "bidspoke-worker"\n`
    const problems = durableObjectProblems(planted, opsIndex)
    expect(problems).toContain('BULKHEAD names script_name bidspoke-worker, another Worker\'s object')
    expect(problems).toContain('BULKHEAD names BulkheadObject, which src/ops/index.ts does not export')
    expect(problems).toContain('BULKHEAD names BulkheadObject, which no migration in this config creates')
  })

  /**
   * The first ops object (#2334): ConnectionTokenObject, SQLite backed, under
   * the ops Worker's own migration v1. Durable Object migrations are one way
   * (ADR 0011): v1 is the ops Worker's rollback floor, recorded in
   * docs/disaster-recovery.md.
   */
  it('creates ConnectionTokenObject under its own migration v1, and records it as the ops rollback floor', () => {
    const migrations = tables(toml, 'migrations')
    expect(migrations).toHaveLength(1)
    expect(migrations[0]).toMatch(/^tag = "v1"$/m)
    expect(migrations[0]).toMatch(/^new_sqlite_classes = \["ConnectionTokenObject"\]$/m)
    const bindings = tables(toml, 'durable_objects.bindings')
    expect(bindings).toHaveLength(1)
    expect(bindings[0]).toMatch(/^name = "CONNECTION_TOKENS"$/m)
    expect(bindings[0]).toMatch(/^class_name = "ConnectionTokenObject"$/m)
    expect(read('docs/disaster-recovery.md')).toContain('`bidspoke-worker-ops` Durable Object migrations: `v1`')
  })

  /**
   * Two service bindings, each to a NAMED entrypoint (#1946, #1949): SELF, to this
   * Worker's own OpsInternal, and OPS_GATEWAY, to the bidding Worker's OpsGateway
   * (decision 4: the ops workflows' state and the minute cron's heartbeat). A
   * binding to either Worker's default export, which the public route also
   * reaches, or any third binding, must fail here.
   */
  it('holds exactly two service bindings: SELF to its own OpsInternal, OPS_GATEWAY to the bidding Worker\'s OpsGateway', () => {
    const services = tables(toml, 'services')
    expect(services).toHaveLength(2)
    const byBinding = new Map(services.map((t) => [/^binding = "([^"]+)"$/m.exec(t)?.[1], t]))
    expect([...byBinding.keys()].sort()).toEqual(['OPS_GATEWAY', 'SELF'])
    const self = byBinding.get('SELF')!
    expect(self).toMatch(/^service = "bidspoke-worker-ops"$/m)
    expect(self).toMatch(/^entrypoint = "OpsInternal"$/m)
    const gateway = byBinding.get('OPS_GATEWAY')!
    expect(gateway).toMatch(/^service = "bidspoke-worker"$/m)
    expect(gateway).toMatch(/^entrypoint = "OpsGateway"$/m)
    for (const t of services) expect(t, 'every binding names an entrypoint, never a default export').toMatch(/^entrypoint = "[A-Za-z]+"$/m)
    expect(toml).toMatch(/^name = "bidspoke-worker-ops"$/m)
  })

  it('binds an entrypoint the bidding Worker really exports', () => {
    expect(read('apps/worker/src/index.ts')).toMatch(/^export \{ OpsGateway \} from '\.\/lib\/ops-gateway-entrypoint'$/m)
    expect(read('apps/worker/src/lib/ops-gateway-entrypoint.ts')).toMatch(/^export class OpsGateway extends WorkerEntrypoint<Env>/m)
  })

  /**
   * The minute cron (#1949), stated, never left out (#1946): wrangler deploy
   * leaves a Worker's existing schedules alone when the config names none, so
   * removing Spike 0's [triggers] block left its minute cron firing into a Worker
   * with no scheduled() handler (measured 2026-10-16, 19:05 UTC). The tick now
   * has its handler, and this is its one schedule.
   */
  it('declares the one minute cron the tick runs on, and exports the handler it fires (#1949)', () => {
    const triggers = tables(toml, 'triggers')
    expect(triggers).toHaveLength(1)
    expect(triggers[0]).toMatch(/^crons = \["\* \* \* \* \*"\]$/m)
    expect(read('apps/worker/src/ops/index.ts')).toMatch(/^ {2}scheduled\(controller: ScheduledController, env: OpsEnv\): Promise<void> \{$/m)
  })

  it('exports the OpsInternal entrypoint the SELF binding names from its main module', () => {
    expect(toml).toMatch(/^main = "src\/ops\/index\.ts"$/m)
    expect(read('apps/worker/src/ops/index.ts')).toMatch(/^export \{ OpsInternal \} from '\.\/internal'$/m)
  })

  /**
   * OpsConnections (#2335, PR 8 of phase 5), the entrypoint the bidding Worker's
   * OPS_CONNECTIONS binding (PR 9) names. Cloudflare accepts a binding to an
   * entrypoint the deployed Worker does not export, and every call then throws
   * (Phase 0 spike, #2330), so it must stay exported from the main module, and
   * the first deploy carrying it is the ops Worker's rollback floor.
   */
  it('exports the OpsConnections entrypoint from its main module, and records it as the ops rollback floor', () => {
    expect(read('apps/worker/src/ops/index.ts')).toMatch(/^export \{ OpsConnections \} from '\.\/ops-connections-entrypoint'$/m)
    expect(read('apps/worker/src/ops/ops-connections-entrypoint.ts')).toMatch(/^export class OpsConnections extends WorkerEntrypoint<OpsEnv>/m)
    expect(read('docs/disaster-recovery.md')).toContain('the first deploy exporting `OpsConnections`')
  })
})

/**
 * The ops Worker's route lives in Cloudflare, not in its config (#1709). CI's
 * Cloudflare token cannot manage zone routes: the first Deploy Ops Worker run
 * (37535186964, 2026-10-06) uploaded the Worker and then failed on
 * /zones/.../workers/routes. The bidding Worker's route is held the same way
 * (docs/disaster-recovery.md, configuration that exists only in a dashboard),
 * and every Deploy Ops Worker run proves the route still answers with
 * .github/scripts/prove-ops-host.sh.
 */
describe('the ops Worker route (#1709)', () => {
  it('is not declared in wrangler.ops.toml, where CI would fail trying to manage it', () => {
    const toml = read('apps/worker/wrangler.ops.toml')
    expect(toml.split('\n').filter((l) => /^\s*(routes?|\[\[routes\]\])\s*(=|$)/.test(l))).toEqual([])
  })

  it('is listed among the configuration that exists only in a dashboard', () => {
    expect(read('docs/disaster-recovery.md')).toContain('Worker route `ops.trypennie.dev/porting/*` to `bidspoke-worker-ops`')
  })
})
