/**
 * The one way a test loads the Worker entry (src/index.ts) to fire its crons
 * (#2619): the entry itself, and every module the entry loads lazily inside a
 * cron branch (`await import('./lib/...')`), all loaded before the first test.
 *
 * Why: loading a module is charged to whichever test first needs it, against
 * that test's 5 second limit. The entry and the modules its crons load lazily
 * are a few hundred modules, which take about half a second on a quiet laptop
 * and 5 to 8 seconds on one with a load average above 100, so the first test
 * of a file to fire a cron could fail on a busy machine and pass alone (#2619).
 * Called at the top level of a test file, all of it is loaded while the file is
 * collected, which no per test limit covers, and the tests then time only what
 * they assert about.
 *
 * Mocks still apply: vi.mock calls are hoisted above everything in the test
 * file, so they are registered before this runs, and a lazily loaded module
 * that a test mocks is loaded as its mock.
 *
 * apps/web/src/lib/__guards__/worker/worker-app-loaded-at-collection.test.ts
 * fails on a test that fires the crons with the entry loaded any other way.
 */
// Read through Vite's raw import rather than node:fs: the worker tsconfig
// carries no Node types.
// @ts-expect-error Vite resolves the ?raw suffix to the file's text.
import ENTRY_SOURCE from '../index.ts?raw'

/** The relative modules `source` (the entry's text) imports with import(), as written there, each once. */
export function lazyImportsOf(source: string): string[] {
  return [...new Set([...source.matchAll(/\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g)].map((m) => m[2]))]
}

/** A specifier written in src/index.ts, as this file (one directory down) must write it. */
export const fromHere = (specifier: string): string => (specifier.startsWith('./') ? `../${specifier.slice(2)}` : `../${specifier}`)

export async function loadWorker(): Promise<typeof import('../index')> {
  const entry = await import('../index')
  await Promise.all(lazyImportsOf(ENTRY_SOURCE as string).map((s) => import(/* @vite-ignore */ fromHere(s))))
  return entry
}
