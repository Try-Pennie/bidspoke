/**
 * The declarative half of a catalogue action (#1689 section 3.0, #2337): what
 * the step form renders, what the validator checks a step's `args` against, and
 * what the executor reads to decide how a failed send may be retried. Nothing
 * here runs; `run` lives in the runtime entry.
 */

export const ARGUMENT_TYPES = ['text', 'dropdown', 'list', 'code'] as const
export type ArgumentType = (typeof ARGUMENT_TYPES)[number]

/** A named lookup the panel calls to fill a dropdown or to add fields (Phase 8). */
export interface LookupRef {
  readonly lookup: string
}

export interface ActionArgument {
  readonly key: string
  readonly type: ArgumentType
  readonly required: boolean
  /** Whether the value may carry `{{ }}` references to earlier steps. */
  readonly allowsVariables: boolean
  /** Whether the entered text is parsed as JSON before `run` receives it. */
  readonly parseJson: boolean
  /** The lookup that fills a dropdown. Required for a dropdown. */
  readonly source?: LookupRef
  /** Keys of the arguments whose values this one's lookup reads. */
  readonly dependsOn?: readonly string[]
  /** A lookup returning field definitions, one input per field (a sheet's columns). */
  readonly extraFieldsSource?: LookupRef
}

export interface ActionSchema {
  /** `<service key>.<action>`, unique with `version` across the catalogue. */
  readonly key: string
  readonly name: string
  /** A positive whole number. A change to behaviour is a new version, never an edit (D1). */
  readonly version: number
  readonly arguments: readonly ActionArgument[]
  /** It writes or sends something outside Bidspoke, so a run that is not real refuses it (R11). */
  readonly sideEffect: boolean
  /**
   * Repeating it after an uncertain outcome is safe. Decided per action by us,
   * never taken from a Pipedream annotation. A non idempotent action whose send
   * timed out is recorded as outcome unknown and never retried automatically
   * (#1950's executor).
   */
  readonly idempotent: boolean
  /** Why `idempotent` has the value it has: the decision, written down. */
  readonly idempotentBecause: string
}

export interface ServiceSchema {
  readonly key: string
  readonly name: string
  readonly actions: readonly ActionSchema[]
}

/**
 * Which fields of an action, and of an argument, are part of what it DOES. A
 * behaviour field is in the version fingerprint, so changing it needs a new
 * version; a display field is not. Typed as a record over every key so a field
 * added to either interface does not compile until somebody decides which it is.
 */
export type FieldRole = 'identity' | 'behaviour' | 'display'

export const ACTION_FIELD_ROLES: Readonly<Record<keyof ActionSchema, FieldRole>> = {
  key: 'identity',
  version: 'identity',
  name: 'display',
  arguments: 'behaviour',
  sideEffect: 'behaviour',
  idempotent: 'behaviour',
  idempotentBecause: 'display',
}

export const ARGUMENT_FIELD_ROLES: Readonly<Record<keyof ActionArgument, FieldRole>> = {
  key: 'behaviour',
  type: 'behaviour',
  required: 'behaviour',
  allowsVariables: 'behaviour',
  parseJson: 'behaviour',
  source: 'behaviour',
  dependsOn: 'behaviour',
  extraFieldsSource: 'behaviour',
}
