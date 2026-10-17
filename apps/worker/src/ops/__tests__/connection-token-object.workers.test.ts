/**
 * The first ops Durable Object, ConnectionTokenObject (#2334, phase 4 of #1689),
 * constructed inside workerd against the real wrangler.ops.toml.
 *
 * It ships inert in this deploy (ADR 0011: a deploy that adds a class adds
 * nothing a running path depends on): exported, bound, created by migration
 * v1, and called by nothing. What is proven here is what the deploy needs: the
 * binding resolves to the exported class, an instance constructs, its storage
 * is the SQLite backend the migration asks for, and any request is refused by
 * name rather than answered.
 */
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { CONNECTION_TOKEN_OBJECT_INERT, ConnectionTokenObject } from '../connection-token-object'
import type { OpsEnv } from '../index'

const opsEnv = env as unknown as OpsEnv

describe('ConnectionTokenObject in workerd (#2334)', () => {
  it('constructs from the CONNECTION_TOKENS binding, on SQLite backed storage', async () => {
    expect(opsEnv.CONNECTION_TOKENS).toBeDefined()
    const stub = opsEnv.CONNECTION_TOKENS!.get(opsEnv.CONNECTION_TOKENS!.idFromName('connection:workerd-test'))
    await runInDurableObject(stub, (instance: ConnectionTokenObject, state: DurableObjectState) => {
      expect(instance).toBeInstanceOf(ConnectionTokenObject)
      expect(state.storage.sql).toBeDefined()
      expect(state.storage.sql.exec<{ n: number }>('SELECT 1 AS n').one().n).toBe(1)
    })
  })

  it('refuses every request by name while it is inert, and stores nothing', async () => {
    const stub = opsEnv.CONNECTION_TOKENS!.get(opsEnv.CONNECTION_TOKENS!.idFromName('connection:workerd-inert'))
    for (const path of ['/token', '/refresh', '/']) {
      const res = await stub.fetch(`https://connection-token-object${path}`, { method: 'POST', body: '{}' })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: CONNECTION_TOKEN_OBJECT_INERT })
    }
    await runInDurableObject(stub, async (_instance: ConnectionTokenObject, state: DurableObjectState) => {
      expect(await state.storage.list()).toEqual(new Map())
    })
  })
})
