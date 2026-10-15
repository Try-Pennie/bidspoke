import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installInterruptCleanup } from './interrupt.ts'

function fakeProcess() {
  const emitter = new EventEmitter()
  const exits: number[] = []
  let resolveExit: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve
  })
  return {
    on: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => emitter.on(signal, handler),
    off: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => emitter.off(signal, handler),
    exit: (code: number) => {
      exits.push(code)
      resolveExit(code)
    },
    emit: (signal: 'SIGINT' | 'SIGTERM') => emitter.emit(signal),
    exits,
    exited,
    listeners: (signal: string) => emitter.listenerCount(signal),
  }
}

describe('installInterruptCleanup', () => {
  it('runs cleanup on SIGINT, then exits 130', async () => {
    const proc = fakeProcess()
    const ran: string[] = []
    installInterruptCleanup(proc, async () => {
      ran.push('cleanup')
    }, () => {})
    proc.emit('SIGINT')
    expect(await proc.exited).toBe(130)
    expect(ran).toEqual(['cleanup'])
  })

  it('runs cleanup on SIGTERM, then exits 143', async () => {
    const proc = fakeProcess()
    let cleaned = 0
    installInterruptCleanup(proc, async () => {
      cleaned += 1
    }, () => {})
    proc.emit('SIGTERM')
    expect(await proc.exited).toBe(143)
    expect(cleaned).toBe(1)
  })

  it('runs cleanup once when a second signal arrives while it is still running', async () => {
    const proc = fakeProcess()
    let cleaned = 0
    let release: () => void = () => {}
    installInterruptCleanup(proc, async () => {
      cleaned += 1
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }, () => {})
    proc.emit('SIGINT')
    proc.emit('SIGINT')
    release()
    await proc.exited
    expect(cleaned).toBe(1)
    expect(proc.exits).toEqual([130])
  })

  it('still exits, non zero, when cleanup itself throws', async () => {
    const proc = fakeProcess()
    const logged: string[] = []
    installInterruptCleanup(proc, async () => {
      throw new Error('network down')
    }, (line) => logged.push(line))
    proc.emit('SIGINT')
    expect(await proc.exited).toBe(130)
    expect(logged.join('\n')).toMatch(/network down/)
  })

  it('removes its handlers when uninstalled, so the normal path can clean up on its own', () => {
    const proc = fakeProcess()
    const uninstall = installInterruptCleanup(proc, async () => {}, () => {})
    expect(proc.listeners('SIGINT')).toBe(1)
    uninstall()
    expect(proc.listeners('SIGINT')).toBe(0)
    expect(proc.listeners('SIGTERM')).toBe(0)
  })
})
