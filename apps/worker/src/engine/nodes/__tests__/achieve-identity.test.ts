import { describe, it, expect } from 'vitest'
import { achieveIdentityHeaders, ACHIEVE_CLIENT_HEADER, ACHIEVE_KEY_HEADER, ACHIEVE_CLIENT_ID } from '../achieve-identity'

describe('achieveIdentityHeaders', () => {
  it('carries the client id and the shared key when the key is set', () => {
    const headers = achieveIdentityHeaders({ saved: { ACHIEVE_PARTNER_KEY: 'a-shared-secret' }, worker: {} })
    expect(headers[ACHIEVE_CLIENT_HEADER]).toBe(ACHIEVE_CLIENT_ID)
    expect(headers[ACHIEVE_KEY_HEADER]).toBe('a-shared-secret')
  })

  // The key is what their Skip rule matches on, so an unset one means the request
  // is refused exactly as it is today. It must still be identifiable in their
  // firewall log, which is what the client header is for, and the missing key is
  // made loud by the required-secrets guard rather than by refusing to send.
  it('still identifies us when the key is unset, and omits the key header entirely', () => {
    const headers = achieveIdentityHeaders({ saved: {}, worker: {} })
    expect(headers[ACHIEVE_CLIENT_HEADER]).toBe(ACHIEVE_CLIENT_ID)
    expect(ACHIEVE_KEY_HEADER in headers).toBe(false)
  })

  // An empty or whitespace-only value reads to their rule as a key that simply
  // does not match, which is indistinguishable from a wrong one. Omitting it
  // instead keeps "never set" and "set wrong" as different things on their side.
  it.each(['', '   '])('omits the key header for a blank value (%j)', (value) => {
    const headers = achieveIdentityHeaders({ saved: { ACHIEVE_PARTNER_KEY: value }, worker: { ACHIEVE_PARTNER_KEY: value } })
    expect(ACHIEVE_KEY_HEADER in headers).toBe(false)
  })

  // The key has two copies, the saved Environment Variables row and the Worker
  // binding the page pushes with it (#1263). Every other reader of a partner
  // credential takes the saved value first and the binding second (buildSandboxEnv),
  // and the daily required secrets check measures the binding, so this reader must
  // fall back to it too, or a row removed by hand stops the calls while that check
  // stays green.
  it('falls back to the Worker binding when the saved row is missing', () => {
    const headers = achieveIdentityHeaders({ saved: {}, worker: { ACHIEVE_PARTNER_KEY: 'from-binding' } })
    expect(headers[ACHIEVE_KEY_HEADER]).toBe('from-binding')
  })

  it.each(['', '   '])('falls back to the Worker binding when the saved value is blank (%j)', (value) => {
    const headers = achieveIdentityHeaders({ saved: { ACHIEVE_PARTNER_KEY: value }, worker: { ACHIEVE_PARTNER_KEY: 'from-binding' } })
    expect(headers[ACHIEVE_KEY_HEADER]).toBe('from-binding')
  })

  it('prefers the saved value over the Worker binding', () => {
    const headers = achieveIdentityHeaders({
      saved: { ACHIEVE_PARTNER_KEY: 'from-row' },
      worker: { ACHIEVE_PARTNER_KEY: 'from-binding' },
    })
    expect(headers[ACHIEVE_KEY_HEADER]).toBe('from-row')
  })

  // The reachability probe runs outside any workflow, so it has no saved values.
  it('reads the Worker binding alone when there are no saved values', () => {
    const headers = achieveIdentityHeaders({ saved: null, worker: { ACHIEVE_PARTNER_KEY: 'from-binding' } })
    expect(headers[ACHIEVE_KEY_HEADER]).toBe('from-binding')
  })

  it('ignores a binding that is not a string', () => {
    const headers = achieveIdentityHeaders({ saved: {}, worker: { ACHIEVE_PARTNER_KEY: { not: 'a string' } } })
    expect(ACHIEVE_KEY_HEADER in headers).toBe(false)
  })

  it('names the headers Achieve agreed to', () => {
    expect(ACHIEVE_CLIENT_HEADER).toBe('X-Pennie-Client')
    expect(ACHIEVE_KEY_HEADER).toBe('X-Pennie-Key')
  })
})
