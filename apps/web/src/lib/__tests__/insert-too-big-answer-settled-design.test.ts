/**
 * Guard (#2882): the settled design for an earlier step whose test answer was too big to keep,
 * docs/design/insert-too-big-answer.html, carries one check for every decision its map says is
 * verified by a check, on exactly the frames it names. D1's check is run on the component in
 * components/canvas/__tests__/insert-too-big-answer-design.test.tsx.
 */
import { describe, expect, it } from 'vitest'
import { coverageProblems, readSettledDesign } from './_settled-design'

describe('docs/design/insert-too-big-answer.html', () => {
  it('checks every decision the map says is checked, on exactly its frames', () => {
    const { decisions, frameIds, checks } = readSettledDesign('insert-too-big-answer')
    expect(frameIds).toEqual(['picker-too-big'])
    expect(checks.map((c) => c.id)).toEqual(['D1'])
    expect(coverageProblems(decisions, checks, frameIds)).toEqual([])
  })
})
