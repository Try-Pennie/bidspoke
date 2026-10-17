import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { DELIVERY_HELD_CAP, FAIL_OPEN_HELD_CAP, SCHEDULED_DELIVERIES_PER_DAY } from '../../../../../worker-tail/src/copier-caps'

/**
 * The tail worker's held-row caps cover a day long database outage (#2284).
 *
 * The tail worker holds rows the database refuses and writes them with a later
 * batch, up to a cap, past which it drops the oldest. The cron delivery record
 * first shared the fail-open record's 2,000, sized as "a day of the minute tick",
 * while it receives every delivery of every cron: about 1,900 a day, twice that
 * while Cloudflare doubles ticks. So a day of database outage dropped records.
 * Each record now has its own cap, and this holds both against the crons the
 * bidding Worker actually runs, read from its wrangler.toml, so a new cron
 * cannot quietly shrink the margin.
 */

const WRANGLER = path.join(REPO_ROOT, 'apps/worker/wrangler.toml')

/** Deliveries a day of the bidding Worker's crons. Only the shapes it runs are counted; anything else fails. */
function deliveriesPerDay(): number {
  const toml = readFileSync(WRANGLER, 'utf8')
  const match = /^crons = (\[.*\])$/m.exec(toml)
  if (!match) throw new Error('no crons line in apps/worker/wrangler.toml')
  const crons = JSON.parse(match[1]) as string[]
  const count = (field: string, span: number) => {
    if (field === '*') return span
    const step = /^\*\/(\d+)$/.exec(field)
    if (step) return Math.ceil(span / Number(step[1]))
    if (/^\d+$/.test(field)) return 1
    throw new Error(`a cron field this guard cannot count: ${field}`)
  }
  return crons.reduce((n, cron) => {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/)
    if (dayOfMonth !== '*' || month !== '*' || dayOfWeek !== '*') throw new Error(`a cron this guard cannot count: ${cron}`)
    return n + count(minute, 60) * count(hour, 24)
  }, 0)
}

describe('the tail worker\'s held-row caps (#2284)', () => {
  it('state the deliveries a day the crons really make', () => {
    expect(SCHEDULED_DELIVERIES_PER_DAY).toBe(deliveriesPerDay())
  })

  it('hold two days of every cron delivered twice before the delivery record drops one', () => {
    expect(DELIVERY_HELD_CAP).toBeGreaterThanOrEqual(2 * 2 * deliveriesPerDay())
  })

  it('hold a whole day of every cron failing open before the fail-open record drops one', () => {
    expect(FAIL_OPEN_HELD_CAP).toBeGreaterThanOrEqual(deliveriesPerDay())
  })
})
