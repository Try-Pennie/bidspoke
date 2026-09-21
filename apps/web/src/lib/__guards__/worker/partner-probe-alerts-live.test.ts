import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

/**
 * The partner reachability probe posts nothing unless `PARTNER_PROBE_ALERTS` is
 * exactly `on` (#1274, #1396). Every other value, including a plausible one like
 * `true`, `yes` or `On`, is observe mode.
 *
 * That default is the right way round, because a probe that pages before its
 * setup is proven is worse than one that is quiet. But once it is live the same
 * comparison becomes a silent failure: the probe still runs every five minutes,
 * still reads every host, still writes its state, and still logs a summary. The
 * ONLY difference between alerting and mute is one word inside a log line
 * (`mode=alert` against `mode=observe`), which nothing reads and nobody watches.
 * A partner firewall block would then be seen, recorded, and told to no one.
 *
 * So the shipped value is asserted against the predicate the code actually
 * applies, read out of the source rather than restated here (L107, L70): if that
 * comparison is ever changed, this fails rather than quietly agreeing with a
 * value that no longer means anything.
 */
const WRANGLER = readFileSync(path.join(REPO_ROOT, 'apps/worker/wrangler.toml'), 'utf8')
const PROBE = readFileSync(path.join(REPO_ROOT, 'apps/worker/src/lib/partner-reachability.ts'), 'utf8')

/** The literal the probe compares `PARTNER_PROBE_ALERTS` against to enter alert mode. */
function alertingValue(): string {
  const m = /PARTNER_PROBE_ALERTS === '([^']+)'/.exec(PROBE)
  expect(m, 'the probe no longer compares PARTNER_PROBE_ALERTS to a literal, so this guard reads nothing').not.toBeNull()
  return m![1]
}

/** What wrangler.toml actually ships as the deployed value. */
function shippedValue(): string {
  const m = /^PARTNER_PROBE_ALERTS\s*=\s*"([^"]*)"/m.exec(WRANGLER)
  expect(m, 'PARTNER_PROBE_ALERTS is not set in wrangler.toml, so the probe is mute on every deploy').not.toBeNull()
  return m![1]
}

describe('the partner reachability probe ships able to alert (#1396)', () => {
  it('reads an alerting literal out of the probe rather than assuming one', () => {
    // The positive control: without this, a guard whose regex stopped matching
    // would compare undefined against undefined and pass on nothing (L178).
    expect(alertingValue()).toBe('on')
  })

  it('ships the value that puts the probe in alert mode', () => {
    expect(shippedValue()).toBe(alertingValue())
  })
})
