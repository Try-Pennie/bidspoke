// ESLint for the compare namespace outbound Worker (#1708). The same shared
// rules as the other Worker packages (#907).
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
    // The shared definition, spread rather than restated (#907). These rules
    // were duplicated here with comments saying they were "held in both Worker
    // packages so the invariant can't drift", which is the right intent and the
    // wrong mechanism: two copies drift the moment one is edited. There is now
    // one definition, and a guard fails if a package restates it instead (L41).
    rules: { ...sharedRules },
  },
]
