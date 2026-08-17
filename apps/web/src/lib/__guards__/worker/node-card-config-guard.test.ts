/**
 * Guard against the "canvas card asserts a config field the engine ignores" bug
 * class (#645).
 *
 * The Achieve node rendered an `fdr` chip from `config.targeted_products` while
 * Achieve picked the product server-side and ignored the field entirely. The
 * card, the config picker and reality disagreed for weeks and nothing surfaced
 * it, because a wrong label reads exactly like a right one. Dan's own fix
 * (60c06f1) named the rule: "a UI control that cannot affect the outcome is a
 * trap".
 *
 * The invariant, enforced here: every `config.X` a node card DISPLAYS must be a
 * field the worker actually reads for that node type. A field the executor never
 * sees cannot be a truthful claim about what the node does.
 *
 * Mirrors the classifier + real-source-scan shape of shadow-side-effect-guard
 * (#230): a pure function with synthetic-input unit tests (so the guard is
 * proven able to FAIL), plus a scan over the real cards and executors.
 *
 * Limitation (accepted): the check is text-based and asks only "does the
 * executor reference this field at all". It catches a field that never reaches
 * the worker (targeted_products, partner_name, service_label). It cannot prove a
 * field the executor reads actually changes behaviour.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CARD_EXECUTORS,
  DISPLAY_ONLY_FIELDS,
  extractDisplayedConfigFields,
  findCardConfigViolations,
} from '../../node-card-config-guard'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_NODES = path.resolve(HERE, '../../../components/canvas/nodes')
const WORKER_SRC = path.resolve(HERE, '../../../../../worker/src')

describe('extractDisplayedConfigFields', () => {
  it('finds dot-access reads', () => {
    expect(extractDisplayedConfigFields('const p = config.targeted_products ?? []')).toEqual(['targeted_products'])
  })

  it('finds bracket-access reads', () => {
    expect(extractDisplayedConfigFields("const m = config['wait_for']")).toEqual(['wait_for'])
  })

  it('de-duplicates and ignores non-config member access', () => {
    const fields = extractDisplayedConfigFields('config.mode; config.mode; data.mode; other.config.x')
    expect(fields).toEqual(['mode'])
  })

  it('finds nothing in a card that renders no config', () => {
    expect(extractDisplayedConfigFields('export function N() { return null }')).toEqual([])
  })
})

describe('findCardConfigViolations (classifier)', () => {
  const executors = { demo: 'const x = config.url; const y = config.method' }

  it('flags a card displaying a field the executor never reads', () => {
    const v = findCardConfigViolations(
      [{ card: 'DemoNode.tsx', type: 'demo', content: 'config.url; config.partner_name' }],
      executors,
      {},
    )
    expect(v).toEqual([
      expect.objectContaining({ card: 'DemoNode.tsx', field: 'partner_name' }),
    ])
  })

  it('passes a card whose displayed fields are all read by the executor', () => {
    const v = findCardConfigViolations(
      [{ card: 'DemoNode.tsx', type: 'demo', content: 'config.url; config.method' }],
      executors,
      {},
    )
    expect(v).toEqual([])
  })

  it('honours an explicit display-only allowlist entry', () => {
    const v = findCardConfigViolations(
      [{ card: 'DemoNode.tsx', type: 'demo', content: 'config.else_label' }],
      executors,
      { demo: { else_label: 'cosmetic handle text; the engine routes on the handle id' } },
    )
    expect(v).toEqual([])
  })

  it('does not let one node type borrow another type executor field reads', () => {
    const v = findCardConfigViolations(
      [{ card: 'OtherNode.tsx', type: 'other', content: 'config.url' }],
      { ...executors, other: 'const z = config.script' },
      {},
    )
    expect(v.map((x) => x.field)).toEqual(['url'])
  })
})

describe('every node card only displays config the engine actually reads', () => {
  it('has no violations across the real canvas cards and worker executors', () => {
    const cards = Object.entries(CARD_EXECUTORS).map(([card, spec]) => ({
      card,
      type: spec.type,
      content: readFileSync(path.join(WEB_NODES, card), 'utf8'),
    }))
    const executors: Record<string, string> = {}
    for (const spec of Object.values(CARD_EXECUTORS)) {
      executors[spec.type] = spec.sources
        .map((rel) => readFileSync(path.join(WORKER_SRC, rel), 'utf8'))
        .join('\n')
    }

    const violations = findCardConfigViolations(cards, executors, DISPLAY_ONLY_FIELDS)
    expect(
      violations.map((v) => `${v.card} displays config.${v.field}, which ${v.type} never reads`),
    ).toEqual([])
  })

  it('actually reads real source (guard is not passing vacuously)', () => {
    const src = readFileSync(path.join(WEB_NODES, 'SalesforceNode.tsx'), 'utf8')
    expect(src.length).toBeGreaterThan(200)
    expect(extractDisplayedConfigFields(src)).toContain('operation')
  })
})
