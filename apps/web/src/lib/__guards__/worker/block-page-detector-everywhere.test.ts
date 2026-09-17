/**
 * Every outbound partner call in the engine runs its failure body through the block page
 * detector (#1265), enumerated from the SOURCE rather than from a list somebody remembers.
 *
 * The readers are found by the state they reach: a file under the engine that awaits a bare
 * `fetch(` is calling a partner (the code node dispatches to its sandbox through a binding's
 * `.fetch`, which is not a partner call and does not match). Each such file must turn a
 * non-2xx body into a sighting through `sightingFromResponse`, the one wrapper over the one
 * detector. A new outbound node that forgets is caught here, not by the next incident.
 *
 * Lives on the web side with the other worker source guards because the worker's tsconfig
 * has no node types. Mutation checked 2026-09-17 by removing the call from one reader.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC, listTsFiles } from '../../__tests__/_scan-utils'

const ENGINE_DIR = path.join(WORKER_SRC, 'engine')
const rel = (f: string) => path.relative(ENGINE_DIR, f)

/** Files that make an outbound HTTP call to a partner: a bare, awaited global fetch. */
function partnerCallers(): string[] {
  return listTsFiles(ENGINE_DIR).filter((file) => /\bawait fetch\(/.test(readFileSync(file, 'utf8')))
}

describe('every engine reader of a partner body runs it through the block page detector (#1265)', () => {
  it('finds the readers from the source, so the list cannot go stale', () => {
    const names = partnerCallers().map(rel).sort()
    // The five known today. A sixth appearing is fine; it just has to pass the test below.
    expect(names).toEqual(expect.arrayContaining([
      'bid-resolver.ts',
      'nodes/achieve-offers.ts',
      'nodes/integration.ts',
      'nodes/partner-bid.ts',
      'nodes/salesforce.ts',
    ]))
  })

  it('each reader turns a non-2xx body into a sighting through sightingFromResponse', () => {
    const missing = partnerCallers()
      .filter((file) => !/\bsightingFromResponse\(/.test(readFileSync(file, 'utf8')))
      .map(rel)
    expect(missing, `outbound partner callers that never run a failure body through sightingFromResponse: ${missing.join(', ')}`).toEqual([])
  })

  it('a sighting is only ever made through the one wrapper, never a second detector call', () => {
    // Two predicates for one rule is how the sandbox half of the draft plan went wrong
    // (L370): readers must not call detectBlockPage themselves.
    const offenders = listTsFiles(ENGINE_DIR)
      .filter((file) => !file.endsWith('block-sightings.ts') && /\bdetectBlockPage\(/.test(readFileSync(file, 'utf8')))
      .map(rel)
    expect(offenders).toEqual([])
  })
})
