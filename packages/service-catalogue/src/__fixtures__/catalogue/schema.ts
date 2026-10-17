import type { ActionSchema, ServiceSchema } from '../../schema/types'

/**
 * TEST ONLY. A one action fixture service that proves the catalogue machinery
 * (versioned lookup, fingerprints, trait checks) while the shipped catalogue is
 * still empty. Nothing outside tests imports this directory, and catalogue.test.ts
 * fails if either entry point ever reaches it.
 *
 * Two versions of one action with different outputs, the shape D1's own test
 * asks for: a step pinned to version 1 keeps running version 1 after version 2
 * exists.
 */

const text = { key: 'text', type: 'text', required: true, allowsVariables: true, parseJson: false } as const

export const FIXTURE_ECHO_V1: ActionSchema = {
  key: 'fixture.echo',
  name: 'Echo (test fixture)',
  version: 1,
  arguments: [text],
  sideEffect: false,
  idempotent: true,
  idempotentBecause: 'It reads nothing and writes nothing, so running it twice is the same as once.',
}

export const FIXTURE_ECHO_V2: ActionSchema = {
  ...FIXTURE_ECHO_V1,
  version: 2,
}

export const FIXTURE_SERVICES: readonly ServiceSchema[] = [
  { key: 'fixture', name: 'Fixture (test only)', actions: [FIXTURE_ECHO_V1, FIXTURE_ECHO_V2] },
]
