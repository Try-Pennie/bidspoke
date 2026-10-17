'use client'

/**
 * usePartnerPageLive (#2135, PR4 of #2114): the open partners page's live
 * channel. Joins partners:<organization> through the PartnerLiveContext's join,
 * hands each notice to the form, asks for a refetch when the channel becomes
 * Live again or the tab becomes visible. With no context (no provider) it does
 * nothing. The header's seconds are counted by LiveStatusLine itself, so the
 * form is not drawn again every second.
 */
import { useEffect, useRef, useState } from 'react'
import type { PartnerPageNotice } from '@bidspoke/partner-page-live'
import { PartnerLiveChannel, type LiveStatus } from '@/lib/partner-live-channel'
import type { PartnerLiveDeps } from '@/components/partners/live/PartnerLive'

export interface PartnerPageLiveHandlers {
  onNotice: (notice: PartnerPageNotice) => void
  /** The channel came back, or the tab became visible: anything sent meanwhile was missed, so read again. */
  onCatchUp: () => void
  /** A join was refused for a missing partition, once per outage (#2288): report it. */
  onPartitionRefused?: () => void
}

export interface PartnerPageLive {
  status: LiveStatus | null
  retry: () => void
  /** The probe found a change no notice announced: show paused and join afresh. */
  suspect: (reason: string) => void
}

export function usePartnerPageLive(live: PartnerLiveDeps | null, organizationId: string | null, handlers: PartnerPageLiveHandlers): PartnerPageLive {
  const [status, setStatus] = useState<LiveStatus | null>(null)
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const channelRef = useRef<PartnerLiveChannel | null>(null)

  useEffect(() => {
    if (!live || !organizationId) return
    const channel = new PartnerLiveChannel({
      join: live.join,
      clock: live.clock,
      organizationId,
      onStatus: setStatus,
      onNotice: (n) => handlersRef.current.onNotice(n),
      onLive: (reconnected) => { if (reconnected) handlersRef.current.onCatchUp() },
      onPartitionRefused: () => handlersRef.current.onPartitionRefused?.(),
    })
    channelRef.current = channel
    channel.start()
    return () => {
      channel.stop()
      channelRef.current = null
      setStatus(null)
    }
  }, [live, organizationId])

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
    retry: () => channelRef.current?.retry(),
    suspect: (reason) => channelRef.current?.suspect(reason),
  }
}
