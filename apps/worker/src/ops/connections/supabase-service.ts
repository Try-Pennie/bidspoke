/**
 * The ops Supabase service as OpsConnections uses it (#2337, phase 7 of #1689):
 * one project's service key. Built per request by opsServiceRegistry
 * (services.ts), since the ops project it must refuse is read from this
 * Worker's own env.
 *
 * The login is `{ service_key }` (the static key minter's supabase placement:
 * apikey and a bearer token, minters/static-key.ts); the target is
 * `{ project_url }`, the Project URL or the bare ref, read by the catalogue's
 * one rule (supabaseProjectRefOf, schema/supabase-project.ts). Every request
 * goes to https://<ref>.supabase.co, the one host declared.
 *
 * THE CROSS LANE RULE. A connection naming the bidding project or the ops
 * project is refused: at save on bidding, where the field agnostic money check
 * compares the Project URL with SUPABASE_URL (lib/connection-money-targets.ts,
 * supabase_project); and here, against laneProjectRefs (../ops-db.ts, the same
 * rule that keeps the ops client off the bidding project), by verify before
 * anything is sent (verify_supabase_lane_project) and by declaredHosts on every
 * request after it, so a stored copy naming one is refused at send too. With
 * the lane projects unreadable, both refuse rather than pass.
 *
 * THE EXPIRY SIGNAL is the static key minter's: a 401 (Supabase's answer to a
 * key that is not the project's, or was revoked). connectionFetch renews once,
 * which reads the same key again, and a second 401 is needs_reauth.
 *
 * WHAT VERIFY MEASURES. A GET of the project's REST root, which costs nothing
 * and needs a key of that project: Supabase keys are project scoped, so a key
 * answered 2xx on the declared project's host is that project's, and a key of
 * another project (the bidding one declared as something else included) is
 * refused there with a 401. The identity is the project ref; nothing is kept.
 */
import { supabaseProjectHost, supabaseProjectRefOf } from '@bidspoke/service-catalogue/schema'
import { IdentityMismatch, IdentityUnreadable, type IdentityProbe } from './identity'
import { targetFields } from './minters/login-fields'
import { STATIC_KEY_PLACEMENTS, staticKeyAuth } from './minters/static-key'
import { LoginMintError } from './refusals'
import type { OpsServiceEntry } from './ops-connections'

export interface SupabaseServiceDeps {
  /** The bidding and ops project refs (laneProjectRefs). Throws when they cannot be read. */
  laneProjectRefs(): readonly string[]
}

/** The project a target declares. Throws LoginMintError (not_allowed, target_invalid) when it names none. */
export function supabaseProjectOf(target: unknown): string {
  const fields = targetFields(target)
  const ref = supabaseProjectRefOf(Object.hasOwn(fields, 'project_url') ? fields.project_url : undefined)
  if (ref === null) throw new LoginMintError('not_allowed', 'target_invalid')
  return ref
}

/** Whether a project is one Bidspoke itself runs on. Throws when the lane projects cannot be read. */
function isLaneProject(deps: SupabaseServiceDeps, ref: string): boolean {
  return deps.laneProjectRefs().map((r) => r.toLowerCase()).includes(ref)
}

export function supabaseIdentity(deps: SupabaseServiceDeps): IdentityProbe {
  return {
    kind: 'supabase',
    async measure(fetch, target) {
      const ref = supabaseProjectOf(target)
      let lane: boolean
      try {
        lane = isLaneProject(deps, ref)
      } catch {
        throw new IdentityUnreadable('the bidding and ops projects could not be read on this Worker, so a Supabase project is not told apart from them')
      }
      if (lane) throw new IdentityMismatch('the target names a Supabase project Bidspoke itself runs on', 'verify_supabase_lane_project')
      const response = await fetch(`https://${supabaseProjectHost(ref)}/rest/v1/`, { method: 'GET' })
      // Its status only: never the body, the project's schema.
      response.body?.cancel().catch(() => undefined)
      if (response.status < 200 || response.status >= 300) throw new IdentityUnreadable(`the project's REST root answered HTTP ${response.status}`)
      return { kind: 'supabase', projectRef: ref }
    },
  }
}

export function supabaseServiceEntry(deps: SupabaseServiceDeps): OpsServiceEntry {
  const key = staticKeyAuth(STATIC_KEY_PLACEMENTS.supabase)
  return {
    rules: {
      service: 'supabase',
      // A lane project, or lane projects that cannot be read, throw: connectionFetch refuses that as connection_target_invalid.
      declaredHosts: (target) => {
        const ref = supabaseProjectOf(target)
        if (isLaneProject(deps, ref)) throw new LoginMintError('not_allowed', 'target_invalid')
        return [supabaseProjectHost(ref)]
      },
      expired: key.expired,
      // The target is read first, so a connection naming no project is refused by rule before its key is read.
      authorize: async (input) => {
        supabaseProjectOf(input.target)
        return key.authorize(input)
      },
    },
    identity: supabaseIdentity(deps),
  }
}
