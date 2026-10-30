import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { WORKER_SRC, listTsFiles, sanitizeSource } from '../../__tests__/_scan-utils'

/**
 * Every page about an incident is recorded, delivered or not (#3056).
 *
 * The record used to hear of a page only from recordPaged, which each delivery
 * site called inside its `if (sent)`. So a page that was due and that Slack
 * refused left nothing: no alert_incidents row and a job run still saying ok.
 * Four Lead Economy shifts went unpaged that way (#2808) and nothing recorded
 * it. Now one function, recordPageOutcome (or recordPageOutcomeOn for a check
 * keeping its incident in its own state), takes the send's answer and records
 * either outcome, and this guard keeps every site on it:
 *
 *  1. Only lib/alert-recovery.ts writes a `paged` or `undelivered` event, and
 *     nothing names recordPaged, which is retired.
 *  2. Every file that arms an incident (markAlerted, keepAlerted, or an
 *     `opened` event of its own) records its page outcomes there. Enumerated by
 *     the state reached (L247): arming is what makes a file a delivery site,
 *     whatever its send is called.
 *  3. At each call the delivered argument is the send's answer: never a literal
 *     true or false, and never inside a branch, or behind an &&, that tests
 *     that same answer, where it could only ever be one value.
 */
const RECOVERY = path.join(WORKER_SRC, 'lib', 'alert-recovery.ts')

interface Source { file: string; raw: string; code: string }

const sources: Source[] = listTsFiles(WORKER_SRC)
  .filter((full) => !full.replace(/\\/g, '/').includes('/__tests__/'))
  .map((full) => {
    const raw = readFileSync(full, 'utf8')
    return { file: path.relative(WORKER_SRC, full), raw, code: sanitizeSource(raw, { blankStrings: false }) }
  })

const RECORDERS: Record<string, number> = { recordPageOutcome: 5, recordPageOutcomeOn: 6 }

/** Files that write a paged or undelivered event themselves. */
function writesPageEvents(code: string): boolean {
  return /\bwriteIncidentEvent\(\s*[\w.]+\s*,\s*\{\s*type:\s*'(?:paged|undelivered)'/.test(code)
}

function arms(code: string): boolean {
  return /\b(?:markAlerted|keepAlerted)\(/.test(code) || /\bwriteIncidentEvent\(\s*[\w.]+\s*,\s*\{\s*type:\s*'opened'/.test(code)
}

function recordsOutcomes(code: string): boolean {
  return /\brecordPageOutcome(?:On)?\(/.test(code)
}

/** Each recorder call whose delivered argument cannot be the send's answer, as `line: why`. */
function misplacedOutcomes(fileName: string, raw: string): string[] {
  const sf = ts.createSourceFile(fileName, raw, ts.ScriptTarget.Latest, true)
  const problems: string[] = []
  const mentions = (cond: ts.Node, arg: ts.Expression): boolean => {
    const text = cond.getText(sf)
    if (ts.isIdentifier(arg)) return new RegExp(`(^|[^\\w.$])${arg.text}(?![\\w$])`).test(text)
    return text.includes(arg.getText(sf))
  }
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text in RECORDERS) {
      const at = RECORDERS[node.expression.text]
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const arg = node.arguments[at]
      if (!arg) {
        problems.push(`${line}: no delivered argument`)
      } else if (arg.kind === ts.SyntaxKind.TrueKeyword || arg.kind === ts.SyntaxKind.FalseKeyword) {
        problems.push(`${line}: delivered is the literal ${arg.getText(sf)}, not the send's answer`)
      } else {
        for (let child: ts.Node = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
          // Through a callback (a bookkeeping wrapper, a closure), never out of a named function.
          if (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) break
          if (ts.isIfStatement(parent) && child !== parent.expression && mentions(parent.expression, arg)) {
            problems.push(`${line}: recorded only inside a branch that tests ${arg.getText(sf)}`)
            break
          }
          if (ts.isConditionalExpression(parent) && child !== parent.condition && mentions(parent.condition, arg)) {
            problems.push(`${line}: recorded only on one side of a test of ${arg.getText(sf)}`)
            break
          }
          if (ts.isBinaryExpression(parent) && child === parent.right
            && (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
            && mentions(parent.left, arg)) {
            problems.push(`${line}: recorded only behind a test of ${arg.getText(sf)}`)
            break
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return problems
}

describe('every page about an incident is recorded, delivered or not (#3056)', () => {
  it('reads the worker source, the arming sites among it', () => {
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.filter((s) => s.file !== 'lib/alert-recovery.ts' && arms(s.code)).length).toBeGreaterThan(20)
  })

  it('writes a paged or undelivered event only through alert-recovery.ts', () => {
    const writers = sources.filter((s) => path.join(WORKER_SRC, s.file) !== RECOVERY && writesPageEvents(s.code)).map((s) => s.file)
    expect(writers).toEqual([])
    const retired = sources.filter((s) => /\brecordPaged\b/.test(s.code)).map((s) => s.file)
    expect(retired, 'recordPaged is retired: call recordPageOutcome with the send\'s answer').toEqual([])
  })

  it('has every file that arms an incident record its page outcomes', () => {
    const silent = sources
      .filter((s) => path.join(WORKER_SRC, s.file) !== RECOVERY && arms(s.code) && !recordsOutcomes(s.code))
      .map((s) => s.file)
    expect(silent, 'these arm an incident but never record what became of its page').toEqual([])
  })

  it('hands every recorder the send\'s answer, outside any branch that tests it', () => {
    const found = sources.flatMap((s) => misplacedOutcomes(s.file, s.raw).map((p) => `${s.file}:${p}`))
    expect(found).toEqual([])
  })

  it('fails on the shapes it exists to catch', () => {
    const call = 'recordPageOutcome(kv, P, id, incident, now, sent)'
    expect(misplacedOutcomes('a.ts', `async function f() { if (sent) { await ${call} } }`)).toEqual(['1: recorded only inside a branch that tests sent'])
    expect(misplacedOutcomes('a.ts', `async function f() { if (!sent) return; else await ${call} }`)).toEqual(['1: recorded only inside a branch that tests sent'])
    expect(misplacedOutcomes('a.ts', `async function f() { sent && await ${call} }`)).toEqual(['1: recorded only behind a test of sent'])
    expect(misplacedOutcomes('a.ts', 'async function f() { await recordPageOutcome(kv, P, id, incident, now, true) }')).toEqual(["1: delivered is the literal true, not the send's answer"])
    expect(misplacedOutcomes('a.ts', 'async function f() { if (sent) { await recordPageOutcomeOn(kv, S, id, start, incident, now, sent) } }')).toEqual(['1: recorded only inside a branch that tests sent'])
    expect(misplacedOutcomes('a.ts', 'async function f() { if (r.paged > 0) await recordPageOutcome(kv, P, id, incident, now, r.paged > 0) }')).toEqual(['1: recorded only inside a branch that tests r.paged > 0'])
    expect(misplacedOutcomes('a.ts', `async function f() { if (sent) await keep(() => ${call}) }`)).toEqual(['1: recorded only inside a branch that tests sent'])
    // The answer recorded whatever it was, or only when a page was tried at all.
    expect(misplacedOutcomes('a.ts', `async function f() { if (sent) await markAlerted(kv, P, id, incident, now)\n  await ${call} }`)).toEqual([])
    expect(misplacedOutcomes('a.ts', `async function f() { if (mode === 'alert') await ${call} }`)).toEqual([])
    expect(misplacedOutcomes('a.ts', `async function f() { if (unsent) await ${call} }`)).toEqual([])
    // Recorded only when a page was tried (sent or refused), never only when it was delivered.
    expect(misplacedOutcomes('a.ts', "async function f() { if (pageTried(attempt)) await recordPageOutcome(kv, P, id, incident, now, attempt === 'sent') }")).toEqual([])
    expect(misplacedOutcomes('a.ts', "async function f() { if (attempt === 'sent') await recordPageOutcome(kv, P, id, incident, now, attempt === 'sent') }")).toEqual(["1: recorded only inside a branch that tests attempt === 'sent'"])
  })

  it('counts a file that arms without recording, and one that records, as such', () => {
    expect(arms('await markAlerted(kv, P, id, ctx, now)') && !recordsOutcomes('await markAlerted(kv, P, id, ctx, now)')).toBe(true)
    expect(recordsOutcomes('await recordPageOutcome(kv, P, id, ctx, now, sent)')).toBe(true)
    expect(writesPageEvents("await writeIncidentEvent(kv, { type: 'paged', signal: S, subject: id, startedAt }, ctx, now)")).toBe(true)
    expect(writesPageEvents("await writeIncidentEvent(kv, { type: 'opened', signal: S, subject: id, startedAt }, ctx, now)")).toBe(false)
  })
})
