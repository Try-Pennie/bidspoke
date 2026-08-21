// Rules shared by every TypeScript package in this repo.
//
// Extracted from the Worker's config (#907), which was the only place they
// lived. `packages/uuidv7` declared no lint script at all, so `pnpm -r lint`
// skipped it: the first shared package in the repo was never linted, and every
// future one inherited that exemption by default rather than by decision. The
// exemption was invisible, because `pnpm -r lint` prints "Scope: 4 of 5
// workspace projects" and reports Done, which reads exactly like everything was
// linted (L98).
//
// It matters most for the rules that are about CORRECTNESS rather than about
// being a Worker: the ban on stringifying a caught error, no-base-to-string,
// and the async-correctness family. Shared package code is imported and run by
// both apps, so a rule the apps enforce and the package does not is a hole in
// the middle of everything.
//
// This is the definition, not a copy of one. The Worker spreads it rather than
// restating it, so a rule added here reaches every package, and a list that must
// mirror another source of truth is derived from it rather than maintained
// beside it (L41).
//
// Tiering is unchanged from where these came from: async correctness and
// information loss are ERRORS, the `no-unsafe-*` family is WARN (tracked debt,
// #295), and each package may still tighten a rule for its own hot paths, as the
// Worker does for src/engine.

export const sharedRules = {
    // --- Async correctness: ERROR (the reason this config exists) ---
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/require-await': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-implied-eval': 'error',
    '@typescript-eslint/only-throw-error': 'error',

    // --- Information loss: ERROR (#601) ---
    // Stringifying an object with a default toString yields "[object Object]".
    // A Supabase/PostgREST error IS a plain object, so this silently destroyed
    // the cause in dead-letter alerts, export alerts, and a code-node throw
    // (#598). It reads as a style nit; it is a bug that blinds you mid-incident.
    // Caveat: with default options this does NOT fire on a value still typed
    // `unknown` (only once narrowing widens it to `{}`). A ratchet, not a proof.
    '@typescript-eslint/no-base-to-string': 'error',

    // no-base-to-string is blind to a value still typed `unknown` (it only fires
    // once narrowing widens the type to `{}`), which is exactly the most common
    // place this bug appears: a caught error. This name-based guard closes that
    // gap (#606). It bans a bare `String(err)` and a `${err}` template
    // interpolation on an identifier named err/error/e, pointing at the shared
    // renderer. Crude by name, but unlike the type-aware rule it does not care
    // whether the type was narrowed.
    //
    // The `err instanceof Error ? err.message : String(err)` idiom was exempt
    // until #687. It isn't safe: the false branch is precisely where a
    // non-Error lands, so it renders the "[object Object]" this guard exists to
    // stop. `instanceof Error` itself stays legal (a `.name` read, a static
    // user-facing fallback); only the String()/coerceString() branch is banned.
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "CallExpression[callee.name=/^(String|coerceString)$/] > Identifier[name=/^(err|error|e)$/]",
        message:
          'Do not stringify a caught error with String()/coerceString(): a plain Supabase/PostgREST error renders as "[object Object]" (coerceString gives "{}") and blanks the alert. Use formatErr() from lib/format-error.ts.',
      },
      {
        selector: "TemplateLiteral > Identifier[name=/^(err|error|e)$/]",
        message:
          'Do not interpolate a caught error into a template: a plain object renders as "[object Object]". Use formatErr() from lib/format-error.ts.',
      },
    ],

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
    '@typescript-eslint/restrict-template-expressions': 'warn',

    // tsc already enforces these via noUnusedLocals/noUnusedParameters
    '@typescript-eslint/no-unused-vars': 'off',
    // engine polling/retry loops use intentional `while (true) { ... break }`
    'no-constant-condition': ['error', { checkLoops: false }],
    // `let` is legitimate when a var is read in a closure defined before its
    // assignment (e.g. circular Proxy/handler refs); don't force const there.
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],

    // New to eslint:recommended as of the ESLint 10 upgrade (#453). Real
    // findings, but neither is an async-correctness bug, so they follow the
    // same tiering as the rest of this file: warn, tracked debt.
    'no-useless-assignment': 'warn',
    'preserve-caught-error': 'warn',
}
