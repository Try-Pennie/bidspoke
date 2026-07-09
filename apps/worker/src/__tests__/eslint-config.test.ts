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

// A flat config file exports an array of config objects, each optionally
// scoped by `files`/`ignores`, whose `rules` merge in array order for any
// given file. This is a lightweight stand-in for that resolution, sufficient
// for this test's purpose: find the specific config object(s) that apply to
// a rule, not a full ESLint-equivalent config resolver.
interface FlatConfigEntry {
  files?: string[]
  ignores?: string[]
  rules?: Record<string, unknown>
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

// Information-loss rules: ERROR. These do not catch a type-safety smell, they
// catch a bug that silently destroys the evidence you need during an incident.
// `no-base-to-string` fires on stringifying an object with a default toString,
// which is exactly how a plain Supabase/PostgREST error became the "[object
// Object]" that blanked every dead-letter alert (#598, #601).
//
// Caveat, deliberately not papered over: with default options the rule does not
// fire on a value still typed `unknown` (it fires once narrowing widens it to
// `{}`). So `String(err)` on an untouched `unknown` still slips through, e.g.
// lib/code-node-deployer.ts's isWorkerNotFoundError. This rule is a ratchet, not
// a proof.
const INFORMATION_LOSS_ERRORS = ['@typescript-eslint/no-base-to-string']

// Type-safety debt: surfaced but non-blocking. Must stay 'warn', not error/off.
const TYPE_SAFETY_WARNINGS = [
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-return',
]

// Both Worker packages must share the same tiered invariants. The configs are
// untyped .mjs files resolved at runtime (the worker tsconfig has no
// declaration for them, so a plain dynamic import won't typecheck).
const PACKAGES = [
  // @ts-expect-error -- untyped .mjs module, resolved at runtime
  { name: 'worker', load: () => import('../../eslint.config.mjs') },
  // @ts-expect-error -- untyped .mjs module, resolved at runtime
  { name: 'worker-tail', load: () => import('../../../worker-tail/eslint.config.mjs') },
] as const

const configs: Record<string, FlatConfigEntry[]> = {}
beforeAll(async () => {
  for (const pkg of PACKAGES) {
    const mod = await pkg.load()
    configs[pkg.name] = mod.default as FlatConfigEntry[]
  }
})

// Flat config resolves by merging every unscoped (no `files`) entry's rules in
// array order, later entries winning, same as ESLint itself does for a file
// that isn't matched by any `files`-scoped override. Presets (eslint:recommended,
// the typescript-eslint recommended-type-checked array) are unscoped too, so
// this merge is required, not just a lookup of "the one rules block."
function baseRules(entries: FlatConfigEntry[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const e of entries) {
    if (!e.files && e.rules) Object.assign(merged, e.rules)
  }
  return merged
}

describe.each(PACKAGES)('$name eslint config', ({ name }) => {
  it.each(ASYNC_CORRECTNESS_ERRORS)('keeps %s as an error', (rule) => {
    expect(baseRules(configs[name])[rule]).toBe('error')
  })

  it.each(TYPE_SAFETY_WARNINGS)('keeps %s as a non-blocking warning', (rule) => {
    expect(baseRules(configs[name])[rule]).toBe('warn')
  })

  it.each(INFORMATION_LOSS_ERRORS)('keeps %s as an error', (rule) => {
    expect(baseRules(configs[name])[rule]).toBe('error')
  })
})

// Only apps/worker has test files (and therefore a test-file override); worker-tail
// has none, so this invariant applies to the worker config alone.
describe('worker test-file override', () => {
  it('relaxes only non-bug rules in test files, never the floating/misused-promise guards', () => {
    const testOverride = configs.worker.find((e) => e.files?.some((f) => f.includes('test')))
    expect(testOverride).toBeDefined()
    // The two rules that catch genuine async bugs must NOT be relaxed in tests.
    expect(testOverride!.rules?.['@typescript-eslint/no-floating-promises']).toBeUndefined()
    expect(testOverride!.rules?.['@typescript-eslint/no-misused-promises']).toBeUndefined()
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
    const engineOverride = configs.worker.find((e) => e.files?.some((f) => f.includes('engine')))
    expect(engineOverride).toBeDefined()
    for (const rule of ENGINE_ERROR_RULES) {
      expect(engineOverride!.rules?.[rule]).toBe('error')
    }
  })
})
