// Lint for the Salesforce API rules package (#2337). The bidding Worker, the
// ops Worker and the service catalogue's Salesforce actions import it, so it
// is held to the rules they enforce, read from the repo's shared definition
// rather than restated here (L41).
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
]
