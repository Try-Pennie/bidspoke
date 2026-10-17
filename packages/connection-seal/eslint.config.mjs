// Lint for the connection seal package (#2333). Both Workers will import it,
// so it is held to the rules they enforce, read from the repo's shared
// definition rather than restated here (L41).
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
