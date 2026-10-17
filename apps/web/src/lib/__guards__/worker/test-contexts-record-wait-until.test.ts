import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKER_SRC, listFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * No worker unit test writes its own waitUntil (#2120).
 *
 * A hand written sink (a bare vi.fn(), a function that drops the promise, or
 * one that pushes it onto an array the test drains once) let work the code
 * under test handed off run on after the test ended. When it logged after the
 * file's worker closed, vitest failed the whole worker run ("Closing rpc while
 * onUserConsoleLog was pending") with every test green: 4 of 15 full runs on
 * 2026-10-17, and a production Deploy run on 2026-10-16.
 *
 * Every worker unit test now hands the code recordingContext() from
 * apps/worker/src/test-setup/wait-until.ts, and the setup file
 * wait-until-guard.ts fails a test that ends with any of its work still
 * running. This refuses a test file that defines a waitUntil any other way, so
 * the next one cannot bypass that check, and fails if the setup file stops
 * being registered. Passing a recorder's own waitUntil on
 * (`waitUntil: ctx.waitUntil`) is allowed.
 */
const WORKER = path.dirname(WORKER_SRC)

/** The worker's Node unit suite, as apps/worker/vitest.config.ts includes and excludes it. */
const unitTestFiles = (): string[] =>
  [WORKER_SRC, path.join(WORKER, 'money-gate')]
    .flatMap((root) => listFiles(root, { exts: ['.ts'], includeTests: true, skipDirs: ['node_modules'] }))
    .filter((f) => f.endsWith('.test.ts') && !f.endsWith('.workers.test.ts') && !f.endsWith('.gate.test.ts'))

// A waitUntil property whose value is anything but a context's own waitUntil,
// or a waitUntil method written out.
const PROPERTY_SINK = /(?<![.\w$])waitUntil\s*:(?!\s*[\w$.]+\.waitUntil\b)/
const METHOD_SINK = /(?<![.\w$])waitUntil\s*\([^()]*\)\s*(?::\s*[^{=]+)?\{/

/** Line numbers of every hand written waitUntil, comments and string contents ignored. */
function handWrittenSinks(source: string): number[] {
  return sanitizeSource(source).split('\n').flatMap((line, i) =>
    PROPERTY_SINK.test(line) || METHOD_SINK.test(line) ? [i + 1] : [])
}

describe('the hand written waitUntil detector', () => {
  it.each([
    ['a bare vi.fn()', 'const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any'],
    ['a function that drops the promise', 'const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }'],
    ['one that catches and drops it', 'const ec = { waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined) }'],
    ['one that pushes it onto an array', '    waitUntil: (p: Promise<unknown>) => background.push(p.catch(() => {})),'],
    ['a dependency option', 'registerScheduledSlack(client, { kv, pager, waitUntil: (p) => handed.push(p) })'],
    ['a method', '  waitUntil(p: Promise<unknown>) { handed.push(p) },'],
    ['a typed method', '  waitUntil(p: Promise<unknown>): void {'],
  ])('flags %s', (_label, line) => {
    expect(handWrittenSinks(line)).toEqual([1])
  })

  it.each([
    ['a recorder', 'const mockCtx = recordingContext()'],
    ['a recorder\'s waitUntil passed on', 'registerScheduledSlack(client, { kv, pager, waitUntil: ctx.waitUntil })'],
    ['a call', '  ctx.waitUntil(p)'],
    ['an assertion', 'expect(mockCtx.waitUntil).not.toHaveBeenCalled()'],
    ['a comment', '    // A job handed to waitUntil: started inside the tick, awaited by nobody here.'],
    ['a trailing comment', 'await run() // handed to waitUntil: then settled'],
    ['a test name', 'it(\'a page handed to waitUntil: never awaited\', async () => {'],
  ])('allows %s', (_label, line) => {
    expect(handWrittenSinks(line)).toEqual([])
  })
})

describe('worker unit tests (#2120)', () => {
  it('hand the code under test recordingContext(), never a waitUntil of their own', () => {
    const files = unitTestFiles()
    // Not vacuous: the walk reaches the suite, and the recorder is in use across it.
    expect(files.length, 'the walk found too few worker unit test files').toBeGreaterThan(400)
    const sources = files.map((f) => ({ file: path.relative(WORKER, f), text: readFileSync(f, 'utf8') }))
    expect(sources.filter((s) => s.text.includes('recordingContext()')).length).toBeGreaterThan(60)
    const found = sources.flatMap((s) => handWrittenSinks(s.text).map((line) => `${s.file}:${line}`))
    expect(found, 'use recordingContext() from src/test-setup/wait-until.ts, and await ctx.settle() before the test ends').toEqual([])
  })

  it('run the check after every test, from the unit suite setup files', () => {
    const config = sanitizeSource(readFileSync(path.join(WORKER, 'vitest.config.ts'), 'utf8'), { blankStrings: false })
    const setupFiles = /setupFiles:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? ''
    expect(setupFiles).toContain("'src/test-setup/wait-until-guard.ts'")
  })
})
