/**
 * The outage drill (#1305) runs every fixture's up run and down runs in one
 * workerd isolate, resetting storage between them. State a module keeps in the
 * isolate's memory survives that reset, so a down run could be answered from
 * memory the up run filled (and pass without ever meeting the outage), or skip a
 * write the previous fixture made (partner-last-good's bookkeeping did, which is
 * how this was found). Plan B1 on #1675: the drill forgets every such memory
 * before each run, found by a scan, not a hand list.
 *
 * This scan lists every module-level Map, Set, WeakMap or WeakSet created empty,
 * and every module-level `let`, in the Worker's source. Each must be either forgotten by the drill (FORGOTTEN, which the drill
 * calls through harness/isolate-memory.ts) or listed in KEPT with the reason it cannot
 * change what a run decides or sends.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FORGOTTEN_STATE } from '../isolate-memory'

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const src = join(workerRoot, 'src')

/** Module-level state that cannot change what a run decides or sends, each with why. */
const KEPT: Record<string, string> = {
  'src/lib/jwt.ts:cachedKeys': 'the signing keys of the signed-in app; no run reads them',
  'src/lib/jwt.ts:lastUnknownKidRefetchMs': 'a refetch throttle for those keys; no run reads it',
  'src/lib/lead-read-budget.ts:leads': 'keyed by each lead\'s own client object, which no other run holds',
  'src/lib/scheduled-slack.ts:registered': 'keyed by the scheduled handler\'s client object, built per tick; no run holds that client (#1303)',
  'src/engine/response-contracts.ts:undeclaredReported': 'only stops a log line repeating',
  'src/engine/nodes/code.ts:bundlesWithoutCapture': 'only stops a log line repeating',
  'src/lib/secret-crypto.ts:imported': 'an imported key decrypts exactly as one imported again; only saves the import (#2090)',
  'src/lib/incident-outbox.ts:seq': 'only orders two incident outbox keys written in one millisecond; no run reads it, and the drain does not depend on it (#2099)',
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : filesUnder(p)
    return p.endsWith('.ts') && !p.endsWith('.d.ts') ? [p] : []
  })
}

/** Every module-level mutable binding, as `path:name`. */
function moduleState(): string[] {
  const found: string[] = []
  for (const file of filesUnder(src)) {
    const rel = relative(workerRoot, file)
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      // Created empty (state that accumulates as runs go), or any module-level let.
      // A Map or Set built from a fixed list is a constant, not memory.
      const m = /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*new\s+(?:Map|Set|WeakMap|WeakSet)\b.*\(\)\s*;?\s*$/.exec(line) ?? /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)/.exec(line)
      if (m) found.push(`${rel}:${m[1]}`)
    }
  }
  return found.sort()
}

describe('module state the outage drill must forget (#1305, plan B1)', () => {
  it('finds module state at all, so an empty scan cannot pass', () => {
    expect(moduleState()).toContain('src/lib/partner-last-good.ts:lastGoodWritten')
  })

  it('every module-level Map, Set or let is forgotten by the drill or kept with a reason', () => {
    const forgotten = new Set<string>(FORGOTTEN_STATE)
    const unaccounted = moduleState().filter((s) => !forgotten.has(s) && !(s in KEPT))
    expect(unaccounted, 'add a forget function to the module and to harness/isolate-memory.ts, or a reason to KEPT').toEqual([])
  })

  it('names nothing that no longer exists, in either list', () => {
    const state = new Set(moduleState())
    const stale = [...FORGOTTEN_STATE, ...Object.keys(KEPT)].filter((s) => !state.has(s))
    expect(stale).toEqual([])
  })
})
