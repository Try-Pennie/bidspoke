'use client'

/**
 * usePartnerPageLive (#2135, PR4 of #2114): the open partners page's live
 * channel. Joins partners:<organization> through the PartnerLiveContext's join,
 * hands each notice to the form, asks for a refetch when the channel becomes
 * Live again or the tab becomes visible, and ticks the seconds the header shows
 * while it is not Live. With no context (no provider) it does nothing.
 */
import { useEffect, useRef, useState } from 'react'
import type { PartnerPageNotice } from '@bidspoke/partner-page-live'
import { PartnerLiveChannel, type LiveStatus } from '@/lib/partner-live-channel'
import type { PartnerLiveDeps } from '@/components/partners/live/PartnerLive'

export interface PartnerPageLiveHandlers {
  onNotice: (notice: PartnerPageNotice) => void
  /** The channel came back, or the tab became visible: anything sent meanwhile was missed, so read again. */
  onCatchUp: () => void
}

export interface PartnerPageLive {
  status: LiveStatus | null
  now: number
  retry: () => void
  /** The probe found a change no notice announced: show paused and join afresh. */
  suspect: (reason: string) => void
}

export function usePartnerPageLive(live: PartnerLiveDeps | null, organizationId: string | null, handlers: PartnerPageLiveHandlers): PartnerPageLive {
  const [status, setStatus] = useState<LiveStatus | null>(null)
  const [now, setNow] = useState(() => live?.clock.now() ?? 0)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const channelRef = useRef<PartnerLiveChannel | null>(null)

  useEffect(() => {
    if (!live || !organizationId) return
    const channel = new PartnerLiveChannel({
      join: live.join,
      clock: live.clock,
      organizationId,
      onStatus: (s) => { setStatus(s); setNow(live.clock.now()) },
      onNotice: (n) => handlersRef.current.onNotice(n),
      onLive: (reconnected) => { if (reconnected) handlersRef.current.onCatchUp() },
    })
    channelRef.current = channel
    channel.start()
    return () => {
      channel.stop()
      channelRef.current = null
      setStatus(null)
    }
  }, [live, organizationId])

  // The seconds the header counts while connecting or paused.
  const ticking = status?.kind === 'connecting' || status?.kind === 'reconnecting'
  useEffect(() => {
    if (!ticking || !live) return
    return live.clock.setTimeout(function tick() {
      setNow(live.clock.now())
    }, 1_000)
  }, [ticking, live, now])

  // A tab coming back to the front reads again; a failed channel tries again.
  useEffect(() => {
    if (!live) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (channelRef.current?.current?.kind === 'failed') channelRef.current.retry()
      else handlersRef.current.onCatchUp()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [live])

  return {
    status,
    now,
    retry: () => channelRef.current?.retry(),
    suspect: (reason) => channelRef.current?.suspect(reason),
  }
}
