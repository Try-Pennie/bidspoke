/**
 * Every Slack alert kind is a live name (#2948).
 *
 * Every Worker alert names a fixed kind from SLACK_ALERT_KINDS
 * (apps/worker/src/lib/slack-post-outcome.ts), which the post outcome line
 * records and the tail Worker copies into slack_post_outcomes.alert_kind. The
 * compiler holds every sender to naming one from the list, but nothing holds
 * the list to its senders: a kind left behind when its alert is removed or
 * renamed would read as an alert that simply never posts, and a name listed
 * twice would make the list look longer than the alerts it covers.
 *
 * So this holds every listed kind to being SENT: written as a string literal
 * where the type checker expects a SlackAlertKind (a poster's argument, a
 * field typed as one, a map checked against one), anywhere in the non test
 * Worker source. A literal anywhere else does not count, because many kinds
 * share their words with a job, an incident signal, a KV prefix or a log label,
 * and those would keep a dead kind looking used. It also holds the list to
 * having no duplicates.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'
import { buildWorkerProgram, workerProgramLoadErrors } from './_worker-program'

const LIST_FILE = path.join(WORKER_SRC, 'lib', 'slack-post-outcome.ts')
const SLACK_FILE = path.join(WORKER_SRC, 'lib', 'slack.ts')

/** The names between `SLACK_ALERT_KINDS = [` and `] as const`, in order, duplicates kept. */
function listedKinds(src: string): string[] {
  const code = sanitizeSource(src, { blankStrings: false })
  const start = code.search(/\bSLACK_ALERT_KINDS\s*=\s*\[/)
  if (start === -1) return []
  const open = code.indexOf('[', start)
  const close = code.indexOf(']', open)
  return [...code.slice(open + 1, close).matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/**
 * True when `type` is the kind union: a union of string literals holding every
 * listed kind. Matched by its members rather than its alias name, so a kind
 * reached through `satisfies Record<..., SlackAlertKind>` or a typed field counts
 * however TypeScript chose to print the type there.
 */
function isKindUnion(type: ts.Type, kinds: ReadonlySet<string>): boolean {
  if (!type.isUnion()) return false
  const values = new Set<string>()
  for (const member of type.types) {
    if (!member.isStringLiteral()) return false
    values.add(member.value)
  }
  for (const kind of kinds) if (!values.has(kind)) return false
  return true
}

/** Every string literal the checker expects to be an alert kind, in the given files. */
function sentKinds(program: ts.Program, files: readonly string[], kinds: ReadonlySet<string>): Set<string> {
  const checker = program.getTypeChecker()
  const sent = new Set<string>()
  for (const file of files) {
    const sf = program.getSourceFile(file)
    if (!sf) continue
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const expected = checker.getContextualType(node)
        if (expected && isKindUnion(expected, kinds)) sent.add(node.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return sent
}

const SOURCE_FILES = listTsFiles(WORKER_SRC)
const KINDS = listedKinds(readFileSync(LIST_FILE, 'utf8'))
const KIND_SET = new Set(KINDS)

describe('every Slack alert kind is sent by a sender (#2948)', () => {
  // Built and scanned while the file is collected, as ops-reads-through-helper.test.ts
  // does: type checking the whole worker is past a single test's 5 second limit (#2619).
  const program = buildWorkerProgram(SOURCE_FILES)
  const loadErrors = workerProgramLoadErrors(program)
  const sent = sentKinds(program, SOURCE_FILES, KIND_SET)

  // A planted sender, checked the same way: one kind sent, one only named as a
  // job would name it, one only in a comment.
  const planted = path.join(WORKER_SRC, 'lib/__planted_alert_kinds__.ts')
  const plantedSrc = [
    "import { postMessage } from './slack'",
    "const JOB = 'volume-anomaly'",
    "// 'kill-rate-drift' is only in this comment",
    "export const sendIt = () => postMessage('t', 'c', [], JOB, 'email-drop-rate')",
  ].join('\n')
  const plantedSent = sentKinds(buildWorkerProgram([SLACK_FILE], { [planted]: plantedSrc }), [planted], KIND_SET)

  it('loads the worker program fully, so a clean result is not every type being any', () => {
    expect(loadErrors).toEqual([])
  })

  it('reads the list and the senders, so the checks below are not passing on nothing (L1)', () => {
    expect(KINDS.length).toBeGreaterThan(50)
    expect(SOURCE_FILES).toContain(SLACK_FILE)
    expect(sent.has('http-money-host')).toBe(true)
  })

  it('counts only a literal sent as a kind, never one naming a job or sitting in a comment', () => {
    expect([...plantedSent]).toEqual(['email-drop-rate'])
  })

  it('lists no kind twice', () => {
    const twice = KINDS.filter((k, i) => KINDS.indexOf(k) !== i)
    expect(twice, `listed more than once in SLACK_ALERT_KINDS: ${twice.join(', ')}`).toEqual([])
  })

  it('lists no kind that no sender sends', () => {
    const dead = KINDS.filter((k) => !sent.has(k))
    expect(dead, `in SLACK_ALERT_KINDS but sent by no Worker sender: ${dead.join(', ')}`).toEqual([])
  })

  it('finds a duplicate in a list made to hold one', () => {
    const list = "export const SLACK_ALERT_KINDS = [\n  // 'commented-out',\n  'used-kind',\n  'dead-kind',\n  'used-kind',\n] as const\n"
    expect(listedKinds(list)).toEqual(['used-kind', 'dead-kind', 'used-kind'])
  })
})
