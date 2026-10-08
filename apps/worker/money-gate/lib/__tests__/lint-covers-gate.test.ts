import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The money gate guards every bidding change, and was never linted (#1862): the
 * worker's lint script named only src, and eslint's type aware rules had no
 * project holding money-gate/lib, so they could not even parse it. CI's Lint job
 * runs each package's lint script, so both halves must hold.
 */
const worker = join(__dirname, '..', '..', '..')

describe('the worker lint covers the money gate (#1862)', () => {
  it('the lint script names the money gate', () => {
    const pkg = JSON.parse(readFileSync(join(worker, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.lint).toContain('"money-gate/**/*.ts"')
  })

  it('eslint loads the project that holds money-gate/lib, so its type aware rules can parse it', () => {
    const config = readFileSync(join(worker, 'eslint.config.mjs'), 'utf8')
    expect(config).toMatch(/project: \[[^\]]*'\.\/tsconfig\.scripts\.json'/)
    const scripts = JSON.parse(readFileSync(join(worker, 'tsconfig.scripts.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '')) as { include: string[] }
    expect(scripts.include).toContain('money-gate')
  })
})
