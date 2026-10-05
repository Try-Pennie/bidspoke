/**
 * The committed money gate fixtures carry no real person and hang together (#1704).
 *
 * Scans everything under money-gate/fixtures that holds lead shaped data, and every
 * payload the generator builds from it, with the same scanner the replay runs. Also
 * holds the variant files to the rules and workflows they name, so a renamed stub
 * scenario or a workflow that lost its shape fails here, by name, before the replay.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanForPersonalData } from '../fixture-scan'
import { generatePayload } from '../generate'
import { RULES } from '../stub-rules'
import { parseExpectedChanges } from '../expected-changes'
import type { ShapesFile } from '../shape'
import type { ConfigSnapshot } from '../snapshot'
import { resolveVariant, runPlan, type VariantFile } from '../../harness/replay-env'
import { EXTRA_RUN_KINDS } from '../run-kinds'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')
const readJson = <T>(...p: string[]) => JSON.parse(readFileSync(join(fixtures, ...p), 'utf8')) as T

const shapes = readJson<ShapesFile>('shapes.json')
const snapshot = readJson<ConfigSnapshot>('config-snapshot.json')
const variantFiles = readdirSync(join(fixtures, 'variants')).filter((f) => f.endsWith('.json')).map((f) => ({ file: f, v: readJson<VariantFile>('variants', f) }))
const definitionIds = readdirSync(join(fixtures, 'definitions')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))

describe('committed money gate fixtures', () => {
  it('the shapes carry no personal data', () => {
    expect(scanForPersonalData(shapes)).toEqual([])
  })

  it('the config snapshot carries no personal data', () => {
    expect(scanForPersonalData(snapshot)).toEqual([])
  })

  it('no variant sets personal data', () => {
    for (const { file, v } of variantFiles) expect({ file, findings: scanForPersonalData(v) }).toEqual({ file, findings: [] })
  })

  it('no generated fixture payload carries personal data', () => {
    for (const { v } of variantFiles) {
      const shape = shapes.workflows.find((w) => w.workflow_id === v.workflow_id)!
      for (const variant of v.variants.map((x) => resolveVariant(v, x))) {
        const id = `${v.workflow_name}/${variant.name}`
        expect({ id, findings: scanForPersonalData(generatePayload(shape, { seed: id, set: variant.set, unset: variant.unset })) }).toEqual({ id, findings: [] })
      }
    }
  })

  it('expected-changes.json parses, and every entry in it names a workflow, a check and a reason', () => {
    const parsed = parseExpectedChanges(readFileSync(join(fixtures, '..', 'expected-changes.json'), 'utf8'))
    expect(parsed.failures).toEqual([])
  })

  it('every live workflow in the shapes has a committed definition, and every definition a shape', () => {
    expect(shapes.workflows.map((w) => w.workflow_id).sort()).toEqual([...definitionIds].sort())
  })

  it('every workflow is replayed as a test run and as a dry_run shadow run, not only live (#1730)', () => {
    for (const { file, v } of variantFiles) {
      const kinds = new Set(runPlan(v).map((p) => p.kind))
      expect({ file, missing: EXTRA_RUN_KINDS.filter((k) => !kinds.has(k)) }).toEqual({ file, missing: [] })
    }
  })

  it('a variant opts only into kinds of run the gate can replay, each once', () => {
    for (const { file, v } of variantFiles) {
      for (const variant of v.variants) {
        const kinds = variant.also_run_as ?? []
        expect({ file, variant: variant.name, unknown: kinds.filter((k) => !EXTRA_RUN_KINDS.includes(k)), repeated: kinds.filter((k, i) => kinds.indexOf(k) !== i) })
          .toEqual({ file, variant: variant.name, unknown: [], repeated: [] })
      }
    }
  })

  it('every variant file names a workflow with a shape, unique variant names, and stub scenarios that exist', () => {
    const rules = new Map(RULES.map((r) => [r.name, r]))
    for (const { file, v } of variantFiles) {
      expect({ file, hasShape: shapes.workflows.some((w) => w.workflow_id === v.workflow_id) }).toEqual({ file, hasShape: true })
      const names = v.variants.map((x) => x.name)
      expect({ file, duplicates: names.filter((n, i) => names.indexOf(n) !== i) }).toEqual({ file, duplicates: [] })
      for (const variant of v.variants.map((x) => resolveVariant(v, x))) {
        for (const [rule, scenario] of Object.entries({ ...(variant.stubs ?? {}), ...(variant.prior_stubs ?? {}) })) {
          expect({ file, variant: variant.name, rule, known: rules.has(rule) && scenario in rules.get(rule)!.scenarios }).toEqual({ file, variant: variant.name, rule, known: true })
        }
      }
    }
  })
})
