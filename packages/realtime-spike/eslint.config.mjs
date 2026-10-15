// Lint for the realtime spike package (#2131).
//
// The rules come from the repo's shared definition rather than being restated
// here, so this package cannot drift away from what the apps enforce (L41).
import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import { sharedRules } from '../../eslint.rules.shared.mjs'

export default [
  {
    ignores: ['dist', 'node_modules', '.wrangler'],
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
    // Test doubles legitimately use no-await async stubs, matching the other
    // packages. The async-correctness errors still apply.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
