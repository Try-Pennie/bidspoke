import type { ActionSchema, ServiceSchema } from './types'

/**
 * Finding an action by (key, version), the only way a step reaches one (#1689
 * D1). The engine runs exactly the version stored on the step; a version that no
 * longer exists is refused by name, at save and at run, and is never answered
 * with the newest version instead. Generic over the entry type so the validator
 * (schema actions) and the executor (runtime actions) share this one rule.
 */

export type ActionVersionRefusal = 'action_unknown' | 'action_version_missing'

export type ResolvedAction<T> =
  | { readonly ok: true; readonly action: T }
  | {
      readonly ok: false
      readonly reason: ActionVersionRefusal
      readonly key: string
      readonly version: number
      readonly availableVersions: readonly number[]
      readonly message: string
    }

export function resolveActionVersion<T extends { readonly key: string; readonly version: number }>(
  actions: readonly T[],
  key: string,
  version: number,
): ResolvedAction<T> {
  const sameKey = actions.filter((a) => a.key === key)
  const match = sameKey.find((a) => a.version === version)
  if (match) return { ok: true, action: match }

  const availableVersions = sameKey.map((a) => a.version).sort((x, y) => x - y)
  if (availableVersions.length === 0) {
    return {
      ok: false,
      reason: 'action_unknown',
      key,
      version,
      availableVersions,
      message: `The catalogue has no action ${key}.`,
    }
  }
  return {
    ok: false,
    reason: 'action_version_missing',
    key,
    version,
    availableVersions,
    message: `${key} has no version ${version}. Versions it has: ${availableVersions.join(', ')}. The step must be saved again on one of those.`,
  }
}

/** Every action of every service, in catalogue order. */
export function catalogueActions(catalogue: readonly ServiceSchema[]): ActionSchema[] {
  return catalogue.flatMap((s) => s.actions)
}
