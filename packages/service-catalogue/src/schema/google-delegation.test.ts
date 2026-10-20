import { describe, expect, it } from 'vitest'
import { CATALOGUE } from './catalogue'
import { GOOGLE_DELEGATION_GRANTED_SCOPES, googleDelegationScopes } from './google-delegation'
import type { ActionSchema, ServiceSchema } from './types'

/**
 * The Google delegation scopes (#2335, finding F129; Dan's decision 11). The
 * Workspace grant is broad and made once; what the ops minter asks Google for
 * is derived from the catalogue's Google actions, never written by hand, so a
 * token is never minted with a scope no shipped action declares.
 */

function action(key: string, googleScopes?: ActionSchema['googleScopes']): ActionSchema {
  return { key, name: key, version: 1, arguments: [], sideEffect: false, idempotent: true, idempotentBecause: 'a read', googleScopes }
}

const service = (key: string, actions: ActionSchema[]): ServiceSchema => ({
  key,
  name: key,
  actions,
  connection: { tile: `A test ${key} service`, auth: 'service_account_delegation', fields: [] },
})

describe('the Google delegation scopes', () => {
  it('the grant is decision 11\'s four broad scopes, each a full scope URL', () => {
    expect([...GOOGLE_DELEGATION_GRANTED_SCOPES].sort()).toEqual([
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/spreadsheets',
    ])
  })

  it('derives the union of what the catalogue\'s actions declare, once each and in one order', () => {
    const catalogue = [
      service('google_sheets', [
        action('google_sheets.append', ['https://www.googleapis.com/auth/spreadsheets']),
        action('google_sheets.read', ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']),
      ]),
      service('gmail', [action('gmail.send', ['https://www.googleapis.com/auth/gmail.modify'])]),
      service('slack', [action('slack.post')]),
    ]
    expect(googleDelegationScopes(catalogue)).toEqual([
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/spreadsheets',
    ])
  })

  it('derives nothing from actions that declare no Google scope', () => {
    expect(googleDelegationScopes([service('slack', [action('slack.post')])])).toEqual([])
  })

  it('derives nothing from the shipped catalogue until a Google action ships, so no Google token can be minted before then', () => {
    expect(CATALOGUE.flatMap((s) => s.actions).filter((a) => a.googleScopes !== undefined)).toEqual([])
    expect(googleDelegationScopes(CATALOGUE)).toEqual([])
  })
})
