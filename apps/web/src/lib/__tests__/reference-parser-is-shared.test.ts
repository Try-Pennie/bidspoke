/**
 * The `steps.X.Y.Z` syntax has ONE definition (#433).
 *
 * It was written three times before this: the engine's step-scoping scanner,
 * the watched-field derivation, and the canvas rename tool. A fourth was about
 * to be written for build-time validation in the editor.
 *
 * Three copies of a syntax rule is an ordinary drift problem. One of these is
 * worse. The output-wrapper rule decides which field a path NAMES, and it is
 * consulted both by what the engine reads at run time and by what the detector
 * records as present. If those drifted, the detector would watch a different
 * field than the engine reads and be confidently wrong about a field nobody was
 * watching, with every test in both packages still green: a shared NAME is read
 * as evidence of shared BEHAVIOUR, so two same-named functions either side of a
 * package boundary are never compared (L263).
 *
 * Consolidation only holds if something checks it (L41, L96), so this fails when
 * a consumer grows its own copy of the syntax back.
 *
 * Lives here rather than in __guards__/worker because its subjects span both
 * apps and the shared package, and that directory is for guards that read
 * worker source alone.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

const PACKAGE_SRC = path.join(REPO_ROOT, 'packages/references/src/index.ts')

// Every file that parses the reference syntax. Each must get it from the shared
// package rather than restating it.
const CONSUMERS = [
  'apps/worker/src/engine/watched-fields.ts',
  'apps/worker/src/engine/nodes/code.ts',
  'apps/worker/src/engine/field-presence.ts',
  'apps/web/src/lib/rename-step-references.ts',
]

const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8')

describe('the reference syntax has one definition (#433)', () => {
  it('the shared package exists and exports the syntax', () => {
    // A guard whose subject is missing passes vacuously, so assert it is there
    // before asserting anything about the consumers (L98).
    expect(existsSync(PACKAGE_SRC), `${PACKAGE_SRC} is missing`).toBe(true)
    const src = readFileSync(PACKAGE_SRC, 'utf8')
    for (const name of [
      'STEP_CHAIN_SOURCE',
      'stripOutputWrapper',
      'chainToStepPath',
      'parseStepPath',
      'hasDynamicStepsAccess',
      'extractReferencedNamespaces',
      'stepReferencePattern',
    ]) {
      expect(src, `packages/references must export ${name}`).toContain(`export`)
      expect(src, `packages/references must export ${name}`).toContain(name)
    }
  })

  it.each(CONSUMERS)('%s imports the syntax instead of restating it', (rel) => {
    const src = read(rel)
    expect(src, `${rel} must import from @bidspoke/references`).toContain('@bidspoke/references')
  })

  // The chain pattern can be restated as a regex literal (one backslash) or as a
  // pattern string (two), so collapse runs of backslashes before matching, or the
  // guard catches one spelling and waves the other through.
  const restatesChainPattern = (src: string) =>
    src.replace(/\\+/g, '\\').includes('(?<![\\w$])steps')

  it.each(CONSUMERS)('%s does not build its own steps chain regex', (rel) => {
    // The distinctive fragment of the chain pattern: a `steps` root guarded by a
    // negative lookbehind. Only the shared package may spell this out.
    expect(
      restatesChainPattern(read(rel)),
      `${rel} restates the steps chain pattern; build it from STEP_CHAIN_SOURCE instead`,
    ).toBe(false)
  })

  it.each(CONSUMERS)('%s does not restate the output-wrapper rule', (rel) => {
    const src = read(rel)
    // The rule is `segments[1] === 'output' || segments[1] === '$return_value'`.
    // Written any way at all, it names both wrapper spellings in one expression.
    const collapsed = src.replace(/\s+/g, '')
    expect(
      collapsed.includes("==='output'||") && collapsed.includes("'$return_value'"),
      `${rel} restates the output-wrapper rule; use stripOutputWrapper instead`,
    ).toBe(false)
  })

  it('the guard can fail: a restated pattern is caught in either spelling', () => {
    // Proves the checks above are not passing because their fixtures happen to
    // be clean (L1). Runs the same predicates over deliberate violations, in
    // both the regex-literal and the pattern-string spelling.
    const asRegexLiteral = 'const RE = /(?<![\\w$])steps/g'
    const asPatternString = "const RE = new RegExp('(?<![\\\\w$])steps', 'g')"
    expect(restatesChainPattern(asRegexLiteral)).toBe(true)
    expect(restatesChainPattern(asPatternString)).toBe(true)

    const badWrapper = "if (segments[1] === 'output' || segments[1] === '$return_value') {}"
    const collapsed = badWrapper.replace(/\s+/g, '')
    expect(collapsed.includes("==='output'||") && collapsed.includes("'$return_value'")).toBe(true)
  })
})
