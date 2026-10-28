/**
 * What a Pipedream step is, and the one parser for a code step's source (#1705,
 * #1695). The instrumenter and the converter both read code steps, so they share
 * these rather than each deciding what parses: a step one of them could read and
 * the other could not would be instrumented and then refused at port, or the
 * other way round.
 *
 * Code is read through its syntax tree (recast over @babel/parser), never as text
 * (#17). The options are the syntax Pipedream accepts in a step: a module, with a
 * return or an await at the top level.
 */
import { parse as babelParse } from '@babel/parser'
import { parse, type types } from 'recast'
import type { PipedreamStep } from './instrument.ts'

/** A step whose props carry `_controlFlow`: an if/else, switch or parallel block, whose code Pipedream generates. */
export const isControlFlowStep = (s: PipedreamStep): boolean => !!s.props && '_controlFlow' in s.props

/** A step whose source is written in the workflow: inline code, not a registry component, not control flow. */
export const isCodeStep = (s: PipedreamStep): boolean => typeof s.uses?.code === 'string' && s.uses.registry !== true && !isControlFlowStep(s)

/**
 * Parses a code step's source. Throws babel's SyntaxError, whose `loc.line` is
 * where it stopped, on source that does not parse.
 */
export function parseStepCode(code: string): types.namedTypes.File {
  return parse(code, {
    parser: {
      parse: (source: string) =>
        babelParse(source, {
          sourceType: 'module',
          tokens: true,
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
          errorRecovery: false,
          plugins: ['jsx', 'topLevelAwait'],
        }),
    },
  }) as types.namedTypes.File
}
