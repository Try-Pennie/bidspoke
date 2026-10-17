/**
 * The money gate's verdict (#1704): compares the merge base transcript with the
 * head transcript and fails on any difference expected-changes.json does not
 * excuse, or on a run that checked nothing. Coverage is printed whatever the outcome.
 *
 * Run by .github/scripts/money-gate.sh after the two replays, through its own
 * config (vitest.money-gate-verdict.config.mts), because it needs the two
 * transcripts named by MONEY_GATE_BASE and MONEY_GATE_HEAD, and the merge base's
 * expected-changes.json named by MONEY_GATE_EXPECTED_BASE, and must not run in the
 * ordinary suite, where they do not exist. On a pull request it also reads the live
 * worker's copy, MONEY_GATE_EXPECTED_LIVE from MONEY_GATE_LIVE_COMMIT (#1836).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, expect } from 'vitest'
import type { Transcript } from './lib/compare'
import { gateVerdict } from './lib/verdict'
import { oldestSample, type ShapesFile } from './lib/shape'
import { resolveExpectedBase, resolveExpectedLive } from './lib/expected-changes'

const readIfPresent = (p: string | undefined): string | null => (p && existsSync(p) ? readFileSync(p, 'utf8') : null)

it('the head does what the merge base does with every fixture', () => {
  const basePath = process.env.MONEY_GATE_BASE
  const headPath = process.env.MONEY_GATE_HEAD
  expect(basePath && headPath, 'MONEY_GATE_BASE and MONEY_GATE_HEAD must name the two transcripts').toBeTruthy()
  // The base copy, or git's word that it is absent there; anything else fails by name.
  const expectedBase = resolveExpectedBase(process.env.MONEY_GATE_EXPECTED_BASE, { exists: existsSync, read: (p) => readFileSync(p, 'utf8') })
  if (expectedBase.failure) {
    if (process.env.MONEY_GATE_VERDICT_OUT) writeFileSync(process.env.MONEY_GATE_VERDICT_OUT, `money gate: ${expectedBase.failure}\n`)
    expect.fail(`money gate: ${expectedBase.failure}`)
  }
  const read = (p: string) => JSON.parse(readFileSync(resolve(p), 'utf8')) as Transcript
  const here = dirname(fileURLToPath(import.meta.url))
  const shapes = JSON.parse(readFileSync(join(here, 'fixtures', 'shapes.json'), 'utf8')) as ShapesFile
  const committedDefinitionIds = readdirSync(join(here, 'fixtures', 'definitions')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))

  const verdict = gateVerdict({
    base: read(basePath!),
    head: read(headPath!),
    // A carried over shape (#2173) is as old as its samples, not the export that kept it.
    shapesExportedAt: oldestSample(shapes),
    now: new Date(),
    committedDefinitionIds,
    expectedHead: readIfPresent(join(here, 'expected-changes.json')),
    expectedBase: expectedBase.text,
    // Only a pull request hands this over (#1836); a Deploy leaves it unset.
    expectedLive: resolveExpectedLive(process.env.MONEY_GATE_EXPECTED_LIVE, process.env.MONEY_GATE_LIVE_COMMIT, { exists: existsSync, read: (p) => readFileSync(p, 'utf8') }),
  })
  // Written to a file as well, because a passing test's console output is not
  // printed: the coverage report must reach the log on a green run too.
  if (process.env.MONEY_GATE_VERDICT_OUT) writeFileSync(process.env.MONEY_GATE_VERDICT_OUT, `${verdict.output}\n`)
  expect(verdict.exitCode, verdict.output).toBe(0)
})
