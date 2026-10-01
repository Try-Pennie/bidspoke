// Lint for the porting evidence package (#1705).
//
// The rules come from the repo's shared definition rather than being restated
// here, so this package cannot drift away from what the apps enforce, and a rule
// added there reaches it automatically (L41).
import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import { sharedRules } from '../../eslint.rules.shared.mjs'

export default [
  {
    ignores: ['dist', 'node_modules'],
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
    rules: { ...sharedRules },
  },
  {
    // Test fixtures legitimately use `any` and no-await async stubs, matching
    // the Worker's own override. The async-correctness errors still apply.
    files: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
