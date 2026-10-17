import type { RuntimeAction, ServiceRuntime } from './types'

/**
 * Every shipped action's run, paired with its schema through `implement`, and
 * every service's auth functions. Empty until the first service PR of #2337.
 *
 * Each action's run is exported as `run` from its own file,
 * `runtime/actions/<key>.v<version>.ts`, and imported here. The catalogue
 * checks import that file and refuse a registered run that is not the one it
 * exports, because the version fingerprint is taken over that file and what it
 * imports: a run written anywhere else would change without its fingerprint
 * moving.
 */
export const RUNTIME_ACTIONS: readonly RuntimeAction[] = []

export const SERVICE_RUNTIMES: readonly ServiceRuntime[] = []
