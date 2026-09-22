/**
 * #1432. On 2026-09-21 the buyer profile work (#1409, merged as #1427) committed
 * apps/worker/src/types/database.ts with one extra blank line at the end of the
 * file. Nothing else differed: every table, column, function and enum matched the
 * live schema. The nightly DB Types Drift check compares the regenerated file byte
 * for byte, so it went red the next morning on that single byte and told Slack a
 * migration had landed without a types regen, which had not happened. It then
 * failed again on the next run, and would have gone on failing, and while it is red
 * it cannot report a real schema change either (L36, L538).
 *
 * This is the same class as #1186: a generated file altered by something other than
 * the generator, caught the next morning by a network-bound check rather than on the
 * pull request. #1186's guard asserts the ORDER of the keys, which a whitespace-only
 * change satisfies. This one asserts the whitespace the generator always writes:
 * no carriage returns, no trailing whitespace on any line, and the file ends with
 * exactly one newline after `} as const`. All three were measured on a freshly
 * regenerated file, not assumed.
 *
 * It needs no network and no database, so it runs on the pull request that
 * introduces the edit, which is where the cost is one push rather than a day of a
 * blind drift check.
 *
 * If #1115 lands and the drift check compares by structure rather than character
 * for character, whitespace stops failing it, and this becomes the thing that still
 * keeps the committed file identical to what the generator writes.
 *
 * The scanner is exercised in both directions on synthetic input (L1, L159), and the
 * real file must yield a non-trivial number of lines, because a scanner that read
 * nothing would pass everything (L100).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../__tests__/_scan-utils'

const COMMITTED = path.join(REPO_ROOT, 'apps/worker/src/types/database.ts')

interface Scan {
  lineCount: number
  /** 1-indexed lines carrying a space or tab immediately before the line break. */
  trailingWhitespace: number[]
  /** 1-indexed lines carrying a carriage return. */
  carriageReturn: number[]
  /** True when the last byte is not a newline, so the final line is unterminated. */
  missingFinalNewline: boolean
  /** True when a newline is followed by nothing but another newline at the end. */
  blankLineAtEnd: boolean
}

export function scanWhitespaceShape(source: string): Scan {
  const lines = source.split('\n')
  const missingFinalNewline = source.length > 0 && !source.endsWith('\n')
  // split('\n') leaves one empty element for the newline that ends the last real
  // line. Anything beyond that element is a genuine blank line at the end.
  const body = missingFinalNewline ? lines : lines.slice(0, -1)

  return {
    lineCount: body.length,
    trailingWhitespace: body.flatMap((text, i) => (/[ \t]$/.test(text) ? [i + 1] : [])),
    carriageReturn: body.flatMap((text, i) => (text.includes('\r') ? [i + 1] : [])),
    missingFinalNewline,
    blankLineAtEnd: body.length > 0 && body[body.length - 1] === '',
  }
}

const REGENERATE = "Run 'pnpm --filter worker db:types' and commit the result."

describe('the whitespace scanner reads what it claims (#1432 positive control)', () => {
  it('reports a clean file as clean', () => {
    const scan = scanWhitespaceShape('export const Constants = {\n} as const\n')

    expect(scan).toEqual({
      lineCount: 2,
      trailingWhitespace: [],
      carriageReturn: [],
      missingFinalNewline: false,
      blankLineAtEnd: false,
    })
  })

  it('names the blank line at the end, which is what went red', () => {
    const scan = scanWhitespaceShape('} as const\n\n')

    expect(scan.blankLineAtEnd).toBe(true)
    expect(scan.lineCount).toBe(2)
  })

  it('names a line padded with a space and one padded with a tab', () => {
    const scan = scanWhitespaceShape('a\nb \nc\nd\t\n')

    expect(scan.trailingWhitespace).toEqual([2, 4])
  })

  it('names a line carrying a carriage return', () => {
    const scan = scanWhitespaceShape(`a\nb${String.fromCharCode(13)}\nc\n`)

    expect(scan.carriageReturn).toEqual([2])
  })

  it('reports a file whose last line is unterminated', () => {
    const scan = scanWhitespaceShape('} as const')

    expect(scan.missingFinalNewline).toBe(true)
    expect(scan.blankLineAtEnd).toBe(false)
  })
})

describe("the committed DB types carry the generator's whitespace (#1432)", () => {
  const source = readFileSync(COMMITTED, 'utf8')
  const scan = scanWhitespaceShape(source)

  it('reads a non-trivial number of lines, so it cannot pass by matching nothing', () => {
    // Measured 2026-09-22: 2930 lines. A floor far under it, so shrinking the schema
    // does not fail this, while a broken scanner does.
    expect(scan.lineCount).toBeGreaterThanOrEqual(500)
  })

  it('ends with exactly one newline and no blank line after it', () => {
    expect(
      scan.blankLineAtEnd,
      `apps/worker/src/types/database.ts ends with a blank line, which the generator never writes, so the nightly DB Types Drift check will fail on it. ${REGENERATE}`,
    ).toBe(false)
    expect(
      scan.missingFinalNewline,
      `apps/worker/src/types/database.ts does not end with a newline. ${REGENERATE}`,
    ).toBe(false)
  })

  it('ends on the Constants block the generator closes the file with', () => {
    expect(source.split('\n').slice(-2, -1)[0]).toBe('} as const')
  })

  it('has no trailing whitespace and no carriage returns on any line', () => {
    expect(
      scan.trailingWhitespace,
      `apps/worker/src/types/database.ts has trailing whitespace on these lines, which the generator never writes. ${REGENERATE}`,
    ).toEqual([])
    expect(
      scan.carriageReturn,
      `apps/worker/src/types/database.ts has carriage returns on these lines. ${REGENERATE}`,
    ).toEqual([])
  })
})
