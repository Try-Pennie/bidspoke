import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every alert `slack.ts` exports must have something in production that calls it.
 *
 * Issue #252. Hyperdrive was retired on 2026-06-20 and its cron check was removed
 * in #363, but `sendHyperdriveFallbackAlert` was left behind: exported, fully
 * written, describing a fallback that can no longer happen, and called by nothing
 * at all. It read as a live alert to anyone auditing what this system pages on.
 *
 * That is the worse half of LESSONS L29 and the mirror of L46: an alert nobody
 * calls looks exactly like an alert that has simply never fired, so the roster of
 * what we are actually watched for silently drifts from the roster in the file.
 *
 * A test-only caller does not count. An alert reachable only from its own test is
 * still unreachable in production, which is precisely the state this catches.
 */
const SLACK = path.join(WORKER_SRC, 'lib/slack.ts')

/** Names of the alert helpers `slack.ts` exports. */
export function exportedAlerts(src: string): string[] {
  return [...sanitizeSource(src, { blankStrings: false }).matchAll(/export\s+async\s+function\s+(send[A-Za-z]*)/g)].map(
    (m) => m[1],
  )
}

/** Worker source files that could call an alert, excluding slack.ts itself. */
function productionFiles(): { path: string; src: string }[] {
  return listTsFiles(WORKER_SRC)
    .filter((p) => p !== SLACK)
    .map((p) => ({ path: p, src: readFileSync(p, 'utf8') }))
}

export function alertsWithoutCallers(alerts: string[], files: { path: string; src: string }[]): string[] {
  return alerts.filter((name) => {
    const re = new RegExp(`\\b${name}\\b`)
    return !files.some((f) => re.test(f.src))
  })
}

describe('every exported Slack alert is reachable in production (#252)', () => {
  it('has a production caller for each one', () => {
    const alerts = exportedAlerts(readFileSync(SLACK, 'utf8'))
    expect(alertsWithoutCallers(alerts, productionFiles()), 'wire it or delete it; git remembers').toEqual([])
  })

  it('found alerts to check, so it cannot pass vacuously', () => {
    // Green on a renamed file or a changed export style would be worthless.
    expect(exportedAlerts(readFileSync(SLACK, 'utf8')).length).toBeGreaterThan(10)
  })

  it('flags an alert that nothing calls', () => {
    const alerts = ['sendUsedAlert', 'sendOrphanAlert']
    const files = [{ path: 'cron.ts', src: 'await sendUsedAlert(supabase, orgId)' }]
    expect(alertsWithoutCallers(alerts, files)).toEqual(['sendOrphanAlert'])
  })

  it('does not count a mention inside a comment as a caller', () => {
    const alerts = ['sendOrphanAlert']
    const files = [{ path: 'cron.ts', src: 'const x = 1' }]
    expect(alertsWithoutCallers(alerts, files)).toEqual(['sendOrphanAlert'])
  })

  it('reads the export list without being fooled by a similar name in prose', () => {
    const src = '// mentions export async function sendGhostAlert in a comment\nexport async function sendRealAlert() {}'
    expect(exportedAlerts(src)).toEqual(['sendRealAlert'])
  })
})
