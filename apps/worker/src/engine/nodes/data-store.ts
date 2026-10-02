/**
 * Data Store node — workflow-author KV with TTL.
 *
 * Config:
 *   store:        which KV namespace to target (currently only 'submissions')
 *   operation:    'set' | 'get' | 'delete'
 *   key:          string, supports {{trigger.*}} / {{steps.*.output.*}} / {{env.*}} templates
 *   value:        any JSON-serializable value (set only); supports templates anywhere inside
 *   ttl_seconds:  KV expirationTtl (set only). Cloudflare KV minimum is 60s; we clamp up.
 *
 * Output:
 *   set:    { store, operation: 'set', key, ttl_seconds }
 *   get:    { store, operation: 'get', key, value, hit: boolean }
 *   delete: { store, operation: 'delete', key }
 */

import type { NodeDefinition, ExecutionContext, StepExecutionResult, ResolvedStepInput } from '../../types'
import type { Env } from '../../index'
import { resolveValue } from '../context'
import { coerceString } from '../../lib/coerce'
import { shadowOf } from '../run-reality'

type DataStoreName = 'submissions'

interface DataStoreConfig {
  store?: DataStoreName
  operation?: 'set' | 'get' | 'delete'
  key?: string
  value?: unknown
  ttl_seconds?: number
}

const KV_MIN_TTL_SECONDS = 60

export async function executeDataStoreNode(
  node: NodeDefinition,
  ctx: ExecutionContext,
  env: Env
): Promise<StepExecutionResult> {
  const config = node.config as unknown as DataStoreConfig
  const store: DataStoreName = config.store ?? 'submissions'
  const operation = config.operation
  const rawKey = config.key

  if (!operation) throw new Error('Data Store node missing required config: operation')
  if (!rawKey) throw new Error('Data Store node missing required config: key')

  const kv = pickNamespace(env, store)
  const key = coerceString(resolveValue(rawKey, ctx))
  if (!key) throw new Error('Data Store node resolved an empty key')

  const templateBase = { store: config.store, operation, key: rawKey, ttl_seconds: config.ttl_seconds, value: config.value }

  switch (operation) {
    case 'set': {
      const value = resolveValue(config.value ?? null, ctx)
      const putOpts: KVNamespacePutOptions = {}
      if (typeof config.ttl_seconds === 'number' && config.ttl_seconds > 0) {
        putOpts.expirationTtl = Math.max(config.ttl_seconds, KV_MIN_TTL_SECONDS)
      }
      if (!shadowOf(ctx).outboundStubbed) {
        await kv.put(key, JSON.stringify(value), putOpts)
      }
      const resolvedInput: ResolvedStepInput = {
        template: templateBase,
        resolved: { store, operation: 'set', key, value, ttl_seconds: putOpts.expirationTtl ?? null },
      }
      return {
        output: {
          store,
          operation: 'set',
          key,
          ttl_seconds: putOpts.expirationTtl ?? null,
        },
        resolvedInput,
      }
    }
    case 'get': {
      const raw = await kv.get(key)
      const value = raw === null ? null : safeParse(raw)
      const resolvedInput: ResolvedStepInput = {
        template: templateBase,
        resolved: { store, operation: 'get', key },
      }
      return {
        output: {
          store,
          operation: 'get',
          key,
          value,
          hit: raw !== null,
        },
        resolvedInput,
      }
    }
    case 'delete': {
      if (!shadowOf(ctx).outboundStubbed) {
        await kv.delete(key)
      }
      const resolvedInput: ResolvedStepInput = {
        template: templateBase,
        resolved: { store, operation: 'delete', key },
      }
      return {
        output: { store, operation: 'delete', key },
        resolvedInput,
      }
    }
    default:
      throw new Error(`Data Store node unsupported operation: ${operation as string}`)
  }
}

function pickNamespace(env: Env, store: DataStoreName): KVNamespace {
  switch (store) {
    case 'submissions':
      return env.SUBMISSIONS
    default:
      throw new Error(`Data Store node unknown store: ${store as string}`)
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}
