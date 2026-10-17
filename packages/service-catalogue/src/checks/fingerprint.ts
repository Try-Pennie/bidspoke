import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ACTION_FIELD_ROLES,
  ARGUMENT_FIELD_ROLES,
  type ActionArgument,
  type ActionSchema,
  type FieldRole,
} from '../schema/types'
import { collectModuleGraph } from './module-graph'

/**
 * The fingerprint of one released action version (#1689 D1, #2337): a sha256
 * over its behaviour fields (arguments and traits, never a display name) and
 * the source of its run file plus every file that file reaches through a
 * relative value import (module-graph.ts says what that does not cover).
 *
 * Taken from the source TEXT, not from `run.toString()`, so a transpiler or
 * test runner upgrade that reformats emitted code cannot move it. Line endings
 * are normalised and object keys sorted, so a checkout setting or a reordered
 * object literal does not either.
 */

/** The id a fingerprint is committed under. */
export const actionVersionId = (a: { readonly key: string; readonly version: number }) => `${a.key}@${a.version}`

const counts = (role: FieldRole) => role !== 'display'

function project<T extends object>(value: T, roles: Readonly<Record<keyof T, FieldRole>>): Partial<T> {
  const out: Partial<T> = {}
  for (const field of Object.keys(roles) as Array<keyof T>) {
    if (counts(roles[field])) out[field] = value[field]
  }
  return out
}

/** The parts of an action a fingerprint covers. */
export function behaviourOf(action: ActionSchema): object {
  const projected = project(action, ACTION_FIELD_ROLES)
  return {
    ...projected,
    arguments: action.arguments.map((arg: ActionArgument) => project(arg, ARGUMENT_FIELD_ROLES)),
  }
}

/** JSON with object keys sorted at every depth and undefined members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
    const sorted: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k]
    return sorted
  })
}

export function computeFingerprint(action: ActionSchema, runFile: string, packageRoot: string): string {
  const sources = collectModuleGraph(runFile).map((file) => ({
    path: path.relative(packageRoot, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n'),
  }))
  const material = canonicalJson({ behaviour: behaviourOf(action), sources })
  return createHash('sha256').update(material).digest('hex')
}
