// ESLint for the execution Worker. Tiered strictness (see issue #265):
//   - Async-correctness rules are ERRORS. This backend is waitUntil-heavy and
//     runs sandboxed code nodes, PII redaction, secrets, and partner bidding;
//     a floating or misused promise here drops a log write or a side effect.
//   - The type-safety `no-unsafe-*` family is WARN: real debt on `any`-typed
//     Supabase rows, JSON payloads, and partner responses, surfaced on every
//     lint run but not blocking CI so it can be paid down incrementally.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
  ],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  ignorePatterns: ['dist', 'node_modules', '*.cjs', 'src/types/database.ts'],
  rules: {
    // --- Async correctness: ERROR (the reason this config exists) ---
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/require-await': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-implied-eval': 'error',
    '@typescript-eslint/only-throw-error': 'error',

    // --- Type-safety on `any` boundaries: WARN (tracked debt, non-blocking) ---
    '@typescript-eslint/no-unsafe-assignment': 'warn',
    '@typescript-eslint/no-unsafe-member-access': 'warn',
    '@typescript-eslint/no-unsafe-argument': 'warn',
    '@typescript-eslint/no-unsafe-call': 'warn',
    '@typescript-eslint/no-unsafe-return': 'warn',
    '@typescript-eslint/no-unsafe-function-type': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
    '@typescript-eslint/unbound-method': 'warn',
    '@typescript-eslint/no-base-to-string': 'warn',
    '@typescript-eslint/restrict-template-expressions': 'warn',

    // tsc already enforces these via noUnusedLocals/noUnusedParameters
    '@typescript-eslint/no-unused-vars': 'off',
    // engine polling/retry loops use intentional `while (true) { ... break }`
    'no-constant-condition': ['error', { checkLoops: false }],
    // `let` is legitimate when a var is read in a closure defined before its
    // assignment (e.g. circular Proxy/handler refs); don't force const there.
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
  },
  overrides: [
    {
      // Ratchet for the execution path (the money/PII hot path): the no-unsafe-*
      // family is a warning elsewhere (tracked debt, #295) but an ERROR here, so
      // a new untyped `any` boundary in the engine fails CI instead of adding an
      // ignorable warning. Engine test files fall through to the relaxed override
      // below. Cleared in #295 Phase A. Keep src/engine/ at zero unsafe-* warnings.
      files: ['src/engine/**/*.ts'],
      excludedFiles: ['**/__tests__/**', '**/*.test.ts'],
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
      },
    },
  ],
};
