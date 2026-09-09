import { describe, it, expect } from 'vitest'
// @ts-expect-error Vite resolves ?raw to the file's text; no ambient declaration here.
import INDEX_SOURCE from '../index.ts?raw'

/**
 * The daily 13:00 batch stamps itself completed only once every check it
 * launched has settled (#985). That promise holds only for checks registered
 * through `track()`, which both pushes into `dailyWork` AND calls waitUntil. A
 * check added with a bare `ctx.waitUntil` still runs, and still has its own
 * failure boundary, so it looks completely correct at the call site, but the
 * batch can stamp "completed" while it is still going.
 *
 * That is invisible to the heartbeat tests, because they enumerate what the
 * batch tracked rather than what it started, so a check that opted out cannot
 * be seen by the very machinery meant to notice a check not running (L96: a
 * guard driven by a registry checks only what the registry lists).
 *
 * Two checks were added this way on 2026-09-09 (#1010, #1230) by copying the
 * shape of a neighbouring block rather than the shape of this one.
 */
describe('the daily 13:00 cron batch', () => {
  const block = (() => {
    const start = INDEX_SOURCE.indexOf("event.cron === '0 13 * * *'")
    expect(start).toBeGreaterThan(-1)
    const end = INDEX_SOURCE.indexOf("event.cron ===", start + 10)
    return INDEX_SOURCE.slice(start, end === -1 ? INDEX_SOURCE.length : end)
  })()

  // Proves the slice actually contains the batch, so an empty or mislocated
  // block cannot pass every assertion below at once (L215).
  it('was located, and contains the checks it is supposed to run', () => {
    expect(block).toContain('daily-1300')
    expect(block.match(/\btrack\(/g)?.length ?? 0).toBeGreaterThan(5)
  })

  it('registers every check through track(), never a bare ctx.waitUntil', () => {
    const lines = block.split('\n')
    const offenders: string[] = []
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s+ctx\.waitUntil\(/.test(lines[i])) continue
      // Three bare calls are the heartbeat machinery itself, not checks, and
      // must stay bare: the "started" stamp, the waitUntil inside track(), and
      // the completion stamp, which waits on dailyWork and would deadlock if it
      // were tracked. Recognised by what they call rather than by line number,
      // so this does not go stale as the block moves.
      const window = lines.slice(i, i + 3).join(' ')
      if (/writeHeartbeat|completeAfter/.test(window)) continue
      if (/^\s+ctx\.waitUntil\(p\)/.test(lines[i])) continue
      offenders.push(lines.slice(i, i + 4).join('\n'))
    }
    expect(offenders).toEqual([])
  })
})
