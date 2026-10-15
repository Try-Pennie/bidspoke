import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { main, type Wiring } from './cli.ts'
import type { CleanupOps } from './cleanup.ts'
import type { LedgerIo } from './ledger.ts'
import type { SpikeDeps, SpikeResult } from './spike.ts'

const MARKER = 'realtime-spike-20261015t153012z'

function wiring(overrides: Partial<Wiring> = {}) {
  const calls: string[] = []
  const lines: string[] = []
  const files = new Map<string, string>()
  const emitter = new EventEmitter()
  let markExited: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    markExited = resolve
  })
  const io: LedgerIo = {
    exists: (p) => files.has(p),
    read: (p) => {
      const text = files.get(p)
      if (text === undefined) throw new Error(`ENOENT ${p}`)
      return text
    },
    write: (p, text) => {
      calls.push(`write ${p}`)
      files.set(p, text)
    },
  }
  const cleanupOps: CleanupOps = {
    findUserIdByEmail: async () => null,
    findAuthUserIdByEmail: async () => null,
    deletePublicUser: async () => 0,
    deleteAuthUser: async () => 'absent',
    deleteOrganization: async (id) => {
      calls.push(`delete organization ${id}`)
      return 1
    },
    deleteAllowlist: async () => 0,
  }
  const w: Wiring = {
    io,
    log: (line) => lines.push(line),
    proc: {
      on: (s, h) => emitter.on(s, h),
      off: (s, h) => emitter.off(s, h),
      exit: (code) => {
        calls.push(`exit ${code}`)
        markExited(code)
      },
    },
    now: () => new Date('2026-10-15T15:30:12Z'),
    loadConfig: () => {
      calls.push('loadConfig')
      return { supabaseUrl: 'https://ref.supabase.co', project: 'ref' } as never
    },
    cleanupOps: () => {
      calls.push('cleanupOps')
      return cleanupOps
    },
    liveDeps: async (_config, _ledger, _marker, register) => {
      calls.push('liveDeps')
      register(async () => {
        calls.push('close')
      })
      return { deps: {} as SpikeDeps }
    },
    spike: async () => {
      calls.push('spike')
      return { orgBEmpty: true } as SpikeResult
    },
    ...overrides,
  }
  return { w, calls, lines, files, emitter, exited }
}

describe('main', () => {
  it('refuses without --i-have-approval and touches nothing: no config, no ledger, no connection', async () => {
    const h = wiring()
    expect(await main(['--ledger', '/l.json'], h.w)).toBe(2)
    expect(h.calls).toEqual([])
    expect(h.lines.join('\n')).toMatch(/--i-have-approval/)
  })

  it('--cleanup removes what the ledger names, prints the report, and exits 0 when nothing failed', async () => {
    const h = wiring()
    h.files.set(
      '/l.json',
      JSON.stringify({
        version: 1,
        marker: MARKER,
        project: 'ref',
        startedAt: 'x',
        entries: [{ kind: 'organization', key: `${MARKER}-example-com`, id: 'org-b', state: 'created' }],
      }),
    )
    expect(await main(['--cleanup', '/l.json'], h.w)).toBe(0)
    expect(h.calls).toContain('delete organization org-b')
    expect(h.lines.join('\n')).toMatch(/removed: organization/)
  })

  it('--cleanup exits 1 when something could not be removed', async () => {
    const h = wiring({
      cleanupOps: () => ({
        findUserIdByEmail: async () => null,
        findAuthUserIdByEmail: async () => null,
        deletePublicUser: async () => 0,
        deleteAuthUser: async () => 'absent',
        deleteOrganization: async () => {
          throw new Error('foreign key')
        },
        deleteAllowlist: async () => 0,
      }),
    })
    h.files.set(
      '/l.json',
      JSON.stringify({
        version: 1,
        marker: MARKER,
        project: 'ref',
        startedAt: 'x',
        entries: [{ kind: 'organization', key: `${MARKER}-example-com`, id: 'org-b', state: 'created' }],
      }),
    )
    expect(await main(['--cleanup', '/l.json'], h.w)).toBe(1)
    expect(h.lines.join('\n')).toMatch(/could not remove: organization .*foreign key/)
  })

  it('writes the ledger before connecting, and cleans up on the normal path after the spike', async () => {
    const h = wiring()
    expect(await main(['--i-have-approval', '--ledger', '/l.json'], h.w)).toBe(0)
    expect(h.calls.indexOf('write /l.json')).toBeLessThan(h.calls.indexOf('liveDeps'))
    expect(h.calls.indexOf('spike')).toBeLessThan(h.calls.indexOf('cleanupOps'))
    expect(h.calls).toContain('close')
    expect(h.files.has('/l.json.result.json')).toBe(true)
  })

  it('still cleans up, and exits 1, when the spike throws', async () => {
    const h = wiring({
      spike: async () => {
        throw new Error('realtime unreachable')
      },
    })
    expect(await main(['--i-have-approval', '--ledger', '/l.json'], h.w)).toBe(1)
    expect(h.calls).toContain('cleanupOps')
    expect(h.lines.join('\n')).toMatch(/realtime unreachable/)
  })

  it('cleans up from the ledger when interrupted mid run, then exits 130', async () => {
    const h = wiring({
      spike: async () => {
        h.emitter.emit('SIGINT')
        return new Promise<SpikeResult>(() => {})
      },
    })
    void main(['--i-have-approval', '--ledger', '/l.json'], h.w)
    expect(await h.exited).toBe(130)
    expect(h.calls).toContain('cleanupOps')
    expect(h.calls).toContain('exit 130')
  })

  it('keeps the signal handlers until the normal path cleanup has finished, so a signal during it waits rather than killing it', async () => {
    let release: () => void = () => {}
    let deletes = 0
    const h = wiring({
      cleanupOps: () => ({
        findUserIdByEmail: async () => null,
        findAuthUserIdByEmail: async () => null,
        deletePublicUser: async () => 0,
        deleteAuthUser: async () => 'absent',
        deleteOrganization: async () => {
          deletes += 1
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return 1
        },
        deleteAllowlist: async () => 0,
      }),
      spike: async (deps) => {
        void deps
        // The spike ran and Org B is in the ledger by the time cleanup starts.
        const ledger = JSON.parse(h.files.get('/l.json') ?? '{}') as { entries: unknown[] }
        ledger.entries.push({ kind: 'organization', key: `${MARKER}-example-com`, id: 'org-b', state: 'created' })
        h.files.set('/l.json', JSON.stringify(ledger))
        return { orgBEmpty: true } as SpikeResult
      },
      now: () => new Date('2026-10-15T15:30:12Z'),
    })
    const run = main(['--i-have-approval', '--ledger', '/l.json'], h.w)
    await expect.poll(() => deletes).toBe(1)
    h.emitter.emit('SIGTERM')
    release()
    expect(await h.exited).toBe(143)
    await run
    expect(deletes).toBe(1)
  })

  it('on a signal, waits for a create already in flight before cleaning up, and lets no new one start', async () => {
    let land: () => void = () => {}
    const order: string[] = []
    let laterCall: Promise<unknown> = Promise.resolve()
    const deps = {
      createAuthUser: () =>
        new Promise<string>((resolve) => {
          land = () => {
            order.push('create landed')
            resolve('user-b')
          }
        }),
      createOrganization: async () => {
        order.push('organization created after the signal')
      },
    } as unknown as SpikeDeps
    const h = wiring({
      liveDeps: async () => ({ deps }),
      cleanupOps: () => {
        order.push('cleanup started')
        return {
          findUserIdByEmail: async () => null,
          findAuthUserIdByEmail: async () => null,
          deletePublicUser: async () => 0,
          deleteAuthUser: async () => 'absent',
          deleteOrganization: async () => 0,
          deleteAllowlist: async () => 0,
        }
      },
      spike: async (d) => {
        void d.createAuthUser('x', 'y')
        h.emitter.emit('SIGINT')
        laterCall = d.createOrganization({ id: 'o', name: 'n', slug: 's' }).catch((err: Error) => order.push(err.message))
        land()
        return new Promise<SpikeResult>(() => {})
      },
    })
    void main(['--i-have-approval', '--ledger', '/l.json'], h.w)
    expect(await h.exited).toBe(130)
    await laterCall
    expect(order.indexOf('create landed')).toBeLessThan(order.indexOf('cleanup started'))
    expect(order).not.toContain('organization created after the signal')
  })

  it('--cleanup refuses a ledger made against another project, and removes nothing', async () => {
    const h = wiring()
    h.files.set(
      '/l.json',
      JSON.stringify({
        version: 1,
        marker: MARKER,
        project: 'xvrmivmpfykwwtriqwpg',
        startedAt: 'x',
        entries: [{ kind: 'organization', key: `${MARKER}-example-com`, id: 'org-b', state: 'created' }],
      }),
    )
    expect(await main(['--cleanup', '/l.json'], h.w)).toBe(1)
    expect(h.calls).not.toContain('delete organization org-b')
    expect(h.lines.join('\n')).toMatch(/made against project xvrmivmpfykwwtriqwpg.*ref/)
  })

  it('on a signal while the live dependencies are still starting, stops what they had already started', async () => {
    const h = wiring({
      liveDeps: async (_config, _ledger, _marker, register) => {
        register(async () => {
          h.calls.push('stopped worker')
        })
        h.emitter.emit('SIGINT')
        return new Promise<never>(() => {})
      },
    })
    void main(['--i-have-approval', '--ledger', '/l.json'], h.w)
    expect(await h.exited).toBe(130)
    expect(h.calls).toContain('stopped worker')
  })

  it('stops something started after a signal\'s cleanup began, rather than leaving it running', async () => {
    let lateRegister: (closer: () => Promise<void>) => void = () => {}
    const h = wiring({
      liveDeps: async (_config, _ledger, _marker, register) => {
        lateRegister = register
        h.emitter.emit('SIGINT')
        return new Promise<never>(() => {})
      },
    })
    void main(['--i-have-approval', '--ledger', '/l.json'], h.w)
    expect(await h.exited).toBe(130)
    lateRegister(async () => {
      h.calls.push('stopped late worker')
    })
    await expect.poll(() => h.calls).toContain('stopped late worker')
  })

  it('refuses a ledger path that already exists, before creating anything', async () => {
    const h = wiring()
    h.files.set('/l.json', '{}')
    expect(await main(['--i-have-approval', '--ledger', '/l.json'], h.w)).toBe(2)
    expect(h.calls).not.toContain('liveDeps')
  })
})
