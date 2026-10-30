/**
 * Which step a parallel block's cut-off row is written under (#3071).
 *
 * A block that stops waiting for a slot writes that slot's row itself. It used
 * to write it under the slot's FIRST step, so a slot cut off on a later step of
 * its chain gave its first step a second row and left the step it was running
 * with none. The row now goes on the step the slot was running, with that
 * step's own start, order and last noted request (#3064).
 */
import { describe, expect, it } from 'vitest'
import type { NodeDefinition, ResolvedStepInput } from '../../types'
import { SlotSteps, type SlotStep } from '../parallel-cut-off'

const node = (namespace: string): NodeDefinition => ({ id: namespace, namespace, type: 'webhook', config: {} })
const step = (namespace: string, stepOrder: number, startedAt: string): SlotStep => ({ node: node(namespace), stepOrder, startedAt })
const request = (submissionId: string): ResolvedStepInput => ({ template: { submission_id: '{{trigger.payload.submission_id}}' }, resolved: { submission_id: submissionId } })

const BLOCK_START = '2026-10-29T12:00:00.000Z'
const first = step('gate', 1, BLOCK_START)

describe('the step a cut-off row is written under (#3071)', () => {
  it('a slot cut off on its first step: that step, with its own start and request', () => {
    const slots = new SlotSteps()
    slots.start(0, step('gate', 1, '2026-10-29T12:00:00.004Z'))
    slots.note(0, 'gate', request('sub-1'))
    expect(slots.cutOff(0, first)).toEqual({ ...step('gate', 1, '2026-10-29T12:00:00.004Z'), input: request('sub-1') })
  })

  it('a slot cut off on a later step: the later step, its order and start, and its own request', () => {
    const slots = new SlotSteps()
    slots.start(0, step('gate', 1, '2026-10-29T12:00:00.004Z'))
    slots.note(0, 'gate', request('sub-gate'))
    slots.record(0, 'gate')
    slots.start(0, step('relay_post', 2, '2026-10-29T12:00:00.009Z'))
    slots.note(0, 'relay_post', request('sub-relay'))
    expect(slots.cutOff(0, first)).toEqual({ ...step('relay_post', 2, '2026-10-29T12:00:00.009Z'), input: request('sub-relay') })
  })

  it('a later step that noted nothing is not given the request an earlier step noted', () => {
    const slots = new SlotSteps()
    slots.start(0, step('relay_post', 1, '2026-10-29T12:00:00.004Z'))
    slots.note(0, 'relay_post', request('sub-relay'))
    slots.record(0, 'relay_post')
    slots.start(0, step('score_gate', 2, '2026-10-29T12:00:00.009Z'))
    expect(slots.cutOff(0, first)).toEqual({ ...step('score_gate', 2, '2026-10-29T12:00:00.009Z'), input: null })
  })

  it('a slot whose running step already wrote its own row gets no cut-off row: never a second row (#63)', () => {
    const slots = new SlotSteps()
    slots.start(0, step('gate', 1, '2026-10-29T12:00:00.004Z'))
    slots.record(0, 'gate')
    expect(slots.cutOff(0, first)).toBeNull()
  })

  it('recording a step the slot is no longer on leaves the running step to be cut off', () => {
    const slots = new SlotSteps()
    slots.start(0, step('relay_post', 2, '2026-10-29T12:00:00.009Z'))
    slots.record(0, 'gate')
    expect(slots.cutOff(0, first)?.node.namespace).toBe('relay_post')
  })

  it('a slot that reported no step at all is written under its first step at the block\'s start, with no request', () => {
    expect(new SlotSteps().cutOff(0, first)).toEqual({ ...first, input: null })
  })

  it('slots are kept apart: one slot\'s steps and requests never reach another\'s row', () => {
    const slots = new SlotSteps()
    slots.start(0, step('gate', 1, '2026-10-29T12:00:00.004Z'))
    slots.start(1, step('relay_post', 2, '2026-10-29T12:00:00.005Z'))
    slots.note(1, 'relay_post', request('sub-relay'))
    expect(slots.cutOff(0, first)).toEqual({ ...step('gate', 1, '2026-10-29T12:00:00.004Z'), input: null })
    expect(slots.cutOff(1, step('relay_post', 2, BLOCK_START))?.input).toEqual(request('sub-relay'))
  })

  it('the row is a copy: a note the slot makes after it was cut off never changes it', () => {
    const slots = new SlotSteps()
    slots.start(0, step('relay_post', 1, '2026-10-29T12:00:00.004Z'))
    slots.note(0, 'relay_post', request('sub-1'))
    const row = slots.cutOff(0, first)
    slots.note(0, 'relay_post', request('sub-after-cut-off'))
    expect(row?.input).toEqual(request('sub-1'))
  })
})
