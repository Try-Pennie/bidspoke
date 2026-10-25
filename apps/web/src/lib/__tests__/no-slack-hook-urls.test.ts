import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './_scan-utils'

/**
 * No Slack hook URL is committed anywhere in the tree (#2777).
 *
 * A Slack incoming webhook or workflow trigger URL is its own credential: anyone
 * holding it can post into the channel or start the workflow. Five trigger URLs
 * sat in the tree from April until the repository went public on 2026-10-25, and
 * CI's gitleaks scan never reported them, because the version it pinned had no
 * rule for the `hooks.slack.com/triggers/` shape. A workflow reads such a URL
 * from a secret environment variable (`{{env.SLACK_TRIGGER_FORMS_GEOFF}}`), never
 * as a literal.
 *
 * This reads every tracked file, whatever gitleaks's ruleset covers today.
 */

// A real hook: hooks.slack.com/<kind>/<team>/<id>/<token>. The token is what
// makes it a credential, so a URL cut short before it is not one.
const HOOK = 'hooks\\.slack\\.com/(services|triggers|workflows)/[A-Z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]{16,}'

const filesWithHooks = (): string[] => {
  try {
    return execFileSync('git', ['grep', '-l', '-I', '-E', HOOK], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

describe('Slack hook URLs', () => {
  it('the pattern recognises each kind of hook and not a URL without its token', () => {
    const re = new RegExp(HOOK)
    // Assembled from parts, so this file holds no hook URL of its own.
    const host = ['hooks', 'slack', 'com'].join('.')
    for (const kind of ['services', 'triggers', 'workflows']) {
      expect(re.test(`https://${host}/${kind}/T0000FAKE/9000000000000/${'a1'.repeat(16)}`), kind).toBe(true)
    }
    expect(re.test(`https://${host}/triggers/T0000FAKE/9000000000000/`)).toBe(false)
  })

  it('is in no tracked file', () => {
    expect(filesWithHooks()).toEqual([])
  })

  it('git grep reads the tree here, so the empty answer is a measurement', () => {
    // An unusable git also answers "no files"; a pattern every repo holds must come back.
    const found = execFileSync('git', ['grep', '-l', '-I', '-E', '"name"', '--', 'package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    expect(found).toContain('package.json')
  })
})
