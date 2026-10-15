/**
 * BIDDING_PICKUP is never smaller than the bound the Worker's own settings
 * give (#2132, L316).
 *
 * Every sentence that says when bidding sees a change reads BIDDING_PICKUP
 * (apps/web/src/lib/bidding-pickup.ts). Its figures were measured, but they hold
 * only while the Worker settings behind them stay as they were: how old the
 * partner constants last good copy may get before the prewarm reconfirms it,
 * how often the prewarm runs, how long a warm isolate keeps its memory copy,
 * and the buyer profile cache TTL. This reads each from the Worker source,
 * derives the bound, and fails when it exceeds the constant, so a change to any
 * of them re-opens the copy rather than leaving it promising too little time.
 *
 * Seen red by raising STORED_COPY_RECONFIRM_AFTER_MS from 5 to 8 minutes (the
 * partner constants bound became 11 minutes, over the constant's 8).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WORKER_SRC } from '../../__tests__/_scan-utils'
import { BIDDING_PICKUP, KV_PROPAGATION_MS } from '../../bidding-pickup'

const read = (rel: string) => readFileSync(path.join(WORKER_SRC, rel), 'utf8')

/** The value of `const NAME = <arithmetic>` in a source file, evaluated; throws when it is not there. */
export function constantIn(source: string, name: string): number {
  const m = source.match(new RegExp(`(?:export )?const ${name}\\s*=\\s*([0-9_ *+]+)\\n`))
  if (!m) throw new Error(`${name} is not declared as a plain number in this file`)
  const expr = m[1].replace(/_/g, '').trim()
  if (!/^[0-9 *+]+$/.test(expr)) throw new Error(`${name} = ${expr} is not plain arithmetic`)
  return expr.split('+').reduce((sum, term) => sum + term.split('*').reduce((p, f) => p * Number(f.trim()), 1), 0)
}

/** The interval, in ms, of the cron the scheduled handler runs prewarmKvCaches under. */
export function prewarmTickMs(indexSource: string, wranglerToml: string): number {
  const call = indexSource.indexOf('prewarmKvCaches(supabase, env')
  if (call === -1) throw new Error('index.ts no longer calls prewarmKvCaches(supabase, env...)')
  const branch = indexSource.slice(0, call).match(/event\.cron === '([^']+)'(?![\s\S]*event\.cron === ')/)
  if (!branch) throw new Error('could not find the cron branch that runs the prewarm')
  const cron = branch[1]
  if (!wranglerToml.includes(`"${cron}"`)) throw new Error(`the prewarm's cron ${cron} is not registered in wrangler.toml`)
  if (cron === '* * * * *') return 60_000
  const every = cron.match(/^\*\/(\d+) \* \* \* \*$/)
  if (every) return Number(every[1]) * 60_000
  throw new Error(`cannot read an interval from the prewarm's cron ${cron}`)
}

export function derivedBounds() {
  const reconfirm = constantIn(read('lib/stored-copy-age.ts'), 'STORED_COPY_RECONFIRM_AFTER_MS')
  const memory = constantIn(read('lib/partner-constants-loader.ts'), 'MEMORY_TTL_MS')
  const profileTtlMs = constantIn(read('lib/buyer-profile-loader.ts'), 'BUYER_PROFILES_CACHE_TTL_SECONDS') * 1000
  const tick = prewarmTickMs(read('index.ts'), readFileSync(path.join(REPO_ROOT, 'apps/worker/wrangler.toml'), 'utf8'))
  return {
    // The reconfirm falls due, the next tick finds it, a warm isolate keeps its
    // memory copy, and other locations see KV's write a little later.
    partnerConstantsMs: reconfirm + tick + memory + KV_PROPAGATION_MS,
    // The prewarm rebuilds the cache every tick (the TTL bounds it if it stops), then KV propagates.
    buyerProfilesMs: Math.min(profileTtlMs, tick) + KV_PROPAGATION_MS,
    parts: { reconfirm, memory, profileTtlMs, tick },
  }
}

describe('BIDDING_PICKUP covers the bound the Worker settings give (#2132)', () => {
  it('reads every part from the Worker source', () => {
    const { parts } = derivedBounds()
    expect(parts.reconfirm).toBeGreaterThan(0)
    expect(parts.memory).toBeGreaterThan(0)
    expect(parts.profileTtlMs).toBeGreaterThan(0)
    expect(parts.tick).toBe(60_000)
  })

  it('partner constants: the constant is at least the derived bound', () => {
    const { partnerConstantsMs } = derivedBounds()
    expect(BIDDING_PICKUP.partnerConstantsMinutes * 60_000).toBeGreaterThanOrEqual(partnerConstantsMs)
  })

  it('buyer profiles: the constant is at least the derived bound', () => {
    const { buyerProfilesMs } = derivedBounds()
    expect(BIDDING_PICKUP.buyerProfilesMinutes * 60_000).toBeGreaterThanOrEqual(buyerProfilesMs)
  })

  it('the reader fails loudly on a constant it cannot read, rather than deriving from nothing', () => {
    expect(() => constantIn('const X = someCall()\n', 'X')).toThrow(/plain number/)
    expect(constantIn('export const X = 5 * 60 * 1000\n', 'X')).toBe(300_000)
    expect(constantIn('const MEMORY_TTL_MS = 15_000\n', 'MEMORY_TTL_MS')).toBe(15_000)
  })
})
