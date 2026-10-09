/**
 * The scheduled partner reachability probe (#1274).
 *
 * Block detection (#1265) fires only when a real lead calls the partner. Scout gets about
 * seven leads an hour, so a block that lifts produces no event at all and a block that
 * returns is seen tens of minutes late. On 2026-09-10 Achieve lifted its IP block at 16:08
 * UTC, four calls succeeded, the block returned at 16:49, six attempts were refused, and
 * nobody was told any of it. This probe asks every five minutes, so both directions are
 * seen within one interval, and it owns the all-clear on the same `partner-block:<host>`
 * key the lead path reports on.
 *
 * What it does NOT do, each for a recorded reason:
 *
 *  - It sends the identity headers Achieve keys its Skip rule on. A header-less GET from
 *    Cloudflare's shared Workers address is exactly the request their IP block refuses, so
 *    a probe without them would read blocked for ever while leads flow fine (L472).
 *  - It never enters the engine, so executions, sightings and the field presence check
 *    never count it: a canary must not flatter a rate computed over real traffic (L528).
 *    The one shared log line, `event=partner_block_page`, carries `seen_in=probe`.
 *  - It judges every threshold on the CLOCK from the moment a state began, never on a
 *    count of ticks: a delayed scheduler moves a count without moving time, and a retried
 *    cron moves it twice (L386, L600).
 *  - It reads its own positive control first. `block-probe.trypennie.dev` is blocked by a
 *    firewall rule on our own zone and must read blocked every run; a run on which the
 *    control's fetch itself fails holds every other reading as UNMEASURED rather than
 *    paging four partner outages, because a reading that says everything is dead is first
 *    evidence about the measurement (L438, L411).
 *  - It posts only while `PARTNER_PROBE_ALERTS` is exactly `on`; any other value observes,
 *    running the whole state machine and turning every would-be post into a log line. It
 *    shipped observing so the control's first blocked reading could prove the setup before
 *    a page could be false (L56, L142), and #1396 turned it on on 2026-09-21 once it had.
 *
 * Log line to search for: `event=partner_probe`. The control's lines carry `control=true`.
 */
import type { AlertClaims } from './alert-claim'
import { ALERT_CLAIM_TTL_SECONDS } from './volume-cliff'
import { clearCondition, backoffCooldownKey, type BackoffKv } from './alert-backoff'
import { deliverAll, postStanding as postStandingAlert, type SlackTarget, type StandingAlert } from './standing-alert'
import { keepAlerted, markSpikeSeen, recoveryDue, settleRecovery, type RecoveryKv } from './alert-recovery'
import { detectBlockPage, cloudflareErrorCode, type BlockPage } from './html-error-summary'
import { reportPartnerBlock, partnerBlockKey, PARTNER_BLOCK_CONDITION_TTL_SECONDS, PARTNER_REACHABILITY_RECOVERY_PREFIX, PROBE_SEEN_IN } from './partner-block-alert'
import { ACHIEVE_HOSTS, achieveIdentityHeaders } from '../engine/nodes/achieve-identity'
import { BLOCK_CAPTURE_BODY_HEAD_BYTES } from './code-node-deployer'
import { sendPartnerBlockAlert, sendPartnerUnreachableAlert, sendProbeControlAlert, sendProbeBrokenAlert, sendGroupedRecoveryAlert } from './slack'
import { formatErr } from './format-error'

export const CONTROL_HOST = 'block-probe.trypennie.dev'
export const PROBE_USER_AGENT = 'bidspoke-partner-reachability-probe (+https://bidspoke.trypennie.dev)'
export const PROBE_TIMEOUT_MS = 10_000
/** A host silent for this long on the clock is reported as not answering. */
export const UNREACHABLE_ALERT_AFTER_MS = 30 * 60 * 1000
/** The control not reading blocked for this long means the detector is unproven or broken. */
export const CONTROL_ALERT_AFTER_MS = 15 * 60 * 1000
/** The control's own fetch failing for this long means the probe, not a partner, is the problem. */
export const PROBE_BROKEN_AFTER_MS = 10 * 60 * 1000
export const PROBE_CONTROL_KEY = 'partner-probe-control'
export const PARTNER_UNREACHABLE_KEY_PREFIX = 'partner-unreachable'
const RECOVERY_CLAIM_KEY = 'partner-reachability-recovery'
const RECOVERY_PREFIX = PARTNER_REACHABILITY_RECOVERY_PREFIX

export const stateKey = (host: string) => `partner-reachability:state:${host}`
export const unreachableKey = (host: string) => `${PARTNER_UNREACHABLE_KEY_PREFIX}:${host}`

export type ProbeState = 'reachable' | 'blocked' | 'unreachable'

export interface ProbeTarget {
  host: string
  url: string
  headers: Record<string, string>
  expect: ProbeState
  /** The partner's other hosts behind the same firewall. */
  siblings: string[]
  control: boolean
}

type HeaderReader = { get(name: string): string | null } | Record<string, string>

/** What one look at a host came back with, before any judgement. */
export interface ProbeOutcome {
  status: number | null
  body: string
  headers: HeaderReader | null
  /** The fetch itself threw or timed out. */
  error: string | null
  /** A 3xx answer's Location, never followed. */
  redirect: string | null
}

export interface ProbeReading {
  state: ProbeState
  reason: string
  /** A 403 HTML page carrying none of the firewall markers: reachable, but worth a note. */
  html403: boolean
  /** True only when the fetch threw; an edge error page is an answer, not a failed fetch. */
  fetchFailed: boolean
  block: BlockPage | null
  /** What actually came back, for an alert that quotes it. */
  status: number | null
  bodyHead: string
}

export interface ReachabilityDeps {
  kv: BackoffKv & RecoveryKv
  claims: AlertClaims | undefined
  env: Record<string, string | undefined>
  probe: (target: ProbeTarget) => Promise<ProbeOutcome>
  resolveSlack: () => Promise<SlackTarget[]>
  senders: {
    block: typeof sendPartnerBlockAlert
    unreachable: typeof sendPartnerUnreachableAlert
    control: typeof sendProbeControlAlert
    recovery: typeof sendGroupedRecoveryAlert
    probeBroken: typeof sendProbeBrokenAlert
  }
  now: () => number
  log: (line: string) => void
}

export interface ReachabilitySummary {
  probed: number
  reachable: number
  blocked: number
  unreachable: number
  unmeasured: number
  /** What was posted (or, in observe mode, would have been), as `<kind>:<host>`. */
  alerts: string[]
  allClears: string[]
  errors: string[]
  mode: 'alert' | 'observe' | 'silent'
}

/** The four targets. A constant, because the hosts change with the code that calls them. */
export function probeTargets(env: Record<string, string | undefined>): ProbeTarget[] {
  const identity = achieveIdentityHeaders(env)
  const achieve: ProbeTarget[] = ACHIEVE_HOSTS.map((host) => ({
    host,
    url: `https://${host}/`,
    headers: { ...identity, 'User-Agent': PROBE_USER_AGENT },
    expect: 'reachable',
    siblings: ACHIEVE_HOSTS.filter((h) => h !== host),
    control: false,
  }))
  return [
    ...achieve,
    { host: CONTROL_HOST, url: `https://${CONTROL_HOST}/`, headers: { 'User-Agent': PROBE_USER_AGENT }, expect: 'blocked', siblings: [], control: true },
  ]
}

/** Cloudflare's own "your request did not reach the origin" statuses. */
const ORIGIN_ERROR_STATUSES = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526, 530])

/**
 * One classifier, in this order: the fetch failed; Cloudflare says the origin was not
 * reached; the shared block page detector says a firewall refused us; anything else is the
 * application answering, whatever it said. The detector is the lead path's (L35), with one
 * documented difference: a 403 HTML page carrying none of the firewall markers is
 * `reachable` here, because a bare root on an API gateway commonly answers a branded 403
 * page while the real path works, and this probe never asks a data endpoint.
 */
export function classifyProbe(outcome: ProbeOutcome): ProbeReading {
  const none = { html403: false, fetchFailed: false, block: null, status: outcome.status, bodyHead: outcome.body.slice(0, 200) }
  if (outcome.error !== null || outcome.status === null) {
    return { ...none, state: 'unreachable', reason: outcome.error ?? 'no status', fetchFailed: true }
  }
  if (ORIGIN_ERROR_STATUSES.has(outcome.status)) {
    return { ...none, state: 'unreachable', reason: `origin_error:${outcome.status}` }
  }
  const block = detectBlockPage(outcome.status, outcome.body, outcome.headers ?? undefined)
  if (block && block.vendor === 'cloudflare') {
    return { ...none, state: 'blocked', reason: block.markers.join(', '), block }
  }
  const edgeCode = cloudflareErrorCode(outcome.body)
  if (edgeCode !== null && outcome.status >= 400) {
    return { ...none, state: 'unreachable', reason: `cloudflare_error:${edgeCode}` }
  }
  if (outcome.status >= 300 && outcome.status < 400) {
    return { ...none, state: 'reachable', reason: `redirect:${outcome.status}${outcome.redirect ? ` ${outcome.redirect}` : ''}` }
  }
  return { ...none, state: 'reachable', reason: `http:${outcome.status}`, html403: block !== null }
}

/** The production probe: one GET, no redirects, a deadline, and a capped body. */
export async function fetchProbe(target: ProbeTarget, fetchImpl: typeof fetch = fetch): Promise<ProbeOutcome> {
  try {
    const res = await fetchImpl(target.url, {
      method: 'GET',
      headers: target.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    let body = ''
    try {
      body = (await res.text()).slice(0, BLOCK_CAPTURE_BODY_HEAD_BYTES)
    } catch {
      body = ''
    }
    const redirect = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    return { status: res.status, body, headers: res.headers, error: null, redirect }
  } catch (e) {
    return { status: null, body: '', headers: null, error: formatErr(e), redirect: null }
  }
}

interface HostState {
  state: ProbeState
  reason: string
  /** ISO time the current state began. Every threshold is judged from here. */
  since: string
  /** ISO time the control first read blocked, kept for ever (L557). */
  controlPassedAt?: string
}

/**
 * A read that THREW is a storage outage and skips the host this run, its clock untouched. A
 * record that reads but cannot be used is permanent, so it is replaced rather than skipped:
 * skipping left the probe blind to that host on every later run while its heartbeat said it
 * was running (#1933).
 */
type StateRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; error: string }
  /** `controlPassedAt` is kept when it alone still reads as a time: it is recorded once and never re-derived (L557). */
  | { kind: 'malformed'; error: string; controlPassedAt?: string }
  | { kind: 'present'; state: HostState }

const PROBE_STATES: readonly ProbeState[] = ['reachable', 'blocked', 'unreachable']
const isTime = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))

async function readState(kv: RecoveryKv, host: string): Promise<StateRead> {
  let raw: string | null
  try {
    raw = await kv.get(stateKey(host))
  } catch (e) {
    return { kind: 'unreadable', error: formatErr(e) }
  }
  if (raw === null) return { kind: 'absent' }
  try {
    const parsed = JSON.parse(raw) as Partial<HostState>
    const valid = PROBE_STATES.includes(parsed.state as ProbeState) && typeof parsed.reason === 'string' && isTime(parsed.since) &&
      (parsed.controlPassedAt === undefined || isTime(parsed.controlPassedAt))
    if (!valid) {
      return { kind: 'malformed', error: 'the state record is not one this probe wrote', ...(isTime(parsed.controlPassedAt) ? { controlPassedAt: parsed.controlPassedAt } : {}) }
    }
    return { kind: 'present', state: parsed as HostState }
  } catch (e) {
    return { kind: 'malformed', error: formatErr(e) }
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

export async function runPartnerReachabilityCheck(deps: ReachabilityDeps): Promise<ReachabilitySummary> {
  const nowMs = deps.now()
  const mode: ReachabilitySummary['mode'] = deps.env.LOCAL_DEV ? 'silent' : deps.env.PARTNER_PROBE_ALERTS === 'on' ? 'alert' : 'observe'
  const summary: ReachabilitySummary = { probed: 0, reachable: 0, blocked: 0, unreachable: 0, unmeasured: 0, alerts: [], allClears: [], errors: [], mode }
  const targets = probeTargets(deps.env)

  // Every host looked at, one failure never skipping another.
  const looks = await Promise.allSettled(targets.map(async (t) => ({ target: t, reading: classifyProbe(await deps.probe(t)), outcome: undefined as ProbeOutcome | undefined })))
  const readings: Array<{ target: ProbeTarget; reading: ProbeReading; outcome: ProbeOutcome | null }> = []
  for (let i = 0; i < looks.length; i++) {
    const look = looks[i]
    if (look.status === 'fulfilled') {
      readings.push({ target: look.value.target, reading: look.value.reading, outcome: null })
    } else {
      summary.errors.push(`${targets[i].host}: probe threw: ${formatErr(look.reason)}`)
      deps.log(`[partner-reachability] event=partner_probe host=${targets[i].host} state=error reason=${JSON.stringify(formatErr(look.reason))}`)
    }
  }
  summary.probed = readings.length

  // The control comes first: whether the rest can be trusted depends on it.
  const control = readings.find((r) => r.target.control)
  const probeCannotFetch = control !== undefined && control.reading.fetchFailed

  if (mode === 'silent') {
    for (const { target, reading } of readings) {
      deps.log(`[partner-reachability] event=partner_probe host=${target.host} state=${reading.state} reason=${JSON.stringify(reading.reason)}${target.control ? ' control=true expect=blocked' : ''} silent=true`)
      summary[reading.state] += 1
    }
    return summary
  }

  const senders = mode === 'alert' ? deps.senders : observeSenders(deps.log)
  let targetsSlack: SlackTarget[] = []
  try {
    targetsSlack = await deps.resolveSlack()
  } catch (e) {
    summary.errors.push(`Slack destinations could not be resolved: ${formatErr(e)}`)
    deps.log(`[partner-reachability] Slack destinations could not be resolved: ${formatErr(e)}`)
  }
  const claim = async (key: string): Promise<boolean> => (deps.claims ? deps.claims.claim(key, ALERT_CLAIM_TTL_SECONDS) : true)
  const release = async (key: string): Promise<void> => { if (deps.claims) await deps.claims.release(key) }

  const dueForAllClear: Array<{ host: string; alertedAt: string; endedAt: string | null }> = []

  for (const { target, reading } of readings) {
    const host = target.host
    const prior = await readState(deps.kv, host)
    if (prior.kind === 'unreadable') {
      summary.errors.push(`${host}: state unreadable: ${prior.error}`)
      deps.log(`[partner-reachability] event=partner_probe host=${host} state=unreadable reason=${JSON.stringify(prior.error)}`)
      continue
    }
    // Replaced by the write below once this host is judged; a run that holds it unmeasured
    // writes nothing, so this says only that the record is malformed.
    if (prior.kind === 'malformed') {
      summary.errors.push(`${host}: state malformed, a fresh record is written once this host is judged: ${prior.error}`)
      deps.log(`[partner-reachability] event=partner_probe host=${host} state_malformed=true reason=${JSON.stringify(prior.error)}`)
    }

    // A silent control means the probe cannot fetch. Hold every non-blocked reading of a
    // real host: its state does not advance, and nothing is concluded from it.
    if (probeCannotFetch && !target.control && reading.state !== 'blocked') {
      summary.unmeasured += 1
      deps.log(`[partner-reachability] event=partner_probe host=${host} state=unmeasured probe_unmeasured=true reason=${JSON.stringify(reading.reason)}`)
      continue
    }

    summary[reading.state] += 1
    const previous = prior.kind === 'present' ? prior.state : null
    const keptControlPass = previous?.controlPassedAt ?? (prior.kind === 'malformed' ? prior.controlPassedAt : undefined)
    const changed = previous === null || previous.state !== reading.state
    const state: HostState = changed
      ? { state: reading.state, reason: reading.reason, since: iso(nowMs), ...(keptControlPass ? { controlPassedAt: keptControlPass } : {}) }
      : { ...previous, reason: reading.reason }
    let dirty = changed
    const heldForMs = nowMs - Date.parse(state.since)

    deps.log(
      `[partner-reachability] event=partner_probe host=${host} state=${reading.state} reason=${JSON.stringify(reading.reason)} since=${state.since} for=${Math.round(heldForMs / 1000)}s` +
        (target.control ? ' control=true expect=blocked' : '') + (reading.html403 ? ' html_403=true' : ''),
    )

    if (target.control) {
      if (reading.state === 'blocked') {
        if (!state.controlPassedAt) { state.controlPassedAt = iso(nowMs); dirty = true }
        const due = await recoveryDue(deps.kv, RECOVERY_PREFIX, host, { now: nowMs })
        if (due) {
          if (await claim(RECOVERY_CLAIM_KEY)) {
            const delivered = await deliverAll(targetsSlack, (s) => senders.recovery(s, s.default_channel, {
              signal: 'probe control',
              recoveredPhrase: 'reading the block page again',
              items: [{ subject: host, alertedAt: due.alertedAt, endedAt: due.endedAt }],
            }, nowMs))
            if (delivered) {
              await settleRecovery(deps.kv, RECOVERY_PREFIX, host, backoffCooldownKey(PROBE_CONTROL_KEY))
              await clearCondition(deps.kv, PROBE_CONTROL_KEY)
              summary.allClears.push(host)
            } else await release(RECOVERY_CLAIM_KEY)
          }
        }
      } else if (reading.fetchFailed) {
        // The probe itself cannot fetch: one line about the probe, under the control key.
        await markSpikeSeen(deps.kv, RECOVERY_PREFIX, host, nowMs)
        if (heldForMs >= PROBE_BROKEN_AFTER_MS) {
          await postStanding(deps, PROBE_CONTROL_KEY, claim, release, targetsSlack, nowMs, { problem: 'probe-broken', details: [reading.reason] }, (s, repeat) =>
            senders.probeBroken(s, s.default_channel, { reason: reading.reason, since: state.since, repeat, at: nowMs }))
            .then((posted) => { if (posted) summary.alerts.push(`probe-broken:${host}`) })
          await keepAlerted(deps.kv, RECOVERY_PREFIX, host, state.since)
        }
      } else {
        await markSpikeSeen(deps.kv, RECOVERY_PREFIX, host, nowMs)
        if (heldForMs >= CONTROL_ALERT_AFTER_MS) {
          const control = { problem: 'control-failing' as const, details: [String(state.controlPassedAt !== undefined), String(reading.status), reading.bodyHead] }
          await postStanding(deps, PROBE_CONTROL_KEY, claim, release, targetsSlack, nowMs, control, (s, repeat) =>
            senders.control(s, s.default_channel, {
              host, everPassed: state.controlPassedAt !== undefined, status: reading.status, bodyHead: reading.bodyHead, since: state.since, repeat, at: nowMs,
            }))
            .then((posted) => { if (posted) summary.alerts.push(`control:${host}`) })
          await keepAlerted(deps.kv, RECOVERY_PREFIX, host, state.since)
        }
      }
    } else if (reading.state === 'blocked') {
      // The shared reporter: same key as the lead path, its cooldown and claim decide
      // whether anything posts, and it arms the all-clear for either observer.
      const block = reading.block!
      const full = { host, status: block.status, vendor: block.vendor, bodyRayId: block.bodyRayId, edgeRayId: block.edgeRayId, markers: block.markers, seenIn: PROBE_SEEN_IN, ...(target.siblings.length ? { siblingHosts: target.siblings } : {}) }
      const outcome = await reportPartnerBlock(
        { kv: deps.kv, claims: deps.claims, resolveSlack: () => Promise.resolve(targetsSlack), send: senders.block, now: deps.now, log: deps.log, silent: false, appUrl: deps.env.APP_URL ?? '' },
        { orgId: PROBE_SEEN_IN },
        full,
      )
      await keepAlerted(deps.kv, RECOVERY_PREFIX, host, state.since)
      if (outcome === 'posted') summary.alerts.push(`block:${host}`)
    } else if (reading.state === 'unreachable') {
      await markSpikeSeen(deps.kv, RECOVERY_PREFIX, host, nowMs)
      if (heldForMs >= UNREACHABLE_ALERT_AFTER_MS) {
        await postStanding(deps, unreachableKey(host), claim, release, targetsSlack, nowMs, { problem: 'unreachable', details: [reading.reason] }, (s, repeat) =>
          senders.unreachable(s, s.default_channel, { host, reason: reading.reason, since: state.since, repeat, at: nowMs }))
          .then((posted) => { if (posted) summary.alerts.push(`unreachable:${host}`) })
        await keepAlerted(deps.kv, RECOVERY_PREFIX, host, state.since)
      }
    } else {
      const due = await recoveryDue(deps.kv, RECOVERY_PREFIX, host, { now: nowMs })
      if (due) dueForAllClear.push({ host, alertedAt: due.alertedAt, endedAt: due.endedAt })
    }

    if (dirty) {
      try {
        await deps.kv.put(stateKey(host), JSON.stringify(state))
      } catch (e) {
        summary.errors.push(`${host}: state write failed: ${formatErr(e)}`)
      }
    }
  }

  // One all-clear for every host that recovered on this tick, settled all or none.
  if (dueForAllClear.length > 0) {
    if (await claim(RECOVERY_CLAIM_KEY)) {
      const delivered = await deliverAll(targetsSlack, (s) => senders.recovery(s, s.default_channel, {
        signal: 'partner reachability',
        recoveredPhrase: 'answering a GET without a Cloudflare block page for 30 minutes, with no lead sighting one in that time',
        items: dueForAllClear.map((d) => ({ subject: d.host, alertedAt: d.alertedAt, endedAt: d.endedAt })),
      }, nowMs))
      if (delivered) {
        for (const d of dueForAllClear) {
          await settleRecovery(deps.kv, RECOVERY_PREFIX, d.host, backoffCooldownKey(partnerBlockKey(d.host)))
          await clearCondition(deps.kv, partnerBlockKey(d.host))
          await clearCondition(deps.kv, unreachableKey(d.host))
          summary.allClears.push(d.host)
        }
      } else {
        await release(RECOVERY_CLAIM_KEY)
        summary.errors.push(`all-clear for ${dueForAllClear.map((d) => d.host).join(', ')} was not delivered`)
      }
    }
  }

  return summary
}

/** The shared standing post (lib/standing-alert.ts), with this probe's TTL and log prefix. */
function postStanding(
  deps: ReachabilityDeps,
  key: string,
  claim: (key: string) => Promise<boolean>,
  release: (key: string) => Promise<void>,
  targets: SlackTarget[],
  nowMs: number,
  alert: StandingAlert,
  send: (s: SlackTarget, repeat: string | null) => Promise<string | null>,
): Promise<boolean> {
  return postStandingAlert({
    kv: deps.kv, key, claim, release, targets, nowMs, alert, send,
    conditionTtlSeconds: PARTNER_BLOCK_CONDITION_TTL_SECONDS, logPrefix: '[partner-reachability]', log: deps.log,
  })
}

/** Observe mode: every send becomes a log line and reports success, so the state machine runs exactly as it will live. */
function observeSenders(log: (line: string) => void): ReachabilityDeps['senders'] {
  const would = (kind: string, subject: string) => { log(`[partner-reachability] would_post=${kind} subject=${subject} mode=observe`) }
  return {
    block: (_s, _c, p) => { would('block', p.host); return Promise.resolve('observed') },
    unreachable: (_s, _c, p) => { would('unreachable', p.host); return Promise.resolve('observed') },
    control: (_s, _c, p) => { would('control', p.host); return Promise.resolve('observed') },
    probeBroken: () => { would('probe-broken', CONTROL_HOST); return Promise.resolve('observed') },
    recovery: (_s, _c, p) => { would('recovery', p.items.map((i) => i.subject).join(',')); return Promise.resolve(true) },
  }
}

/** The senders the cron wires in production. */
export const liveSenders: ReachabilityDeps['senders'] = {
  block: sendPartnerBlockAlert,
  unreachable: sendPartnerUnreachableAlert,
  control: sendProbeControlAlert,
  recovery: sendGroupedRecoveryAlert,
  probeBroken: sendProbeBrokenAlert,
}
