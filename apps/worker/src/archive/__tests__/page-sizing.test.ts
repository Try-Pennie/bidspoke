/**
 * Sizing an execution page by BYTES rather than by count (#983).
 *
 * `SLICE_SIZE` limited a page to 150 executions, but what the 128 MB isolate
 * constrains is bytes, and a count says nothing about bytes. Measured on prod
 * 2026-08-22 over the 13:00 UTC hour (3,575 executions): the heaviest window of
 * 150 consecutive executions is 14.1 MB, a comfortable margin, and the heaviest
 * SINGLE execution is 2.0 MB. A page that happened to catch 150 of those would
 * be 304 MB and would be killed exactly as the whole-hour reader was.
 *
 * The distribution is fat tailed (7.5 kB median wire against 218 kB largest), so
 * the margin rested entirely on the tail not clustering.
 */
import { describe, it, expect } from 'vitest'
import {
  nextPageSize,
  INITIAL_PAGE_SIZE,
  MIN_PAGE_SIZE,
  MAX_PAGE_SIZE,
  TARGET_SLICE_BYTES,
} from '../stream-hour'

const KB = 1024
const MB = 1024 * KB

describe('nextPageSize', () => {
  it('starts small, because the first page is the one no measurement can cover', () => {
    // Slow start. The adaptive size can only react to bytes it has already seen.
    expect(nextPageSize(0, 0)).toBe(INITIAL_PAGE_SIZE)
  })

  it('runs at the ceiling on an ordinary hour', () => {
    // About 70 kB per execution including its steps, which is what production
    // actually looks like. The byte budget is nowhere near binding, so the page
    // is decided by the ceiling and the read costs what it always did.
    expect(nextPageSize(70 * KB * 100, 100)).toBe(MAX_PAGE_SIZE)
  })

  it('shrinks to fit when the executions are the heaviest ones measured', () => {
    // 2.0 MB each, the heaviest single execution observed. 150 of these would be
    // 304 MB; this asks for twelve.
    const page = nextPageSize(2 * MB * 30, 30)

    expect(page).toBe(12)
    expect(page * 2 * MB).toBeLessThan(TARGET_SLICE_BYTES + 2 * MB)
  })

  it('keeps making progress when the executions are absurd', () => {
    // 50 MB each. A page of zero would stall the hour forever, which is worse
    // than a page that is too big: a stalled hour blocks its whole day at the
    // deletion gate and nothing can clear it.
    expect(nextPageSize(50 * MB * 4, 4)).toBe(MIN_PAGE_SIZE)
  })

  it('never asks for more than the ceiling, however light the rows are', () => {
    expect(nextPageSize(10, 1000)).toBe(MAX_PAGE_SIZE)
  })

  it('the first page of the heaviest hour still fits the isolate', () => {
    // The residual the old comment recorded and could not close. At 25 and 2.0
    // MB that is 50 MB, which fits in 128 MB alongside the wires; at 150 it
    // would be 300 MB and the run would be killed before it learned anything.
    expect(INITIAL_PAGE_SIZE * 2 * MB).toBeLessThan(64 * MB)
  })

  it('grows from the first page to the ceiling, so a normal hour pays about one extra read', () => {
    // The cost of the slow start, stated. An hour of 3,575 executions is 25 then
    // 150s, which is 25 pages rather than 24.
    expect(nextPageSize(70 * KB * INITIAL_PAGE_SIZE, INITIAL_PAGE_SIZE)).toBe(MAX_PAGE_SIZE)
  })
})
