// ESLint for the tail-consumer Worker. Same tiered strictness as apps/worker
// (see issue #265): async-correctness rules are errors; the `no-unsafe-*`
// family on `any`-typed TraceItem/Supabase data is warned, not blocked.
import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  {
    ignores: ['dist', 'node_modules', '**/*.cjs'],
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
    rules: {
      // --- Async correctness: ERROR ---
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/only-throw-error': 'error',

      // --- Type-safety on `any` boundaries: WARN (tracked debt) ---
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
      'no-constant-condition': ['error', { checkLoops: false }],
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
]
