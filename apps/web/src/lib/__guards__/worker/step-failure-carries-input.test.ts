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

/** Each throw whose nearest logStep above it logged an input the throw does not pass on. */
function throwsMissingTheirInput(source: string): string[] {
  const lines = source.split('\n')
  const missing: string[] = []
  lines.forEach((line, i) => {
    if (!line.includes('throw new StepFailureError(')) return
    // The whole throw expression, which can span lines.
    let expr = ''
    for (let j = i; j < lines.length && j < i + 8; j++) {
      expr += lines[j]
      if (lines[j].trimEnd().endsWith(')')) break
    }
    for (let k = i - 1; k >= Math.max(0, i - 40); k--) {
      const m = /logStep\(\s*stepLogQueue,\s*executionId,\s*executionStartedAt,\s*\w+,\s*[^,]+,\s*([A-Za-z_]\w*),/.exec(lines[k])
      if (!m) continue
      const input = m[1]
      if (input !== 'null' && !expr.includes(input)) missing.push(`line ${i + 1}: logged ${input}, threw without it`)
      return
    }
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
})
