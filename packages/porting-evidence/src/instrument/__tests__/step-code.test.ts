import { describe, expect, it } from 'vitest'
import { isCodeStep, isControlFlowStep, parseStepCode, type PipedreamStep } from '../index.ts'

describe('parseStepCode, the one parser for a Pipedream code step (#1695)', () => {
  it('parses a component module, with the syntax Pipedream accepts at the top level', () => {
    const ast = parseStepCode('import axios from "axios"\nexport default defineComponent({ async run({ steps, $ }) { return 1 } })\nawait 0\n')
    expect(ast.program.body).toHaveLength(3)
  })

  it('throws with the line it stopped at, so a caller can name it', () => {
    let caught: unknown
    try {
      parseStepCode('export default defineComponent({\n  async run({ steps, $ }) {\n    return (\n  }\n})\n')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(SyntaxError)
    expect((caught as { loc?: { line: number } }).loc?.line).toBe(4)
  })
})

describe('step kinds the instrumenter and the converter share (#1695)', () => {
  const code: PipedreamStep = { namespace: 'a', uses: { registry: false, code: 'x' } }
  const flow: PipedreamStep = { namespace: 'b', uses: { registry: false, code: 'x' }, props: { _controlFlow: { type: 'ifelse' } } }
  const registry: PipedreamStep = { namespace: 'c', uses: { registry: true, key: 'k', version: '0.0.1' } }

  it('tells a code step from a control flow step and a registry step', () => {
    expect([code, flow, registry].map(isCodeStep)).toEqual([true, false, false])
    expect([code, flow, registry].map(isControlFlowStep)).toEqual([false, true, false])
  })
})
