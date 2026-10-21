/**
 * The verdict of the money gate's definition A/B mode (#2591, ab.ts): compares
 * the transcript of the current definition with the candidate's.
 *
 * Run by .github/scripts/money-gate-swap.sh after its two replays, through its
 * own config (vitest.money-gate-swap.config.mts), because it needs the two
 * transcripts (MONEY_GATE_CURRENT, MONEY_GATE_CANDIDATE_TRANSCRIPT) and the
 * candidate's name, and must not run in the ordinary suite, where they do not exist.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, expect } from 'vitest'
import type { Transcript } from '../lib/compare'
import { findCandidate, swapVerdict } from './ab'

it('the candidate does with every fixture what the current definition does', () => {
  const currentPath = process.env.MONEY_GATE_CURRENT
  const candidatePath = process.env.MONEY_GATE_CANDIDATE_TRANSCRIPT
  const name = process.env.MONEY_GATE_CANDIDATE
  expect(currentPath && candidatePath && name, 'MONEY_GATE_CURRENT, MONEY_GATE_CANDIDATE_TRANSCRIPT and MONEY_GATE_CANDIDATE must be set').toBeTruthy()
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = join(here, 'candidates')
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown]))
  const read = (p: string) => JSON.parse(readFileSync(resolve(p), 'utf8')) as Transcript
  const verdict = swapVerdict(read(currentPath!), read(candidatePath!), findCandidate(files, name!), process.env.MONEY_GATE_CANDIDATE_SEED || undefined)
  if (process.env.MONEY_GATE_VERDICT_OUT) writeFileSync(process.env.MONEY_GATE_VERDICT_OUT, `${verdict.output}\n`)
  expect(verdict.exitCode, verdict.output).toBe(0)
})
