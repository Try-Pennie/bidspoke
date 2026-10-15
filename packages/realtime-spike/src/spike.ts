/**
 * The PR0 spike itself (#2131): can the database send a Supabase broadcast on a
 * private partners:<org> topic that only that organization's people receive?
 *
 * Every remote effect is a dependency, so the order (ledger before create), the
 * controls and the verdict are tested against doubles; src/live.ts supplies the
 * real ones. What the run does, in order:
 *
 *   1. Org A is the hidden e2e user's organization. Org B, its allowlist row and
 *      its one user are created under the marker, each written to the ledger
 *      first. Org B gets no partners, buyer profiles or workflows.
 *   2. The day's realtime.messages partition is read before anything connects.
 *      Then four joins: A and B each to partners:<A> and partners:<B>. A on A
 *      and B on B must be admitted, B on A and A on B refused (the live two
 *      organization negative control, L714, both directions, L497).
 *   3. The partition is read again and waited for if absent, because the
 *      platform makes it when a tenant connects, a send into a missing day is
 *      swallowed into a WARNING, and a private join into a missing day is
 *      refused (production's newest day was 2026-10-02 when read on 2026-10-15).
 *      Joins refused for that reason are made again once it exists.
 *   4. N sends from SQL (realtime.send as service_role), each timed from the
 *      start of the send to A's receipt, with the partition checked at each send
 *      and every WARNING captured as raised.
 *   5. The fallback, the same way: N Worker REST broadcasts to the same topic.
 *      This is also the control that proves the receive side, the policy and
 *      setAuth when the database sender fails (L248).
 *   6. A subscriber running in workerd (decision 2) joins and receives.
 *   7. Org B is checked empty in the tables jobs read across every organization.
 */
import type { LedgerHandle } from './ledger.ts'
import { emailForMarker, orgSlugForEmail } from './ledger.ts'
import { summarize, type LatencySummary } from './stats.ts'

export type JoinStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED' | 'UNREACHABLE'

export interface Received {
  event: string
  payload: Record<string, unknown>
  at: number
}

export interface Subscription {
  status: JoinStatus
  detail: string | null
  received: Received[]
  close(): Promise<void>
}

export interface OrgRowCounts {
  partner_configs: number
  buyer_profiles: number
  workflows: number
}

export interface SpikeDeps {
  marker: string
  orgA: { email: string; password: string }
  now(): number
  sleep(ms: number): Promise<void>
  log(line: string): void
  ledger: LedgerHandle
  newId(): string
  newPassword(): string
  signIn(email: string, password: string): Promise<{ jwt: string; userId: string }>
  orgOfUser(userId: string): Promise<string | null>
  createAllowlist(email: string): Promise<void>
  createOrganization(org: { id: string; name: string; slug: string }): Promise<void>
  createAuthUser(email: string, password: string): Promise<string>
  countOrgRows(orgId: string): Promise<OrgRowCounts>
  partitionExists(): Promise<boolean>
  dbSend(topic: string, event: string, payload: Record<string, unknown>): Promise<{ warnings: string[] }>
  restSend(topic: string, event: string, payload: Record<string, unknown>): Promise<{ status: number; body: string }>
  subscribe(label: string, jwt: string, topic: string): Promise<Subscription>
  workerSubscribe(
    jwt: string,
    topic: string,
    whenReady: () => Promise<void>,
  ): Promise<{ status: JoinStatus; detail: string | null; receivedAfterMs: number | null }>
  /** Sends this process SIGINT, for the deliberate interrupt run; never resolves normally. */
  interrupt(): Promise<never>
}

export interface SpikeOptions {
  samples: number
  receiveTimeoutMs: number
  partitionWaitMs: number
  partitionPollMs: number
  gapMs: number
  selfInterrupt: boolean
}

export const DEFAULT_OPTIONS: Omit<SpikeOptions, 'samples' | 'selfInterrupt'> = {
  receiveTimeoutMs: 10_000,
  partitionWaitMs: 180_000,
  partitionPollMs: 5_000,
  gapMs: 250,
}

export type FailingStep = 'policy' | 'partition' | 'send' | 'subscribe' | 'delivery'

export interface SpikeResult {
  marker: string
  orgA: string
  orgB: string
  joins: Record<'aOnA' | 'bOnA' | 'bOnB' | 'aOnB', { status: JoinStatus; detail: string | null }>
  boundaryHeld: boolean
  partition: { beforeConnect: boolean; afterFirstJoin: boolean; appearedAfterMs: number | null }
  joinAttempts: number
  dbSender: {
    verdict: 'proved' | 'not_proved'
    failingStep: FailingStep | null
    warnings: string[]
    /** Errors a send threw, as opposed to the WARNINGs realtime.send raises and swallows. */
    sendErrors: string[]
    partitionAtEachSend: boolean[]
    latency: LatencySummary
    crossTopicLeak: boolean
    /** Whether B received the one message sent on its own topic; null when it was not sent. */
    bReceivedOwnTopic: boolean | null
  }
  restSender: { statuses: number[]; latency: LatencySummary }
  workerSubscriber: { status: JoinStatus; detail: string | null; sender: 'database' | 'rest'; receivedAfterMs: number | null }
  orgBEmpty: boolean
  orgBRows: OrgRowCounts | null
  problems: string[]
}

const UNAUTHORIZED = /unauthori[sz]ed|permission/i
const MISSING_PARTITION = /MissingPartition/i

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : JSON.stringify(err)
}

async function waitFor(deps: SpikeDeps, timeoutMs: number, done: () => boolean): Promise<boolean> {
  const deadline = deps.now() + timeoutMs
  while (!done()) {
    if (deps.now() >= deadline) return false
    await deps.sleep(10)
  }
  return true
}

function seqOf(r: Received): unknown {
  return r.payload.seq
}

export async function runSpike(deps: SpikeDeps, options: SpikeOptions): Promise<SpikeResult> {
  const problems: string[] = []
  const { marker, ledger } = deps
  const log = (line: string) => deps.log(line)

  // 1. Org A, then Org B under the marker, each entry on disk before its create.
  const a = await deps.signIn(deps.orgA.email, deps.orgA.password)
  const orgA = await deps.orgOfUser(a.userId)
  if (!orgA) throw new Error(`setup: ${deps.orgA.email} has no users row, so Org A is unknown`)
  log(`Org A: ${orgA}`)

  const email = emailForMarker(marker)
  const slug = orgSlugForEmail(email)
  const orgB = deps.newId()
  const password = deps.newPassword()

  ledger.plan('allowlist', email, null)
  await deps.createAllowlist(email)
  ledger.created('allowlist', email, null)

  ledger.plan('organization', slug, orgB)
  await deps.createOrganization({ id: orgB, name: marker, slug })
  ledger.created('organization', slug, orgB)

  ledger.plan('auth_user', email, null)
  const userB = await deps.createAuthUser(email, password)
  ledger.created('auth_user', email, userB)

  ledger.plan('public_user', email, userB)
  const filedUnder = await deps.orgOfUser(userB)
  if (filedUnder !== orgB) {
    throw new Error(`setup: the signup trigger filed ${email} under ${filedUnder ?? 'no organization'}, not Org B ${orgB}`)
  }
  ledger.created('public_user', email, userB)
  log(`Org B: ${orgB} (${slug}), user ${userB}`)

  if (options.selfInterrupt) {
    log('self interrupt: sending SIGINT now that Org B exists, to exercise the interrupt cleanup')
    await deps.interrupt()
  }

  const b = await deps.signIn(email, password)
  const topicA = `partners:${orgA}`
  const topicB = `partners:${orgB}`

  // 2 and 3. The day's partition, read before anything connects, then the joins.
  // Realtime authorizes a private join by writing a row into realtime.messages,
  // so with no partition for today the join itself is refused (MissingPartition,
  // measured on a local stack 2026-10-15). A connecting tenant is what makes the
  // platform create its partitions, so a refusal for that reason is waited out
  // and the joins made again, never concluded from (#2131 item 4).
  const beforeConnect = await deps.partitionExists()
  const joinAll = async () => ({
    aOnA: await deps.subscribe('A on partners:<A>', a.jwt, topicA),
    bOnA: await deps.subscribe('B on partners:<A>', b.jwt, topicA),
    bOnB: await deps.subscribe('B on partners:<B>', b.jwt, topicB),
    aOnB: await deps.subscribe('A on partners:<B>', a.jwt, topicB),
  })
  let subs = await joinAll()
  let joinAttempts = 1

  const started = deps.now()
  const afterFirstJoin = await deps.partitionExists()
  let present = afterFirstJoin
  while (!present && deps.now() - started < options.partitionWaitMs) {
    await deps.sleep(options.partitionPollMs)
    present = await deps.partitionExists()
  }
  const partition = {
    beforeConnect,
    afterFirstJoin,
    appearedAfterMs: present ? (afterFirstJoin ? 0 : deps.now() - started) : null,
  }
  log(
    `partition for today: ${
      beforeConnect
        ? 'present before any connection'
        : afterFirstJoin
          ? 'absent before connecting, present after the first joins'
          : present
            ? `appeared ${partition.appearedAfterMs} ms after the first joins`
            : 'never appeared'
    }`,
  )

  if (present && Object.values(subs).some((s) => MISSING_PARTITION.test(s.detail ?? ''))) {
    log('joins were refused for a missing partition that now exists: joining again')
    for (const s of Object.values(subs)) await s.close()
    subs = await joinAll()
    joinAttempts = 2
  }

  const joins = Object.fromEntries(
    Object.entries(subs).map(([k, s]) => [k, { status: s.status, detail: s.detail }]),
  ) as SpikeResult['joins']
  if (subs.bOnA.status === 'SUBSCRIBED') problems.push(`TENANT BOUNDARY BROKEN: B was admitted to ${topicA}`)
  if (subs.aOnB.status === 'SUBSCRIBED') problems.push(`TENANT BOUNDARY BROKEN: A was admitted to ${topicB}`)
  if (subs.bOnB.status !== 'SUBSCRIBED') problems.push(`B was not admitted to its own topic (${subs.bOnB.status}: ${subs.bOnB.detail ?? ''}), so B's refusal on A proves nothing about the policy`)
  const boundaryHeld = subs.bOnA.status !== 'SUBSCRIBED' && subs.aOnB.status !== 'SUBSCRIBED'

  // 4. The database sender. With no partition, one send is made anyway, whether
  // or not A could join, to capture the WARNING it raises word for word.
  const warnings: string[] = []
  const sendErrors: string[] = []
  const partitionAtEachSend: boolean[] = []
  const dbLatencies: Array<number | null> = []
  const aJoined = subs.aOnA.status === 'SUBSCRIBED'
  if (aJoined || !present) {
    const attempts = present ? options.samples : 1
    for (let seq = 1; seq <= attempts; seq++) {
      partitionAtEachSend.push(await deps.partitionExists())
      const t0 = deps.now()
      // A send that throws (a role or statement failure) is the send step
      // failing, recorded with its error, and the run goes on to the controls.
      try {
        const sent = await deps.dbSend(topicA, 'spike-db', { marker, seq })
        warnings.push(...sent.warnings)
      } catch (err) {
        sendErrors.push(errorText(err))
      }
      const arrived =
        aJoined &&
        (await waitFor(deps, options.receiveTimeoutMs, () =>
          subs.aOnA.received.some((r) => r.event === 'spike-db' && seqOf(r) === seq),
        ))
      const hit = subs.aOnA.received.find((r) => r.event === 'spike-db' && seqOf(r) === seq)
      dbLatencies.push(arrived && hit ? hit.at - t0 : null)
      await deps.sleep(options.gapMs)
    }
  }
  // One send on B's topic: B (admitted to B) must receive it, A (on A) must not.
  // B's receipt is recorded, because A not receiving a message nobody received
  // proves nothing about the boundary.
  let crossTopicLeak = false
  let bReceivedOwnTopic: boolean | null = null
  if (present && aJoined && sendErrors.length === 0) {
    try {
      await deps.dbSend(topicB, 'spike-db-b', { marker, seq: 'b' })
    } catch (err) {
      sendErrors.push(errorText(err))
    }
    bReceivedOwnTopic = await waitFor(deps, options.receiveTimeoutMs, () => subs.bOnB.received.some((r) => r.event === 'spike-db-b'))
    crossTopicLeak = subs.aOnA.received.some((r) => r.event === 'spike-db-b') || subs.bOnA.received.length > 0
    if (crossTopicLeak) problems.push('TENANT BOUNDARY BROKEN: a message reached a subscriber of another topic')
    if (!bReceivedOwnTopic) problems.push(`B did not receive the message sent on its own ${topicB}, so A not receiving it proves nothing about the boundary`)
  }

  const dbLatency = summarize(dbLatencies)
  let failingStep: FailingStep | null = null
  if (!present || partitionAtEachSend.includes(false) || MISSING_PARTITION.test(subs.aOnA.detail ?? '')) failingStep = 'partition'
  else if (!aJoined) failingStep = UNAUTHORIZED.test(subs.aOnA.detail ?? '') ? 'policy' : 'subscribe'
  else if (warnings.length > 0 || sendErrors.length > 0) failingStep = 'send'
  else if (dbLatency.lost > 0) failingStep = 'delivery'
  const dbSender: SpikeResult['dbSender'] = {
    verdict: failingStep === null ? 'proved' : 'not_proved',
    failingStep,
    warnings,
    sendErrors,
    partitionAtEachSend,
    latency: dbLatency,
    crossTopicLeak,
    bReceivedOwnTopic,
  }
  log(`database sender: ${dbSender.verdict}${failingStep ? ` (failing step: ${failingStep})` : ''}`)

  // 5. The Worker REST sender, to the same subscriber on the same private topic.
  const statuses: number[] = []
  const restLatencies: Array<number | null> = []
  for (let seq = 1; seq <= options.samples; seq++) {
    const t0 = deps.now()
    let sent: { status: number; body: string }
    try {
      sent = await deps.restSend(topicA, 'spike-rest', { marker, seq })
    } catch (err) {
      sent = { status: 0, body: errorText(err) }
    }
    statuses.push(sent.status)
    if (sent.status < 200 || sent.status >= 300) problems.push(`REST broadcast ${seq} answered ${sent.status}: ${sent.body.slice(0, 200)}`)
    const arrived = await waitFor(deps, options.receiveTimeoutMs, () =>
      subs.aOnA.received.some((r) => r.event === 'spike-rest' && seqOf(r) === seq),
    )
    const hit = subs.aOnA.received.find((r) => r.event === 'spike-rest' && seqOf(r) === seq)
    restLatencies.push(arrived && hit ? hit.at - t0 : null)
    await deps.sleep(options.gapMs)
  }
  const restSender = { statuses, latency: summarize(restLatencies) }

  // 6. A subscriber in workerd, sent to by whichever sender was proved.
  const sender: 'database' | 'rest' = dbSender.verdict === 'proved' ? 'database' : 'rest'
  const worker = await deps.workerSubscribe(a.jwt, topicA, async () => {
    if (sender === 'database') await deps.dbSend(topicA, 'spike-worker', { marker, seq: 'worker' })
    else await deps.restSend(topicA, 'spike-worker', { marker, seq: 'worker' })
  })
  const workerSubscriber = { ...worker, sender }

  for (const s of Object.values(subs)) await s.close()

  // 7. Org B must hold nothing a cross organization job could pick up (L261).
  let orgBRows: OrgRowCounts | null = null
  let orgBEmpty = false
  try {
    orgBRows = await deps.countOrgRows(orgB)
    const held = Object.entries(orgBRows).filter(([, n]) => n > 0)
    orgBEmpty = held.length === 0
    if (!orgBEmpty) problems.push(`Org B holds rows a cross organization job reads: ${held.map(([t, n]) => `${t} ${n}`).join(', ')}`)
  } catch (err) {
    problems.push(`could not check that Org B is empty: ${err instanceof Error ? err.message : JSON.stringify(err)}`)
  }

  return {
    marker,
    orgA,
    orgB,
    joins,
    boundaryHeld,
    partition,
    joinAttempts,
    dbSender,
    restSender,
    workerSubscriber,
    orgBEmpty,
    orgBRows,
    problems,
  }
}
