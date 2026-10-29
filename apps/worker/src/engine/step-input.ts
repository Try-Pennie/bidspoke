/**
 * Putting a step's resolved request onto the error it failed with (#3057).
 *
 * The walk records a failed step's `input` from the error's `resolvedInput`
 * (`extractResolvedInput` in engine/index.ts), the same field a node returns on
 * success. A node that throws its own error sets it there itself; this is for an
 * error the node did not build: a fetch that threw (a dropped connection, an
 * abort), and the step deadline's error from withTimeout, which wins the race
 * against the node's own and so never carries what the node built.
 *
 * The request is the one the node built for its step record, masked as it is
 * on success, never a second copy built here.
 */
import type { ResolvedStepInput } from '../types'

/**
 * Returns `err` carrying `input` as its `resolvedInput`, unless it carries one
 * already (a node's own error says more) or it is not an Error. A thrown value
 * that is not an Error is left alone, because the error message renders such an
 * object with no message as its own JSON, and the request would be printed into
 * it. Never throws: an error that refuses the property is returned as it was.
 */
export function carryStepInput(err: unknown, input: ResolvedStepInput | null | undefined): unknown {
  if (!input || !(err instanceof Error)) return err
  const tagged = err as Error & { resolvedInput?: ResolvedStepInput }
  if (tagged.resolvedInput) return err
  try {
    tagged.resolvedInput = input
  } catch {
    // A frozen or otherwise sealed error: the step records no input, as before.
  }
  return err
}
