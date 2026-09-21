import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, readWorkflow } from './_scan-utils'

/**
 * CI and the deploy's Verify leg both run the worker's Durable Object suite
 * (#1410). It lives in its own vitest project (`test:do`), which the Node
 * suite's config excludes, so nothing else would run it: a workflow edit that
 * dropped the step would leave every SQLite backed object untested while both
 * jobs stayed green (L98). Same shape as ci-runs-every-package-suite.test.ts,
 * which cannot see this suite because it checks package `test` scripts.
 */
const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']

const stripComments = (yaml: string): string =>
  yaml
    .split('\n')
    .map((line) => (/^\s*#/.test(line) ? '' : line.replace(/\s+#.*$/, '')))
    .join('\n')

describe('CI runs the worker Durable Object suite (#1410)', () => {
  it('the worker declares a test:do script that runs the Workers project config', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'apps/worker/package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts['test:do']).toBe('vitest run --config vitest.do.config.mts')
  })

  it.each(WORKFLOWS)('%s invokes it outside a comment', (workflow) => {
    const yaml = stripComments(readWorkflow(workflow))
    expect(yaml).toMatch(/pnpm --filter[= ]worker test:do(?![\w:-])/)
  })

  it('the Node project excludes the Workers files, so they cannot pass vacuously there', () => {
    const cfg = readFileSync(path.join(REPO_ROOT, 'apps/worker/vitest.config.ts'), 'utf8')
    expect(cfg).toMatch(/exclude:\s*\[[^\]]*durable-objects\/__tests__\/\*\.workers\.test\.ts/)
  })
})
