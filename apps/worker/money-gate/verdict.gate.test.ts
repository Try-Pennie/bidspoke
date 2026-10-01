/**
 * The money gate's verdict (#1704): compares the merge base transcript with the
 * head transcript and fails on any difference, or on a workflow that executed no
 * node. Coverage is printed whatever the outcome.
 *
 * Run by .github/scripts/money-gate.sh after the two replays, through its own
 * config (vitest.money-gate-verdict.config.mts), because it needs the two
 * transcripts named by MONEY_GATE_BASE and MONEY_GATE_HEAD and must not run in the
 * ordinary suite, where they do not exist.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, expect } from 'vitest'
import type { Transcript } from './lib/compare'
import { gateVerdict } from './lib/verdict'

it('the head does what the merge base does with every fixture', () => {
  const basePath = process.env.MONEY_GATE_BASE
  const headPath = process.env.MONEY_GATE_HEAD
  expect(basePath && headPath, 'MONEY_GATE_BASE and MONEY_GATE_HEAD must name the two transcripts').toBeTruthy()
  const read = (p: string) => JSON.parse(readFileSync(resolve(p), 'utf8')) as Transcript
  const here = dirname(fileURLToPath(import.meta.url))
  const shapes = JSON.parse(readFileSync(join(here, 'fixtures', 'shapes.json'), 'utf8')) as { exported_at: string }

  const verdict = gateVerdict({ base: read(basePath!), head: read(headPath!), shapesExportedAt: shapes.exported_at, now: new Date() })
  // Written to a file as well, because a passing test's console output is not
  // printed: the coverage report must reach the log on a green run too.
  if (process.env.MONEY_GATE_VERDICT_OUT) writeFileSync(process.env.MONEY_GATE_VERDICT_OUT, `${verdict.output}\n`)
  expect(verdict.exitCode, verdict.output).toBe(0)
})
