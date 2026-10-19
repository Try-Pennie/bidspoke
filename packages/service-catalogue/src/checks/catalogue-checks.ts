import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ActionSchema, ServiceSchema } from '../schema/types'
import { GOOGLE_DELEGATION_GRANTED_SCOPES } from '../schema/google-delegation'
import type { RuntimeAction } from '../runtime/types'
import { actionVersionId, computeFingerprint } from './fingerprint'
import { LockfileError, readImporterLock, type ImporterLock } from './lockfile'
import { ModuleGraphError } from './module-graph'

/**
 * Every check a catalogue is held to (#2337), as one function over a catalogue
 * description, so the shipped catalogue (catalogue.test.ts) and the test only
 * fixture (checks/catalogue-checks.test.ts, where each problem below is made to
 * appear) run through the same code. Test support only: neither entry point
 * imports it, and it reads files, which a Worker cannot.
 *
 * - Versioning (D1): every (key, version) has a committed fingerprint, and a
 *   released one that no longer matches fails, asking for a new version. That
 *   includes an edit to a workspace package its run imports, and an upgrade
 *   anywhere in the dependency closure of an npm package its run reaches, read
 *   from the lockfile; a package or snapshot the lockfile does not resolve is
 *   refused by name.
 * - Traits (R11): every action decides `sideEffect` and `idempotent` itself and
 *   writes down why it is or is not idempotent.
 * - Pairing: schema and runtime hold the same (key, version) set, and each run
 *   is the one exported by `<actionsDir>/<key>.v<version>.ts`, the file its
 *   fingerprint is taken over.
 */

export interface CatalogueUnderCheck {
  readonly label: string
  readonly services: readonly ServiceSchema[]
  readonly runtime: readonly RuntimeAction[]
  /** The committed fingerprints, by `key@version`. */
  readonly fingerprints: Readonly<Record<string, string>>
  /** Where each action's run file lives, absolute. */
  readonly actionsDir: string
  /** The package root fingerprint source paths are taken relative to. */
  readonly packageRoot: string
  /** The pnpm-lock.yaml the npm versions a fingerprint folds in are read from, absolute. */
  readonly lockfile: string
  /** The run files' workspace package, as the lockfile's importers section names it. */
  readonly importer: string
}

export type ProblemCode =
  | 'action_key_outside_service'
  | 'version_not_positive_integer'
  | 'duplicate_action_version'
  | 'trait_not_decided'
  | 'idempotent_reason_missing'
  | 'read_not_idempotent'
  | 'argument_duplicate_key'
  | 'argument_depends_on_unknown'
  | 'dropdown_without_source'
  | 'google_scope_not_granted'
  | 'schema_without_run'
  | 'run_without_schema'
  | 'run_file_missing'
  | 'run_file_unregistered'
  | 'run_not_from_its_file'
  | 'run_source_unreadable'
  | 'lockfile_unreadable'
  | 'dependency_unresolved'
  | 'fingerprint_missing'
  | 'fingerprint_changed'
  | 'fingerprint_orphaned'

export interface Problem {
  readonly code: ProblemCode
  /** The `key@version` (or file, or fingerprint id) the problem is about. */
  readonly subject: string
  readonly message: string
}

const RUN_FILE = /^(.+)\.v(\d+)\.ts$/

export const runFileName = (a: { readonly key: string; readonly version: number }) => `${a.key}.v${a.version}.ts`

function checkAction(service: ServiceSchema, action: ActionSchema, problems: Problem[]): void {
  const id = actionVersionId(action)
  const add = (code: ProblemCode, message: string) => problems.push({ code, subject: id, message })

  if (!action.key.startsWith(`${service.key}.`)) {
    add('action_key_outside_service', `${id} belongs to service ${service.key}, so its key must start with "${service.key}."`)
  }
  if (!Number.isInteger(action.version) || action.version < 1) {
    add('version_not_positive_integer', `${id}: a version is a whole number from 1`)
  }

  for (const trait of ['sideEffect', 'idempotent'] as const) {
    if (typeof action[trait] !== 'boolean') {
      add('trait_not_decided', `${id} does not decide ${trait}; every action states it as true or false`)
    }
  }
  if (typeof action.idempotentBecause !== 'string' || action.idempotentBecause.trim() === '') {
    add('idempotent_reason_missing', `${id} does not say why it is${action.idempotent ? '' : ' not'} idempotent`)
  }
  if (action.sideEffect === false && action.idempotent === false) {
    add('read_not_idempotent', `${id} has no side effect, so repeating it changes nothing; it cannot be non idempotent`)
  }

  const argKeys = new Set<string>()
  for (const arg of action.arguments) {
    if (argKeys.has(arg.key)) add('argument_duplicate_key', `${id} declares the argument ${arg.key} twice`)
    argKeys.add(arg.key)
  }
  for (const arg of action.arguments) {
    for (const dep of arg.dependsOn ?? []) {
      if (dep === arg.key || !argKeys.has(dep)) {
        add('argument_depends_on_unknown', `${id}: argument ${arg.key} depends on ${dep}, which is not another argument of it`)
      }
    }
    if (arg.type === 'dropdown' && !arg.source) {
      add('dropdown_without_source', `${id}: dropdown ${arg.key} names no lookup to fill it`)
    }
  }

  // The ops minter asks Google for these, so each must be one the Workspace grant holds (#2335, F129).
  if (action.googleScopes !== undefined) {
    const granted: readonly string[] = GOOGLE_DELEGATION_GRANTED_SCOPES
    if (action.googleScopes.length === 0) add('google_scope_not_granted', `${id} declares an empty Google scope list; leave googleScopes out instead`)
    for (const scope of action.googleScopes) {
      if (!granted.includes(scope)) add('google_scope_not_granted', `${id} asks for ${scope}, which the Workspace delegation grant (decision 11) does not hold`)
    }
  }
}

function runFilesIn(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out
  for (const entry of readdirSync(dir)) {
    const m = RUN_FILE.exec(entry)
    if (m && !entry.endsWith('.test.ts')) out.set(`${m[1]}@${Number(m[2])}`, path.join(dir, entry))
  }
  return out
}

export async function checkCatalogue(catalogue: CatalogueUnderCheck): Promise<Problem[]> {
  const problems: Problem[] = []

  // Structure and traits, and one registration per (key, version).
  const schemaById = new Map<string, ActionSchema>()
  for (const service of catalogue.services) {
    for (const action of service.actions) {
      checkAction(service, action, problems)
      const id = actionVersionId(action)
      if (schemaById.has(id)) {
        problems.push({ code: 'duplicate_action_version', subject: id, message: `${id} is registered more than once` })
      } else {
        schemaById.set(id, action)
      }
    }
  }

  // Schema and runtime pair one to one.
  const runtimeById = new Map(catalogue.runtime.map((r) => [actionVersionId(r), r]))
  for (const id of schemaById.keys()) {
    if (!runtimeById.has(id)) {
      problems.push({ code: 'schema_without_run', subject: id, message: `${id} is in the catalogue schema but no run implements it` })
    }
  }
  for (const id of runtimeById.keys()) {
    if (!schemaById.has(id)) {
      problems.push({ code: 'run_without_schema', subject: id, message: `${id} has a run but no catalogue schema entry` })
    }
  }

  // Each run lives in its own file, and nothing else lives there unregistered.
  const files = runFilesIn(catalogue.actionsDir)
  const registered = new Set([...schemaById.keys(), ...runtimeById.keys()])
  for (const id of registered) {
    if (!files.has(id)) {
      const [key, version] = id.split('@')
      problems.push({
        code: 'run_file_missing',
        subject: id,
        message: `${id} has no run file at ${path.join(catalogue.actionsDir, runFileName({ key, version: Number(version) }))}`,
      })
    }
  }
  for (const [id, file] of files) {
    if (!registered.has(id)) {
      problems.push({ code: 'run_file_unregistered', subject: file, message: `${file} is an action run file nothing registers` })
    }
  }
  for (const [id, action] of runtimeById) {
    const file = files.get(id)
    if (!file) continue
    const mod = (await import(pathToFileURL(file).href)) as { run?: unknown }
    if (mod.run !== action.run) {
      problems.push({
        code: 'run_not_from_its_file',
        subject: id,
        message: `${id}'s registered run is not the \`run\` exported by ${file}, so its fingerprint does not cover it`,
      })
    }
  }

  // Versioning: committed fingerprints (D1). The lockfile is read and parsed
  // once for the whole run, and read even when there is no action, so a wrong
  // path fails before the first action ships rather than with it.
  let lock: ImporterLock
  try {
    lock = readImporterLock(catalogue.lockfile, catalogue.importer)
  } catch (err) {
    if (!(err instanceof LockfileError)) throw err
    problems.push({
      code: 'lockfile_unreadable',
      subject: catalogue.lockfile,
      message: `${err.message}. No fingerprint can be checked without the versions it pins.`,
    })
    return problems
  }
  for (const [id, action] of schemaById) {
    const file = files.get(id)
    if (!file) continue
    let actual: string
    try {
      actual = computeFingerprint(action, file, catalogue.packageRoot, lock)
    } catch (err) {
      if (err instanceof ModuleGraphError) {
        problems.push({ code: 'run_source_unreadable', subject: id, message: err.message })
      } else if (err instanceof LockfileError) {
        problems.push({ code: 'dependency_unresolved', subject: id, message: err.message })
      } else {
        throw err
      }
      continue
    }
    const committed = catalogue.fingerprints[id]
    if (committed === undefined) {
      problems.push({
        code: 'fingerprint_missing',
        subject: id,
        message: `${id} has no committed fingerprint. Add this line to the ${catalogue.label} fingerprints file: "${id}": "${actual}"`,
      })
    } else if (committed !== actual) {
      const next = Math.max(...[...schemaById.values()].filter((a) => a.key === action.key).map((a) => a.version)) + 1
      problems.push({
        code: 'fingerprint_changed',
        subject: id,
        message:
          `${id} is released and its arguments, traits, run source (a workspace package's included), the resolved version ` +
          `of an npm package it imports or a package that one depends on no longer match its committed fingerprint, ` +
          `so every step saved on it would silently change. Put version ${action.version} back as it was and add the change as version ${next}.`,
      })
    }
  }
  for (const id of Object.keys(catalogue.fingerprints)) {
    if (!schemaById.has(id)) {
      problems.push({
        code: 'fingerprint_orphaned',
        subject: id,
        message: `${id} has a committed fingerprint but no catalogue action. Removing a released version is deliberate: remove its fingerprint in the same change.`,
      })
    }
  }

  return problems
}

const HINT = 'idempotent' + 'Hint'

/**
 * Files under `dir` that mention Pipedream's idempotency annotation. Copied
 * Pipedream code carries an `annotations` block, and `idempotent` must be our
 * decision per action, never that hint (#1689 section 3.0), so the hint may not
 * appear anywhere in the catalogue's source.
 */
export function scanForIdempotentHints(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') out.push(...scanForIdempotentHints(full))
    } else if (/\.(ts|mts|js|mjs|cjs|json)$/.test(entry) && readFileSync(full, 'utf8').includes(HINT)) {
      out.push(full)
    }
  }
  return out.sort()
}
