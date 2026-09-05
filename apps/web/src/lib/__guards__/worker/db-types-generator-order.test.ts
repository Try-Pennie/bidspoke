/**
 * #1186. The generated types file says "do not edit by hand" in its header, and
 * nothing enforced it. PR #1165 (70cbdbb2) added the `bid_recording_coverage`
 * function type by hand, below `create_next_month_partitions`, which is the wrong
 * slot: Supabase's generator emits every section's keys sorted by name. Every
 * pre-merge check passed, because the only guard on this file asks whether the
 * migration's function NAME appears in the types (#853), and a hand edit satisfies
 * that. The nightly drift check then went red the next morning on a diff that moved
 * two lines and changed no type, and its alert blamed a migration that had in fact
 * been recorded.
 *
 * This guard asserts what a regenerated file always has and a hand edit rarely
 * does: byte order within each of `Tables`, `Views`, `Functions`, `Enums` and
 * `CompositeTypes`. It needs no network, so it runs on the PR rather than the next
 * morning. Order was measured on the committed file rather than assumed: every
 * section was in plain byte order except the one hand-inserted key.
 *
 * It matters more once #1115 lands: comparing by structure would let an
 * ordering-only diff pass silently, and this would then be the only thing keeping
 * the file regenerated rather than hand-patched.
 *
 * The scanner is exercised on a synthetic file in both directions (L1, L159): an
 * out-of-order key is named, a sorted file passes. And the real file must yield a
 * non-trivial number of keys, because a scanner that matched nothing would pass
 * (L100; this repo's source-scanning guards have passed vacuously before).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const COMMITTED = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

const SECTIONS = ['Tables', 'Views', 'Functions', 'Enums', 'CompositeTypes'] as const
type Section = (typeof SECTIONS)[number]

interface OutOfOrder {
  section: Section
  line: number
  key: string
  previous: string
}

interface Scan {
  keyCount: Record<Section, number>
  outOfOrder: OutOfOrder[]
}

// The generator indents a schema's section headers (Tables, Functions, ...) by four
// spaces and the keys inside them by six. A section ends at the next four-space
// closing brace. Views/Enums/CompositeTypes are usually the one-line
// `{ [_ in never]: never }` form, which opens and closes on the header line and so
// contributes no keys; that is correct, not a miss.
const SECTION_HEADER = /^ {4}(Tables|Views|Functions|Enums|CompositeTypes): \{$/
const SECTION_END = /^ {4}\}$/
const KEY = /^ {6}([A-Za-z_][A-Za-z0-9_]*): /

export function scanGeneratorOrder(source: string): Scan {
  const keyCount = { Tables: 0, Views: 0, Functions: 0, Enums: 0, CompositeTypes: 0 }
  const outOfOrder: OutOfOrder[] = []
  let section: Section | null = null
  let previous: string | null = null
  source.split('\n').forEach((text, index) => {
    const header = SECTION_HEADER.exec(text)
    if (header) {
      section = header[1] as Section
      previous = null
      return
    }
    if (section === null) return
    if (SECTION_END.test(text)) {
      section = null
      return
    }
    const key = KEY.exec(text)
    if (!key) return
    keyCount[section] += 1
    if (previous !== null && key[1] < previous) {
      outOfOrder.push({ section, line: index + 1, key: key[1], previous })
    }
    previous = key[1]
  })
  return { keyCount, outOfOrder }
}

function describeFailures(found: OutOfOrder[]): string {
  return found
    .map((f) => `${f.section}.${f.key} (line ${f.line}) sorts before ${f.previous} but is listed after it`)
    .join('\n')
}

function synthetic(functionKeys: string[]): string {
  return [
    'export type Database = {',
    '  public: {',
    '    Tables: {',
    '      alpha: { Row: { id: string } }',
    '      beta: { Row: { id: string } }',
    '    }',
    '    Views: { [_ in never]: never }',
    '    Functions: {',
    ...functionKeys.map((k) => `      ${k}: { Args: never; Returns: undefined }`),
    '    }',
    '    Enums: { [_ in never]: never }',
    '    CompositeTypes: { [_ in never]: never }',
    '  }',
    '}',
    '',
  ].join('\n')
}

describe('generated DB types are in generator order (#1186)', () => {
  it('names an out-of-order key on a synthetic file (positive control)', () => {
    const scan = scanGeneratorOrder(synthetic(['create_a', 'create_b', 'bid_coverage', 'zeta']))
    expect(scan.outOfOrder).toEqual([
      { section: 'Functions', line: 11, key: 'bid_coverage', previous: 'create_b' },
    ])
    expect(scan.keyCount.Tables).toBe(2)
    expect(scan.keyCount.Functions).toBe(4)
  })

  it('passes a synthetic file whose sections are sorted', () => {
    const scan = scanGeneratorOrder(synthetic(['bid_coverage', 'create_a', 'create_b']))
    expect(scan.outOfOrder).toEqual([])
  })

  it('reads a non-trivial number of keys from the committed file, so it cannot pass by matching nothing', () => {
    const scan = scanGeneratorOrder(readFileSync(COMMITTED, 'utf8'))
    // Measured 2026-09-05: 39 tables and 29 functions. A floor well under both, so
    // a dropped table or two does not fail this, while a broken regex does.
    expect(scan.keyCount.Tables).toBeGreaterThanOrEqual(20)
    expect(scan.keyCount.Functions).toBeGreaterThanOrEqual(10)
  })

  it('finds every section of the committed file in byte order, as the generator writes it', () => {
    const scan = scanGeneratorOrder(readFileSync(COMMITTED, 'utf8'))
    expect(
      scan.outOfOrder,
      `apps/worker/src/types/database.ts was edited by hand rather than regenerated:\n${describeFailures(scan.outOfOrder)}\nRun 'pnpm --filter worker db:types' and commit the result.`,
    ).toEqual([])
  })
})
