/**
 * Every failure the walk throws carries the input its step logged (#1992, #2050
 * review). The dead letter and the replay store read the request from the
 * failure, never from the step log, so a site that logs its resolved input and
 * then throws without it hands them nothing. The chain path was one such site
 * and the four buyer and bid group paths were the rest.
 *
 * Read from the source, because these paths each need a whole node fixture to
 * reach, and what matters is the same at every site: the variable the step was
 * logged with is the one the throw passes on.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WORKER_SRC } from '../../__tests__/_scan-utils'

const SOURCE = readFileSync(path.join(WORKER_SRC, 'engine', 'index.ts'), 'utf8')

/**
 * Throws that legitimately log no step first, each with its reason. A throw
 * missing from here with no step log before it FAILS the guard, so a scan that
 * cannot see a site never passes it by default.
 */
const NO_STEP_LOG: Array<{ marker: string; why: string }> = [
  { marker: 'MAX_WALK_STEPS', why: 'the runaway loop guard stops the walk before the node runs, so there is no input' },
]

const LOG_STEP = /logStep\(\s*stepLogQueue,\s*executionId,\s*executionStartedAt,\s*\w+,\s*[^,]+,\s*([A-Za-z_]\w*),/

/**
 * Each throw judged by the nearest step log since the previous throw, with no
 * distance limit: the throw must pass on the input that log recorded.
 */
function throwsMissingTheirInput(source: string): string[] {
  const lines = source.split('\n')
  const missing: string[] = []
  let lastInput: string | undefined
  lines.forEach((line, i) => {
    const logged = LOG_STEP.exec(line)
    if (logged) lastInput = logged[1]
    if (!line.includes('throw new StepFailureError(')) return
    // The whole throw expression, which can span lines.
    let expr = ''
    for (let j = i; j < lines.length && j < i + 8; j++) {
      expr += lines[j]
      if (lines[j].trimEnd().endsWith(')')) break
    }
    if (lastInput === undefined) {
      if (!NO_STEP_LOG.some((x) => expr.includes(x.marker))) {
        missing.push(`line ${i + 1}: no step log before this throw; log one or name it in NO_STEP_LOG`)
      }
    } else if (lastInput !== 'null' && !expr.includes(lastInput)) {
      missing.push(`line ${i + 1}: logged ${lastInput}, threw without it`)
    }
    lastInput = undefined
  })
  return missing
}

describe('a thrown step failure carries the input its step logged', () => {
  it('holds at every throw site in the walk', () => {
    expect(throwsMissingTheirInput(SOURCE)).toEqual([])
  })

  it('finds the sites it is meant to check', () => {
    // A scan that matched nothing would pass on any source.
    const checked = SOURCE.split('\n').filter((l: string) => l.includes('throw new StepFailureError(')).length
    expect(checked).toBeGreaterThanOrEqual(5)
    const broken = 'logStep(stepLogQueue, executionId, executionStartedAt, node, s, fooInput, out, msg, t, 0, at, o)\n  throw new StepFailureError(msg, node.namespace, t)\n'
    expect(throwsMissingTheirInput(broken)).toEqual(['line 2: logged fooInput, threw without it'])
  })

  it('still checks a throw however far below its step log it sits', () => {
    const far = 'logStep(stepLogQueue, executionId, executionStartedAt, node, s, fooInput, out, msg, t, 0, at, o)\n' +
      '  // filler\n'.repeat(80) + '  throw new StepFailureError(msg, node.namespace, t)\n'
    expect(throwsMissingTheirInput(far)).toEqual(['line 82: logged fooInput, threw without it'])
  })

  it('reports a throw with no step log before it, rather than skipping it', () => {
    const bare = '  doWork()\n  throw new StepFailureError(msg, node.namespace, t)\n'
    expect(throwsMissingTheirInput(bare)).toEqual(['line 2: no step log before this throw; log one or name it in NO_STEP_LOG'])
  })
})
