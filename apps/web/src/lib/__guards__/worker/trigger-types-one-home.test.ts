import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, WEB_SRC, WORKER_SRC, listFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * The trigger types have one home, @bidspoke/workflow-definition (#1947,
 * packages/workflow-definition/src/trigger.ts). The aliases left in
 * apps/worker/src/types.ts, apps/worker/src/lib/failure-rate.ts and
 * apps/web/src/types/workflow.ts so old imports kept compiling are deleted
 * (#2648, L613: a shim is not left to argue for itself), and this fails on the
 * next one, in either app:
 *
 * - a declaration of a trigger type (`type X =` or `interface X`), the old
 *   `TriggerDef` alias included;
 * - a re-export of one (`export type { X }`, with or without `from`);
 * - an import of one from anywhere but the package.
 *
 * Tests are scanned too, because an import from an alias in a test keeps the
 * alias alive as surely as one in shipping code. Comments are stripped, so a
 * comment naming a type is not a declaration.
 */

const HOME = '@bidspoke/workflow-definition'
const TRIGGER_TYPES = ['TriggerConfig', 'HttpWebhookTrigger', 'HttpWebhookConfig', 'ScheduleTrigger', 'MutedFailureSignal', 'TriggerDef']
const IS_TRIGGER_TYPE = new Set(TRIGGER_TYPES)

/** The names a `{ a, type b, c as d }` list brings in, by their original name. */
function namesIn(list: string): string[] {
  return list
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter(Boolean)
}

/** Every way `source` declares, re-exports or imports a trigger type outside its home. */
export function triggerTypeStrays(source: string): string[] {
  const src = sanitizeSource(source, { blankStrings: false })
  const found: string[] = []
  for (const m of src.matchAll(/\b(import|export)\s+(?:type\s+)?\{([^}]*)\}(\s*from\s*['"]([^'"]+)['"])?/g)) {
    const [, kind, list, withFrom, from] = m
    for (const name of namesIn(list)) {
      if (!IS_TRIGGER_TYPE.has(name)) continue
      if (kind === 'export') found.push(`re-exports ${name}`)
      else if (withFrom && from !== HOME) found.push(`imports ${name} from ${from}`)
    }
  }
  for (const m of src.matchAll(/\b(?:type|interface)\s+([A-Za-z_$][\w$]*)\s*(?:=|<|\{|extends\b)/g)) {
    if (IS_TRIGGER_TYPE.has(m[1])) found.push(`declares ${m[1]}`)
  }
  return found
}

function strays(root: string): string[] {
  const out: string[] = []
  for (const file of listFiles(root, { includeTests: true, skipDirs: ['__guards__', 'node_modules'] })) {
    const rel = path.relative(REPO_ROOT, file)
    for (const what of triggerTypeStrays(readFileSync(file, 'utf8'))) out.push(`${rel}: ${what}`)
  }
  return out.sort()
}

describe('the detector', () => {
  it('finds an alias declared by type or interface', () => {
    expect(triggerTypeStrays('export type TriggerDef = HttpWebhookTrigger')).toEqual(['declares TriggerDef'])
    expect(triggerTypeStrays('interface MutedFailureSignal { match: string }')).toEqual(['declares MutedFailureSignal'])
  })

  it('finds a re-export, from the package or bare', () => {
    expect(triggerTypeStrays(`export type { HttpWebhookTrigger, ScheduleTrigger } from '${HOME}'`)).toEqual([
      're-exports HttpWebhookTrigger',
      're-exports ScheduleTrigger',
    ])
    expect(triggerTypeStrays('export type { MutedFailureSignal }')).toEqual(['re-exports MutedFailureSignal'])
  })

  it('finds an import from anywhere but the package, renamed or inline typed', () => {
    expect(triggerTypeStrays(`import type { TriggerConfig as T } from '../types'`)).toEqual(['imports TriggerConfig from ../types'])
    expect(triggerTypeStrays(`import { type HttpWebhookConfig, x } from '@/types/workflow'`)).toEqual([
      'imports HttpWebhookConfig from @/types/workflow',
    ])
  })

  it('passes an import from the package, other names, and comments', () => {
    expect(triggerTypeStrays(`import type { HttpWebhookTrigger, MutedFailureSignal } from '${HOME}'`)).toEqual([])
    expect(triggerTypeStrays(`export type { NodeType } from '@bidspoke/node-types'\ntype Other = string`)).toEqual([])
    expect(triggerTypeStrays('// export type TriggerDef = HttpWebhookTrigger')).toEqual([])
  })
})

describe('the trigger types have one home', () => {
  it('the worker declares, re-exports and imports none of them but from the package', () => {
    expect(strays(WORKER_SRC)).toEqual([])
  })

  it('the web app declares, re-exports and imports none of them but from the package', () => {
    expect(strays(WEB_SRC)).toEqual([])
  })
})
