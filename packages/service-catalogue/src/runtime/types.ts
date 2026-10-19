import type { ActionSchema } from '../schema/types'

/**
 * The runtime half of a catalogue action (#2337): `run`, and the slots the
 * services' auth functions will fill. Imported only by the Workers.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** A step's arguments after variable resolution and any `parseJson`. */
export type ActionArgs = Readonly<Record<string, JsonValue>>

/**
 * What a run is handed. `fetch` is the connection bound fetch (Phase 5's
 * connectionFetch): it applies the connection's auth after anything is
 * recorded, so a run never holds a login itself. `signal` is the step's
 * deadline. `target` is the connection's declared target, its public half (a
 * Snowflake account, a Salesforce instance), which is where the run's requests
 * go; connectionFetch refuses any other host. `sleep` is every wait a run makes
 * (a poll's interval), injected so a test crossing one does not wait (L524).
 *
 * How a run fails is runtime/failure.ts.
 */
export interface ActionContext {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly signal: AbortSignal
  readonly target: JsonValue
  readonly sleep: (ms: number) => Promise<void>
}

export type ActionRun = (ctx: ActionContext, args: ActionArgs) => Promise<JsonValue>

/** `{ key, name, version, arguments[], sideEffect, idempotent, run }` (#1689 section 3.0). */
export interface RuntimeAction extends ActionSchema {
  readonly run: ActionRun
}

/** Pairs an action's declared half with its run. The schema object is the one CATALOGUE holds. */
export function implement(schema: ActionSchema, run: ActionRun): RuntimeAction {
  return { ...schema, run }
}

export type AuthCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export interface AuthContext {
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>
  readonly signal: AbortSignal
}

/**
 * A service's auth functions (#1689 section 3.0), each optional because a
 * service needs only the ones its login kind uses. The slots only: the minters
 * and refresh that fill them are Phase 5's, on the ops Worker.
 */
export interface ServiceAuth {
  /** The URL a person is sent to for an OAuth consent. */
  readonly buildAuthUrl?: (params: { readonly state: string; readonly redirectUri: string }) => string
  /** Proves a newly saved login works, before the connection is stored. */
  readonly verify?: (ctx: AuthContext) => Promise<AuthCheck>
  /** A cheap check that a stored login is still accepted. */
  readonly stillValid?: (ctx: AuthContext) => Promise<AuthCheck>
  /** Renews an expiring login. */
  readonly refresh?: (ctx: AuthContext) => Promise<AuthCheck>
}

export interface ServiceRuntime {
  readonly key: string
  readonly auth: ServiceAuth
}
