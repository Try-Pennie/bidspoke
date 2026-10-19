import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unstable_readConfig } from 'wrangler'
import { refusingServiceStubs } from '../service-stubs'

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('refusingServiceStubs (#2335)', () => {
  it('stubs every service binding the engine under test declares, each refusing with 503 and naming itself', async () => {
    const stubs = refusingServiceStubs([{ binding: 'OPS_CONNECTIONS', service: 'bidspoke-worker-ops' }, { binding: 'OTHER', service: 'x' }])
    expect(Object.keys(stubs).sort()).toEqual(['OPS_CONNECTIONS', 'OTHER'])
    const res = stubs.OPS_CONNECTIONS()
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('bidspoke-worker-ops')
  })

  it('with no service bindings (a merge base before any), stubs nothing', () => {
    expect(refusingServiceStubs(undefined)).toEqual({})
  })

  it('covers the OPS_CONNECTIONS binding the real wrangler.toml declares, or workerd refuses to start the replay', () => {
    const services = unstable_readConfig({ config: resolve(workerRoot, 'wrangler.toml') }, { hideWarnings: true }).services
    expect(Object.keys(refusingServiceStubs(services))).toContain('OPS_CONNECTIONS')
  })
})
