import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'
import { describeRepeat, intervalSecondsFor } from '../../../../../worker/src/lib/alert-backoff'

/**
 * Deploy Drift posts a standing condition once, then reminds on the worker's
 * backoff schedule (#1761).
 *
 * Drift kept no state between runs, so a strand that stood overnight on
 * 2026-10-05 posted three Slack messages every hour, each reading as a fresh
 * discovery. It now keeps a small record in its own run history (an artifact
 * uploaded by every run and read by the next), and backs off on the same 6h, 12h,
 * then daily schedule as apps/worker/src/lib/alert-backoff.ts, read from the same
 * JSON file and worded by the same sentence (held equal below against the TS).
 *
 * The record cannot live in the worker: drift exists partly to report a dead or
 * unreachable worker, so it must not need that worker to decide whether to speak
 * (L71). A record that cannot be read fails toward speaking (L42), and says so,
 * so a possible repeat is explained rather than mysterious (L11).
 */
const SCRIPT = path.join(REPO_ROOT, '.github/scripts/drift-alert-state.sh')
const SCHEDULE = path.join(REPO_ROOT, 'apps/worker/src/lib/alert-backoff-schedule.json')

const H = 3600
const NOW = 1_791_000_000 // a fixed instant, so every test sets the clock itself (L524)
const iso = (epoch: number) => new Date(epoch * 1000).toISOString().replace('.000Z', 'Z')

interface Entry {
  key: string
  since: string
  alerts: number
  last_alert: string
  class: string
}

/** A fresh state directory, holding a prior record when one is given. */
const stateDir = (prior?: { status: 'state' | 'none' | 'unavailable'; targets?: Record<string, Entry> }): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drift-state-'))
  writeFileSync(path.join(dir, 'schedule.json'), readFileSync(SCHEDULE))
  if (prior) {
    writeFileSync(path.join(dir, 'prior-status'), `${prior.status}\n`)
    if (prior.status === 'state') {
      writeFileSync(path.join(dir, 'prior.json'), JSON.stringify({ version: 1, targets: prior.targets ?? {} }))
    }
  }
  return dir
}

/** A curl stand in that records the posted body, and exits with `code`. */
const fakeCurl = (dir: string, code = 0): string => {
  const bin = path.join(dir, 'curl')
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = "--data" ]; then printf '%s' "$2" > ${JSON.stringify(path.join(dir, 'posted.json'))}; fi; shift; done\nexit ${code}\n`,
  )
  chmodSync(bin, 0o755)
  return bin
}

const posted = (dir: string): string | null => {
  const file = path.join(dir, 'posted.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { text: string }).text : null
}

const alert = (
  dir: string,
  args: { target: string; kind: string; facts?: string; text?: string },
  opts: { now?: number; curlExit?: number; webhook?: string } = {},
): string => {
  const r = spawnSync('bash', [SCRIPT, 'alert', args.target, args.kind, args.facts ?? '', args.text ?? 'TEXT'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DRIFT_STATE_DIR: dir,
      DRIFT_NOW: String(opts.now ?? NOW),
      CURL_BIN: fakeCurl(dir, opts.curlExit ?? 0),
      SLACK_WEBHOOK_URL: opts.webhook ?? 'https://hooks.example/x',
    },
  })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.trim()
}

const clear = (dir: string, target: string) => {
  execFileSync('bash', [SCRIPT, 'clear', target], { env: { ...process.env, DRIFT_STATE_DIR: dir } })
}

const finish = (
  dir: string,
  outcomes: { WORKER?: string; WORKER_PROBE?: string; PAGES?: string; TAIL?: string } = {},
): { outcome: string; next: { version: number; targets: Record<string, Entry> } } => {
  const outcome = execFileSync('bash', [SCRIPT, 'finish'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DRIFT_STATE_DIR: dir,
      WORKER: outcomes.WORKER ?? 'skipped',
      WORKER_PROBE: outcomes.WORKER_PROBE ?? 'skipped',
      PAGES: outcomes.PAGES ?? 'success',
      TAIL: outcomes.TAIL ?? 'success',
    },
  }).trim()
  return { outcome, next: JSON.parse(readFileSync(path.join(dir, 'next.json'), 'utf8')) }
}

const KEY = 'worker|alert|aaaa|bbbb'
const standing = (alerts: number, lastAgo: number, sinceAgo = lastAgo): Entry => ({
  key: KEY,
  since: iso(NOW - sinceAgo),
  alerts,
  last_alert: iso(NOW - lastAgo),
  class: 'finding',
})
const strand = { target: 'worker', kind: 'alert', facts: 'aaaa|bbbb' }

describe('drift-alert-state alert: the first sighting posts', () => {
  it('posts a condition with no record and records it at one alert', () => {
    const dir = stateDir({ status: 'none' })
    expect(alert(dir, strand)).toBe('post-first')
    expect(posted(dir)).toBe('TEXT')
    expect(finish(dir, { WORKER: 'failure' }).next.targets.worker).toEqual({
      key: KEY,
      since: iso(NOW),
      alerts: 1,
      last_alert: iso(NOW),
      class: 'finding',
    })
  })

  it('posts again at once when a fact the message states changes, because that is news', () => {
    for (const facts of ['cccc|bbbb', 'aaaa|cccc']) {
      const dir = stateDir({ status: 'state', targets: { worker: standing(1, 600) } })
      expect(alert(dir, { ...strand, facts })).toBe('post-first')
    }
  })

  it('posts again at once when the kind of condition changes', () => {
    const dir = stateDir({ status: 'state', targets: { worker: standing(1, 600) } })
    expect(alert(dir, { ...strand, kind: 'alert-unconfirmed' })).toBe('post-first')
  })

  it('treats a malformed entry as no record', () => {
    const dir = stateDir({
      status: 'state',
      targets: { worker: { key: KEY, since: 'x', alerts: 'two', last_alert: 'x', class: 'finding' } as unknown as Entry },
    })
    expect(alert(dir, strand)).toBe('post-first')
  })
})

describe('drift-alert-state alert: a standing condition backs off on the shared schedule', () => {
  it.each([
    [1, 6],
    [2, 12],
    [3, 24],
    [7, 24],
  ])('after %i alert(s) it holds until %ih after the last one, then reminds', (alerts, hours) => {
    const held = stateDir({ status: 'state', targets: { worker: standing(alerts, hours * H - 1, 100 * H) } })
    expect(alert(held, strand)).toBe('held')
    expect(posted(held)).toBeNull()

    const due = stateDir({ status: 'state', targets: { worker: standing(alerts, hours * H, 100 * H) } })
    expect(alert(due, strand)).toBe('post-reminder')
  })

  it('carries a held record forward unchanged', () => {
    const entry = standing(2, H)
    const dir = stateDir({ status: 'state', targets: { worker: entry } })
    alert(dir, strand)
    expect(finish(dir, { WORKER: 'failure' }).next.targets.worker).toEqual(entry)
  })

  it('says a reminder is a reminder, in the worker wording, and keeps the first sighting time', () => {
    const entry = standing(1, 6 * H, 6 * H)
    const dir = stateDir({ status: 'state', targets: { worker: entry } })
    expect(alert(dir, strand)).toBe('post-reminder')
    const sentence = describeRepeat({ since: entry.since, alerts: 1 }, NOW * 1000)
    expect(posted(dir)).toBe(`TEXT\n\n${sentence}`)
    expect(finish(dir, { WORKER: 'failure' }).next.targets.worker).toMatchObject({
      since: entry.since,
      alerts: 2,
      last_alert: iso(NOW),
    })
  })

  it('reminds rather than holds when the last alert time cannot be read', () => {
    const dir = stateDir({ status: 'state', targets: { worker: { ...standing(1, H), last_alert: 'garbage' } } })
    expect(alert(dir, strand)).toBe('post-reminder')
  })
})

describe('drift-alert-state alert: it fails toward speaking', () => {
  it('posts when the earlier record could not be read, and says this may repeat an alert', () => {
    const dir = stateDir({ status: 'unavailable' })
    expect(alert(dir, strand)).toBe('post-first')
    expect(posted(dir)).toMatch(/^TEXT\n\n.*could not be read.*repeat/)
    expect(finish(dir, { WORKER: 'failure' }).next.targets.worker.alerts).toBe(1)
  })

  it('posts when no read was recorded at all', () => {
    const dir = stateDir()
    expect(alert(dir, strand)).toBe('post-first')
  })

  it('posts when the schedule cannot be read, even inside what would be the cooldown', () => {
    const dir = stateDir({ status: 'state', targets: { worker: standing(1, 60) } })
    writeFileSync(path.join(dir, 'schedule.json'), '{"stepsSeconds": []}')
    expect(alert(dir, strand)).toBe('post-first')
    expect(posted(dir)).toMatch(/could not be read/)
  })

  it('records nothing new when Slack refused the post, so the next run posts again', () => {
    const entry = standing(1, 6 * H)
    const dir = stateDir({ status: 'state', targets: { worker: entry } })
    expect(alert(dir, strand, { curlExit: 22 })).toBe('post-failed')
    const done = finish(dir, { WORKER: 'failure' })
    expect(done.next.targets.worker).toEqual(entry)
    expect(done.outcome).toBe('unreported')
  })

  it('records nothing and reports nothing delivered when no webhook is configured', () => {
    const dir = stateDir({ status: 'none' })
    expect(alert(dir, strand, { webhook: '' })).toBe('no-webhook')
    const done = finish(dir, { WORKER: 'failure' })
    expect(done.next.targets.worker).toBeUndefined()
    expect(done.outcome).toBe('unreported')
  })
})

describe('drift-alert-state clear and finish', () => {
  it('forgets a cleared condition, so its next occurrence starts the schedule again', () => {
    const dir = stateDir({ status: 'state', targets: { worker: standing(3, H) } })
    clear(dir, 'worker')
    const done = finish(dir)
    expect(done.next.targets.worker).toBeUndefined()

    const again = stateDir({ status: 'state', targets: done.next.targets })
    expect(alert(again, strand)).toBe('post-first')
  })

  it('carries forward a target this run did not judge (in flight, propagating, or never reached)', () => {
    const entry = { ...standing(2, H), key: 'site|alert-behind|eeee' }
    const dir = stateDir({ status: 'state', targets: { site: entry } })
    expect(finish(dir).next.targets.site).toEqual(entry)
  })

  it('writes an empty record when nothing stands and nothing was readable before', () => {
    expect(finish(stateDir({ status: 'unavailable' })).next).toEqual({ version: 1, targets: {} })
  })

  it('is clean when no alert step failed', () => {
    expect(finish(stateDir({ status: 'none' })).outcome).toBe('clean')
  })

  it('is reported when every failed alert step posted or held a finding about its target', () => {
    const dir = stateDir({
      status: 'state',
      targets: { site: { ...standing(1, H), key: 'site|alert-behind|eeee' } },
    })
    alert(dir, strand)
    alert(dir, { target: 'site', kind: 'alert-behind', facts: 'eeee' })
    expect(finish(dir, { WORKER: 'failure', PAGES: 'failure' }).outcome).toBe('reported')
  })

  it('counts the worker probe step as the worker target', () => {
    const dir = stateDir({ status: 'none' })
    alert(dir, { target: 'worker', kind: 'alert-unreachable' })
    expect(finish(dir, { WORKER_PROBE: 'failure' }).outcome).toBe('reported')
  })

  it('is unreported when a failed alert step recorded nothing, as a step that crashed before alerting would', () => {
    expect(finish(stateDir({ status: 'none' }), { TAIL: 'failure' }).outcome).toBe('unreported')
  })

  it('is unreported when what was reported is that the check itself could not run, so the schedule watch still speaks', () => {
    for (const [target, kind] of [
      ['worker', 'crashed'],
      ['worker', 'alert-unconfirmed'],
      ['worker', 'alert-inflight-unknown'],
      ['worker', 'alert-unconfigured'],
      ['site', 'unconfigured'],
      ['site', 'alert-no-samples'],
      ['site', 'alert-malformed'],
      ['site', 'alert-propagation-unknown'],
      ['tail', 'alert-inflight-unknown'],
      ['tail', 'alert-unconfigured'],
      ['tail', 'something-new'],
    ]) {
      const dir = stateDir({ status: 'none' })
      alert(dir, { target, kind })
      const outcomes = { worker: { WORKER: 'failure' }, site: { PAGES: 'failure' }, tail: { TAIL: 'failure' } }[target]
      expect(finish(dir, outcomes).outcome, `${target} ${kind}`).toBe('unreported')
    }
  })

  it('treats each finding the targets can report as a finding', () => {
    for (const [target, kind] of [
      ['worker', 'alert'],
      ['worker', 'alert-unreachable'],
      ['worker', 'alert-unstamped'],
      ['site', 'alert-behind'],
      ['site', 'alert-stuck-deploy'],
      ['site', 'alert-unstamped'],
      ['site', 'alert-unknown-commit'],
      ['site', 'alert-unreachable'],
      ['tail', 'alert'],
      ['tail', 'alert-unstamped'],
      ['tail', 'alert-unreachable'],
      ['tail', 'alert-unknown-commit'],
    ]) {
      const dir = stateDir({ status: 'none' })
      alert(dir, { target, kind })
      const outcomes = { worker: { WORKER: 'failure' }, site: { PAGES: 'failure' }, tail: { TAIL: 'failure' } }[target]
      expect(finish(dir, outcomes).outcome, `${target} ${kind}`).toBe('reported')
    }
  })
})

/** A stub gh for `read`: lists `artifacts`, and serves `zip` for any download. */
const read = (
  artifacts: unknown,
  opts: { listExit?: number; zipExit?: number; content?: string; runId?: string } = {},
): { word: string; dir: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drift-read-'))
  const work = path.join(dir, 'work')
  mkdirSync(work)
  writeFileSync(path.join(work, 'next.json'), opts.content ?? JSON.stringify({ version: 1, targets: {} }))
  const zip = path.join(dir, 'artifact.zip')
  execFileSync('zip', ['-q', '-j', zip, path.join(work, 'next.json')])
  const gh = path.join(dir, 'gh')
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      'case "$2" in',
      `  */zip) cat ${JSON.stringify(zip)}; exit ${opts.zipExit ?? 0} ;;`,
      `  *) printf '%s' ${JSON.stringify(typeof artifacts === 'string' ? artifacts : JSON.stringify({ artifacts }))}; exit ${opts.listExit ?? 0} ;;`,
      'esac',
      '',
    ].join('\n'),
  )
  chmodSync(gh, 0o755)
  const state = path.join(dir, 'state')
  const word = execFileSync('bash', [SCRIPT, 'read'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_BIN: gh,
      DRIFT_STATE_DIR: state,
      DRIFT_SCHEDULE_SRC: SCHEDULE,
      GITHUB_REPOSITORY: 'Try-Pennie/bidspoke',
      GITHUB_RUN_ID: opts.runId ?? '999',
    },
  }).trim()
  return { word, dir: state }
}

const artifact = (id: number, created: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'deploy-drift-alert-state',
  expired: false,
  created_at: created,
  workflow_run: { id: id * 10, head_branch: 'main' },
  ...extra,
})

describe('drift-alert-state read: three answers, never two', () => {
  it('answers state when the newest earlier record downloads and parses', () => {
    const r = read([artifact(1, '2026-10-05T01:00:00Z'), artifact(2, '2026-10-05T02:00:00Z')])
    expect(r.word).toBe('state')
    expect(JSON.parse(readFileSync(path.join(r.dir, 'prior.json'), 'utf8'))).toEqual({ version: 1, targets: {} })
    expect(readFileSync(path.join(r.dir, 'prior-status'), 'utf8').trim()).toBe('state')
    expect(readFileSync(path.join(r.dir, 'schedule.json'), 'utf8')).toBe(readFileSync(SCHEDULE, 'utf8'))
  })

  it('answers none when GitHub confirms there is no earlier record', () => {
    expect(read([]).word).toBe('none')
  })

  it('ignores this run’s own upload, expired records and records from another branch', () => {
    expect(
      read(
        [
          artifact(99, '2026-10-05T03:00:00Z', { workflow_run: { id: 999, head_branch: 'main' } }),
          artifact(3, '2026-10-05T02:00:00Z', { expired: true }),
          artifact(4, '2026-10-05T01:00:00Z', { workflow_run: { id: 40, head_branch: 'some-branch' } }),
        ],
        { runId: '999' },
      ).word,
    ).toBe('none')
  })

  it('answers unavailable when the list cannot be fetched', () => {
    expect(read([], { listExit: 1 }).word).toBe('unavailable')
  })

  it('answers unavailable when the list is not the shape GitHub sends', () => {
    expect(read('<html>').word).toBe('unavailable')
    expect(read('{"message":"x"}').word).toBe('unavailable')
  })

  it('answers unavailable when the record cannot be downloaded', () => {
    expect(read([artifact(1, '2026-10-05T01:00:00Z')], { zipExit: 1 }).word).toBe('unavailable')
  })

  it('answers unavailable when the record is not one this script wrote', () => {
    expect(read([artifact(1, '2026-10-05T01:00:00Z')], { content: '{"version":2,"targets":{}}' }).word).toBe(
      'unavailable',
    )
    expect(read([artifact(1, '2026-10-05T01:00:00Z')], { content: 'not json' }).word).toBe('unavailable')
  })
})

describe('the reminder wording and schedule match the worker exactly (#1761, L26)', () => {
  const shell = (...args: string[]) =>
    execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, DRIFT_SCHEDULE: SCHEDULE },
    }).replace(/\n$/, '')

  it.each([-1, 0, 1, 2, 3, 4, 9])('intervalSecondsFor(%i)', (n) => {
    expect(shell('interval', String(n))).toBe(String(intervalSecondsFor(n)))
  })

  const ages = [0, 29 * 60 + 59, 30 * 60, 6 * H, 30 * H, 100 * H + 1800]
  it.each([1, 2, 3, 4, 5].flatMap((alerts) => ages.map((age) => [alerts, age])))(
    'describeRepeat after %i alert(s), %is old',
    (alerts, age) => {
      const since = iso(NOW - age)
      expect(shell('describe', since, String(alerts), String(NOW))).toBe(
        describeRepeat({ since, alerts }, NOW * 1000),
      )
    },
  )

  it('describeRepeat with a first sighting time that cannot be read', () => {
    expect(shell('describe', 'garbage', '2', String(NOW))).toBe(describeRepeat({ since: 'garbage', alerts: 2 }, NOW * 1000))
  })
})
