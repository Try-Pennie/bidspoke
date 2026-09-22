/**
 * makeBidLogger (#1411): the lead_sighting_bids writer the Partner Bid node
 * carried as a closure, extracted so the buyer_select node's live attempts
 * write their row through the same code (L613).
 *
 * The behaviour is the closure's, exactly. A run with no sighting id writes
 * nothing. The fixed fields come from the context and the resolver type from
 * the partner; the caller's fields win. The write is registered on the context
 * so finalizeSighting can await it before its winner UPDATE, which otherwise
 * races the unawaited insert, matches zero rows and leaves the winning bid
 * is_winner false for ever (#88). recordBidAttempt never rejects.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionContext } from '../types'
import { recordBidAttempt, type BidAttemptInsert } from './lead-sightings'

export type BidLogInput = Partial<Omit<BidAttemptInsert, 'sighting_id' | 'trace_id' | 'execution_id' | 'is_test' | 'partner_slug' | 'attempted_at_utc'>> & {
  partner_slug: string
  attempted_at_utc: Date
}

export type BidLogger = (input: BidLogInput) => void

export function makeBidLogger(supabase: SupabaseClient, ctx: ExecutionContext, resolverType: string | null): BidLogger {
  return (input) => {
    if (!ctx.trigger.sighting_id) return
    const write = recordBidAttempt(supabase, {
      sighting_id: ctx.trigger.sighting_id,
      trace_id: ctx.trigger.trace_id,
      execution_id: ctx.trigger.execution_id ?? '',
      partner_slug: input.partner_slug,
      attempted_at_utc: input.attempted_at_utc,
      attempted_at_et: input.attempted_at_et ?? input.attempted_at_utc,
      responded_at_utc: input.responded_at_utc ?? null,
      responded_at_et: input.responded_at_et ?? input.responded_at_utc ?? null,
      http_status: input.http_status ?? null,
      bid_cents: input.bid_cents ?? null,
      classification: input.classification ?? null,
      decline_reason: input.decline_reason ?? null,
      resolver_type: resolverType,
      skip_reason: input.skip_reason ?? null,
      is_test: false,
    })
    ;(ctx.pendingBidWrites ??= []).push(write)
  }
}
