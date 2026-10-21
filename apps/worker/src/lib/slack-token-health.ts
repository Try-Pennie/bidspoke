/**
 * The page for a sealed Slack token nobody can read (#2331, F128).
 *
 * Every reader of a Slack row logs a token it cannot open by name
 * (slack-connection.ts), but a log is not a page, and the about 45 alert senders
 * that read the row must not each page about it. So the minute database probe,
 * which reads every organization's row anyway, is this signal's one owner: it
 * hands over what it saw each healthy minute, and this module pages each
 * organization whose token could not be opened, once per cooldown, through the
 * connection that can still post (the plaintext copy while the dual write
 * lasts, or the saved copy's entry the probe carried forward), and says the
 * all-clear once the row has read cleanly for the re-arm window.
 *
 * Not gated on any of the organization's alert toggles: a toggle mutes a kind
 * of alert, and this is about whether any alert can be sent at all.
 *
 * Each organization is its own failure boundary, as in database-reachability.ts:
 * one whose page or bookkeeping throws is logged and the rest go on. Nothing
 * here throws to the probe.
 */
import type { SlackConnection, SlackTokenProblem } from './slack-connection'
import { sendSlackTokenReadableAlert, sendSlackTokenUnreadableAlert } from './slack'
import { announceRecovery, markAlerted, markSpikeSeen, recordPaged, RECOVERY_TTL_SECONDS, type IncidentContext, type RecoveryKv } from './alert-recovery'
import { BACKOFF_STEPS_SECONDS, backoffCooldownKey, clearCondition, describeRepeat, inCooldown, readCondition, recordAlert } from './alert-backoff'
import { minuteAllClearClaim, postMinutePage } from './alert-fanout'
import type { AlertClaims } from './alert-claim'
import { formatErr } from './format-error'

/** The incident record's signal and the prefix of every key below. */
export const SLACK_TOKEN_SIGNAL = 'slack-token-undecryptable'

const backoffKey = (orgId: string) => `${SLACK_TOKEN_SIGNAL}:${orgId}`
const incident = (orgId: string): IncidentContext => ({ scope: { kind: 'org', organizationId: orgId }, subjectLabel: 'Slack token' })

/** One organization whose sealed token the probe could not open this minute. */
export interface SlackTokenSighting {
  orgId: string
  reason: SlackTokenProblem
  /** True when the plaintext copy stood in; false when only the saved copy can. */
  fellBackToPlaintext: boolean
}

export interface SlackTokenHealthDeps {
  kv: RecoveryKv
  appUrl: string
  claims?: AlertClaims
}

/**
 * Page each sighting through `tellWith` (the connections the probe can post
 * with), and stand down each organization in `readable` whose incident is
 * owed its all-clear.
 */
export async function judgeSlackTokens(
  deps: SlackTokenHealthDeps,
  sightings: SlackTokenSighting[],
  tellWith: Map<string, SlackConnection>,
  readable: Map<string, SlackConnection>,
  nowMs: number,
): Promise<void> {
  for (const s of sightings) {
    try {
      await markSpikeSeen(deps.kv, SLACK_TOKEN_SIGNAL, s.orgId, nowMs)
      const conn = tellWith.get(s.orgId)
      if (!conn) {
        console.error(`[slack-token-health] org=${s.orgId} ${s.reason}: nobody can be told, there is no plaintext copy and no saved copy entry to post with`)
        continue
      }
      const backoff = backoffKey(s.orgId)
      let standing: Awaited<ReturnType<typeof readCondition>> = null
      const posted = await postMinutePage({
        claims: deps.claims,
        key: backoff,
        inCooldown: async () => {
          const cooling = await inCooldown(deps.kv, backoff)
          if (!cooling) standing = await readCondition(deps.kv, backoff)
          return cooling
        },
        send: () => sendSlackTokenUnreadableAlert(conn, conn.default_channel, {
          reason: s.reason,
          fellBackToPlaintext: s.fellBackToPlaintext,
          appUrl: deps.appUrl,
          repeat: describeRepeat(standing, nowMs, true, BACKOFF_STEPS_SECONDS) ?? undefined,
        }),
      })
      if (posted === 'sent') {
        await markAlerted(deps.kv, SLACK_TOKEN_SIGNAL, s.orgId, incident(s.orgId), nowMs)
        await recordPaged(deps.kv, SLACK_TOKEN_SIGNAL, s.orgId, incident(s.orgId), nowMs)
        await recordAlert(deps.kv, backoff, standing, nowMs, { conditionTtlSeconds: RECOVERY_TTL_SECONDS })
      }
    } catch (e) {
      console.error(`[slack-token-health] page for org=${s.orgId} failed, the other organizations go on: ${formatErr(e)}`)
    }
  }

  const seen = new Set(sightings.map((s) => s.orgId))
  for (const [orgId, conn] of readable) {
    if (seen.has(orgId)) continue
    try {
      const recovered = await announceRecovery(
        deps.kv,
        SLACK_TOKEN_SIGNAL,
        orgId,
        backoffCooldownKey(backoffKey(orgId)),
        incident(orgId),
        (alertedAt, endedAt, firstHealthyAt) => sendSlackTokenReadableAlert(conn, conn.default_channel, { alertedAt, endedAt, firstHealthyAt, appUrl: deps.appUrl }, nowMs),
        { now: nowMs, claim: minuteAllClearClaim(deps.claims, SLACK_TOKEN_SIGNAL, orgId) },
      )
      if (recovered) await clearCondition(deps.kv, backoffKey(orgId))
    } catch (e) {
      console.error(`[slack-token-health] all-clear for org=${orgId} failed, the other organizations go on: ${formatErr(e)}`)
    }
  }
}
