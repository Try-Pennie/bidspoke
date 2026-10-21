/**
 * The edits the lead validation settings list makes to a step's ordered checks
 * (#2590): add, move up and down, remove, and which check stays chosen after
 * each. The order is the order the checks run in, so each edit is pinned here.
 */
import { describe, expect, it } from 'vitest'
import { parseLeadValidationConfig } from '@bidspoke/workflow-definition'
import { addCheck, blankCheck, chosenIndex, moveCheck, newLeadValidationConfig, nextCheckId, removeCheck } from '../lead-validation-checks'

const ids = (checks: { id?: unknown }[]) => checks.map((c) => c.id)
const three = () => [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('nextCheckId', () => {
  it('is the smallest check_N the step does not hold yet', () => {
    expect(nextCheckId([])).toBe('check_1')
    expect(nextCheckId([{ id: 'check_1' }, { id: 'check_3' }])).toBe('check_2')
    expect(nextCheckId([{ id: 'state' }, { id: 'check_1' }])).toBe('check_2')
  })
})

describe('blankCheck', () => {
  it('starts with one empty condition, no reason chosen, and a lead missing a value rejected', () => {
    expect(blankCheck('check_1')).toEqual({
      id: 'check_1',
      label: '',
      condition: { logic: 'AND', groups: [{ logic: 'AND', conditions: [{ field: '', operator: 'eq', value: '' }] }] },
      reason: '',
      on_missing: 'reject',
    })
  })
})

describe('newLeadValidationConfig: a step dropped on the canvas', () => {
  it('holds one blank check to fill in, which the save check names as unfinished', () => {
    const config = newLeadValidationConfig()
    expect(ids(config.checks)).toEqual(['check_1'])
    const parsed = parseLeadValidationConfig(config)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.problems[0]).toBe('No lead id field set')
  })
})

describe('addCheck', () => {
  it('appends a blank check and chooses it', () => {
    const next = addCheck(three())
    expect(ids(next.checks)).toEqual(['a', 'b', 'c', 'check_1'])
    expect(next.chosen).toBe(3)
  })
})

describe('moveCheck', () => {
  it('moves the chosen check up or down and keeps it chosen', () => {
    expect(moveCheck(three(), 1, -1)).toEqual({ checks: [{ id: 'b' }, { id: 'a' }, { id: 'c' }], chosen: 0 })
    expect(moveCheck(three(), 1, 1)).toEqual({ checks: [{ id: 'a' }, { id: 'c' }, { id: 'b' }], chosen: 2 })
  })

  it('leaves the first check where it is on a move up, and the last on a move down', () => {
    expect(moveCheck(three(), 0, -1)).toEqual({ checks: three(), chosen: 0 })
    expect(moveCheck(three(), 2, 1)).toEqual({ checks: three(), chosen: 2 })
  })
})

describe('removeCheck', () => {
  it('removes the chosen check and chooses the one that took its place', () => {
    expect(removeCheck(three(), 1)).toEqual({ checks: [{ id: 'a' }, { id: 'c' }], chosen: 1 })
  })

  it('chooses the new last check when the last is removed, and none is left chosen past the end', () => {
    expect(removeCheck(three(), 2)).toEqual({ checks: [{ id: 'a' }, { id: 'b' }], chosen: 1 })
    expect(removeCheck([{ id: 'a' }], 0)).toEqual({ checks: [], chosen: 0 })
  })
})

describe('chosenIndex', () => {
  it('keeps a remembered choice inside the list after the config changes underneath it', () => {
    expect(chosenIndex(5, 3)).toBe(2)
    expect(chosenIndex(-1, 3)).toBe(0)
    expect(chosenIndex(1, 0)).toBe(0)
  })
})
