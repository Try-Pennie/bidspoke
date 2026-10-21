/**
 * A Reconnect's login, rebuilt from what the stored row names and the new
 * login fields (#2338, build PR 6; R19, D19). Only the login is rebuilt: the
 * target stays the row's own, so a target field the form cannot hold (a
 * Google target's drives, an array, as the minter reads it) never blocks it.
 */
import { describe, expect, it } from 'vitest'
import { connectionParts, type ConnectionDeclaration } from '@bidspoke/service-catalogue/schema'
import { reconnectLogin, reconnectValues } from '../connection-reconnect'

const SALESFORCE: ConnectionDeclaration = {
  tile: 'An org',
  auth: 'client_credentials',
  fields: [
    { key: 'instance_url', label: 'Org', input: 'salesforce_org', required: true, target: 'instance_url' },
    { key: 'client_id', label: 'Client id', input: 'text', required: true, login: 'client_id', target: 'client_id' },
    { key: 'client_secret', label: 'Client secret', input: 'secret', required: true, login: 'client_secret' },
  ],
}

const GOOGLE: ConnectionDeclaration = {
  tile: 'A company mailbox or drive',
  auth: 'service_account_delegation',
  fields: [
    { key: 'subject', label: 'Mailbox', input: 'text', required: true, target: 'subject' },
    { key: 'drives', label: 'Drive', input: 'text', required: false, target: 'drives' },
    { key: 'client_email', label: 'Service account', input: 'text', required: true, login: 'client_email' },
    { key: 'private_key', label: 'Private key', input: 'secret_block', required: true, login: 'private_key' },
  ],
}

const build = (c: ConnectionDeclaration, target: unknown, body: Record<string, string>) => {
  const v = reconnectValues(c, target, body)
  return v.ok ? connectionParts(reconnectLogin(c), v.values) : v
}

describe('reconnectValues', () => {
  it('keeps a field that is both login and target from the row: the client id', () => {
    expect(build(SALESFORCE, { instance_url: 'https://achieve.my.salesforce.com', client_id: 'app' }, { client_secret: 's' }))
      .toMatchObject({ ok: true, login: { client_id: 'app', client_secret: 's' } })
  })

  it('reconnects a Google connection whose target names its drives as the minter reads them, an array', () => {
    const target = { subject: 'reports@trypennie.com', drives: ['0AbCdEf', '0GhIjKl'] }
    expect(build(GOOGLE, target, { client_email: 'svc@x.iam.example', private_key: 'pem' }))
      .toEqual({ ok: true, login: { client_email: 'svc@x.iam.example', private_key: 'pem' }, target: {} })
  })

  it('refuses a value for what the connection names unless it is the row\'s own', () => {
    expect(reconnectValues(SALESFORCE, { instance_url: 'https://a.my.salesforce.com', client_id: 'app' }, { client_secret: 's', instance_url: 'https://b.my.salesforce.com' }))
      .toEqual({ ok: false, code: 'reconnect_target_changed', fields: ['instance_url'] })
    expect(reconnectValues(SALESFORCE, { instance_url: 'https://a.my.salesforce.com', client_id: 'app' }, { client_secret: 's', instance_url: 'https://a.my.salesforce.com' }))
      .toMatchObject({ ok: true })
    // A target value the form cannot hold can only be sent back changed.
    expect(reconnectValues(GOOGLE, { subject: 'r@x.example', drives: ['0Ab'] }, { private_key: 'pem', client_email: 'svc', drives: '0Ab' }))
      .toEqual({ ok: false, code: 'reconnect_target_changed', fields: ['drives'] })
  })

  it('refuses a login field the row names in a shape the form cannot hold', () => {
    expect(reconnectValues(SALESFORCE, { instance_url: 'https://a.my.salesforce.com', client_id: ['app'] }, { client_secret: 's' }))
      .toEqual({ ok: false, code: 'reconnect_target_unreadable', fields: ['client_id'] })
  })

  it('names a field the service does not declare', () => {
    expect(reconnectValues(SALESFORCE, {}, { client_secret: 's', password: 'p' })).toEqual({ ok: false, code: 'connection_fields_undeclared', fields: ['password'] })
  })
})
