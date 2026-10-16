/**
 * The page's types for the partner delete check and its answers (#2140) are the
 * Worker's, field for field, in both directions: the web cannot import the
 * Worker at run time, so lib/api.ts keeps its own copy and this holds them equal.
 */
import { describe, expectTypeOf, it } from 'vitest'
import type { PartnerDeleteCheck as WorkerCheck, PartnerDeleted as WorkerDeleted, PartnerDeleteRefused as WorkerRefused } from '../../../../worker/src/lib/partner-delete-shape'
import type { PartnerDeleteCheck, PartnerDeleted, PartnerDeleteRefused } from '../api'

describe('the partner delete answer types', () => {
  it('are the same on the page as in the Worker', () => {
    expectTypeOf<PartnerDeleteCheck>().toEqualTypeOf<WorkerCheck>()
    expectTypeOf<PartnerDeleted>().toEqualTypeOf<WorkerDeleted>()
    expectTypeOf<PartnerDeleteRefused>().toEqualTypeOf<WorkerRefused>()
  })
})
