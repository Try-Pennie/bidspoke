/**
 * The worker's lint runs with a heap big enough to finish.
 *
 * Its ESLint config is type aware, so it holds the whole worker program in
 * memory. On 2026-10-13 that crossed Node's default heap on the CI runner (about
 * 2 GB): from 19:15 UTC every Lint job on every branch ended in "JavaScript heap
 * out of memory" (exit 134) with no lint error at all, which blocked every merge.
 * Locally the same lint crashes the same way at 1.6 GB and passes at 2 GB. The
 * heap is raised in the package's own script, by running ESLint under node with
 * the flag, so a local run and CI run the same command on any shell.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REPO_ROOT } from './_scan-utils'

/** Comfortably above the 2.4 GB measured, so ordinary growth does not hit it next week. */
const MIN_HEAP_MB = 4096

describe('the worker lint heap', () => {
  it('raises the heap past the CI default for the worker lint', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps/worker/package.json'), 'utf8')) as { scripts: Record<string, string> }
    const lint = pkg.scripts.lint
    const heap = /--max-old-space-size=(\d+)/.exec(lint)
    expect(heap, `apps/worker lint runs on the default heap, which the type aware lint outgrew: ${lint}`).not.toBeNull()
    expect(Number(heap?.[1])).toBeGreaterThanOrEqual(MIN_HEAP_MB)
    // The option has to reach ESLint's own Node process: given to node as it starts
    // the ESLint entry point, or through NODE_OPTIONS ahead of eslint. A flag placed
    // after eslint is read by ESLint as one of its own arguments and does nothing.
    expect(lint).toMatch(/^(node --max-old-space-size=\d+ \S*eslint\S*\s|(cross-env )?NODE_OPTIONS=--max-old-space-size=\d+ eslint\s)/)
  })
})
