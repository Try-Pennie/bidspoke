/**
 * How much of a step's answer ops keeps (#2339, #2703): one rule for a step
 * test's result (step-test.ts) and for each step a run walks (run-walk.ts), as
 * Dan decided on 2026-10-24 (#2703: step records keep their output with a size
 * cap, the same way step test results are kept).
 *
 * The answer is kept as the step gave it. An app_action step's answer is built
 * from what connectionFetch handed the action, which has already removed every
 * secret of the connection; the in memory steps answer only from the payload
 * and earlier answers, and an ops definition may read no environment variable.
 */

/**
 * The largest answer kept, in bytes of JSON as this Worker writes it. The
 * database holds an answer to 256 KB of its own text form, which spaces each
 * separator and so can be up to half as long again: 160 KB stays under it.
 */
export const STEP_OUTPUT_MAX_BYTES = 160_000

/** The database keeps an error to 2,000 characters; a clipped one says how much more there was. */
export const STEP_ERROR_MAX = 2_000

export const byteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value ?? null)).length

/** The text, or its first max characters and a count of the rest. */
export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)} [${text.length - max} more characters not kept]`)

/** An error clipped with room for the count of what was not kept. */
export const clipError = (error: string): string => clip(error, STEP_ERROR_MAX - 60)

/**
 * What is kept of an answer: the answer itself, or null when it is over the
 * cap, which is then named by its size (outputBytes) rather than read as empty.
 * bytes is the answer's measured size either way.
 */
export function keepOutput(output: unknown): { output: unknown; outputBytes: number | null; bytes: number } {
  const bytes = byteLength(output)
  return bytes > STEP_OUTPUT_MAX_BYTES ? { output: null, outputBytes: bytes, bytes } : { output: output ?? null, outputBytes: null, bytes }
}
