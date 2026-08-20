/**
 * A credential-shaped name must be BLOCKED, not merely classified (#870).
 *
 * `sandbox-env.ts` types its policy as `Record<EnvStringKey, 'block' | 'expose'>`,
 * so adding a string binding to `Env` without classifying it is a compile error.
 * That is a good guard and it caught the six archive identities being added in
 * this phase. It only forces a DECISION though, never the right one: `'expose'`
 * type-checks exactly as well as `'block'`, and the test that lists the withheld
 * secrets is a hand-written array of key names, so a newly added credential is
 * absent from it and nothing notices (LESSONS L96, L113).
 *
 * The stake is concrete. The eraser identity is the only credential in the
 * Snowflake account holding DELETE on 13 months of archived SSNs, dates of birth
 * and credit reports, and a code node runs author-written JavaScript. One
 * mistyped word in a policy table would hand that to user scripts, and the
 * failure is silent: everything compiles, every existing test passes, and the
 * only symptom is a capability nobody intended to grant.
 *
 * So this asserts the RULE rather than the instances: if a binding's name says it
 * is a credential, it is withheld. One-directional on purpose. A name that does
 * not look like a credential may still be blocked (`CLOUDFLARE_ACCOUNT_ID`,
 * `GITHUB_CODE_REPO` and the archive `_USER` names all are), because withholding
 * something nothing needs is cheap and this guard should never argue for exposing
 * anything.
 */
import { describe, expect, it } from 'vitest'
import { ENV_SANDBOX_POLICY, SANDBOX_BLOCKED_ENV_KEYS } from '../sandbox-env'

/**
 * Name fragments that mean "this is a credential". Matched against the binding
 * name only, never its value, because the value is absent at build time and the
 * name is what a reviewer sees in a diff.
 */
const CREDENTIAL_PATTERNS = [
  /PRIVATE_KEY/,
  /SECRET/,
  /TOKEN/,
  /PASSWORD/,
  /PEPPER/,
  /API_KEY/,
  /_KEY$/,
]

/**
 * The ONE binding whose name looks like a credential and is deliberately exposed.
 *
 * Supabase's publishable key is public by design: it ships in the browser bundle
 * of every page of the app, so withholding it from a code node would protect
 * nothing while pretending to. Kept as a named exception with its reason rather
 * than by loosening the patterns, because loosening them to accommodate one key
 * would stop catching the next real credential that happens to end in `_KEY`.
 */
const EXPOSED_BY_DESIGN: Record<string, string> = {
  SUPABASE_PUBLISHABLE_KEY:
    'public by design, shipped in the browser bundle, so withholding it protects nothing',
}

const looksLikeCredential = (key: string): boolean =>
  CREDENTIAL_PATTERNS.some((pattern) => pattern.test(key))

describe('credential-shaped bindings are withheld from code nodes (#870)', () => {
  it('finds credential-shaped names to check, so this cannot pass vacuously', () => {
    // A renamed policy export or an emptied table would otherwise satisfy every
    // assertion below by having nothing to assert about (L98).
    const matched = Object.keys(ENV_SANDBOX_POLICY).filter(looksLikeCredential)
    expect(matched.length).toBeGreaterThan(5)
  })

  it('blocks every one of them', () => {
    for (const key of Object.keys(ENV_SANDBOX_POLICY)) {
      if (!looksLikeCredential(key)) continue
      if (key in EXPOSED_BY_DESIGN) continue
      expect(
        SANDBOX_BLOCKED_ENV_KEYS.has(key),
        `${key} reads as a credential but is exposed to user-authored code nodes`,
      ).toBe(true)
    }
  })

  it('keeps the archive identities withheld by name, since the eraser can destroy the archive', () => {
    // Named explicitly as well as covered by the rule above: the `_USER` halves do
    // not match any credential pattern, and an identity is only as withheld as its
    // least protected half.
    for (const key of [
      'ARCHIVE_WRITER_USER',
      'ARCHIVE_WRITER_PRIVATE_KEY',
      'ARCHIVE_READER_USER',
      'ARCHIVE_READER_PRIVATE_KEY',
      'ARCHIVE_ERASER_USER',
      'ARCHIVE_ERASER_PRIVATE_KEY',
    ]) {
      expect(SANDBOX_BLOCKED_ENV_KEYS.has(key), `${key} must be withheld`).toBe(true)
    }
  })

  it('carries no stale exception for a binding that no longer exists', () => {
    // An exemption outliving the thing it exempted is an exemption nobody is
    // reviewing, and it reads as deliberate forever (L129).
    for (const key of Object.keys(EXPOSED_BY_DESIGN)) {
      expect(
        key in ENV_SANDBOX_POLICY,
        `${key} is exempted here but is no longer an env binding, so the exemption is dead`,
      ).toBe(true)
    }
  })
})
