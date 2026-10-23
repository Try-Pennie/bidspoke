import type { ActionSchema } from './types'

/**
 * An app_action step's settings (#2339, plan section 3.0): `{ service, action,
 * actionVersion, connection, args }`. One reading of them, shared by the
 * definition validator at save and the ops executor at run, so the two can never
 * disagree about what a step holds (L342).
 *
 * The step names its action by key and the version it was saved on, and runs
 * exactly that version (D1, lookup.ts). It names its connection by id, a
 * service_connections row of its organization; a value that is not an id is
 * refused, never matched against a name or replaced by another connection (L75).
 *
 * Its arguments are held as the step form holds them: text as entered, with
 * `{{ }}` references to earlier steps where the argument allows variables, and
 * an argument the catalogue parses as JSON either as that JSON's text or as the
 * value itself. readStepArgs checks them against the pinned version's schema
 * and parses the JSON; the references are resolved only at run, by the engine.
 */

export interface AppActionConfig {
  readonly service: string
  readonly action: string
  readonly actionVersion: number
  readonly connection: string
  readonly args: Readonly<Record<string, unknown>>
}

export const APP_ACTION_CONFIG_REFUSALS = [
  'action_not_chosen',
  'action_service_mismatch',
  'action_version_not_pinned',
  'connection_not_chosen',
  'connection_id_invalid',
  'args_not_object',
] as const
export type AppActionConfigRefusal = (typeof APP_ACTION_CONFIG_REFUSALS)[number]

export type AppActionConfigReading =
  | { readonly ok: true; readonly config: AppActionConfig }
  | { readonly ok: false; readonly reason: AppActionConfigRefusal; readonly message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
const refuse = (reason: AppActionConfigRefusal, message: string): AppActionConfigReading => ({ ok: false, reason, message })

/** The step's settings, or the first thing missing in the setup order (service and action, version, connection). */
export function readAppActionConfig(config: unknown): AppActionConfigReading {
  const c = isRecord(config) ? config : {}
  const { service, action, actionVersion, connection, args } = c
  if (blank(service) || blank(action) || typeof service !== 'string' || typeof action !== 'string') {
    return refuse('action_not_chosen', 'No service and action chosen')
  }
  if (!action.startsWith(`${service}.`)) return refuse('action_service_mismatch', `The action ${action} is not one of ${service}'s`)
  if (typeof actionVersion !== 'number' || !Number.isInteger(actionVersion) || actionVersion < 1) {
    return refuse('action_version_not_pinned', `No version of ${action} pinned`)
  }
  if (blank(connection)) return refuse('connection_not_chosen', 'No connection chosen')
  if (typeof connection !== 'string' || !UUID.test(connection)) {
    return refuse('connection_id_invalid', 'The connection is not a connection id; choose the connection again')
  }
  if (args !== undefined && args !== null && !isRecord(args)) return refuse('args_not_object', 'The arguments are not a set of named values')
  return { ok: true, config: { service, action, actionVersion, connection, args: isRecord(args) ? args : {} } }
}

export const STEP_ARG_PROBLEMS = [
  'argument_missing',
  'argument_unknown',
  'argument_not_text',
  'argument_json_invalid',
  'argument_not_list',
  'argument_variables_not_allowed',
] as const
export type StepArgProblemReason = (typeof STEP_ARG_PROBLEMS)[number]

export interface StepArgProblem {
  readonly reason: StepArgProblemReason
  readonly argument: string
  readonly message: string
}

export type StepArgsReading =
  | { readonly ok: true; readonly args: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly problems: readonly StepArgProblem[] }

const WHOLE_REFERENCE = /^\{\{[^{}]+\}\}$/

/** Whether a value carries a `{{ }}` reference anywhere inside it. */
export function hasVariables(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{')
  if (Array.isArray(value)) return value.some(hasVariables)
  if (isRecord(value)) return Object.values(value).some(hasVariables)
  return false
}

/**
 * The step's arguments checked against the pinned version's schema: every
 * required one present, none the schema does not declare, a reference only
 * where the argument allows variables, text where it takes text, and JSON
 * parsed where it says so (a list must parse to a list). A whole reference
 * (`{{steps.x.output.rows}}`) standing for a JSON argument is kept as it is: it
 * is resolved, and its value checked, at run. Problems come in declared order,
 * then the unknown names.
 */
export function readStepArgs(action: ActionSchema, stored: Readonly<Record<string, unknown>>): StepArgsReading {
  const problems: StepArgProblem[] = []
  const args: Record<string, unknown> = {}
  const add = (reason: StepArgProblemReason, argument: string, message: string) => problems.push({ reason, argument, message })

  for (const arg of action.arguments) {
    const value = Object.hasOwn(stored, arg.key) ? stored[arg.key] : undefined
    if (blank(value)) {
      if (arg.required) add('argument_missing', arg.key, `${arg.key} is required`)
      continue
    }
    if (!arg.allowsVariables && hasVariables(value)) {
      add('argument_variables_not_allowed', arg.key, `${arg.key} may not refer to another step`)
      continue
    }
    if (!arg.parseJson) {
      if (typeof value !== 'string') add('argument_not_text', arg.key, `${arg.key} must be text`)
      else args[arg.key] = value
      continue
    }
    let parsed: unknown = value
    if (typeof value === 'string' && !WHOLE_REFERENCE.test(value.trim())) {
      try {
        parsed = JSON.parse(value)
      } catch {
        add('argument_json_invalid', arg.key, `${arg.key} is not valid JSON`)
        continue
      }
    }
    const whole = typeof parsed === 'string' && WHOLE_REFERENCE.test(parsed.trim())
    if (arg.type === 'list' && !whole && !Array.isArray(parsed)) {
      add('argument_not_list', arg.key, `${arg.key} must be a list`)
      continue
    }
    args[arg.key] = parsed
  }

  const declared = new Set(action.arguments.map((a) => a.key))
  for (const key of Object.keys(stored)) {
    if (!declared.has(key)) add('argument_unknown', key, `${key} is not an argument of ${action.key} version ${action.version}`)
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, args }
}
