import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every Slack alert read of `service_connections` is narrowed to the alert row
 * (#2332, phase 2 of #1689).
 *
 * Release 2 lets an organization hold an ops Slack connection (sealed_for
 * 'ops_key', its own name and bot) beside the alert bot's row. A read that
 * asks for service_type 'slack' alone then reads the ops row as the alert row
 * and posts an alert with the ops bot, or, with both present, fails as "more
 * than one row" and reads as "not connected". The alert row is defined once,
 * onlySlackAlertRow in lib/slack-connection.ts, and every alert reader calls
 * it; this scan fails on a read that skips it (the component plus its guard,
 * L613).
 *
 * This fails on any `.from('service_connections')` in the alert path's
 * modules (lib/slack.ts, lib/alert-fanout.ts, routes/api/integrations.ts) that
 * is not inside onlySlackAlertRow(...), except the three that are not
 * unscoped alert row reads, each with its reason (NOT_ALERT_ROW_READS):
 * - the save's upsert in integrations.ts POST /slack, which writes the alert
 *   row by its conflict target (organization_id, service_type, name 'slack');
 * - the settings change's update in integrations.ts PATCH /slack/settings,
 *   which writes the row by the id its narrowed read returned;
 * - probeSlackConnectionsTable in alert-fanout.ts, the volume check's proof
 *   that the database answers: one organization_id from any row, no token.
 *
 * The other readers of the table (lib/secret-reencrypt.ts, routes/api/
 * connections.ts and admin.ts) are not alert paths and are held by
 * service-connections-readers.test.ts instead.
 */

const ALERT_PATH_FILES = ['lib/slack.ts', 'lib/alert-fanout.ts', 'routes/api/integrations.ts']

const FROM = /\.from\((['"`])service_connections\1\)/g

/** Why a `.from` that is not narrowed is still not an alert row read, by what follows it. */
const NOT_ALERT_ROW_READS: Array<{ follows: RegExp; why: string }> = [
  { follows: /^\s*\.upsert\(/, why: 'the save writes the alert row by its conflict target (organization_id, service_type, name)' },
  { follows: /^\s*\.update\([^)]*\)\s*\.eq\((['"`])id\1/, why: 'the settings change updates the row by the id the narrowed read returned' },
  { follows: /^\s*\.select\((['"`])organization_id\1\)\s*\.limit\(1\)/, why: 'the volume check probes that the database answers, reading no token' },
]

/** Each unnarrowed, unexcused `.from('service_connections')` in `source`, by the text that follows it. */
export function unscopedReads(source: string): string[] {
  const src = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  for (const m of src.matchAll(FROM)) {
    const at = m.index ?? 0
    const before = src.slice(Math.max(0, at - 120), at)
    const after = src.slice(at + m[0].length, at + m[0].length + 200)
    // Inside onlySlackAlertRow( ... ): the call opens before the `.from` and is not yet closed.
    const open = before.lastIndexOf('onlySlackAlertRow(')
    if (open >= 0 && depthAfter(before.slice(open + 'onlySlackAlertRow('.length)) >= 0) continue
    if (NOT_ALERT_ROW_READS.some((e) => e.follows.test(after))) continue
    found.push(after.slice(0, 80).replace(/\s+/g, ' ').trim())
  }
  return found
}

/** The paren depth of `text` from inside an open call: never below zero while the call is still open. */
function depthAfter(text: string): number {
  let depth = 0
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth < 0) return -1
    }
  }
  return depth
}

describe('Slack alert reads are narrowed to the alert row (#2332)', () => {
  for (const rel of ALERT_PATH_FILES) {
    it(`${rel}: every read of service_connections goes through onlySlackAlertRow`, () => {
      expect(unscopedReads(readFileSync(path.join(WORKER_SRC, rel), 'utf8'))).toEqual([])
    })
  }

  it('finds narrowed reads in every alert path file, so it cannot pass by matching nothing', () => {
    for (const rel of ALERT_PATH_FILES) {
      const src = readFileSync(path.join(WORKER_SRC, rel), 'utf8')
      expect([...src.matchAll(FROM)].length, rel).toBeGreaterThan(0)
      expect(src, rel).toContain('onlySlackAlertRow(')
    }
  })

  it('fails on a planted read by service type alone, and passes the narrowed and excused forms', () => {
    // Positive control: the read every alert reader did before #2332.
    expect(unscopedReads(`return supabase.from('service_connections').select(SLACK_ROW_COLUMNS).eq('organization_id', orgId).eq('service_type', 'slack').maybeSingle()`)).toHaveLength(1)
    expect(unscopedReads('const q = supabase\n  .from("service_connections")\n  .select("config")\n  .eq("service_type", "slack")')).toHaveLength(1)
    // A narrowing call that closed before the read does not count.
    expect(unscopedReads(`const f = onlySlackAlertRow(x)\nconst q = supabase.from('service_connections').select('config')`)).toHaveLength(1)
    expect(unscopedReads(`return onlySlackAlertRow(supabase.from('service_connections').select(columns))`)).toEqual([])
    expect(unscopedReads(`return onlySlackAlertRow(\n    supabase\n      .from('service_connections')\n      .select(SLACK_ROW_COLUMNS)\n      .eq('organization_id', orgId),\n  ).limit(2)`)).toEqual([])
    expect(unscopedReads(`await supabase\n    .from('service_connections')\n    .upsert({ name: 'slack' }, { onConflict: 'organization_id,service_type,name' })`)).toEqual([])
    expect(unscopedReads(`return supabase.from('service_connections').select('organization_id').limit(1).abortSignal(signal)`)).toEqual([])
    expect(unscopedReads(`supabase\n      .from('service_connections')\n      .update({ config: nextConfig, updated_by: userId })\n      .eq('id', existing.id)`)).toEqual([])
    // An update scoped by service type alone is not the excused one.
    expect(unscopedReads(`supabase.from('service_connections').update({ config }).eq('service_type', 'slack')`)).toHaveLength(1)
  })
})
