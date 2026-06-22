/**
 * ESLint config contract (issue #265).
 *
 * The Worker runs sandboxed code nodes, PII redaction, secrets, and partner
 * bidding, and logs almost everything off the request path via ctx.waitUntil().
 * A dropped or misused promise here silently loses a side effect. The lint
 * config is therefore *tiered*: the async-correctness rules are errors (they
 * block CI), while the `no-unsafe-*` family on `any`-typed Supabase/JSON/partner
 * boundaries is warnings (tracked debt, paid down incrementally).
 *
 * This test is a tripwire: it fails if any async-correctness rule is silently
 * downgraded, or if the type-safety debt rules are flipped to error (which would
 * block CI on the existing ~300 warnings) or off (which would hide the debt).
 */
import { describe, it, expect, beforeAll } from 'vitest'

interface EslintConfig {
  extends: string[]
  rules: Record<string, unknown>
  overrides: Array<{ files: string[]; rules: Record<string, unknown> }>
}

let config: EslintConfig
beforeAll(async () => {
  // .eslintrc.cjs is a CommonJS config file with no type declarations.
  // @ts-expect-error -- untyped .cjs module, resolved at runtime
  const mod = await import('../../.eslintrc.cjs')
  config = (mod.default ?? mod) as EslintConfig
})

// Rules that catch real bugs in this waitUntil-heavy backend. Non-negotiable.
const ASYNC_CORRECTNESS_ERRORS = [
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/require-await',
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-implied-eval',
  '@typescript-eslint/only-throw-error',
]

// Type-safety debt: surfaced but non-blocking. Must stay 'warn', not error/off.
const TYPE_SAFETY_WARNINGS = [
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-return',
]

describe('worker eslint config', () => {
  it('extends the type-checked typescript-eslint preset', () => {
    expect(config.extends).toContain('plugin:@typescript-eslint/recommended-type-checked')
  })

  it.each(ASYNC_CORRECTNESS_ERRORS)('keeps %s as an error', (rule) => {
    expect(config.rules[rule]).toBe('error')
  })

  it.each(TYPE_SAFETY_WARNINGS)('keeps %s as a non-blocking warning', (rule) => {
    expect(config.rules[rule]).toBe('warn')
  })

  it('relaxes only non-bug rules in test files, never the floating/misused-promise guards', () => {
    const testOverride = config.overrides.find((o) =>
      o.files.some((f) => f.includes('test'))
    )
    expect(testOverride).toBeDefined()
    // The two rules that catch genuine async bugs must NOT be relaxed in tests.
    expect(testOverride!.rules['@typescript-eslint/no-floating-promises']).toBeUndefined()
    expect(testOverride!.rules['@typescript-eslint/no-misused-promises']).toBeUndefined()
  })
})
