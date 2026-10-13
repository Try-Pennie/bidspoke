// The recordsBidAttempts trait must name EVERY node that writes bid-attempt rows
// during the walk, because the strand projection (bidAttemptsForProjection)
// omits exactly those types to avoid double counting, which is the #368 gap: a
// stranded run that bid through one of them loses its per-attempt rows.
//
// A trait a node must OPT INTO cannot, on its own, catch a new writer that forgets
// to set it (L96): the opt-in list simply stays short. So this guard derives the
// set from what the code ACTUALLY does, by reading the worker executor source for
// the bid logger call, and fails if the declared trait does not match. A new
// executor that calls makeBidLogger / recordBidAttempt without setting
// recordsBidAttempts fails here, which is the signal to either carry its attempts
// through the projection or re-document the #368 gap for it.
//
// Scope, stated so the boundary is not mistaken for full coverage (L93): this
// enforces the two ways a native bid writer actually arises in this engine. One,
// an executor under engine/nodes that calls the logger (caught by the source
// scan). Two, a walk-only node that fans out to partner_bid children, which must
// set synthesizesAttempts to have those children run at all (counted from the
// trait, which is itself pinned by the node-types suite). A node that wrote bid
// rows by calling the logger straight from the walk in index.ts, with no executor
// file AND no synthesizesAttempts, would be outside this scan, but that shape
// cannot write a bid row here: a walk-only node with no executor runs nothing of
// its own, and a synthesizing one carries the trait.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { listTsFiles, sanitizeSource, WORKER_SRC } from '../../__tests__/_scan-utils'
import { NODE_TRAITS, NODE_TYPES, type NodeType } from '@bidspoke/node-types'

const NODES_DIR = path.join(WORKER_SRC, 'engine/nodes')

/** Executor basenames (no .ts) whose source calls the bid logger, comments blanked. */
function executorsCallingBidLogger(): Set<string> {
  const callsLogger = /\b(makeBidLogger|recordBidAttempt)\s*\(/
  const out = new Set<string>()
  for (const file of listTsFiles(NODES_DIR)) {
    if (callsLogger.test(sanitizeSource(readFileSync(file, 'utf8')))) {
      out.add(path.basename(file, '.ts'))
    }
  }
  return out
}

const executorFiles = new Set(
  NODE_TYPES.map((t) => NODE_TRAITS[t].executorFile).filter((f): f is string => f !== null),
)

describe('recordsBidAttempts names every native bid writer (#368)', () => {
  it('every engine/nodes file that calls the bid logger is an executor the scan can map to a type', () => {
    // The scan below maps a calling file to a node type by its executorFile name.
    // If a logger call is introduced in a HELPER file in engine/nodes (basename
    // not an executorFile), it would silently not map, so this fails first and
    // names it, rather than letting a new writer slip past the mapping (the review
    // finding on this guard). A call reached through the walk OUTSIDE engine/nodes
    // belongs to a walkGraphOnly node, which is covered by synthesizesAttempts in
    // the derivation below (that is how bid_group counts).
    const unmapped = [...executorsCallingBidLogger()].filter((base) => !executorFiles.has(base))
    expect(unmapped, `engine/nodes files call the bid logger but are not executors: ${unmapped.join(', ')}`).toEqual([])
  })

  it('matches the executors that call the bid logger, plus the synthesizers', () => {
    const callers = executorsCallingBidLogger()
    // A synthesizing node (bid_group) writes its attempt rows through the
    // partner_bid children it fans out to, so it counts even though its own
    // executor file does not call the logger directly.
    const derived = NODE_TYPES.filter(
      (t: NodeType) =>
        NODE_TRAITS[t].synthesizesAttempts ||
        (NODE_TRAITS[t].executorFile !== null && callers.has(NODE_TRAITS[t].executorFile)),
    ).sort()
    const declared = NODE_TYPES.filter((t: NodeType) => NODE_TRAITS[t].recordsBidAttempts).sort()

    // Not vacuous: there ARE native bid writers, so an empty derived set would be
    // a broken scan, not a clean bill (L98).
    expect(derived.length).toBeGreaterThan(0)
    expect(declared).toEqual(derived)
  })

  it('finds the two direct bid-logger callers it is calibrated against', () => {
    // If a refactor renames the logger or moves these calls, the scan above would
    // silently read an empty caller set; pin the two it is meant to see.
    const callers = executorsCallingBidLogger()
    expect(callers.has('partner-bid')).toBe(true)
    expect(callers.has('buyer-select')).toBe(true)
  })
})
