/**
 * @bidspoke/service-catalogue/runtime (#2337): every action's `run` and the
 * services' auth function slots. Imported only by the Workers; apps/web never
 * imports it (service-catalogue-runtime-stays-out-of-web.test.ts).
 */
import { resolveActionVersion, type ResolvedAction } from '../schema/lookup'
import { RUNTIME_ACTIONS } from './registry'
import type { RuntimeAction } from './types'

export * from './types'
export { RUNTIME_ACTIONS, SERVICE_RUNTIMES } from './registry'

/** The run a step pinned to (key, version) executes, or a named refusal (D1). */
export function resolveRuntimeAction(key: string, version: number): ResolvedAction<RuntimeAction> {
  return resolveActionVersion(RUNTIME_ACTIONS, key, version)
}
