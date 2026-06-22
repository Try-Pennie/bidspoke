/**
 * ESLint config contract (issues #265, #298).
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
 *
 * Both Worker packages (apps/worker and apps/worker-tail) carry near-duplicate
 * configs; the shared invariants are asserted against BOTH so they can't drift.
 */
import { describe, it, expect, beforeAll } from 'vitest'

interface EslintConfig {
  extends: string[]
  rules: Record<string, unknown>
  overrides?: Array<{ files: string[]; rules: Record<string, unknown> }>
}

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

// Both Worker packages must share the same tiered invariants. The configs are
// untyped .cjs files resolved at runtime (the worker tsconfig has no @types/node,
// so a plain require/import.meta won't typecheck — a literal dynamic import does).
const PACKAGES = [
  // @ts-expect-error -- untyped .cjs module, resolved at runtime
  { name: 'worker', load: () => import('../../.eslintrc.cjs') },
  // @ts-expect-error -- untyped .cjs module, resolved at runtime
  { name: 'worker-tail', load: () => import('../../../worker-tail/.eslintrc.cjs') },
] as const

const configs: Record<string, EslintConfig> = {}
beforeAll(async () => {
  for (const pkg of PACKAGES) {
    const mod = await pkg.load()
    configs[pkg.name] = (mod.default ?? mod) as EslintConfig
  }
})

describe.each(PACKAGES)('$name eslint config', ({ name }) => {
  it('extends the type-checked typescript-eslint preset', () => {
    expect(configs[name].extends).toContain('plugin:@typescript-eslint/recommended-type-checked')
  })

  it.each(ASYNC_CORRECTNESS_ERRORS)('keeps %s as an error', (rule) => {
    expect(configs[name].rules[rule]).toBe('error')
  })

  it.each(TYPE_SAFETY_WARNINGS)('keeps %s as a non-blocking warning', (rule) => {
    expect(configs[name].rules[rule]).toBe('warn')
  })
})

// Only apps/worker has test files (and therefore a test-file override); worker-tail
// has none, so this invariant applies to the worker config alone.
describe('worker test-file override', () => {
  it('relaxes only non-bug rules in test files, never the floating/misused-promise guards', () => {
    const testOverride = configs.worker.overrides?.find((o) =>
      o.files.some((f) => f.includes('test'))
    )
    expect(testOverride).toBeDefined()
    // The two rules that catch genuine async bugs must NOT be relaxed in tests.
    expect(testOverride!.rules['@typescript-eslint/no-floating-promises']).toBeUndefined()
    expect(testOverride!.rules['@typescript-eslint/no-misused-promises']).toBeUndefined()
  })
})

// #295 Phase A ratchet: the execution path is held at error-level for the
// no-unsafe-* family so a new untyped boundary in the money/PII engine fails CI.
describe('worker engine ratchet', () => {
  const ENGINE_ERROR_RULES = [
    '@typescript-eslint/no-unsafe-assignment',
    '@typescript-eslint/no-unsafe-member-access',
    '@typescript-eslint/no-unsafe-argument',
    '@typescript-eslint/no-unsafe-call',
    '@typescript-eslint/no-unsafe-return',
    '@typescript-eslint/no-unsafe-function-type',
  ]

  it('escalates the no-unsafe-* family to error for src/engine/ non-test code', () => {
    const engineOverride = configs.worker.overrides?.find((o) =>
      o.files.some((f) => f.includes('engine'))
    )
    expect(engineOverride).toBeDefined()
    for (const rule of ENGINE_ERROR_RULES) {
      expect(engineOverride!.rules[rule]).toBe('error')
    }
  })
})
