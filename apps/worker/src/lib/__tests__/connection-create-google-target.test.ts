/**
 * A Google connection's target is read one way at save and at mint (#2819,
 * lesson L263). The save's list check and the list's removal check read the
 * target through the minter's own reading (readGoogleTarget, which the minter's
 * googleSubjectsOf refuses through as target_invalid), so a target the minter
 * would refuse at every mint is never passed at save, and a drive is compared
 * as stored, never trimmed into one the list holds.
 */
import { describe, expect, it } from 'vitest'
import { CATALOGUE, connectionParts } from '@bidspoke/service-catalogue/schema'
import { connectionsNamingSubject, unlistedGoogleSubjects } from '../connection-create'
import type { DelegationSubjectRow } from '../ops-connections-contract'
import { readGoogleTarget } from '../../ops/connections/minters/google-target'
import { googleSubjectsOf } from '../../ops/connections/minters/google'
import { LoginMintError } from '../../ops/connections/refusals'

const entry = (kind: 'mailbox' | 'drive', subject: string): DelegationSubjectRow =>
  ({ kind, subject, display_name: null, added_by: 'Dan Wright', added_at: '2026-10-27T15:00:00Z' })

const LIST = [entry('mailbox', 'ops@trypennie.com'), entry('drive', '0AFinanceDrive'), entry('drive', '0AReportsDrive')]

/** The minter's reading of a target, or target_invalid where it refuses one. */
function minterReads(target: unknown): { mailbox: string; drives: string[] } | 'target_invalid' {
  try {
    return googleSubjectsOf(target)
  } catch (err) {
    if (err instanceof LoginMintError && err.message.includes('target_invalid')) return 'target_invalid'
    throw err
  }
}

/** The save's reading of the same target, in the same terms. */
function saveReads(target: unknown): { mailbox: string; drives: string[] } | 'target_invalid' {
  const read = readGoogleTarget(target)
  return read.ok ? { mailbox: read.mailbox, drives: read.drives } : 'target_invalid'
}

const TARGETS: ReadonlyArray<[string, unknown]> = [
  ['a mailbox alone', { subject: 'ops@trypennie.com' }],
  ['a mailbox typed with capitals and spaces', { subject: ' Ops@TryPennie.com ' }],
  ['a mailbox and a list of drives', { subject: 'ops@trypennie.com', drives: ['0AFinanceDrive', '0AReportsDrive'] }],
  ['drives given as text rather than a list', { subject: 'ops@trypennie.com', drives: '0AFinanceDrive' }],
  ['a drive with spaces around it', { subject: 'ops@trypennie.com', drives: [' 0AFinanceDrive '] }],
  ['an empty drive', { subject: 'ops@trypennie.com', drives: [''] }],
  ['a drive that is not text', { subject: 'ops@trypennie.com', drives: [7] }],
  ['more drives than google_delegation_check takes', { subject: 'ops@trypennie.com', drives: Array.from({ length: 101 }, (_, i) => `0ADrive${i}`) }],
  ['a mailbox that is not an address', { subject: 'ops' }],
  ['no mailbox', { drives: ['0AFinanceDrive'] }],
  ['a target that is not an object', ['ops@trypennie.com']],
  ['no target', null],
]

describe('the save reads a Google target exactly as the minter does', () => {
  it.each(TARGETS)('%s', (_, target) => {
    expect(saveReads(target)).toEqual(minterReads(target))
  })

  it('refuses drives given as text, which the save once read as a one drive list', () => {
    expect(readGoogleTarget({ subject: 'ops@trypennie.com', drives: '0AFinanceDrive' })).toEqual({ ok: false })
  })
})

describe('a list of drives saves and mints', () => {
  it('the target the form builds is read the same at save and at mint, and every subject it names is listed', () => {
    const google = CATALOGUE.find((s) => s.key === 'google')
    if (!google) throw new Error('the catalogue declares no google service')
    const parts = connectionParts(google.connection, { subject: 'Ops@TryPennie.com ', drives: ['0AFinanceDrive', '0AReportsDrive'] })
    if (!parts.ok) throw new Error('the form refused a mailbox and two drives')
    const read = readGoogleTarget(parts.target)
    expect(read).toEqual({ ok: true, mailbox: 'ops@trypennie.com', drives: ['0AFinanceDrive', '0AReportsDrive'] })
    if (!read.ok) return
    expect(unlistedGoogleSubjects(read, LIST)).toEqual([])
    expect(googleSubjectsOf(parts.target)).toEqual({ mailbox: read.mailbox, drives: read.drives })
  })
})

describe('the save compares drives as google_delegation_check does, exactly', () => {
  it('names a drive with spaces around it as unlisted, since the mint would send it with them', () => {
    expect(unlistedGoogleSubjects({ mailbox: 'ops@trypennie.com', drives: [' 0AFinanceDrive'] }, LIST)).toEqual([' 0AFinanceDrive'])
  })

  it('names the mailbox and each drive off the list, and nothing that is on it', () => {
    expect(unlistedGoogleSubjects({ mailbox: 'ceo@trypennie.com', drives: ['0AFinanceDrive', '0AOtherDrive'] }, LIST)).toEqual(['ceo@trypennie.com', '0AOtherDrive'])
  })
})

describe('the removal check reads each connection as the minter does', () => {
  const row = (name: string, target: unknown) => ({ name, target })

  it('a connection whose target the minter refuses acts as nobody, so names neither its mailbox nor its drives', () => {
    const rows = [
      row('Text drives', { subject: 'ops@trypennie.com', drives: '0AFinanceDrive' }),
      row('Listed drives', { subject: 'reports@trypennie.com', drives: ['0AFinanceDrive'] }),
    ]
    expect(connectionsNamingSubject(rows, 'drive', '0AFinanceDrive').map((r) => r.name)).toEqual(['Listed drives'])
    expect(connectionsNamingSubject(rows, 'mailbox', 'ops@trypennie.com')).toEqual([])
  })

  it('a drive stored with spaces around it is not the listed drive, as at mint', () => {
    expect(connectionsNamingSubject([row('Spaced', { subject: 'ops@trypennie.com', drives: [' 0AFinanceDrive '] })], 'drive', '0AFinanceDrive')).toEqual([])
  })

  it('a mailbox is matched trimmed and lower cased, as at mint', () => {
    expect(connectionsNamingSubject([row('Ops', { subject: ' OPS@trypennie.com ' })], 'mailbox', 'ops@trypennie.com').map((r) => r.name)).toEqual(['Ops'])
  })
})
