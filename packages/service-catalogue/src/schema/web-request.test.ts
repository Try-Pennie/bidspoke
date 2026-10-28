import { describe, expect, it } from 'vitest'
import { CATALOGUE } from './catalogue'
import { WEB_REQUEST_AUTH_TYPES, WEB_REQUEST_SERVICES, webRequestAuthFor } from './web-request'

/**
 * The web request step's services and the sign in each presets (#2342, decision
 * 10 of the #1689 plan): one list, read by the canvas's Webhook step form. It
 * was two constants in ConfigPanel.tsx; these are the values it held, so moving
 * it changed nothing a person sees or a saved step stores.
 */
describe('WEB_REQUEST_SERVICES', () => {
  it('holds the three services the step offered, in the same order, words and presets', () => {
    expect(WEB_REQUEST_SERVICES).toEqual([
      { value: 'custom', label: 'Custom', authType: 'none' },
      { value: 'equifax', label: 'Equifax', authType: 'basic' },
      { value: 'salesforce', label: 'Salesforce', authType: 'bearer' },
    ])
  })

  it('takes Salesforce from its catalogue service, so its key and name are the catalogue\'s', () => {
    const salesforce = CATALOGUE.find((s) => s.key === 'salesforce')
    expect(salesforce?.webRequestAuth).toBe('bearer')
    expect(WEB_REQUEST_SERVICES.find((s) => s.value === 'salesforce')).toEqual({ value: salesforce?.key, label: salesforce?.name, authType: salesforce?.webRequestAuth })
  })

  it('lists every catalogue service that declares a preset, and no other', () => {
    const declared = CATALOGUE.filter((s) => s.webRequestAuth !== undefined).map((s) => s.key)
    const fromCatalogue = WEB_REQUEST_SERVICES.map((s) => s.value).filter((v) => CATALOGUE.some((s) => s.key === v))
    expect(fromCatalogue).toEqual(declared)
  })

  it('gives each value once, and only sign in types the step knows', () => {
    const values = WEB_REQUEST_SERVICES.map((s) => s.value)
    expect(new Set(values).size).toBe(values.length)
    for (const s of WEB_REQUEST_SERVICES) expect(WEB_REQUEST_AUTH_TYPES).toContain(s.authType)
  })
})

describe('webRequestAuthFor', () => {
  it('presets each listed service\'s sign in', () => {
    expect(webRequestAuthFor('custom')).toBe('none')
    expect(webRequestAuthFor('equifax')).toBe('basic')
    expect(webRequestAuthFor('salesforce')).toBe('bearer')
  })

  it('presets no sign in for a service it does not list, as before', () => {
    expect(webRequestAuthFor('snowflake')).toBe('none')
    expect(webRequestAuthFor('')).toBe('none')
  })
})
