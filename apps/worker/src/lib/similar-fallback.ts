/**
 * Which node types may borrow a cross workflow duration aggregate when a fresh
 * workflow has no runs of its own (the timeout suggester's similar fallback).
 *
 * Every node type is placed here, in exactly one of three sets, and the test
 * beside this file fails on a type in none of them (#1411, L233). A type that
 * fell through used to read as "does not qualify", which is a decision, and one
 * nobody had made.
 */
import type { NodeType } from '@bidspoke/node-types'
import { isNodeType } from '@bidspoke/node-types'
import { CLICK_CHECK_BUDGET_MS } from '@bidspoke/buyer-profile'

/** Duration is consistent enough across workflows for the aggregate to mean something. */
export const SIMILAR_FALLBACK_STABLE: ReadonlySet<NodeType> = new Set<NodeType>([
  'constants', 'transform', 'branch', 'filter', 'exit', 'response', 'parallel', 'parallel_end',
  // In memory over its own checks, like filter and branch (#2589).
  'lead_validation',
])

/** Stable only within one operation, so the aggregate is keyed by subtype too. */
export const SIMILAR_FALLBACK_BY_SUBTYPE: ReadonlySet<NodeType> = new Set<NodeType>(['salesforce'])

/** Never borrows: the duration is the workflow's own, for the reason stated. */
export const SIMILAR_FALLBACK_EXCLUDED: Readonly<Partial<Record<NodeType, string>>> = {
  code: 'a custom script: its duration is whatever that script does',
  partner_bid: 'one partner API: another workflow talks to a different partner',
  bid_group: 'a fan out to a set of partners: the set is the workflow\'s own',
  webhook: 'an arbitrary external HTTP call: the endpoint is the workflow\'s own',
  achieve_offers: 'one external API whose latency has no counterpart in another workflow',
  buyer_select: 'a cascade over whichever buyers hold a profile, so its duration is the buyer set of the day, not the type',
  buyer_click_send: 'one click buyer endpoint, named in its own config, whose latency has no counterpart in another workflow',
  buyer_click_check: `a profile read and one counter read under its own ${CLICK_CHECK_BUDGET_MS} ms budget, so its duration is the cache and the object colo, not the type`,
  branch_end: 'a passthrough: its duration is the chain that led to it, not its own',
  data_store: 'a KV round trip whose latency depends on the key and the colo, not the type',
  latency_gate: 'a KV round trip whose latency depends on the key and the colo, not the type',
}

/** Whether the aggregate for this type is keyed by subtype as well. */
export function requiresSubtype(nodeType: string): boolean {
  return isNodeType(nodeType) && SIMILAR_FALLBACK_BY_SUBTYPE.has(nodeType)
}

export function qualifiesForSimilarFallback(nodeType: string, subtype?: string): boolean {
  if (!isNodeType(nodeType)) return false
  if (SIMILAR_FALLBACK_STABLE.has(nodeType)) return true
  if (SIMILAR_FALLBACK_BY_SUBTYPE.has(nodeType) && subtype) return true
  return false
}
