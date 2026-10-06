// ESLint for the ops namespace outbound Worker (#1709). The same shared rules
// as the other Worker packages (#907).
import js from '@eslint/js'
import { sharedRules } from '../../eslint.rules.shared.mjs'
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
    // The shared definition, spread rather than restated (#907): a guard fails
    // if a package restates it instead (L41).
    rules: { ...sharedRules },
  },
]
