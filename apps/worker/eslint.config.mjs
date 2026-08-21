// ESLint for the execution Worker. Tiered strictness (see issue #265):
//   - Async-correctness rules are ERRORS. This backend is waitUntil-heavy and
//     runs sandboxed code nodes, PII redaction, secrets, and partner bidding;
//     a floating or misused promise here drops a log write or a side effect.
//   - The type-safety `no-unsafe-*` family is WARN: real debt on `any`-typed
//     Supabase rows, JSON payloads, and partner responses, surfaced on every
//     lint run but not blocking CI so it can be paid down incrementally.
import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import { sharedRules } from '../../eslint.rules.shared.mjs'

export default [
  {
    ignores: ['dist', 'node_modules', '**/*.cjs', 'src/types/database.ts'],
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended-type-checked'],
  {
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // The shared definition, spread rather than restated, so a rule added for
    // every package reaches this one too (#907). Package-specific tightening
    // stays below, in its own block.
    rules: { ...sharedRules },
  },
  {
    // Ratchet for the execution path (the money/PII hot path): the no-unsafe-*
    // family is a warning elsewhere (tracked debt, #295) but an ERROR here, so
    // a new untyped `any` boundary in the engine fails CI instead of adding an
    // ignorable warning. Engine test files fall through to the relaxed override
    // below. Cleared in #295 Phase A. Keep src/engine/ at zero unsafe-* warnings.
    files: ['src/engine/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
    },
  },
  {
    // format-error.ts is the sanctioned single renderer: its base case genuinely
    // is `String(e)` (a primitive that has already fallen through the Error and
    // object branches), so the caught-error guard must not fire on itself (#606).
    files: ['src/lib/format-error.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    // Test fixtures legitimately use `any` and no-await async stubs; the
    // async-correctness errors (floating/misused promises) still apply.
    files: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      // Test code stringifies caught errors freely (assertions, fixtures); the
      // guard is about production alert paths, not tests (#606).
      'no-restricted-syntax': 'off',
    },
  },
]
