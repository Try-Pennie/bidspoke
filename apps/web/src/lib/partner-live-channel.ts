/**
 * The partners page live channel's connection (#2135, PR4 of #2114): joins the
 * private topic partners:<organization> and hands on each notice another
 * person's save sends, and keeps the three states the header shows apart (the
 * time taking action rule): Live; paused while it reconnects, from the moment
 * it dropped; failed, with Retry.
 *
 * Pure, so its timing is tested on an injected clock (L524): the browser's
 * Supabase join is passed in (partner-live-join.ts).
 *
 * Two facts from the live run (ADR 0012) are built in. A day can start with no
 * realtime.messages partition, and Realtime then refuses every private join as
 * MissingPartition until it exists, so such a refusal is retried soon and
 * counted rather than treated as routine (L77). And Realtime can answer a join
 * SUBSCRIBED a moment before it streams after an idle shutdown, so a notice can
 * be lost while the header says Live: the page's versions probe is the backstop
 * for that, not this class.
 */
import { parsePartnerPageNotice, partnerPageTopic, type PartnerPageNotice } from '@bidspoke/partner-page-live'

export type LiveStatus =
  | { kind: 'connecting'; since: number }
  | { kind: 'live'; since: number }
  | { kind: 'reconnecting'; since: number; reason: string }
  | { kind: 'failed'; reason: string }

export type JoinAnswer =
  | { ok: true; leave: () => Promise<void> }
  | { ok: false; reason: string; missingPartition: boolean }

/**
 * Join a private topic as the signed in person. `onPayload` is called with each
 * broadcast's payload; `onDrop` once, when a join that was admitted stops being
 * subscribed. Never throws: a failure is a refused answer.
 */
export type JoinFn = (topic: string, onPayload: (payload: unknown) => void, onDrop: (reason: string) => void) => Promise<JoinAnswer>

export interface LiveClock {
  now(): number
  /** Run fn after ms; the answer cancels it. */
  setTimeout(fn: () => void, ms: number): () => void
}

/** The waits between joins that were refused or dropped, the last repeated. */
export const REJOIN_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000] as const
/** The wait after a MissingPartition refusal: the live run saw the partition appear at the refused join itself. */
export const MISSING_PARTITION_RETRY_MS = 1_000
/** How long the channel may be not Live before the header says failed and joining stops until Retry. */
export const FAIL_AFTER_MS = 120_000

export interface LiveChannelOptions {
  join: JoinFn
  clock: LiveClock
  organizationId: string
  onStatus: (status: LiveStatus) => void
  onNotice: (notice: PartnerPageNotice) => void
  /** The channel became Live; reconnected is false only for the first join. The page refetches then, since anything sent while it was not Live was missed. */
  onLive: (reconnected: boolean) => void
}

export class PartnerLiveChannel {
  /** Joins refused because the day's partition did not exist yet (ADR 0012), counted (L77). */
  missingPartitionRefusals = 0
  /** Joins refused for any other reason. */
  otherRefusals = 0
  /** Payloads that were not a notice this page can read: counted, never guessed at. */
  unreadableNotices = 0

  private status: LiveStatus | null = null
  private stopped = false
  private leave: (() => Promise<void>) | null = null
  private cancelTimer: (() => void) | null = null
  /** Each join gets a number; an answer, notice or drop from an older one is ignored. */
  private generation = 0
  private failedAttempts = 0
  private outageSince = 0
  private lastReason = ''
  private everLive = false

  constructor(private readonly opts: LiveChannelOptions) {}

  get current(): LiveStatus | null {
    return this.status
  }

  start(): void {
    this.stopped = false
    this.outageSince = this.opts.clock.now()
    this.failedAttempts = 0
    this.setStatus({ kind: 'connecting', since: this.outageSince })
    void this.join()
  }

  /** Join again after the header said failed. */
  retry(): void {
    if (this.stopped || this.status?.kind !== 'failed') return
    this.start()
  }

  /**
   * The page has reason to think a Live channel is not delivering (its probe
   * found a change no notice announced): show paused and join afresh.
   */
  suspect(reason: string): void {
    if (this.status?.kind !== 'live') return
    this.dropped(reason)
  }

  stop(): void {
    this.stopped = true
    this.generation++
    this.cancelTimer?.()
    this.cancelTimer = null
    this.leaveCurrent()
  }

  private setStatus(status: LiveStatus): void {
    this.status = status
    this.opts.onStatus(status)
  }

  private leaveCurrent(): void {
    const leave = this.leave
    this.leave = null
    if (leave) void leave().catch(() => undefined)
  }

  private async join(): Promise<void> {
    const gen = ++this.generation
    const topic = partnerPageTopic(this.opts.organizationId)
    const answer = await this.opts.join(
      topic,
      (payload) => {
        if (gen !== this.generation) return
        const notice = parsePartnerPageNotice(payload)
        if (notice) this.opts.onNotice(notice)
        else this.unreadableNotices++
      },
      (reason) => {
        if (gen === this.generation && this.status?.kind === 'live') this.dropped(reason)
      },
    )
    if (this.stopped || gen !== this.generation) {
      if (answer.ok) void answer.leave().catch(() => undefined)
      return
    }
    if (answer.ok) {
      this.leave = answer.leave
      this.failedAttempts = 0
      const reconnected = this.everLive
      this.everLive = true
      this.setStatus({ kind: 'live', since: this.opts.clock.now() })
      this.opts.onLive(reconnected)
      return
    }
    if (answer.missingPartition) this.missingPartitionRefusals++
    else this.otherRefusals++
    const wait = answer.missingPartition
      ? MISSING_PARTITION_RETRY_MS
      : REJOIN_DELAYS_MS[Math.min(this.failedAttempts++, REJOIN_DELAYS_MS.length - 1)]
    this.retryAfter(wait, answer.reason)
  }

  private dropped(reason: string): void {
    this.generation++
    this.leaveCurrent()
    this.outageSince = this.opts.clock.now()
    this.failedAttempts = 0
    this.setStatus({ kind: 'reconnecting', since: this.outageSince, reason })
    this.retryAfter(REJOIN_DELAYS_MS[0], reason)
  }

  private retryAfter(ms: number, reason: string): void {
    this.lastReason = reason
    if (this.opts.clock.now() - this.outageSince >= FAIL_AFTER_MS) {
      const partitions = this.missingPartitionRefusals > 0 ? ` (${this.missingPartitionRefusals} joins refused for a missing partition)` : ''
      this.setStatus({ kind: 'failed', reason: `${this.lastReason}${partitions}` })
      return
    }
    this.cancelTimer?.()
    this.cancelTimer = this.opts.clock.setTimeout(() => {
      this.cancelTimer = null
      if (!this.stopped) void this.join()
    }, ms)
  }
}
