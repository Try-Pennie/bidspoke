/**
 * Carrying a partner block sighting from the place a body is read to the one place it is
 * reported (#1265).
 *
 * Node executors cannot reach the Cloudflare context, a Supabase client or the Worker Env
 * uniformly, so nothing here posts anything. A reader turns a response into a sighting with
 * `sightingFromResponse` (the one detector, `detectBlockPage`, decides) and then either
 * notes it on the execution context, which the walker drains after every step, or attaches
 * it to the error it is about to throw where no context is in scope (the Salesforce token
 * fetch and query paging). The walker forwards both to the caller's background reporter.
 *
 * The context collector exists because two readers have no step result to ride on: the
 * partner dedup check answers a boolean and carries on, and a reader deep inside a node
 * would otherwise have to thread the sighting through every return.
 */
import type { ExecutionContext, PartnerBlockSighting } from '../types'
import { detectBlockPage } from '../lib/html-error-summary'

type HeaderReader = { get(name: string): string | null } | Record<string, string>

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** The sighting a response amounts to, or null when it is not a block page. */
export function sightingFromResponse(
  url: string,
  status: number,
  bodyText: string | null | undefined,
  headers: HeaderReader | undefined,
  seenIn: string,
  siblingHosts?: string[],
): PartnerBlockSighting | null {
  const block = detectBlockPage(status, bodyText, headers)
  if (!block) return null
  return {
    host: hostOf(url),
    status: block.status,
    vendor: block.vendor,
    bodyRayId: block.bodyRayId,
    edgeRayId: block.edgeRayId,
    markers: block.markers,
    seenIn,
    ...(siblingHosts && siblingHosts.length > 0 ? { siblingHosts } : {}),
  }
}

/** Note a sighting on the context; the walker drains it after the current step. */
export function noteBlockSighting(ctx: ExecutionContext, sighting: PartnerBlockSighting | null): void {
  if (!sighting) return
  ;(ctx.blockSightings ??= []).push(sighting)
}

/** Take every sighting noted since the last drain, leaving the context empty. */
export function drainBlockSightings(ctx: ExecutionContext): PartnerBlockSighting[] {
  const out = ctx.blockSightings ?? []
  ctx.blockSightings = undefined
  return out
}

/**
 * Move sightings carried on a result or error onto the context. A parallel child's result
 * and error never reach the walker's step handling (the parallel block settles them), so
 * the child runner notes them here and the block's own step drains them.
 */
export function noteCarriedBlockSightings(ctx: ExecutionContext, carrier: unknown): void {
  if (!carrier || typeof carrier !== 'object') return
  const carried = (carrier as { blockSightings?: unknown }).blockSightings
  if (!Array.isArray(carried)) return
  for (const sighting of carried as PartnerBlockSighting[]) noteBlockSighting(ctx, sighting)
}

/** Attach a sighting to an error about to be thrown from code with no context in scope. */
export function attachBlockSighting<E extends object>(err: E, sighting: PartnerBlockSighting | null): E {
  if (!sighting) return err
  const carrier = err as E & { blockSightings?: PartnerBlockSighting[] }
  ;(carrier.blockSightings ??= []).push(sighting)
  return carrier
}
