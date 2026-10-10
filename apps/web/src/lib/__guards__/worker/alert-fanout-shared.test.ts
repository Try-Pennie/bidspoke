import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * The standard "look up every org with a Slack connection" query lives in one
 * place, `apps/worker/src/lib/alert-fanout.ts` (#357).
 *
 * About a dozen scheduled alerts each re-implemented the same lookup: select
 * `organization_id` from `service_connections` where `service_type = 'slack'`,
 * log a read failure as 'slack connections', and continue with an empty list.
 * `slackOrgIds` (and the `forEachSlackOrg` / `rateLimitedOrgAlert` built on it)
 * is now the single home for it, so a cooldown or multi-org change is made once.
 *
 * This fails on the next hand-rolled copy: a file, other than alert-fanout.ts,
 * that chains `.select('organization_id').eq('service_type', 'slack')` AND logs
 * the failure with the conventional `logReadFailure(..., 'slack connections', ..)`.
 *
 * It deliberately does NOT flag the sites that keep a direct lookup on purpose
 * because their error contract differs: email-drop-rate and bid-recording-coverage
 * abort on a read error with a structured `console.error` event rather than
 * continuing empty; standing-alert throws; volume-cliff needs the `config` column
 * and routes a read error to its database-unreachable path. None of those use the
 * log-and-continue convention this guard keys on, so none are swept in.
 */

// The chained plain lookup: select ONLY organization_id, then filter to slack.
const CHAINED_LOOKUP = /\.select\(\s*'organization_id'\s*\)\s*\.eq\(\s*'service_type',\s*'slack'\s*\)/
// The log-and-continue convention slackOrgIds provides.
const SLACK_CONN_LOG = /logReadFailure\([^)]*'slack connections'/

const HELPER = path.join('lib', 'alert-fanout.ts')

const files = listTsFiles(WORKER_SRC)
  // Test files legitimately carry the pattern in Supabase mocks and fixtures.
  .filter((full) => !full.replace(/\\/g, '/').includes('/__tests__/'))
  .map((full) => ({
    rel: path.relative(WORKER_SRC, full).replace(/\\/g, '/'),
    // Keep string literals (we match on them); strip only comments.
    code: sanitizeSource(readFileSync(full, 'utf8'), { blankStrings: false }),
  }))

const matches = files.filter((f) => CHAINED_LOOKUP.test(f.code) && SLACK_CONN_LOG.test(f.code)).map((f) => f.rel)

describe('Slack-org lookup is shared through alert-fanout (#357)', () => {
  it('no file outside alert-fanout re-rolls the log-and-continue slack-org lookup', () => {
    expect(matches.filter((rel) => rel !== HELPER)).toEqual([])
  })

  it('matches the helper itself, so it cannot pass by matching nothing', () => {
    expect(matches).toContain(HELPER)
  })
})
