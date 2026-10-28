/**
 * The largest step answer ops keeps (#2339, #2703), in bytes of JSON as the ops
 * Worker writes it: one rule for a step test's result and for each step a run
 * walks (apps/worker src/ops/step-output.ts applies it). The database holds an
 * answer to 256 KB of its own text form, which spaces each separator and so can
 * be up to half as long again: 160 KB stays under it.
 *
 * It lives here, in the declarative entry both apps import, so the canvas names
 * the same size the Worker applies when an earlier step's answer was too big to
 * keep (#2882, docs/design/insert-too-big-answer.html, D2), never a copy typed twice.
 */
export const STEP_OUTPUT_MAX_BYTES = 160_000
