import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogueUnderCheck } from '../../checks/catalogue-checks'
import { FIXTURE_SERVICES } from './schema'
import { FIXTURE_RUNTIME_ACTIONS } from './registry'
import fingerprints from './fingerprints.json'

/** TEST ONLY. The fixture catalogue, described the way catalogue.test.ts describes the shipped one. */
const HERE = path.dirname(fileURLToPath(import.meta.url))

export const FIXTURE_CATALOGUE: CatalogueUnderCheck = {
  label: 'fixture',
  services: FIXTURE_SERVICES,
  runtime: FIXTURE_RUNTIME_ACTIONS,
  fingerprints,
  actionsDir: path.join(HERE, 'actions'),
  packageRoot: path.resolve(HERE, '../../..'),
  // A slim lockfile of its own, so a test can bump a version in a copy of it
  // without touching the repository's.
  lockfile: path.join(HERE, 'fixture-lock.yaml'),
  importer: 'packages/service-catalogue',
}
