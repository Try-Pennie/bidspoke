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
import { Linter } from 'eslint'

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

  // #606: the caught-error stringification guard is held at error in BOTH Worker
  // packages so the invariant can't drift (matching the no-base-to-string parity).
  it('keeps the no-restricted-syntax caught-error guard at error', () => {
    const entry = baseRules(configs[name])['no-restricted-syntax']
    expect(Array.isArray(entry)).toBe(true)
    expect((entry as unknown[])[0]).toBe('error')
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

// #606: no-base-to-string is structurally blind to a value still typed `unknown`
// (the most common case: a caught error). A name-based no-restricted-syntax guard
// closes that gap. This is a real mutation check (the issue's requirement): it
// runs ESLint against the SHIPPED selector, so it goes red if the guard is
// removed or a String(err) shape is reintroduced, and stays green for the
// the formatErr() fix.
//
// #687: the guard originally exempted `err instanceof Error ? err.message :
// String(err)`, on the theory that the instanceof arm made it safe. It doesn't:
// the false branch is exactly where a non-Error (a plain Supabase/PostgREST
// object) lands, so that arm renders the "[object Object]" the guard exists to
// prevent. #628 removed the last of those from source, so the exemption now
// only lets the pattern grow back. The false branch is what's banned, not
// `instanceof Error` itself, which stays legitimate for a `.name` read or a
// static user-facing fallback.
describe.each(PACKAGES)('$name caught-error stringification guard (#606, #687)', ({ name }) => {
  function lint(code: string): Linter.LintMessage[] {
    const rule = baseRules(configs[name])['no-restricted-syntax']
    const linter = new Linter()
    return linter.verify(code, { rules: { 'no-restricted-syntax': rule as Linter.RuleEntry } })
  }
  const guardHits = (code: string) =>
    lint(code).filter((m) => m.ruleId === 'no-restricted-syntax').length

  it('fires on a bare String(err) in a catch block', () => {
    expect(guardHits('try { go() } catch (err) { console.error(String(err)) }')).toBeGreaterThan(0)
  })

  it('fires on String(error) and String(e) too', () => {
    expect(guardHits('const a = String(error)')).toBeGreaterThan(0)
    expect(guardHits('const a = String(e)')).toBeGreaterThan(0)
  })

  it('fires on template interpolation of a caught error', () => {
    expect(guardHits('try { go() } catch (err) { console.error(`boom ${err}`) }')).toBeGreaterThan(0)
  })

  it('fires on String(err) wrapped in new Error()', () => {
    expect(guardHits('const x = e instanceof Error ? e : new Error(String(e))')).toBeGreaterThan(0)
  })

  it('fires on the String() false branch of an instanceof ternary (#687)', () => {
    expect(guardHits('const m = err instanceof Error ? err.message : String(err)')).toBeGreaterThan(
      0
    )
  })

  it('fires on the coerceString() false branch too: an Error serializes to "{}" (#687)', () => {
    expect(
      guardHits('const m = err instanceof Error ? err.message : coerceString(err)')
    ).toBeGreaterThan(0)
  })

  it('does NOT fire on an instanceof ternary with an empty-string fallback', () => {
    // engine/error-classifier.ts:58,297. Deliberate, so a non-Error cannot be
    // misclassified by matching markers against its stringified form.
    expect(guardHits("const message = err instanceof Error ? err.message : ''")).toBe(0)
  })

  it('does NOT fire on an instanceof ternary reading .name', () => {
    // lib/volume-cliff.ts:219
    expect(guardHits("const errName = e instanceof Error ? e.name : 'unknown'")).toBe(0)
  })

  it('does NOT fire on an instanceof ternary with a static user-facing fallback', () => {
    // routes/api/{sources.ts:131, env.ts:278}
    expect(guardHits("const m = err instanceof Error ? err.message : 'Schema fetch failed'")).toBe(0)
  })

  it('does NOT fire on the formatErr() fix', () => {
    expect(guardHits('const m = formatErr(err)')).toBe(0)
    expect(guardHits('const x = e instanceof Error ? e : new Error(formatErr(e))')).toBe(0)
  })

  it('does NOT fire on coerceString() of a non-error identifier', () => {
    expect(guardHits('const m = coerceString(v)')).toBe(0)
  })

  it('does NOT fire on String() of a non-error identifier', () => {
    expect(guardHits('const m = String(count)')).toBe(0)
  })
})
