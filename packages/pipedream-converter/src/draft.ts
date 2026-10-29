/**
 * The draft the converter produces from one Pipedream workflow (#1695, plan 9.1).
 *
 * This slice carries the workflow's identity, the snapshot it was built from,
 * every trigger and step it found with their kind and pinned component, and
 * everything it could not read, each named. Mapping to Bidspoke nodes (9.2) and
 * the output that passes validateDefinition (9.3) come later and grow this shape.
 *
 * A draft holds names, keys and versions only, never code or prop values, so
 * printing one shows no partner data or credential.
 */
import type { PipedreamState } from '@bidspoke/porting-evidence/inventory'

/** A component pinned by `uses: {key, version}`, the pair 9.1's resolver will read the source of. */
export interface PinnedComponent {
  key: string
  version: string
}

/**
 * What a step is:
 * - `code`: inline code written in the workflow;
 * - `private_component`: one of the account's own components, whose code the export carries;
 * - `registry`: a published Pipedream component, pinned by key and version;
 * - `control_flow`: an if/else, switch or parallel block, whose code Pipedream generates;
 * - `unrecognised`: none of these, and named in `unconverted`.
 */
export type StepKind = 'code' | 'private_component' | 'registry' | 'control_flow' | 'unrecognised'

export interface DraftStep {
  /** `main` for the workflow's own steps, else the deployment id of the branch holding the step. */
  pipeline: string
  namespace: string
  kind: StepKind
  uses: PinnedComponent | null
  disabled: boolean
  /** Whether the step's own code parsed; null for a step with no code of its own to read. */
  parsed: boolean | null
}

export interface DraftTrigger {
  index: number
  type: string
  disabled: boolean
  uses: PinnedComponent | null
}

export type UnconvertedReason = 'unparseable_code' | 'unrecognised_step' | 'unrecognised_trigger'

export interface Unconverted {
  /** `<pipeline>/<namespace>` for a step, `trigger <index>` for a trigger. */
  where: string
  reason: UnconvertedReason
  detail: string
}

export interface Draft {
  workflow: { hashid: string; name: string; projectHashid: string; pipedreamState: PipedreamState }
  /** The export file the draft was built from: the newest recorded for the workflow (Hard Rule 7). */
  snapshot: { sha256: string; exportedAt: string; file: string }
  triggers: DraftTrigger[]
  steps: DraftStep[]
  unconverted: Unconverted[]
}

/** Why no draft was made at all, each a distinct cause with its own message (L11). */
export type RefusalReason =
  | 'workflow_not_in_export'
  | 'never_deployed'
  | 'snapshot_not_recorded'
  | 'snapshot_older_than_recorded'
  | 'snapshot_newer_than_recorded'
  | 'snapshot_differs_from_recorded'
  | 'absent_from_newest_export'

export interface Refusal {
  ok: false
  reason: RefusalReason
  message: string
}

export type ConvertResult = { ok: true; draft: Draft } | Refusal
