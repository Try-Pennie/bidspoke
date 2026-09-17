/**
 * Reporting a partner firewall block page (#1265): one sighting in, at most one Slack post
 * out, on a cadence the standing-condition backoff owns.
 *
 * Sightings arrive from the engine's step handling, never from inside a node, because node
 * executors cannot reach the Cloudflare context, a Supabase client or the Worker Env
 * uniformly. They arrive at the partner call rate during a block (hundreds an hour per host),
 * so the design is: the event line is ALWAYS written (the frequency stays measurable in
 * logs), and everything else is gated in order of cost. A KV cooldown read first, then the
 * alert claim so two isolates cannot both post, then the Slack lookup and the post, and the
 * standing condition is recorded only after Slack accepted the message.
 *
 * Three things this deliberately does NOT do. It never changes classification (the HTML
 * page rule already makes the response transient; retries and partner overrides are
 * untouched). It never posts on a test run or in local dev, the rule every engine alert
 * follows (#547): the event line is the evidence those runs leave. And it posts no
 * all-clear: a block that lifts produces no sighting, so nothing here can see it. The
 * scheduled reachability probe (#1274) owns the all-clear, and it can only announce one
 * for an incident it knows about, so this reporter ARMS it for either observer: on every
 * sighting, posted or suppressed, it records the running end of the incident and keeps
 * the recovery marker alive from the first sighting. A block a lead saw first (the common
 * case) therefore still gets its all-clear, and a lead sighting extends the incident. The
 * standing record is re-armed on every sighting too, so a five day block keeps its
 * first-seen time rather than lapsing at the 25h expiry.
 */
import type { PartnerBlockSighting } from '../types'
import type { AlertClaims } from './alert-claim'
import { inCooldown, readCondition, recordAlert, describeRepeat, touchCondition, type BackoffKv } from './alert-backoff'
import { keepAlerted, markSpikeSeen, type RecoveryKv } from './alert-recovery'
import { sendPartnerBlockAlert, type PartnerBlockAlertPayload } from './slack'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'
import { formatErr } from './format-error'

/** Reminders are posted only on a new sighting, so the record must not outlive a day of silence. */
export const PARTNER_BLOCK_CONDITION_TTL_SECONDS = 25 * 60 * 60

/** After a failed post, hold further attempts so a Slack outage does not turn every sighting into a lookup. */
export const POST_RETRY_HOLD_SECONDS = 3 * 60

export const PARTNER_BLOCK_KEY_PREFIX = 'partner-block'

/** The recovery marker family the probe's all-clear reads; written here for either observer (#1274). */
export const PARTNER_REACHABILITY_RECOVERY_PREFIX = 'partner-reachability'

/** The `seenIn` the scheduled probe reports under; the Slack wording and the docs' log query read it too. */
export const PROBE_SEEN_IN = 'probe'

export type PartnerBlockOutcome = 'posted' | 'logged' | 'cooldown' | 'claimed_elsewhere' | 'no_slack' | 'post_failed'

export interface PartnerBlockDeps {
  kv: BackoffKv & RecoveryKv
  claims: AlertClaims | undefined
  /**
   * Every Slack connection the alert goes to, empty when there is none. A list because the
   * probe (#1274) has no org of its own and posts to every org holding a connection, all
   * inside the one claim: a loop calling this reporter once per org would be refused for
   * every org after the first.
   */
  resolveSlack: () => Promise<Array<{ bot_token: string; default_channel: string }>>
  send?: typeof sendPartnerBlockAlert
  now?: () => number
  log?: (line: string) => void
  /** Test run or local dev: write the event line, touch nothing else. */
  silent: boolean
  appUrl: string
}

export interface PartnerBlockRunContext {
  orgId: string
  /** Absent for the scheduled probe, which runs no workflow; logged as `-`. */
  workflowId?: string
  workflowName?: string | null
  traceId?: string
}

export const partnerBlockKey = (host: string) => `${PARTNER_BLOCK_KEY_PREFIX}:${host}`

type SlackTarget = { bot_token: string; default_channel: string }

/**
 * The org's Slack connection for a block alert, from the database when it answers and from
 * the last-good copy the volume check keeps in KV when it does not (L682). A partner block
 * has nothing to do with Supabase, so this alert must not go quiet during a database wobble.
 * Never another org's connection, and never a throw: a background reporter with nothing to
 * post to logs and stops.
 */
export async function resolveSlackForBlockAlert(
  orgId: string,
  live: () => Promise<SlackTarget | null>,
  lastGood: () => Promise<Map<string, SlackTarget>>,
): Promise<SlackTarget | null> {
  try {
    const conn = await live()
    if (conn) return conn
  } catch (e) {
    console.error(`[partner-block] Slack connection read failed for org ${orgId}, trying the last-good copy: ${formatErr(e)}`)
  }
  try {
    return (await lastGood()).get(orgId) ?? null
  } catch (e) {
    console.error(`[partner-block] last-good Slack copy unreadable for org ${orgId}: ${formatErr(e)}`)
    return null
  }
}
const retryHoldKey = (host: string) => `${partnerBlockKey(host)}:post-retry`

/** Our own proxy workers, whose edge Ray ID is ours rather than the partner's. */
export function isOwnProxyHost(host: string): boolean {
  return host === 'trypennie.dev' || host.endsWith('.trypennie.dev')
}

export async function reportPartnerBlock(
  deps: PartnerBlockDeps,
  run: PartnerBlockRunContext,
  sighting: PartnerBlockSighting,
): Promise<PartnerBlockOutcome> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const send = deps.send ?? sendPartnerBlockAlert
  const key = partnerBlockKey(sighting.host)

  log(
    `[partner-block] event=partner_block_page host=${sighting.host} status=${sighting.status} vendor=${sighting.vendor}` +
      ` body_ray=${sighting.bodyRayId ?? '-'} edge_ray=${sighting.edgeRayId ?? '-'} markers=${JSON.stringify(sighting.markers)}` +
      ` seen_in=${sighting.seenIn} workflow=${run.workflowId ?? '-'} trace=${run.traceId ?? '-'}${deps.silent ? ' silent=true' : ''}`,
  )
  if (deps.silent) return 'logged'

  // Arm the all-clear and extend the incident on EVERY sighting, before any gate below can
  // return early (#1274). The running end moves to now; the recovery marker keeps the
  // condition's first-seen time; the standing record is re-armed with the same content.
  const nowMs = now()
  await markSpikeSeen(deps.kv, PARTNER_REACHABILITY_RECOVERY_PREFIX, sighting.host, nowMs)
  const standingNow = await readCondition(deps.kv, key)
  if (standingNow) {
    await keepAlerted(deps.kv, PARTNER_REACHABILITY_RECOVERY_PREFIX, sighting.host, standingNow.since)
    await touchCondition(deps.kv, key, standingNow, PARTNER_BLOCK_CONDITION_TTL_SECONDS)
  }

  if ((await inCooldown(deps.kv, key)) || (await deps.kv.get(retryHoldKey(sighting.host))) !== null) return 'cooldown'

  if (deps.claims && !(await deps.claims.claim(key, ALERT_CLAIM_TTL_SECONDS))) return 'claimed_elsewhere'

  const release = async () => {
    if (deps.claims) await deps.claims.release(key)
  }

  const targets = await deps.resolveSlack()
  if (targets.length === 0) {
    log(`[partner-block] no Slack connection for org ${run.orgId}, so the block on ${sighting.host} was logged but not posted`)
    await release()
    return 'no_slack'
  }

  const standing = standingNow
  const alsoBlocked: string[] = []
  for (const sibling of sighting.siblingHosts ?? []) {
    if (sibling === sighting.host) continue
    if ((await readCondition(deps.kv, partnerBlockKey(sibling))) !== null) alsoBlocked.push(sibling)
  }

  const payload: PartnerBlockAlertPayload = {
    host: sighting.host,
    status: sighting.status,
    vendor: sighting.vendor,
    bodyRayId: sighting.bodyRayId,
    edgeRayId: sighting.edgeRayId,
    markers: sighting.markers,
    seenIn: sighting.seenIn,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    traceId: run.traceId,
    appUrl: deps.appUrl,
    repeat: describeRepeat(standing, nowMs),
    alsoBlocked,
    ownProxy: isOwnProxyHost(sighting.host),
    at: nowMs,
  }

  // Every connection inside the one claim; delivered if any accepted it.
  let ts: string | null = null
  for (const slack of targets) {
    const one = await send(slack, slack.default_channel, payload)
    if (one !== null && ts === null) ts = one
  }
  if (ts === null) {
    log(`[partner-block] Slack post failed for ${sighting.host}; holding further attempts for ${POST_RETRY_HOLD_SECONDS}s`)
    await deps.kv.put(retryHoldKey(sighting.host), '1', { expirationTtl: POST_RETRY_HOLD_SECONDS })
    await release()
    return 'post_failed'
  }

  const next = await recordAlert(deps.kv, key, standing, nowMs, { conditionTtlSeconds: PARTNER_BLOCK_CONDITION_TTL_SECONDS })
  await keepAlerted(deps.kv, PARTNER_REACHABILITY_RECOVERY_PREFIX, sighting.host, next.since)
  return 'posted'
}
