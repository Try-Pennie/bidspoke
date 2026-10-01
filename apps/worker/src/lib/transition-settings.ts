/**
 * The one typed registry of transition and rollout settings (R9 in discussion
 * #1684, built in #1706).
 *
 * Every lane that exists only for a transition (the porting recorder, the tee,
 * shadow comparisons, Pipedream forwarders, report only validation, a staged
 * rollout) is retired by ONE stored setting, and every such setting is declared
 * here: its key, whether its subject is Pipedream facing, its scope, the rule
 * that says when it retires, and any expiry. The Porting page and the daily lane
 * check read this list, and the doc table in the plan describes it rather than
 * being the source (L41).
 *
 * The scan in __tests__/transition-settings.test.ts fails on any read of a
 * `porting.*`, `rollout.*` or `validation.*` key in the Worker or a workspace
 * package that is not declared here, and on any such key built from a variable,
 * so a lane cannot be added outside this list (L96).
 *
 * VALUE STORE. The values live in `environment_variables`, as non secret rows,
 * never in a new table (discussion #1684, red-team finding 6: today's rollout
 * gates are already environment_variables rows, and a third settings mechanism
 * is the thing to avoid). That store's write routes record every create, update
 * and delete with the old and new values (#1085, routes/api/env.ts), which is
 * the audit R9 asks for.
 *
 * What does NOT exist yet, stated so nobody assumes it does: no code reads any
 * of these settings (the porting recorder in ops/ and packages/porting-evidence
 * takes its recording history as an input and reads no stored flag), and there
 * is no write path specific to them beyond the generic environment variable
 * routes. The reader arrives with the porting work that needs it, and goes
 * through `transitionSetting` so the registry is consulted at the read.
 */

/** Pipedream Workflows shuts down on this date (Pipedream notice, recorded 2026-09-30). */
export const PIPEDREAM_SHUTDOWN_DATE = '2027-03-31'

/** Where every transition setting's value is stored. See the header. */
export const TRANSITION_SETTING_STORE = 'environment_variables' as const

export type TransitionSettingKey = `${'porting' | 'rollout' | 'validation'}.${string}`

/** What one value of the setting applies to (R9). */
export type TransitionSettingScope =
  | 'global'
  | 'per_workflow'
  | 'per_endpoint'
  | 'per_store_group'
  | 'per_token_group'
  | 'per_email_trigger'
  | 'per_allow'

export interface TransitionSetting {
  key: TransitionSettingKey
  /** True when the lane's subject is Pipedream, so it is dead after the shutdown. */
  pipedreamFacing: boolean
  scope: TransitionSettingScope
  /** When the lane is retired and the setting removed, in words a person checks. */
  retireRule: string
  /** ISO date (YYYY-MM-DD) after which the daily check pages if the lane is still on. */
  expiresOn?: string
}

export const TRANSITION_SETTINGS: readonly TransitionSetting[] = [
  {
    key: 'porting.recording_enabled',
    pipedreamFacing: true,
    scope: 'per_workflow',
    retireRule: "The workflow's cutover has settled and its recorder is removed from the Pipedream workflow.",
    expiresOn: PIPEDREAM_SHUTDOWN_DATE,
  },
]

const BY_KEY = new Map<string, TransitionSetting>(TRANSITION_SETTINGS.map((s) => [s.key, s]))

export function isRegisteredTransitionSetting(key: string): boolean {
  return BY_KEY.has(key)
}

/** The registry entry for a key; refuses by name a key that is not registered. */
export function transitionSetting(key: string): TransitionSetting {
  const entry = BY_KEY.get(key)
  if (!entry) throw new Error(`${key} is not a registered transition setting; declare it in lib/transition-settings.ts`)
  return entry
}
