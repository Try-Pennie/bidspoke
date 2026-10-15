import { describe, expect, it } from 'vitest'
import { newLedger, openLedger, type LedgerIo } from './ledger.ts'
import { runSpike, type SpikeDeps, type SpikeOptions, type Subscription } from './spike.ts'

const MARKER = 'realtime-spike-20261015t153012z'
const ORG_A = 'org-a'
const MISSING_PARTITION = 'MissingPartition: Realtime was unable to find the expected messages partition'
const USER_A = 'user-a'

interface World {
  /** Partition checks answered false before the day's partition appears; Infinity means never. */
  partitionAfterChecks: number
  /** Who may join a topic. The real rule is the migration's policy. */
  authorize: (userOrg: string, topic: string) => boolean
  /** Whether a clean database send is delivered. */
  dbDelivers: boolean
  /** Warnings a send raises even with the partition present. */
  sendWarnings: string[]
  /** Rows Org B holds in the tables the cross org jobs read. */
  orgBRows: { partner_configs: number; buyer_profiles: number; workflows: number }
  refusalDetail: string
  /**
   * Realtime authorizes a private join by writing a row into realtime.messages,
   * so with no partition for today the JOIN itself is refused (measured on a
   * local stack, realtime v2.130.0, 2026-10-15).
   */
  joinNeedsPartition: boolean
  /** Topics a clean send is never delivered on. */
  undeliveredTopics: string[]
  /** An error the database send throws (a role or statement failure), if any. */
  dbSendThrows: string | null
  /** An error the REST send throws (the Worker unreachable), if any. */
  restSendThrows: string | null
}

function makeWorld(overrides: Partial<World> = {}): World {
  return {
    partitionAfterChecks: 0,
    authorize: (userOrg, topic) => topic === `partners:${userOrg}`,
    dbDelivers: true,
    sendWarnings: [],
    orgBRows: { partner_configs: 0, buyer_profiles: 0, workflows: 0 },
    refusalDetail: 'Unauthorized: You do not have permissions to read from this Channel topic',
    joinNeedsPartition: false,
    undeliveredTopics: [],
    dbSendThrows: null,
    restSendThrows: null,
    ...overrides,
  }
}

const OPTIONS: SpikeOptions = {
  samples: 3,
  receiveTimeoutMs: 1000,
  partitionWaitMs: 60_000,
  partitionPollMs: 5000,
  gapMs: 100,
  selfInterrupt: false,
}

function harness(world: World, options: Partial<SpikeOptions> = {}) {
  const events: string[] = []
  const files = new Map<string, string>()
  const io: LedgerIo = {
    exists: (p) => files.has(p),
    read: (p) => files.get(p) ?? '',
    write: (p, text) => {
      files.set(p, text)
      const ledger = JSON.parse(text) as { entries: Array<{ kind: string; state: string }> }
      events.push(`ledger ${ledger.entries.map((e) => `${e.kind}:${e.state}`).join(',')}`)
    },
  }
  const ledger = openLedger('/l.json', newLedger(MARKER, 'ref', 'now'), io)
  let clock = 0
  let partitionChecks = 0
  const userOrg = new Map<string, string>([[USER_A, ORG_A]])
  let orgB: string | null = null
  const subscriptions: Array<{ topic: string; sub: Subscription }> = []

  const deliver = (topic: string, event: string, payload: Record<string, unknown>) => {
    if (world.undeliveredTopics.includes(topic)) return
    for (const s of subscriptions) {
      if (s.topic === topic && s.sub.status === 'SUBSCRIBED') s.sub.received.push({ event, payload, at: clock + 40 })
    }
  }

  const deps: SpikeDeps = {
    marker: MARKER,
    orgA: { email: 'e2e-test@trypennie.com', password: 'x' },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
    log: () => {},
    ledger,
    newId: () => 'org-b',
    newPassword: () => 'pw',
    signIn: async (email) => {
      events.push(`signIn ${email}`)
      return email === deps.orgA.email ? { jwt: 'jwt-a', userId: USER_A } : { jwt: 'jwt-b', userId: 'user-b' }
    },
    orgOfUser: async (userId) => userOrg.get(userId) ?? null,
    createAllowlist: async (email) => {
      events.push(`create allowlist ${email}`)
    },
    createOrganization: async (org) => {
      events.push(`create organization ${org.slug}`)
      orgB = org.id
    },
    createAuthUser: async (email) => {
      events.push(`create auth_user ${email}`)
      if (orgB) userOrg.set('user-b', orgB)
      return 'user-b'
    },
    countOrgRows: async (orgId) => {
      events.push(`count ${orgId}`)
      return world.orgBRows
    },
    partitionExists: async () => {
      partitionChecks += 1
      return partitionChecks > world.partitionAfterChecks
    },
    dbSend: async (topic, event, payload) => {
      events.push(`dbSend ${topic}`)
      if (world.dbSendThrows) throw new Error(world.dbSendThrows)
      const present = partitionChecks > world.partitionAfterChecks
      if (!present) return { warnings: ['WarnSendingBroadcastMessage: no partition of relation "messages" found for row'] }
      if (world.sendWarnings.length) return { warnings: world.sendWarnings }
      if (world.dbDelivers) deliver(topic, event, payload)
      return { warnings: [] }
    },
    restSend: async (topic, event, payload) => {
      events.push(`restSend ${topic}`)
      if (world.restSendThrows) throw new Error(world.restSendThrows)
      deliver(topic, event, payload)
      return { status: 202, body: '' }
    },
    subscribe: async (label, jwt, topic) => {
      events.push(`subscribe ${label}`)
      const org = jwt === 'jwt-a' ? ORG_A : orgB ?? ''
      const partitionMissing = world.joinNeedsPartition && !(partitionChecks > world.partitionAfterChecks)
      const allowed = world.authorize(org, topic) && !partitionMissing
      const sub: Subscription = {
        status: allowed ? 'SUBSCRIBED' : 'CHANNEL_ERROR',
        detail: allowed ? null : partitionMissing ? MISSING_PARTITION : world.refusalDetail,
        received: [],
        close: async () => {},
      }
      subscriptions.push({ topic, sub })
      return sub
    },
    workerSubscribe: async (_jwt, topic, whenReady) => {
      events.push('workerSubscribe')
      const sub: Subscription = { status: 'SUBSCRIBED', detail: null, received: [], close: async () => {} }
      subscriptions.push({ topic, sub })
      const started = clock
      await whenReady()
      return { status: 'SUBSCRIBED', detail: null, receivedAfterMs: sub.received.length ? sub.received[0].at - started : null }
    },
    interrupt: async () => {
      events.push('interrupt')
      throw new Error('interrupted')
    },
  }
  return { deps, events, run: () => runSpike(deps, { ...OPTIONS, ...options }) }
}

describe('runSpike: setup', () => {
  it('writes each ledger entry to disk before the thing it names is created', async () => {
    const h = harness(makeWorld())
    await h.run()
    for (const kind of ['allowlist', 'organization', 'auth_user']) {
      const planned = h.events.findIndex((e) => e.startsWith('ledger') && e.includes(`${kind}:planned`))
      const created = h.events.findIndex((e) => e.startsWith(`create ${kind}`))
      expect(planned, `${kind} planned`).toBeGreaterThan(-1)
      expect(created, `${kind} created`).toBeGreaterThan(planned)
    }
  })

  it('asserts Org B holds no partners, buyer profiles or workflows before it returns', async () => {
    const h = harness(makeWorld({ orgBRows: { partner_configs: 0, buyer_profiles: 1, workflows: 0 } }))
    const result = await h.run()
    expect(h.events).toContain('count org-b')
    expect(result.orgBEmpty).toBe(false)
    expect(result.problems.join('\n')).toMatch(/buyer_profiles/)
  })

  it('interrupts itself once Org B exists and before anything subscribes, when asked to', async () => {
    const h = harness(makeWorld(), { selfInterrupt: true })
    await expect(h.run()).rejects.toThrow(/interrupted/)
    expect(h.events).toContain('interrupt')
    expect(h.events.some((e) => e.startsWith('create auth_user'))).toBe(true)
    expect(h.events.some((e) => e.startsWith('subscribe'))).toBe(false)
  })
})

describe('runSpike: the two organization negative control', () => {
  it('records A admitted to its own topic, B refused it, and the same the other way round', async () => {
    const result = await harness(makeWorld()).run()
    expect(result.joins).toEqual({
      aOnA: { status: 'SUBSCRIBED', detail: null },
      bOnA: { status: 'CHANNEL_ERROR', detail: expect.stringMatching(/Unauthorized/) },
      bOnB: { status: 'SUBSCRIBED', detail: null },
      aOnB: { status: 'CHANNEL_ERROR', detail: expect.stringMatching(/Unauthorized/) },
    })
    expect(result.boundaryHeld).toBe(true)
  })

  it('reports the boundary broken when B is admitted to A\'s topic', async () => {
    const result = await harness(makeWorld({ authorize: () => true })).run()
    expect(result.boundaryHeld).toBe(false)
    expect(result.problems.join('\n')).toMatch(/B was admitted to partners:org-a/)
  })
})

describe('runSpike: the database sender', () => {
  it('is proved when every sample sent from SQL reaches A', async () => {
    const result = await harness(makeWorld()).run()
    expect(result.dbSender.verdict).toBe('proved')
    expect(result.dbSender.failingStep).toBeNull()
    expect(result.dbSender.latency.received).toBe(3)
    expect(result.dbSender.partitionAtEachSend).toEqual([true, true, true])
  })

  it('waits for the platform to make the day\'s partition rather than concluding, and records how long it took', async () => {
    const result = await harness(makeWorld({ partitionAfterChecks: 2 })).run()
    expect(result.partition.beforeConnect).toBe(false)
    expect(result.partition.afterFirstJoin).toBe(false)
    expect(result.partition.appearedAfterMs).toBeGreaterThan(0)
    expect(result.dbSender.verdict).toBe('proved')
  })

  it('names the partition as the failing step and keeps the WARNING send raised, word for word', async () => {
    const result = await harness(makeWorld({ partitionAfterChecks: Infinity })).run()
    expect(result.dbSender.verdict).toBe('not_proved')
    expect(result.dbSender.failingStep).toBe('partition')
    expect(result.dbSender.warnings).toEqual(['WarnSendingBroadcastMessage: no partition of relation "messages" found for row'])
    expect(result.partition.appearedAfterMs).toBeNull()
  })

  it('checks the partition before anything connects, then waits for it and joins again when a join was refused for a missing partition', async () => {
    const h = harness(makeWorld({ joinNeedsPartition: true, partitionAfterChecks: 2 }))
    const result = await h.run()
    expect(result.partition.beforeConnect).toBe(false)
    expect(result.joinAttempts).toBe(2)
    expect(result.joins.aOnA.status).toBe('SUBSCRIBED')
    expect(result.joins.bOnA.detail).toMatch(/Unauthorized/)
    expect(result.dbSender.verdict).toBe('proved')
    expect(h.events.filter((e) => e === 'subscribe A on partners:<A>')).toHaveLength(2)
  })

  it('names the partition, not the join, when joins stay refused for a missing partition, and still captures the WARNING a send raises', async () => {
    const result = await harness(makeWorld({ joinNeedsPartition: true, partitionAfterChecks: Infinity })).run()
    expect(result.joins.aOnA.detail).toMatch(/MissingPartition/)
    expect(result.dbSender.failingStep).toBe('partition')
    expect(result.dbSender.warnings).toEqual(['WarnSendingBroadcastMessage: no partition of relation "messages" found for row'])
    expect(result.dbSender.partitionAtEachSend).toEqual([false])
  })

  it('names send when send raises a WARNING with the partition present', async () => {
    const result = await harness(makeWorld({ sendWarnings: ['WarnSendingBroadcastMessage: permission denied'] })).run()
    expect(result.dbSender.failingStep).toBe('send')
    expect(result.dbSender.warnings[0]).toMatch(/permission denied/)
  })

  it('names delivery when sends are clean and nothing arrives', async () => {
    const result = await harness(makeWorld({ dbDelivers: false })).run()
    expect(result.dbSender.failingStep).toBe('delivery')
    expect(result.dbSender.latency.lost).toBe(3)
  })

  it('names policy when A is refused its own topic', async () => {
    const result = await harness(makeWorld({ authorize: () => false })).run()
    expect(result.dbSender.failingStep).toBe('policy')
  })

  it('names subscribe when A\'s join fails for a reason other than authorization', async () => {
    const result = await harness(makeWorld({ authorize: () => false, refusalDetail: 'socket closed' })).run()
    expect(result.dbSender.failingStep).toBe('subscribe')
  })
})

describe('runSpike: the cross topic check', () => {
  it('records that B received its own topic\'s message, so A not receiving it means something', async () => {
    const result = await harness(makeWorld()).run()
    expect(result.dbSender.bReceivedOwnTopic).toBe(true)
    expect(result.dbSender.crossTopicLeak).toBe(false)
  })

  it('reports the cross topic check as proving nothing when B never received its own message', async () => {
    const result = await harness(makeWorld({ undeliveredTopics: ['partners:org-b'] })).run()
    expect(result.dbSender.bReceivedOwnTopic).toBe(false)
    expect(result.problems.join('\n')).toMatch(/B did not receive .*partners:org-b/)
    // The verdict the decision rule reads cannot say proved over it.
    expect(result.dbSender.verdict).toBe('not_proved')
    expect(result.dbSender.failingStep).toBe('delivery')
  })

  it('does not call the sender proved when a message reached a subscriber of another topic', async () => {
    const h = harness(makeWorld())
    const realSubscribe = h.deps.subscribe
    h.deps.subscribe = async (label, jwt, topic) => {
      const sub = await realSubscribe(label, jwt, topic)
      // A leak: A's channel on A also hears what was sent on B.
      if (label === 'A on partners:<A>') {
        const origSend = h.deps.dbSend
        h.deps.dbSend = async (t, event, payload) => {
          const out = await origSend(t, event, payload)
          if (event === 'spike-db-b') sub.received.push({ event, payload, at: 0 })
          return out
        }
      }
      return sub
    }
    const result = await h.run()
    expect(result.dbSender.crossTopicLeak).toBe(true)
    expect(result.dbSender.verdict).toBe('not_proved')
    expect(result.dbSender.failingStep).toBe('policy')
  })
})

describe('runSpike: a send that throws is a result, not an aborted run', () => {
  it('names send as the failing step, keeps the error, and still measures the REST control', async () => {
    const result = await harness(makeWorld({ dbSendThrows: 'permission denied to set role "service_role"' })).run()
    expect(result.dbSender.failingStep).toBe('send')
    expect(result.dbSender.sendErrors[0]).toMatch(/permission denied to set role/)
    expect(result.restSender.latency.received).toBe(3)
  })

  it('records a REST send that throws as status 0 with the error, and carries on', async () => {
    const result = await harness(makeWorld({ restSendThrows: 'connect ECONNREFUSED 127.0.0.1:8799' })).run()
    expect(result.restSender.statuses).toEqual([0, 0, 0])
    expect(result.problems.join('\n')).toMatch(/ECONNREFUSED/)
    expect(result.dbSender.verdict).toBe('proved')
  })
})

describe('runSpike: every control that fails is a problem the exit code carries', () => {
  it('reports a Worker subscriber that could not join or received nothing', async () => {
    const h = harness(makeWorld())
    h.deps.workerSubscribe = async () => ({ status: 'CHANNEL_ERROR', detail: 'socket closed', receivedAfterMs: null })
    const result = await h.run()
    expect(result.problems.join('\n')).toMatch(/subscriber in workerd .*CHANNEL_ERROR.*socket closed/)
  })

  it('reports REST broadcasts that were accepted but never arrived', async () => {
    const result = await harness(makeWorld({ undeliveredTopics: ['partners:org-a'] })).run()
    expect(result.problems.join('\n')).toMatch(/REST .*3 of 3 never arrived/)
  })
})

describe('runSpike: the controls on a failure (L248)', () => {
  it('still measures the Worker REST sender to the same subscribers when the database sender fails', async () => {
    const result = await harness(makeWorld({ partitionAfterChecks: Infinity })).run()
    expect(result.restSender.latency.received).toBe(3)
    expect(result.restSender.statuses).toEqual([202, 202, 202])
  })

  it('proves a subscriber outside the browser, sending by whichever sender was proved', async () => {
    const proved = await harness(makeWorld()).run()
    expect(proved.workerSubscriber).toMatchObject({ status: 'SUBSCRIBED', sender: 'database' })
    expect(proved.workerSubscriber.receivedAfterMs).not.toBeNull()

    const fallback = await harness(makeWorld({ partitionAfterChecks: Infinity })).run()
    expect(fallback.workerSubscriber).toMatchObject({ status: 'SUBSCRIBED', sender: 'rest' })
  })
})
