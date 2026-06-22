/**
 * Latency Gate node — measures elapsed time between two events in a lead's lifecycle.
 *
 * Use case: networks that ping us, take a bid, then send a separate Bid Win
 * Confirmation post after a waiting period. The longer that waiting period, the
 * higher the redirect-fail risk. We stamp the bid moment with `mark`, then on the
 * confirmation we `check` how long it took and route accordingly — over the
 * per-partner threshold means reject the confirmation (BW Pennie Response = reject
 * due to latency).
 *
 * Operations:
 *   mark   stores the current time in KV keyed by a correlation id (the id the
 *          network echoes back on the confirmation), with a TTL. Single output.
 *   check  reads the mark, computes latency_ms = now - marked_at, compares against
 *          the threshold (node threshold_ms override, else the partner's
 *          confirmation_window_ms), and routes 'within' | 'exceeded'. Two outputs.
 *          A missing/expired mark routes 'exceeded' (fail safe to reject).
 *
 * Config:
 *   operation:       'mark' | 'check'
 *   correlation_key: string, supports {{trigger.*}} / {{steps.*.output.*}} / {{env.*}}
 *   scope:           optional key namespace (template), e.g. partner slug
 *   ttl_seconds:     mark only — KV expirationTtl (min 60s, default 24h)
 *   threshold_ms:    check only — explicit threshold, overrides partner config
 *   partner_id:      check only — resolves confirmation_window_ms when no override
 *
 * Output:
 *   mark:  { operation: 'mark', key, marked_at, ttl_seconds }
 *   check: { operation: 'check', key, hit, marked_at, latency_ms, threshold_ms,
 *            within_threshold, _route: 'within' | 'exceeded', reason }
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput } from '../../types'
import type { Env } from '../../index'
import { resolveValue } from '../context'
import { isShadowDryRun } from '../shadow'

interface LatencyGateConfig {
  operation?: 'mark' | 'check'
  correlation_key?: string
  scope?: string
  ttl_seconds?: number
  threshold_ms?: number
  partner_id?: string
}

const KV_MIN_TTL_SECONDS = 60
const KV_DEFAULT_TTL_SECONDS = 86400

export async function executeLatencyGateNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env,
  supabase?: SupabaseClient
): Promise<StepExecutionResult> {
  const config = node.config as unknown as LatencyGateConfig
  const operation = config.operation

  if (!operation) throw new Error('Latency Gate node missing required config: operation')
  if (!config.correlation_key) throw new Error('Latency Gate node missing required config: correlation_key')

  const key = buildKey(config, ctx)
  const kv = env.SUBMISSIONS
  const template = {
    operation,
    correlation_key: config.correlation_key,
    scope: config.scope,
    ttl_seconds: config.ttl_seconds,
    threshold_ms: config.threshold_ms,
    partner_id: config.partner_id,
  }

  if (operation === 'mark') {
    const markedAt = Date.now()
    const ttlSeconds = Math.max(
      typeof config.ttl_seconds === 'number' && config.ttl_seconds > 0
        ? config.ttl_seconds
        : KV_DEFAULT_TTL_SECONDS,
      KV_MIN_TTL_SECONDS
    )
    // Shadow dry-run: don't write the mark to KV (a real side effect); still
    // return the same output shape so downstream logic is unchanged.
    if (!isShadowDryRun(ctx)) {
      await kv.put(key, JSON.stringify({ marked_at: markedAt }), { expirationTtl: ttlSeconds })
    }
    return {
      output: { operation: 'mark', key, marked_at: markedAt, ttl_seconds: ttlSeconds },
      resolvedInput: { template, resolved: { operation: 'mark', key, ttl_seconds: ttlSeconds } },
    }
  }

  if (operation === 'check') {
    const thresholdMs = await resolveThreshold(config, supabase)
    const raw = await kv.get(key)
    const markedAt = raw === null ? null : parseMarkedAt(raw)

    const resolvedInput: ResolvedStepInput = { template, resolved: { operation: 'check', key, threshold_ms: thresholdMs } }

    if (markedAt === null) {
      return {
        output: {
          operation: 'check',
          key,
          hit: false,
          marked_at: null,
          latency_ms: null,
          threshold_ms: thresholdMs,
          within_threshold: false,
          _route: 'exceeded',
          reason: 'mark_not_found',
        },
        resolvedInput,
      }
    }

    const latencyMs = Date.now() - markedAt
    const within = latencyMs <= thresholdMs
    return {
      output: {
        operation: 'check',
        key,
        hit: true,
        marked_at: markedAt,
        latency_ms: latencyMs,
        threshold_ms: thresholdMs,
        within_threshold: within,
        _route: within ? 'within' : 'exceeded',
        reason: within ? null : 'latency_exceeded',
      },
      resolvedInput,
    }
  }

  throw new Error(`Latency Gate node unsupported operation: ${operation as string}`)
}

function buildKey(config: LatencyGateConfig, ctx: ExecutionContext): string {
  const id = String(resolveValue(config.correlation_key, ctx) ?? '')
  if (!id) throw new Error('Latency Gate node resolved an empty correlation_key')
  const scope = config.scope ? String(resolveValue(config.scope, ctx) ?? '') : ''
  return scope ? `latency:${scope}:${id}` : `latency:${id}`
}

async function resolveThreshold(
  config: LatencyGateConfig,
  supabase?: SupabaseClient
): Promise<number> {
  if (typeof config.threshold_ms === 'number') return config.threshold_ms

  if (!config.partner_id) {
    throw new Error('Latency Gate check node missing threshold: set threshold_ms or partner_id')
  }
  if (!supabase) {
    throw new Error('Latency Gate check node requires a Supabase client to resolve partner threshold')
  }

  const { data, error } = await supabase
    .from('partner_configs')
    .select('confirmation_window_ms')
    .eq('id', config.partner_id)
    .single()

  if (error || !data) {
    throw new Error(`Latency Gate check: partner config not found: ${config.partner_id}`)
  }

  const window = (data as { confirmation_window_ms: number | null }).confirmation_window_ms
  if (typeof window !== 'number') {
    throw new Error(
      'Latency Gate check: partner has no confirmation_window_ms; set one or provide threshold_ms'
    )
  }
  return window
}

function parseMarkedAt(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'number') return parsed
    if (parsed && typeof (parsed as { marked_at?: unknown }).marked_at === 'number') {
      return (parsed as { marked_at: number }).marked_at
    }
    return null
  } catch {
    return null
  }
}
